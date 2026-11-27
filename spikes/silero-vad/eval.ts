import { access } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  type GroundTruthLabel,
  type LabelComparisonResult,
  type LabelMatch,
  type SplitSegment,
} from "./labels.js";
import {
  type DetectedSegment,
  type SegmenterConfig,
  type SegmenterEvent,
  type SegmenterState,
  VadSegmenter,
  collectSegmentsFromEvents,
} from "./segmenter.js";
import {
  SILERO_SAMPLE_RATE,
  SILERO_WINDOW_SAMPLES,
  type SileroVad,
} from "./silero.js";

export const FRAME_SAMPLES_20MS = 320; // Simulated WebSocket client frame size (20 ms @ 16 kHz)

export interface WindowStepInfo {
  windowIdx: number;
  currentMs: number;
  prob: number;
  state: SegmenterState;
  stepEvents: SegmenterEvent[];
}

export interface VadRunOptions {
  segmenterConfig?: Partial<SegmenterConfig>;
  onWindow?: (info: WindowStepInfo) => void;
}

export interface VadRunOutput {
  segments: DetectedSegment[];
  events: SegmenterEvent[];
  inferenceTimesMs: number[];
}

export interface FileSummaryRow {
  file: string;
  segments: number;
  splits: number | null;
  falsePositives: number | null;
  missedLabels: number | null;
  maxOnsetConfirmMs: number | null;
  medianVadEndMs: number | null;
}

/**
 * Resolves `<name>.labels.txt` next to `<name>.wav`, returning `null` if absent.
 */
export async function resolveSidecarLabelsPath(wavPath: string): Promise<string | null> {
  const stem = basename(wavPath, extname(wavPath)) || "sample";
  const sidecar = join(dirname(wavPath), `${stem}.labels.txt`);
  try {
    await access(sidecar);
    return sidecar;
  } catch {
    return null;
  }
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function formatSigned(n: number): string {
  const s = formatNumber(n);
  return n > 0 ? `+${s}` : s;
}

export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const formatRow = (cells: readonly string[]) =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");
  return [formatRow(headers), separator, ...rows.map(formatRow)];
}

/**
 * Streams 20 ms PCM chunks through 32 ms Silero windows and the pure VadSegmenter.
 * Always resets the Silero model state first so consecutive files stay isolated.
 */
export async function runVadOnSamples(
  vad: SileroVad,
  float32: Float32Array,
  options: VadRunOptions = {},
): Promise<VadRunOutput> {
  vad.reset();

  let pending = new Float32Array(0);
  const inferenceTimesMs: number[] = [];
  const windowMs = (SILERO_WINDOW_SAMPLES / SILERO_SAMPLE_RATE) * 1000;
  const segmenter = new VadSegmenter(options.segmenterConfig);
  const events: SegmenterEvent[] = [];
  let windowIdx = 0;

  for (let offset = 0; offset < float32.length; offset += FRAME_SAMPLES_20MS) {
    const frame = float32.subarray(
      offset,
      Math.min(offset + FRAME_SAMPLES_20MS, float32.length),
    );

    const combined = new Float32Array(pending.length + frame.length);
    combined.set(pending, 0);
    combined.set(frame, pending.length);
    pending = combined;

    while (pending.length >= SILERO_WINDOW_SAMPLES) {
      const win = pending.subarray(0, SILERO_WINDOW_SAMPLES);
      pending = pending.subarray(SILERO_WINDOW_SAMPLES);

      const t0 = performance.now();
      const prob = await vad.probability(win);
      const dt = performance.now() - t0;
      inferenceTimesMs.push(dt);

      const stepEvents = segmenter.push(prob);
      events.push(...stepEvents);

      options.onWindow?.({
        windowIdx,
        currentMs: windowIdx * windowMs,
        prob,
        state: segmenter.state,
        stepEvents,
      });

      windowIdx++;
    }
  }

  events.push(...segmenter.flush());
  return {
    segments: collectSegmentsFromEvents(events),
    events,
    inferenceTimesMs,
  };
}

export function summarizeVadRun(
  file: string,
  segments: readonly DetectedSegment[],
  comparison: LabelComparisonResult<DetectedSegment> | null,
): FileSummaryRow {
  const maxOnsetConfirmMs =
    segments.length === 0 ? null : Math.max(...segments.map((s) => s.onsetConfirmMs));
  const medianVadEndMs =
    segments.length === 0 ? null : median(segments.map((s) => s.vadEndMs));

  return {
    file,
    segments: segments.length,
    splits: comparison ? comparison.splits.length : null,
    falsePositives: comparison ? comparison.falsePositives.length : null,
    missedLabels: comparison ? comparison.missedLabels.length : null,
    maxOnsetConfirmMs,
    medianVadEndMs,
  };
}

export function renderCombinedSummaryTable(summaries: readonly FileSummaryRow[]): string[] {
  const headers = [
    "file",
    "segments",
    "splits",
    "falsePositives",
    "missedLabels",
    "max onsetConfirmMs",
    "median vadEndMs",
  ];

  const rows = summaries.map((s) => [
    s.file,
    String(s.segments),
    s.splits === null ? "n/a" : String(s.splits),
    s.falsePositives === null ? "n/a" : String(s.falsePositives),
    s.missedLabels === null ? "n/a" : String(s.missedLabels),
    s.maxOnsetConfirmMs === null ? "-" : formatNumber(s.maxOnsetConfirmMs),
    s.medianVadEndMs === null ? "-" : formatNumber(s.medianVadEndMs),
  ]);

  return renderTable(headers, rows);
}

function buildSegmentErrorRow(
  seg: DetectedSegment,
  index: number,
  comparison: LabelComparisonResult<DetectedSegment> | null,
  matchesBySegment: Map<DetectedSegment, LabelMatch<DetectedSegment>[]>,
  splitsBySegment: Map<DetectedSegment, SplitSegment<DetectedSegment>[]>,
): string[] {
  const base = [
    String(seg.index),
    String(seg.startMs),
    String(seg.endMs),
    String(seg.durationMs),
    String(seg.onsetConfirmMs),
    String(seg.vadEndMs),
    seg.endReason,
  ];

  if (!comparison) {
    return [...base, "NO_LABELS", "-", "-", "-", "missing .labels.txt"];
  }

  const ann = comparison.annotations[index];
  const segMatches = matchesBySegment.get(seg) ?? [];
  const segSplits = splitsBySegment.get(seg) ?? [];

  if (ann?.kind === "false_positive") {
    return [...base, "FALSE_POSITIVE", "-", "-", "-", "no overlapping speech label"];
  }

  if (ann?.kind === "split") {
    const labelRef = `#${ann.labelIndices.join(",")}`;
    const detail = segSplits
      .map(
        (s) =>
          `gap=+${s.gapMs}ms after seg #${s.previousSegment.index} (endDelta=${formatSigned(seg.endMs - s.label.endMs)}ms)`,
      )
      .join("; ");
    return [...base, "SPLIT", labelRef, "-", "-", detail];
  }

  const labelRef = `#${segMatches.map((m) => m.label.index).join(",")}`;
  const startDelta = segMatches.map((m) => formatSigned(m.startDeltaMs)).join(", ");
  const endDelta = segMatches.map((m) => formatSigned(m.endDeltaMs)).join(", ");
  const status = segMatches.length > 1 ? "MATCH (merged)" : "MATCH";
  const matchNotes = segMatches.map((m) => m.label.text).join(" / ");
  const splitNotes =
    segSplits.length > 0
      ? ` [also split: ${segSplits.map((s) => `#${s.label.index} gap=+${s.gapMs}ms`).join(", ")}]`
      : "";

  return [...base, status, labelRef, startDelta, endDelta, `${matchNotes}${splitNotes}`];
}

export function renderPerSegmentErrorTable(
  segments: readonly DetectedSegment[],
  comparison: LabelComparisonResult<DetectedSegment> | null,
): string[] {
  const lines: string[] = [];

  if (segments.length === 0) {
    lines.push("(no speech segments detected)");
  } else {
    const matchesBySegment = new Map<DetectedSegment, LabelMatch<DetectedSegment>[]>();
    const splitsBySegment = new Map<DetectedSegment, SplitSegment<DetectedSegment>[]>();

    if (comparison) {
      for (const m of comparison.matches) {
        const list = matchesBySegment.get(m.segment) ?? [];
        list.push(m);
        matchesBySegment.set(m.segment, list);
      }
      for (const s of comparison.splits) {
        const list = splitsBySegment.get(s.segment) ?? [];
        list.push(s);
        splitsBySegment.set(s.segment, list);
      }
    }

    const headers = [
      "#",
      "startMs",
      "endMs",
      "durationMs",
      "onsetConfirmMs",
      "vadEndMs",
      "reason",
      "status",
      "label#",
      "startDeltaMs",
      "endDeltaMs",
      "detail",
    ];
    const rows = segments.map((seg, idx) =>
      buildSegmentErrorRow(seg, idx, comparison, matchesBySegment, splitsBySegment),
    );
    lines.push(...renderTable(headers, rows));
  }

  if (comparison && comparison.missedLabels.length > 0) {
    lines.push("");
    lines.push("Missed labels:");
    const missedHeaders = ["label#", "startMs", "endMs", "durationMs", "text"];
    const missedRows = comparison.missedLabels.map((ml: GroundTruthLabel) => [
      String(ml.index),
      String(ml.startMs),
      String(ml.endMs),
      String(ml.durationMs),
      ml.text,
    ]);
    lines.push(...renderTable(missedHeaders, missedRows));
  }

  return lines;
}
