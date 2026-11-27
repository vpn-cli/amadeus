import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser } from "playwright";
import { SileroRunJsonSchema, type SileroRunJson } from "../../silero-vad/json-schema.js";
import {
  compareSegmentsToLabels,
  parseLabels,
  type GroundTruthLabel,
} from "../../silero-vad/labels.js";
import { findAlignmentLag } from "../src/alignment.js";
import { int16ToFloat32 } from "../src/resampler.js";
import { encodePcm16Wav, parseWav } from "../src/wav.js";
import {
  TARGET_SAMPLE_RATE,
  assert,
  runCaptureSession,
  withFakeMicBrowserPreview,
  type ReportedTrackSettings,
} from "./capture-runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPIKE_ROOT = path.resolve(__dirname, "..");
const SILERO_ROOT = path.resolve(SPIKE_ROOT, "..", "silero-vad");
const SOURCE_WAV_PATH = path.join(SILERO_ROOT, "out", "sample-16k.wav");
const SOURCE_LABELS_PATH = path.join(SILERO_ROOT, "out", "sample-16k.labels.txt");

const OUT_DIR = path.join(SPIKE_ROOT, "out");
const UPSAMPLED_48K_PATH = path.join(OUT_DIR, "smoke-speech-input-48k.wav");

const MIN_WAVEFORM_NCC_OFF = 0.9;
const MIN_ENVELOPE_NCC_ON = 0.8;
const MAX_BOUNDARY_DELTA_MS = 150;

interface ModeReport {
  mode: "on" | "off";
  envelopePeakNcc: number;
  samplePeakNcc: number;
  lagMs: number;
  lagSamples: number;
  reportedSettings: ReportedTrackSettings & {
    ctxSampleRate: string;
    workletChannels: string;
  };
  recordedMs: number;
  analyzedMs: number;
  seqGaps: number;
  segments: number;
  falsePositives: number;
  splits: number;
  missedLabels: number;
  segmentRows: Array<{
    segmentIndex: number;
    labelIndex: number;
    segStartMs: number;
    segEndMs: number;
    labelStartMs: number;
    labelEndMs: number;
    startDeltaMs: number;
    endDeltaMs: number;
    onsetConfirmMs: number;
    vadEndMs: number;
    endReason: string;
  }>;
}

async function ensureInputsExist(): Promise<void> {
  try {
    await access(SOURCE_WAV_PATH);
    await access(SOURCE_LABELS_PATH);
  } catch {
    throw new Error(
      `Missing sample-16k fixture (${SOURCE_WAV_PATH} / ${SOURCE_LABELS_PATH}). Run "pnpm test-wav" in spikes/silero-vad first.`,
    );
  }
}

function buildFakeMicWavWithFfmpeg(inputPath: string, outputPath: string): {
  usedSoxr: boolean;
} {
  const soxrArgs = [
    "-y",
    "-i",
    inputPath,
    "-af",
    "aresample=48000:resampler=soxr,adelay=delays=1000:all=1,apad=pad_dur=2",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    outputPath,
  ];
  const res = spawnSync("ffmpeg", soxrArgs, { encoding: "utf8" });
  if (res.error) {
    throw new Error(`Failed to invoke ffmpeg: ${res.error.message}`);
  }
  if (res.status === 0) {
    return { usedSoxr: true };
  }

  const fallbackArgs = [
    "-y",
    "-i",
    inputPath,
    "-af",
    "aresample=48000,adelay=delays=1000:all=1,apad=pad_dur=2",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    outputPath,
  ];
  const fallback = spawnSync("ffmpeg", fallbackArgs, { encoding: "utf8" });
  if (fallback.error) {
    throw new Error(`Failed to invoke ffmpeg: ${fallback.error.message}`);
  }
  if (fallback.status !== 0) {
    throw new Error(
      `ffmpeg exited with code ${fallback.status}:\n${fallback.stderr || fallback.stdout}`,
    );
  }
  return { usedSoxr: false };
}

async function runSileroJsonSubprocess(wavPath: string): Promise<{
  parsed: SileroRunJson;
  stderr: string;
}> {
  const tsxCli = path.join(SILERO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const runScript = path.join(SILERO_ROOT, "run.ts");

  const { code, stdout, stderr } = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [tsxCli, runScript, wavPath, "--no-labels", "--json"],
      {
        cwd: SILERO_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", rejectPromise);
    child.on("close", (exitCode) => {
      resolvePromise({ code: exitCode, stdout: out, stderr: err });
    });
  });

  if (code !== 0) {
    throw new Error(
      `Silero CLI exited with code ${code}.\nstderr:\n${stderr}\nstdout:\n${stdout}`,
    );
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `Failed to parse stdout from Silero --json as a single JSON object: ${err instanceof Error ? err.message : String(err)}\n--- raw stdout ---\n${stdout}\n--- raw stderr ---\n${stderr}`,
    );
  }

  const parsed = SileroRunJsonSchema.parse(rawJson);
  return { parsed, stderr };
}

function checkFirstPassEndSamples(
  lagSamples: number,
  sourceLength: number,
  recordedLength: number,
): number {
  // Keep only the first complete pass (+1 s trailing silence for Silero vadEnd).
  return Math.min(
    recordedLength,
    lagSamples + sourceLength + TARGET_SAMPLE_RATE,
  );
}

async function runMode(
  browser: Browser,
  previewBaseUrl: string,
  mode: "on" | "off",
  sourceFloat: Float32Array,
  sourceLabels: readonly GroundTruthLabel[],
  fakeMicDurationMs: number,
): Promise<ModeReport> {
  const recordedPath = path.join(OUT_DIR, `smoke-speech-recorded-${mode}-16k.wav`);
  const firstPassPath = path.join(OUT_DIR, `smoke-speech-pass-${mode}-16k.wav`);

  // Record >= 2 × source duration + 1 s to guarantee at least one full pass
  // regardless of Chrome's arbitrary start offset within the looped fake device.
  const recordTargetMs = 2 * fakeMicDurationMs + 1000;
  const minFrames = Math.ceil(recordTargetMs / 20);

  const capture = await runCaptureSession({
    browser,
    url: `${previewBaseUrl}?processing=${mode}`,
    outputWavPath: recordedPath,
    stopCondition: {
      kind: "minFrames",
      minFrames,
      timeoutMs: Math.ceil(recordTargetMs) + 15000,
    },
    label: mode,
  });

  const recordedFloat = int16ToFloat32(capture.pcm16);

  // Search lags in [0, sourceLength) to find the first COMPLETE pass.
  // Chrome's fake device loops from an arbitrary offset, so there is no
  // "leading silence" assumption or fixed-ms window.
  const alignment = findAlignmentLag(sourceFloat, recordedFloat, {
    sampleRate: TARGET_SAMPLE_RATE,
    maxLagSamples: sourceFloat.length,
  });
  const lagMs = (alignment.lagSamples / TARGET_SAMPLE_RATE) * 1000;

  // Mode-dependent NCC gates:
  //   processing=off: waveform peak NCC >= 0.9  (chain preserves waveform)
  //   processing=on:  10 ms RMS-envelope NCC >= 0.8; waveform NCC printed, not gated
  if (mode === "off") {
    assert(
      alignment.peakNcc >= MIN_WAVEFORM_NCC_OFF,
      `[${mode}] waveform NCC ${alignment.peakNcc.toFixed(4)} < ${MIN_WAVEFORM_NCC_OFF}`,
    );
  } else {
    assert(
      alignment.envelopePeakNcc >= MIN_ENVELOPE_NCC_ON,
      `[${mode}] 10 ms RMS-envelope NCC ${alignment.envelopePeakNcc.toFixed(4)} < ${MIN_ENVELOPE_NCC_ON} (waveform NCC=${alignment.peakNcc.toFixed(4)}, printed only)`,
    );
  }

  // Extract first complete pass (+1 s trailing silence for Silero vadEnd).
  const firstPassEnd = checkFirstPassEndSamples(
    alignment.lagSamples,
    sourceFloat.length,
    capture.pcm16.length,
  );
  const firstPassPcm16 = capture.pcm16.subarray(0, firstPassEnd);
  await writeFile(firstPassPath, encodePcm16Wav(firstPassPcm16, TARGET_SAMPLE_RATE, 1));

  const { parsed: silero } = await runSileroJsonSubprocess(firstPassPath);

  const shiftedLabels: GroundTruthLabel[] = sourceLabels.map((lbl) => ({
    ...lbl,
    startMs: Math.round(lbl.startMs + lagMs),
    endMs: Math.round(lbl.endMs + lagMs),
  }));

  const comparison = compareSegmentsToLabels(silero.segments, shiftedLabels);

  assert(
    silero.segments.length === 2,
    `[${mode}] Expected 2 segments, got ${silero.segments.length}`,
  );
  for (const seg of silero.segments) {
    assert(
      seg.endReason === "silence",
      `[${mode}] Expected segment #${seg.index} endReason === "silence", got "${seg.endReason}"`,
    );
  }
  assert(
    comparison.falsePositives.length === 0,
    `[${mode}] Expected 0 false positives, got ${comparison.falsePositives.length}`,
  );
  assert(
    comparison.splits.length === 0,
    `[${mode}] Expected 0 splits, got ${comparison.splits.length}`,
  );
  assert(
    comparison.missedLabels.length === 0,
    `[${mode}] Expected 0 missed labels, got ${comparison.missedLabels.length}`,
  );
  assert(
    comparison.matches.length === 2,
    `[${mode}] Expected 2 matched labels, got ${comparison.matches.length}`,
  );

  const segmentRows = comparison.matches.map((m) => {
    assert(
      Math.abs(m.startDeltaMs) <= MAX_BOUNDARY_DELTA_MS,
      `[${mode}] Segment #${m.segment.index} |startDeltaMs|=${Math.abs(m.startDeltaMs)} > ${MAX_BOUNDARY_DELTA_MS} ms`,
    );
    assert(
      Math.abs(m.endDeltaMs) <= MAX_BOUNDARY_DELTA_MS,
      `[${mode}] Segment #${m.segment.index} |endDeltaMs|=${Math.abs(m.endDeltaMs)} > ${MAX_BOUNDARY_DELTA_MS} ms`,
    );
    return {
      segmentIndex: m.segment.index,
      labelIndex: m.label.index,
      segStartMs: m.segment.startMs,
      segEndMs: m.segment.endMs,
      labelStartMs: m.label.startMs,
      labelEndMs: m.label.endMs,
      startDeltaMs: m.startDeltaMs,
      endDeltaMs: m.endDeltaMs,
      onsetConfirmMs: m.segment.onsetConfirmMs,
      vadEndMs: m.segment.vadEndMs,
      endReason: m.segment.endReason,
    };
  });

  return {
    mode,
    envelopePeakNcc: alignment.envelopePeakNcc,
    samplePeakNcc: alignment.peakNcc,
    lagMs,
    lagSamples: alignment.lagSamples,
    reportedSettings: {
      ...capture.trackSettings,
      ctxSampleRate: capture.ctxSampleRate,
      workletChannels: capture.workletChannels,
    },
    recordedMs: capture.parsed.durationMs,
    analyzedMs: (firstPassPcm16.length / TARGET_SAMPLE_RATE) * 1000,
    seqGaps: capture.seqGaps,
    segments: silero.segments.length,
    falsePositives: comparison.falsePositives.length,
    splits: comparison.splits.length,
    missedLabels: comparison.missedLabels.length,
    segmentRows,
  };
}

function formatSignedMs(n: number): string {
  return `${n >= 0 ? "+" : ""}${n}`;
}

function printModeTable(report: ModeReport): void {
  const gateLabel =
    report.mode === "off"
      ? `waveformNcc=${report.samplePeakNcc.toFixed(4)} (>= ${MIN_WAVEFORM_NCC_OFF}, GATED)`
      : `envelopeNcc=${report.envelopePeakNcc.toFixed(4)} (>= ${MIN_ENVELOPE_NCC_ON}, GATED) | waveformNcc=${report.samplePeakNcc.toFixed(4)} (printed only)`;
  console.log(`\n--- Mode: processing=${report.mode} ---`);
  console.log(
    `Metrics:        ${gateLabel} | lag=${report.lagMs.toFixed(2)} ms (${report.lagSamples} samples) | recorded=${report.recordedMs.toFixed(0)} ms | analyzed=${report.analyzedMs.toFixed(0)} ms | seqGaps=${report.seqGaps}`,
  );
  console.log(
    `Track settings: echoCancellation=${report.reportedSettings.echoCancellation} | noiseSuppression=${report.reportedSettings.noiseSuppression} | autoGainControl=${report.reportedSettings.autoGainControl} | channelCount=${report.reportedSettings.channelCount} | sampleRate=${report.reportedSettings.sampleRate} | audioCtx=${report.reportedSettings.ctxSampleRate} | workletCh=${report.reportedSettings.workletChannels}`,
  );
  console.log(
    `VAD summary:    segments=${report.segments} | FP=${report.falsePositives} | splits=${report.splits} | missed=${report.missedLabels}`,
  );
  console.log("seg# | label# | seg [start, end] ms | shifted label [start, end] ms | startDeltaMs | endDeltaMs | onsetMs | vadEndMs | reason");
  console.log("-----+--------+---------------------+-------------------------------+--------------+------------+---------+----------+--------");
  for (const r of report.segmentRows) {
    const segSpan = `[${r.segStartMs}, ${r.segEndMs}]`.padEnd(19);
    const lblSpan = `[${r.labelStartMs}, ${r.labelEndMs}]`.padEnd(29);
    console.log(
      `${String(r.segmentIndex).padEnd(4)} | ${String(r.labelIndex).padEnd(6)} | ${segSpan} | ${lblSpan} | ${formatSignedMs(r.startDeltaMs).padEnd(12)} | ${formatSignedMs(r.endDeltaMs).padEnd(10)} | ${String(r.onsetConfirmMs).padEnd(7)} | ${String(r.vadEndMs).padEnd(8)} | ${r.endReason}`,
    );
  }
}

async function main(): Promise<void> {
  await ensureInputsExist();
  await mkdir(OUT_DIR, { recursive: true });

  const sourceBytes = new Uint8Array(await readFile(SOURCE_WAV_PATH));
  const parsedSource = parseWav(sourceBytes);
  assert(
    parsedSource.sampleRate === TARGET_SAMPLE_RATE &&
      parsedSource.channels === 1 &&
      parsedSource.bitsPerSample === 16 &&
      parsedSource.samples instanceof Int16Array,
    `Expected 16 kHz mono PCM16 source WAV, got ${parsedSource.sampleRate} Hz, ${parsedSource.channels} ch, ${parsedSource.bitsPerSample}-bit`,
  );
  const sourceFloat = int16ToFloat32(parsedSource.samples);
  const sourceLabels = parseLabels(await readFile(SOURCE_LABELS_PATH, "utf8"));

  const { usedSoxr } = buildFakeMicWavWithFfmpeg(SOURCE_WAV_PATH, UPSAMPLED_48K_PATH);
  const fakeMicWav = parseWav(new Uint8Array(await readFile(UPSAMPLED_48K_PATH)));

  await withFakeMicBrowserPreview(
    { spikeRoot: SPIKE_ROOT, fakeMicWavPath: UPSAMPLED_48K_PATH },
    async ({ browser, previewUrl }) => {
      const reportOn = await runMode(
        browser,
        previewUrl,
        "on",
        sourceFloat,
        sourceLabels,
        fakeMicWav.durationMs,
      );
      const reportOff = await runMode(
        browser,
        previewUrl,
        "off",
        sourceFloat,
        sourceLabels,
        fakeMicWav.durationMs,
      );

      console.log("=== Browser Capture + Silero VAD End-to-End Speech Smoke Report ===");
      console.log("Status:       PASS");
      console.log(
        `Source WAV:   ${SOURCE_WAV_PATH} (${parsedSource.durationMs.toFixed(1)} ms, ${sourceLabels.length} labels)`,
      );
      console.log(
        `Fake-mic WAV: ${UPSAMPLED_48K_PATH} (${fakeMicWav.durationMs.toFixed(1)} ms @ ${fakeMicWav.sampleRate} Hz, ffmpeg resampler=${usedSoxr ? "soxr" : "default"})`,
      );
      printModeTable(reportOn);
      printModeTable(reportOff);
    },
  );
}

main().catch((err) => {
  console.error("=== Browser Capture + Silero VAD End-to-End Speech Smoke Test Report ===");
  console.error("Status: FAIL");
  console.error(err);
  process.exitCode = 1;
});
