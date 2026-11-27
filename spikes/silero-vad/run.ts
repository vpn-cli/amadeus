import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DEFAULT_MODEL_PATH,
  SILERO_MODEL_SHA256,
  SILERO_MODEL_TAG,
  ensureModel,
} from "./download-model.js";
import {
  formatNumber,
  formatSigned,
  median,
  percentile,
  renderTable,
  resolveSidecarLabelsPath,
  runVadOnSamples,
} from "./eval.js";
import {
  type GroundTruthLabel,
  type LabelComparisonResult,
  compareSegmentsToLabels,
  parseLabels,
} from "./labels.js";
import {
  DEFAULT_SEGMENTER_CONFIG,
  type DetectedSegment,
} from "./segmenter.js";
import { SileroVad } from "./silero.js";
import { readPcm16Wav } from "./wav.js";

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
  return resolveSidecarLabelsPath(options.wavPath);
}

function renderBar(prob: number, width = 24): string {
  const filled = Math.round(prob * width);
  return "#".repeat(filled) + ".".repeat(Math.max(0, width - filled));
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

  try {
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

    const { segments, inferenceTimesMs } = await runVadOnSamples(vad, wav.float32, {
      onWindow: ({ windowIdx, currentMs, prob, state, stepEvents }) => {
        if (
          windowIdx % 4 === 0 ||
          prob >= DEFAULT_SEGMENTER_CONFIG.onsetThreshold ||
          stepEvents.length > 0
        ) {
          const tag = state.toUpperCase().padEnd(8);
          const eventNote =
            stepEvents.length > 0
              ? ` | ${stepEvents.map((e) => `${e.type}(${e.reason})`).join(", ")}`
              : "";
          console.log(
            `${(currentMs / 1000).toFixed(2).padStart(6)}s | ${prob.toFixed(3)} | ${renderBar(prob)} | ${tag}${eventNote}`,
          );
        }
      },
    });

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
  } finally {
    await vad.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
