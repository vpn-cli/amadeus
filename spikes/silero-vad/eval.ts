import { access, readFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  type GroundTruthLabel,
  type LabelComparisonResult,
  type LabelMatch,
  type SplitSegment,
  compareSegmentsToLabels,
  parseLabels,
} from "./labels.js";
import {
  DEFAULT_SEGMENTER_CONFIG,
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
export const VAD_WINDOW_MS = (SILERO_WINDOW_SAMPLES / SILERO_SAMPLE_RATE) * 1000;
// 550 ms hang rounded up to whole 32 ms Silero windows = 576 ms (matches docs/ARCHITECTURE.md §7)
export const VAD_END_BUDGET_MS =
  Math.ceil(DEFAULT_SEGMENTER_CONFIG.endSilenceMs / VAD_WINDOW_MS) * VAD_WINDOW_MS;

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

export interface LoadedSidecarLabels {
  labelsPath: string | null;
  labels: GroundTruthLabel[] | null;
}

export interface FileSummaryRow {
  file: string;
  segments: number;
  splits: number | null;
  falsePositives: number | null;
  missedLabels: number | null;
  maxOnsetConfirmMs: number | null;
  medianVadEndMs: number | null;
  maxVadEndMs: number | null;
  withinVadEndBudget: boolean | null;
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

/**
 * Loads labels from an explicit path or `<name>.labels.txt` sidecar.
 * A missing labels file returns `labels: null` ("no comparison"), whereas a
 * 0-byte labels file returns `labels: []` ("labels present, zero speech").
 */
export async function loadSidecarLabels(
  wavPath: string,
  explicitLabelsPath?: string | null,
): Promise<LoadedSidecarLabels> {
  const labelsPath =
    explicitLabelsPath !== undefined ? explicitLabelsPath : await resolveSidecarLabelsPath(wavPath);
  if (labelsPath === null) {
    return { labelsPath: null, labels: null };
  }
  const content = await readFile(labelsPath, "utf8");
  return { labelsPath, labels: parseLabels(content) };
}

/**
 * Compares unpadded detected segments against ground-truth labels.
 * Returns `null` when `labels === null` (missing labels file -> no comparison).
 * When `labels` is `[]` (0-byte labels file -> zero speech), every detected
 * segment is classified as a `FALSE_POSITIVE`.
 */
export function evaluateSegments(
  segments: readonly DetectedSegment[],
  labels: readonly GroundTruthLabel[] | null,
): LabelComparisonResult<DetectedSegment> | null {
  if (labels === null) {
    return null;
  }
  return compareSegmentsToLabels(segments, labels);
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
  vadEndBudgetMs = VAD_END_BUDGET_MS,
): FileSummaryRow {
  const maxOnsetConfirmMs =
    segments.length === 0 ? null : Math.max(...segments.map((s) => s.onsetConfirmMs));
  const vadEndValues = segments.map((s) => s.vadEndMs);
  const medianVadEndMs = segments.length === 0 ? null : median(vadEndValues);
  const maxVadEndMs = segments.length === 0 ? null : Math.max(...vadEndValues);
  const withinVadEndBudget = maxVadEndMs === null ? null : maxVadEndMs <= vadEndBudgetMs;

  return {
    file,
    segments: segments.length,
    splits: comparison ? comparison.splits.length : null,
    falsePositives: comparison ? comparison.falsePositives.length : null,
    missedLabels: comparison ? comparison.missedLabels.length : null,
    maxOnsetConfirmMs,
    medianVadEndMs,
    maxVadEndMs,
    withinVadEndBudget,
  };
}

export function formatVadEndBudget(
  withinBudget: boolean | null,
  vadEndBudgetMs = VAD_END_BUDGET_MS,
): string {
  if (withinBudget === null) return "-";
  return withinBudget ? `OK (<=${vadEndBudgetMs}ms)` : `OVER (>${vadEndBudgetMs}ms)`;
}

export function formatSummaryLine(
  summary: FileSummaryRow,
  vadEndBudgetMs = VAD_END_BUDGET_MS,
): string {
  const maxOnset = summary.maxOnsetConfirmMs === null ? "0" : formatNumber(summary.maxOnsetConfirmMs);
  const medVad = summary.medianVadEndMs === null ? "0" : formatNumber(summary.medianVadEndMs);
  const maxVad = summary.maxVadEndMs === null ? "0" : formatNumber(summary.maxVadEndMs);
  const budget = formatVadEndBudget(summary.withinVadEndBudget, vadEndBudgetMs);
  const splitsStr = summary.splits === null ? "n/a" : String(summary.splits);
  const fpStr = summary.falsePositives === null ? "n/a" : String(summary.falsePositives);
  const missedStr = summary.missedLabels === null ? "n/a" : String(summary.missedLabels);

  return `Summary: segments=${summary.segments} | max onsetConfirmMs=${maxOnset} ms | median vadEndMs=${medVad} ms | max vadEndMs=${maxVad} ms | vadEndBudget=${budget} | splits=${splitsStr} | falsePositives=${fpStr} | missedLabels=${missedStr}`;
}

export function renderCombinedSummaryTable(
  summaries: readonly FileSummaryRow[],
  vadEndBudgetMs = VAD_END_BUDGET_MS,
): string[] {
  const headers = [
    "file",
    "segments",
    "splits",
    "falsePositives",
    "missedLabels",
    "max onsetConfirmMs",
    "median vadEndMs",
    "max vadEndMs",
    "vadEndBudget",
  ];

  const rows = summaries.map((s) => [
    s.file,
    String(s.segments),
    s.splits === null ? "n/a" : String(s.splits),
    s.falsePositives === null ? "n/a" : String(s.falsePositives),
    s.missedLabels === null ? "n/a" : String(s.missedLabels),
    s.maxOnsetConfirmMs === null ? "-" : formatNumber(s.maxOnsetConfirmMs),
    s.medianVadEndMs === null ? "-" : formatNumber(s.medianVadEndMs),
    s.maxVadEndMs === null ? "-" : formatNumber(s.maxVadEndMs),
    formatVadEndBudget(s.withinVadEndBudget, vadEndBudgetMs),
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
    String(seg.confirmedAtMs),
    String(seg.endMs),
    String(seg.decidedAtMs),
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
      "confirmedAtMs",
      "endMs",
      "decidedAtMs",
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

export function renderLabelComparisonTable(
  labels: readonly GroundTruthLabel[],
  comparison: LabelComparisonResult<DetectedSegment>,
): string[] {
  const matchByLabelIdx = new Map(comparison.matches.map((m) => [m.label.index, m]));
  const splitCountByLabelIdx = new Map<number, number>();
  for (const s of comparison.splits) {
    splitCountByLabelIdx.set(s.label.index, (splitCountByLabelIdx.get(s.label.index) ?? 0) + 1);
  }

  const headers = [
    "#",
    "startMs",
    "endMs",
    "durationMs",
    "status",
    "seg#",
    "startDeltaMs",
    "endDeltaMs",
    "text",
  ];
  const rows = labels.map((label) => {
    const m = matchByLabelIdx.get(label.index);
    const splitCount = splitCountByLabelIdx.get(label.index) ?? 0;
    if (!m) {
      return [
        String(label.index),
        String(label.startMs),
        String(label.endMs),
        String(label.durationMs),
        "MISSED",
        "-",
        "-",
        "-",
        label.text,
      ];
    }
    const status = splitCount > 0 ? `MATCH (splits=${splitCount})` : "MATCH";
    return [
      String(label.index),
      String(label.startMs),
      String(label.endMs),
      String(label.durationMs),
      status,
      String(m.segment.index),
      formatSigned(m.startDeltaMs),
      formatSigned(m.endDeltaMs),
      label.text,
    ];
  });

  return renderTable(headers, rows);
}
