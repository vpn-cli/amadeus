import { access, readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  DEFAULT_MODEL_PATH,
  SILERO_MODEL_SHA256,
  SILERO_MODEL_TAG,
  ensureModel,
} from "./download-model.js";
import {
  type GroundTruthLabel,
  type LabelComparisonResult,
  compareSegmentsToLabels,
  parseLabels,
} from "./labels.js";
import {
  type DetectedSegment,
  type SegmenterEvent,
  VadSegmenter,
  collectSegmentsFromEvents,
} from "./segmenter.js";
import {
  SILERO_SAMPLE_RATE,
  SILERO_WINDOW_SAMPLES,
  SileroVad,
} from "./silero.js";
import { readPcm16Wav } from "./wav.js";

const FRAME_SAMPLES_20MS = 320; // Simulated WebSocket client frame size (20 ms @ 16 kHz)

interface CliOptions {
  wavPath: string;
  labelsPath: string | null;
  autoDetectLabels: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let wavArg: string | null = null;
  let labelsArg: string | null = null;
  let autoDetectLabels = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-labels") {
      autoDetectLabels = false;
    } else if (arg === "--labels") {
      const next = argv[++i];
      if (!next) {
        throw new Error("--labels requires a file path");
      }
      labelsArg = next;
    } else if (arg && !arg.startsWith("-")) {
      if (wavArg === null) {
        wavArg = arg;
      } else if (labelsArg === null) {
        labelsArg = arg;
      } else {
        throw new Error(`Unexpected extra argument: ${arg}`);
      }
    } else if (arg) {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  const wavPath = wavArg
    ? resolve(process.cwd(), wavArg)
    : resolve(import.meta.dirname, "out", "sample-16k.wav");

  const labelsPath = labelsArg ? resolve(process.cwd(), labelsArg) : null;
  return { wavPath, labelsPath, autoDetectLabels };
}

async function resolveLabelsPath(options: CliOptions): Promise<string | null> {
  if (!options.autoDetectLabels && options.labelsPath === null) {
    return null;
  }
  if (options.labelsPath !== null) {
    return options.labelsPath;
  }

  const ext = extname(options.wavPath);
  const base = ext ? options.wavPath.slice(0, -ext.length) : options.wavPath;
  const sidecar = join(dirname(options.wavPath), `${base.split(/[\\/]/).pop() ?? "sample"}.labels.txt`);
  try {
    await access(sidecar);
    return sidecar;
  } catch {
    return null;
  }
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function formatSigned(n: number): string {
  const s = formatNumber(n);
  return n > 0 ? `+${s}` : s;
}

function renderBar(prob: number, width = 24): string {
  const filled = Math.round(prob * width);
  return "#".repeat(filled) + ".".repeat(Math.max(0, width - filled));
}

function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const formatRow = (cells: readonly string[]) =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");
  return [formatRow(headers), separator, ...rows.map(formatRow)];
}

function printSegmentsTable(
  segments: readonly DetectedSegment[],
  comparison: LabelComparisonResult<DetectedSegment> | null,
): void {
  console.log("\n--- Detected Speech Segments ---");
  if (segments.length === 0) {
    console.log("(no speech segments detected)");
  } else {
    const headers = [
      "#",
      "startMs",
      "endMs",
      "durationMs",
      "onsetMs",
      "onsetConfirmMs",
      "vadEndMs",
      "reason",
      ...(comparison ? ["match"] : []),
    ];

    const rows = segments.map((seg, i) => {
      const base = [
        String(seg.index),
        String(seg.startMs),
        String(seg.endMs),
        String(seg.durationMs),
        String(seg.onsetMs),
        String(seg.onsetConfirmMs),
        String(seg.vadEndMs),
        seg.endReason,
      ];
      if (!comparison) {
        return base;
      }
      const ann = comparison.annotations[i];
      let tag = "FALSE_POSITIVE";
      if (ann?.kind === "match") {
        tag = `label #${ann.labelIndices.join(",")}`;
      } else if (ann?.kind === "split") {
        tag = `SPLIT (+${ann.splitGapMs ?? 0}ms -> #${ann.labelIndices.join(",")})`;
      }
      return [...base, tag];
    });

    for (const line of renderTable(headers, rows)) {
      console.log(line);
    }
  }

  const maxOnsetConfirmMs =
    segments.length === 0 ? 0 : Math.max(...segments.map((s) => s.onsetConfirmMs));
  const vadEndValues = segments.map((s) => s.vadEndMs);
  const medianVadEndMs = median(vadEndValues);
  const maxVadEndMs = vadEndValues.length === 0 ? 0 : Math.max(...vadEndValues);

  const splitsStr = comparison ? String(comparison.splits.length) : "n/a";
  const fpStr = comparison ? String(comparison.falsePositives.length) : "n/a";
  const missedStr = comparison ? String(comparison.missedLabels.length) : "n/a";

  console.log(
    `Summary: segments=${segments.length} | max onsetConfirmMs=${maxOnsetConfirmMs} ms | median vadEndMs=${formatNumber(medianVadEndMs)} ms | max vadEndMs=${maxVadEndMs} ms | splits=${splitsStr} | falsePositives=${fpStr} | missedLabels=${missedStr}`,
  );
}

function printLabelComparison(
  labels: readonly GroundTruthLabel[],
  comparison: LabelComparisonResult<DetectedSegment>,
): void {
  console.log("\n--- Label Comparison ---");
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

  for (const line of renderTable(headers, rows)) {
    console.log(line);
  }

  if (comparison.splits.length > 0) {
    console.log("\n--- Splits ---");
    const splitHeaders = ["label#", "prevSeg#", "splitSeg#", "gapMs", "overlapMs"];
    const splitRows = comparison.splits.map((s) => [
      String(s.label.index),
      String(s.previousSegment.index),
      String(s.segment.index),
      String(s.gapMs),
      String(s.overlapMs),
    ]);
    for (const line of renderTable(splitHeaders, splitRows)) {
      console.log(line);
    }
  }

  if (comparison.falsePositives.length > 0) {
    console.log("\n--- False Positives ---");
    const fpHeaders = ["seg#", "startMs", "endMs", "durationMs"];
    const fpRows = comparison.falsePositives.map((fp) => [
      String(fp.index),
      String(fp.startMs),
      String(fp.endMs),
      String(fp.durationMs),
    ]);
    for (const line of renderTable(fpHeaders, fpRows)) {
      console.log(line);
    }
  }

  if (comparison.missedLabels.length > 0) {
    console.log("\n--- Missed Labels ---");
    const missedHeaders = ["label#", "startMs", "endMs", "durationMs", "text"];
    const missedRows = comparison.missedLabels.map((ml) => [
      String(ml.index),
      String(ml.startMs),
      String(ml.endMs),
      String(ml.durationMs),
      ml.text,
    ]);
    for (const line of renderTable(missedHeaders, missedRows)) {
      console.log(line);
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const labelsPath = await resolveLabelsPath(options);

  const modelPath = await ensureModel(DEFAULT_MODEL_PATH);
  const vad = await SileroVad.create(modelPath);
  const wav = await readPcm16Wav(options.wavPath);
  const labels = labelsPath ? parseLabels(await readFile(labelsPath, "utf8")) : null;

  console.log(`Loaded WAV: ${options.wavPath}`);
  console.log(`Duration: ${wav.durationMs.toFixed(0)} ms (${wav.float32.length} samples)`);
  console.log(`Model: Silero VAD ${SILERO_MODEL_TAG} (sha256: ${SILERO_MODEL_SHA256})`);
  console.log(
    `Model inputs: [${vad.inputNames.join(", ")}] -> outputs: [${vad.outputNames.join(", ")}]`,
  );
  if (labelsPath && labels) {
    console.log(`Labels: ${labelsPath} (${labels.length} labels)`);
  }
  console.log("");

  // Re-chunk incoming 20ms (320-sample) frames into 32ms (512-sample) Silero windows
  let pending = new Float32Array(0);
  const inferenceTimesMs: number[] = [];
  const windowMs = (SILERO_WINDOW_SAMPLES / SILERO_SAMPLE_RATE) * 1000;
  const segmenter = new VadSegmenter();
  const events: SegmenterEvent[] = [];
  let windowIdx = 0;

  for (let offset = 0; offset < wav.float32.length; offset += FRAME_SAMPLES_20MS) {
    const frame = wav.float32.subarray(
      offset,
      Math.min(offset + FRAME_SAMPLES_20MS, wav.float32.length),
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

      const currentMs = windowIdx * windowMs;
      if (
        windowIdx % 4 === 0 ||
        prob >= segmenter.config.onsetThreshold ||
        stepEvents.length > 0
      ) {
        const tag = segmenter.state.toUpperCase().padEnd(8);
        const eventNote =
          stepEvents.length > 0
            ? ` | ${stepEvents.map((e) => `${e.type}(${e.reason})`).join(", ")}`
            : "";
        console.log(
          `${(currentMs / 1000).toFixed(2).padStart(6)}s | ${prob.toFixed(3)} | ${renderBar(prob)} | ${tag}${eventNote}`,
        );
      }

      windowIdx++;
    }
  }

  events.push(...segmenter.flush());
  const segments = collectSegmentsFromEvents(events);
  const comparison = labels ? compareSegmentsToLabels(segments, labels) : null;

  printSegmentsTable(segments, comparison);
  if (labels && comparison) {
    printLabelComparison(labels, comparison);
  }

  const sorted = [...inferenceTimesMs].sort((a, b) => a - b);
  const avg = sorted.reduce((acc, v) => acc + v, 0) / Math.max(1, sorted.length);

  console.log("\n--- Silero ONNX Inference Latency (per 32ms window) ---");
  console.log(
    `Windows: ${sorted.length} | avg=${avg.toFixed(3)} ms | p50=${percentile(sorted, 50).toFixed(3)} ms | p95=${percentile(sorted, 95).toFixed(3)} ms | max=${(sorted[sorted.length - 1] ?? 0).toFixed(3)} ms`,
  );

  await vad.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
