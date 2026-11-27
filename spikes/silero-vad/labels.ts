export interface GroundTruthLabel {
  index: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  text: string;
}

export interface SegmentInterval {
  startMs: number;
  endMs: number;
}

export interface LabelMatch<S extends SegmentInterval = SegmentInterval> {
  label: GroundTruthLabel;
  segment: S;
  overlapMs: number;
  startDeltaMs: number;
  endDeltaMs: number;
}

export interface SplitSegment<S extends SegmentInterval = SegmentInterval> {
  label: GroundTruthLabel;
  segment: S;
  previousSegment: S;
  gapMs: number;
  overlapMs: number;
}

export type SegmentMatchKind = "match" | "split" | "false_positive";

export interface SegmentAnnotation {
  kind: SegmentMatchKind;
  labelIndices: number[];
  splitGapMs: number | null;
}

export interface LabelComparisonResult<S extends SegmentInterval = SegmentInterval> {
  matches: LabelMatch<S>[];
  splits: SplitSegment<S>[];
  falsePositives: S[];
  missedLabels: GroundTruthLabel[];
  annotations: SegmentAnnotation[];
}

export function parseLabels(content: string): GroundTruthLabel[] {
  const labels: GroundTruthLabel[] = [];
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const raw = lines[lineIdx]?.trim() ?? "";
    if (raw.length === 0 || raw.startsWith("#")) {
      continue;
    }

    const match = /^(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(raw);
    if (!match) {
      throw new Error(`Invalid label syntax on line ${lineIdx + 1}: "${raw}"`);
    }

    const startSec = Number(match[1]);
    const endSec = Number(match[2]);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec < startSec) {
      throw new Error(`Invalid label timestamps on line ${lineIdx + 1}: "${raw}"`);
    }

    const startMs = Math.round(startSec * 1000);
    const endMs = Math.round(endSec * 1000);
    const index = labels.length + 1;
    const text = (match[3] ?? "").trim() || `label_${index}`;

    labels.push({
      index,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      text,
    });
  }

  return labels;
}

export function intervalOverlapMs(a: SegmentInterval, b: SegmentInterval): number {
  const start = Math.max(a.startMs, b.startMs);
  const end = Math.min(a.endMs, b.endMs);
  return Math.max(0, end - start);
}

/**
 * Compares detected speech segments against ground-truth labels.
 * When a label is already matched and another detected segment also overlaps it,
 * that segment is recorded under `splits` (with the gap between the two pieces in ms),
 * not under `falsePositives`.
 */
export function compareSegmentsToLabels<S extends SegmentInterval>(
  segments: readonly S[],
  labels: readonly GroundTruthLabel[],
): LabelComparisonResult<S> {
  const matches: LabelMatch<S>[] = [];
  const splits: SplitSegment<S>[] = [];
  const falsePositives: S[] = [];
  const annotations: SegmentAnnotation[] = [];

  const lastPieceByLabel = new Map<GroundTruthLabel, S>();

  for (const segment of segments) {
    const overlapping = labels
      .map((label) => ({ label, overlapMs: intervalOverlapMs(segment, label) }))
      .filter((entry) => entry.overlapMs > 0);

    if (overlapping.length === 0) {
      falsePositives.push(segment);
      annotations.push({
        kind: "false_positive",
        labelIndices: [],
        splitGapMs: null,
      });
      continue;
    }

    let hasNewMatch = false;
    let firstSplitGapMs: number | null = null;
    const labelIndices: number[] = [];

    for (const { label, overlapMs } of overlapping) {
      labelIndices.push(label.index);
      const previous = lastPieceByLabel.get(label);
      if (!previous) {
        hasNewMatch = true;
        matches.push({
          label,
          segment,
          overlapMs,
          startDeltaMs: segment.startMs - label.startMs,
          endDeltaMs: segment.endMs - label.endMs,
        });
      } else {
        const gapMs = segment.startMs - previous.endMs;
        if (firstSplitGapMs === null) {
          firstSplitGapMs = gapMs;
        }
        splits.push({
          label,
          segment,
          previousSegment: previous,
          gapMs,
          overlapMs,
        });
      }
      lastPieceByLabel.set(label, segment);
    }

    annotations.push({
      kind: hasNewMatch ? "match" : "split",
      labelIndices,
      splitGapMs: hasNewMatch ? null : firstSplitGapMs,
    });
  }

  const missedLabels = labels.filter((label) => !lastPieceByLabel.has(label));

  return {
    matches,
    splits,
    falsePositives,
    missedLabels,
    annotations,
  };
}
