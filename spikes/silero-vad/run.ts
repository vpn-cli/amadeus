import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
import {
  SileroModelJsonSchema,
  SileroParamsJsonSchema,
  SileroRunJsonSchema,
  SileroSegmentJsonSchema,
  type SileroRunJson,
} from "./json-schema.js";
import { DEFAULT_SEGMENTER_CONFIG } from "./segmenter.js";
import { SileroVad } from "./silero.js";
import { readPcm16Wav } from "./wav.js";

export {
  SileroModelJsonSchema,
  SileroParamsJsonSchema,
  SileroRunJsonSchema,
  SileroSegmentJsonSchema,
  type SileroRunJson,
};

interface CliOptions {
  wavPath: string;
  labelsPath: string | null;
  autoDetectLabels: boolean;
  json: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let wavArg: string | null = null;
  let labelsArg: string | null = null;
  let autoDetectLabels = true;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--no-labels") {
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
  return { wavPath, labelsPath, autoDetectLabels, json };
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

  const diag = options.json ? console.error : console.log;
  const modelPath = await ensureModel(DEFAULT_MODEL_PATH, { log: diag });
  const vad = await SileroVad.create(modelPath);
  const wav = await readPcm16Wav(options.wavPath);

  try {
    const { labelsPath, labels } = options.json
      ? { labelsPath: null, labels: null }
      : await loadSidecarLabels(options.wavPath, explicitLabels);

    if (!options.json) {
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
    }

    const { segments, inferenceTimesMs } = await runVadOnSamples(vad, wav.float32, {
      onWindow: options.json
        ? undefined
        : ({ windowIdx, currentMs, prob, state, stepEvents }) => {
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

    if (options.json) {
      const payload: SileroRunJson = SileroRunJsonSchema.parse({
        model: {
          tag: SILERO_MODEL_TAG,
          sha256: SILERO_MODEL_SHA256,
        },
        params: {
          windowSamples: DEFAULT_SEGMENTER_CONFIG.windowSamples,
          onsetThreshold: DEFAULT_SEGMENTER_CONFIG.onsetThreshold,
          offsetThreshold: DEFAULT_SEGMENTER_CONFIG.offsetThreshold,
          minSpeechMs: DEFAULT_SEGMENTER_CONFIG.minSpeechMs,
          endSilenceMs: DEFAULT_SEGMENTER_CONFIG.endSilenceMs,
          pendingGapMs: DEFAULT_SEGMENTER_CONFIG.pendingGapMs,
          maxSpeechMs: DEFAULT_SEGMENTER_CONFIG.maxSpeechMs,
        },
        sampleRate: wav.sampleRate,
        durationMs: wav.durationMs,
        segments,
      });
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    }

    const comparison = evaluateSegments(segments, labels);
    const summary = summarizeVadRun(basename(options.wavPath), segments, comparison);
    const warmupMs = inferenceTimesMs[0] ?? 0;
    const steadySorted = inferenceTimesMs.slice(1).sort((a, b) => a - b);
    const avg =
      steadySorted.reduce((acc, v) => acc + v, 0) / Math.max(1, steadySorted.length);

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

    console.log("\n--- Silero ONNX Inference Latency (per 32ms window) ---");
    console.log(
      `Warm-up (first): ${warmupMs.toFixed(3)} ms | Rest (${steadySorted.length} windows): avg=${avg.toFixed(3)} ms | p50=${percentile(steadySorted, 50).toFixed(3)} ms | p95=${percentile(steadySorted, 95).toFixed(3)} ms | max=${(steadySorted[steadySorted.length - 1] ?? 0).toFixed(3)} ms`,
    );
  } finally {
    await vad.dispose();
  }
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
