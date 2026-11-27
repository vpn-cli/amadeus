import { basename, resolve } from "node:path";
import {
  DEFAULT_MODEL_PATH,
  SILERO_MODEL_SHA256,
  SILERO_MODEL_TAG,
  ensureModel,
} from "./download-model.js";
import {
  evaluateSegments,
  formatSummaryLine,
  loadSidecarLabels,
  percentile,
  renderLabelComparisonTable,
  renderPerSegmentErrorTable,
  runVadOnSamples,
  summarizeVadRun,
} from "./eval.js";
import { DEFAULT_SEGMENTER_CONFIG } from "./segmenter.js";
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

function renderBar(prob: number, width = 24): string {
  const filled = Math.round(prob * width);
  return "#".repeat(filled) + ".".repeat(Math.max(0, width - filled));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const explicitLabels =
    !options.autoDetectLabels && options.labelsPath === null
      ? null
      : options.labelsPath !== null
        ? options.labelsPath
        : undefined;
  const { labelsPath, labels } = await loadSidecarLabels(options.wavPath, explicitLabels);

  const modelPath = await ensureModel(DEFAULT_MODEL_PATH);
  const vad = await SileroVad.create(modelPath);
  const wav = await readPcm16Wav(options.wavPath);

  try {
    console.log(`Loaded WAV: ${options.wavPath}`);
    console.log(`Duration: ${wav.durationMs.toFixed(0)} ms (${wav.float32.length} samples)`);
    console.log(`Model: Silero VAD ${SILERO_MODEL_TAG} (sha256: ${SILERO_MODEL_SHA256})`);
    console.log(
      `Model inputs: [${vad.inputNames.join(", ")}] -> outputs: [${vad.outputNames.join(", ")}]`,
    );
    if (labelsPath !== null && labels !== null) {
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

    const comparison = evaluateSegments(segments, labels);
    const summary = summarizeVadRun(basename(options.wavPath), segments, comparison);

    console.log("\n--- Detected Speech Segments ---");
    for (const line of renderPerSegmentErrorTable(segments, comparison)) {
      console.log(line);
    }
    console.log(formatSummaryLine(summary));

    if (labels !== null && comparison !== null) {
      console.log("\n--- Label Comparison ---");
      if (labels.length === 0) {
        console.log("(0 ground-truth labels; any detected segment is a FALSE_POSITIVE)");
      } else {
        for (const line of renderLabelComparisonTable(labels, comparison)) {
          console.log(line);
        }
      }
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
