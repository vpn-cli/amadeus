import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DEFAULT_MODEL_PATH,
  SILERO_MODEL_SHA256,
  SILERO_MODEL_TAG,
  ensureModel,
} from "./download-model.js";
import {
  type FileSummaryRow,
  evaluateSegments,
  loadSidecarLabels,
  renderCombinedSummaryTable,
  renderPerSegmentErrorTable,
  runVadOnSamples,
  summarizeVadRun,
} from "./eval.js";
import type { GroundTruthLabel, LabelComparisonResult } from "./labels.js";
import type { DetectedSegment } from "./segmenter.js";
import { SileroVad } from "./silero.js";
import { readPcm16Wav } from "./wav.js";

const DEFAULT_FIXTURES_DIR = resolve(import.meta.dirname, "..", "..", "fixtures", "audio");

interface FileEvalResult {
  file: string;
  durationMs: number;
  labels: GroundTruthLabel[] | null;
  labelsPath: string | null;
  segments: DetectedSegment[];
  comparison: LabelComparisonResult<DetectedSegment> | null;
  summary: FileSummaryRow;
}

function parseFixturesDir(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") {
      const next = argv[++i];
      if (!next) {
        throw new Error("--dir requires a directory path");
      }
      return resolve(process.cwd(), next);
    }
    if (arg && !arg.startsWith("-")) {
      return resolve(process.cwd(), arg);
    }
    if (arg) {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return DEFAULT_FIXTURES_DIR;
}

async function listWavFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".wav"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const fixturesDir = parseFixturesDir(process.argv.slice(2));
  const wavFiles = await listWavFiles(fixturesDir);

  if (wavFiles.length === 0) {
    console.log(`No .wav files found in ${fixturesDir}`);
    console.log(
      "Record 16 kHz mono PCM16 WAV clips (see fixtures/audio/README.md) and re-run `pnpm vad:all`.",
    );
    return;
  }

  const modelPath = await ensureModel(DEFAULT_MODEL_PATH);
  const vad = await SileroVad.create(modelPath);
  const results: FileEvalResult[] = [];

  try {
    for (const file of wavFiles) {
      const wavPath = join(fixturesDir, file);
      const wav = await readPcm16Wav(wavPath);
      const { labelsPath, labels } = await loadSidecarLabels(wavPath);

      const { segments } = await runVadOnSamples(vad, wav.float32);
      const comparison = evaluateSegments(segments, labels);
      const summary = summarizeVadRun(file, segments, comparison);

      results.push({
        file,
        durationMs: wav.durationMs,
        labels,
        labelsPath,
        segments,
        comparison,
        summary,
      });
    }
  } finally {
    await vad.dispose();
  }

  console.log(`Model: Silero VAD ${SILERO_MODEL_TAG} (sha256: ${SILERO_MODEL_SHA256})`);
  console.log(`Fixtures: ${fixturesDir} (${results.length} WAV file${results.length === 1 ? "" : "s"})`);
  console.log("");
  console.log("=== Combined Summary ===");
  for (const line of renderCombinedSummaryTable(results.map((r) => r.summary))) {
    console.log(line);
  }

  for (const res of results) {
    const labelMeta = res.labels !== null ? `${res.labels.length} labels` : "missing labels file";
    console.log(`\n=== ${res.file} (${res.durationMs.toFixed(0)} ms, ${labelMeta}) ===`);
    for (const line of renderPerSegmentErrorTable(res.segments, res.comparison)) {
      console.log(line);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
