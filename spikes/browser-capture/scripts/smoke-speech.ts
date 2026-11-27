import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { SileroRunJsonSchema, type SileroRunJson } from "../../silero-vad/json-schema.js";
import {
  compareSegmentsToLabels,
  parseLabels,
  type GroundTruthLabel,
} from "../../silero-vad/labels.js";
import { findAlignmentLag } from "../src/alignment.js";
import { int16ToFloat32 } from "../src/resampler.js";
import { encodePcm16Wav, parseWav } from "../src/wav.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPIKE_ROOT = path.resolve(__dirname, "..");
const SILERO_ROOT = path.resolve(SPIKE_ROOT, "..", "silero-vad");
const SOURCE_WAV_PATH = path.join(SILERO_ROOT, "out", "sample-16k.wav");
const SOURCE_LABELS_PATH = path.join(SILERO_ROOT, "out", "sample-16k.labels.txt");

const OUT_DIR = path.join(SPIKE_ROOT, "out");
const UPSAMPLED_48K_PATH = path.join(OUT_DIR, "smoke-speech-input-48k.wav");

const PREVIEW_PORT = 4173;
const PREVIEW_BASE_URL = `http://127.0.0.1:${PREVIEW_PORT}/`;
const MAX_ALIGNMENT_LAG_MS = 3000;
const MIN_ENVELOPE_PEAK_NCC = 0.6;
const MAX_BOUNDARY_DELTA_MS = 150;
const TARGET_SAMPLE_RATE = 16000;

interface ModeReport {
  mode: "on" | "off";
  envelopePeakNcc: number;
  samplePeakNcc: number;
  lagMs: number;
  lagSamples: number;
  noloopHonored: boolean;
  reportedSettings: {
    echoCancellation: string;
    noiseSuppression: string;
    autoGainControl: string;
    channelCount: string;
    sampleRate: string;
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
  }>;
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
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

function runViteBuild(): void {
  const viteBin = path.join(SPIKE_ROOT, "node_modules", "vite", "bin", "vite.js");
  const res = spawnSync(process.execPath, [viteBin, "build"], {
    cwd: SPIKE_ROOT,
    encoding: "utf8",
  });
  if (res.error) {
    throw new Error(`Failed to run vite build: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`vite build failed:\n${res.stderr || res.stdout}`);
  }
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return;
      }
    } catch {
      // Server not listening yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for preview server at ${url}`);
}

function startPreviewServer(): ChildProcess {
  const viteBin = path.join(SPIKE_ROOT, "node_modules", "vite", "bin", "vite.js");
  return spawn(
    process.execPath,
    [viteBin, "preview", "--host", "127.0.0.1", "--port", String(PREVIEW_PORT), "--strictPort"],
    {
      cwd: SPIKE_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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

async function launchFakeMicBrowser(useNoloopSuffix: boolean): Promise<Browser> {
  const captureArg = useNoloopSuffix
    ? `--use-file-for-fake-audio-capture=${UPSAMPLED_48K_PATH}%noloop`
    : `--use-file-for-fake-audio-capture=${UPSAMPLED_48K_PATH}`;

  return chromium.launch({
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      captureArg,
    ],
  });
}

function checkFirstPassSilenceTail(
  recorded: Float32Array,
  fakeMicDurationMs: number,
): boolean {
  const tailStart = Math.round(((fakeMicDurationMs + 250) / 1000) * TARGET_SAMPLE_RATE);
  if (tailStart >= recorded.length) {
    return true;
  }
  let peak = 0;
  for (let i = tailStart; i < recorded.length; i++) {
    peak = Math.max(peak, Math.abs(recorded[i] ?? 0));
  }
  return peak < 0.01;
}

async function runMode(
  browser: Browser,
  mode: "on" | "off",
  sourceFloat: Float32Array,
  sourceLabels: readonly GroundTruthLabel[],
  fakeMicDurationMs: number,
): Promise<ModeReport> {
  const recordedPath = path.join(OUT_DIR, `smoke-speech-recorded-${mode}-16k.wav`);
  const firstPassPath = path.join(OUT_DIR, `smoke-speech-pass-${mode}-16k.wav`);

  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const browserErrors: string[] = [];

  page.on("pageerror", (err) => {
    browserErrors.push(`pageerror: ${err.message}`);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      browserErrors.push(`console.error: ${msg.text()}`);
    }
  });

  try {
    const url = `${PREVIEW_BASE_URL}?processing=${mode}`;
    await page.goto(url, { waitUntil: "networkidle" });
    await page.click("#start-btn");
    await page.waitForSelector('#status-text[data-state="recording"]', {
      timeout: 10000,
    });

    const recordTargetMs = fakeMicDurationMs + 1000;
    const minFrames = Math.ceil(recordTargetMs / 20);
    await page.waitForFunction(
      (targetFrames: number) =>
        Number(document.getElementById("received-frames")?.textContent ?? "0") >= targetFrames,
      minFrames,
      { timeout: Math.ceil(recordTargetMs) + 15000 },
    );

    await page.click("#stop-btn");
    await page.waitForSelector('#status-text[data-state="stopped"]', {
      timeout: 10000,
    });

    const ctxSampleRate = (await page.textContent("#ctx-sample-rate"))?.trim() ?? "";
    const workletChannels = (await page.textContent("#input-channels"))?.trim() ?? "";
    const droppedFramesText = (await page.textContent("#dropped-frames"))?.trim() ?? "-1";
    const echoCancellation =
      (await page.textContent("#setting-echo-cancellation"))?.trim() ?? "";
    const noiseSuppression =
      (await page.textContent("#setting-noise-suppression"))?.trim() ?? "";
    const autoGainControl =
      (await page.textContent("#setting-auto-gain-control"))?.trim() ?? "";
    const channelCount =
      (await page.textContent("#setting-channel-count"))?.trim() ?? "";
    const sampleRate = (await page.textContent("#setting-sample-rate"))?.trim() ?? "";

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#download-wav-btn"),
    ]);
    await download.saveAs(recordedPath);

    const recordedBytes = new Uint8Array(await readFile(recordedPath));
    const parsedRecorded = parseWav(recordedBytes);
    const seqGaps = Number(droppedFramesText);

    assert(
      browserErrors.length === 0,
      `[${mode}] Browser errors observed:\n${browserErrors.join("\n")}`,
    );
    assert(
      parsedRecorded.sampleRate === TARGET_SAMPLE_RATE,
      `[${mode}] Expected ${TARGET_SAMPLE_RATE} Hz, got ${parsedRecorded.sampleRate}`,
    );
    assert(
      parsedRecorded.channels === 1,
      `[${mode}] Expected 1 channel, got ${parsedRecorded.channels}`,
    );
    assert(
      parsedRecorded.bitsPerSample === 16,
      `[${mode}] Expected 16-bit, got ${parsedRecorded.bitsPerSample}`,
    );
    assert(
      parsedRecorded.sampleCount % 320 === 0,
      `[${mode}] Expected whole 320-sample frames, got ${parsedRecorded.sampleCount}`,
    );
    assert(seqGaps === 0, `[${mode}] Expected 0 seq gaps, got ${seqGaps}`);
    assert(
      parsedRecorded.samples instanceof Int16Array,
      `[${mode}] Expected Int16Array samples`,
    );

    const recordedPcm16 = parsedRecorded.samples as Int16Array;
    const recordedFloat = int16ToFloat32(recordedPcm16);
    const noloopHonored = checkFirstPassSilenceTail(recordedFloat, fakeMicDurationMs);

    const maxLagSamples = Math.round((MAX_ALIGNMENT_LAG_MS / 1000) * TARGET_SAMPLE_RATE) + 1;
    const alignment = findAlignmentLag(sourceFloat, recordedFloat, {
      sampleRate: TARGET_SAMPLE_RATE,
      maxLagSamples,
    });
    const lagMs = (alignment.lagSamples / TARGET_SAMPLE_RATE) * 1000;

    assert(
      alignment.envelopePeakNcc >= MIN_ENVELOPE_PEAK_NCC,
      `[${mode}] 10 ms RMS-envelope correlation peak ${alignment.envelopePeakNcc.toFixed(4)} < ${MIN_ENVELOPE_PEAK_NCC} (samplePeakNcc=${alignment.peakNcc.toFixed(4)})`,
    );

    // Keep only the first pass (+1 s of the 2 s apad trailing silence) so even if Chrome
    // ignored %noloop, Silero sees >= 576 ms trailing silence and never sees a second pass.
    const firstPassEndSamples = Math.min(
      recordedPcm16.length,
      alignment.lagSamples + sourceFloat.length + TARGET_SAMPLE_RATE,
    );
    const firstPassPcm16 = recordedPcm16.subarray(0, firstPassEndSamples);
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
      };
    });

    return {
      mode,
      envelopePeakNcc: alignment.envelopePeakNcc,
      samplePeakNcc: alignment.peakNcc,
      lagMs,
      lagSamples: alignment.lagSamples,
      noloopHonored,
      reportedSettings: {
        echoCancellation,
        noiseSuppression,
        autoGainControl,
        channelCount,
        sampleRate,
        ctxSampleRate,
        workletChannels,
      },
      recordedMs: parsedRecorded.durationMs,
      analyzedMs: (firstPassPcm16.length / TARGET_SAMPLE_RATE) * 1000,
      seqGaps,
      segments: silero.segments.length,
      falsePositives: comparison.falsePositives.length,
      splits: comparison.splits.length,
      missedLabels: comparison.missedLabels.length,
      segmentRows,
    };
  } finally {
    await context.close();
  }
}

function formatSignedMs(n: number): string {
  return `${n >= 0 ? "+" : ""}${n}`;
}

function printModeTable(report: ModeReport): void {
  console.log(`\n--- Mode: processing=${report.mode} ---`);
  console.log(
    `Metrics:        envelopeNcc=${report.envelopePeakNcc.toFixed(4)} (>= ${MIN_ENVELOPE_PEAK_NCC}) | sampleNcc=${report.samplePeakNcc.toFixed(4)} | lag=${report.lagMs.toFixed(2)} ms (${report.lagSamples} samples) | noloop=${report.noloopHonored ? "honored" : "looped-trimmed"} | recorded=${report.recordedMs.toFixed(0)} ms | analyzed=${report.analyzedMs.toFixed(0)} ms | seqGaps=${report.seqGaps}`,
  );
  console.log(
    `Track settings: echoCancellation=${report.reportedSettings.echoCancellation} | noiseSuppression=${report.reportedSettings.noiseSuppression} | autoGainControl=${report.reportedSettings.autoGainControl} | channelCount=${report.reportedSettings.channelCount} | sampleRate=${report.reportedSettings.sampleRate} | audioCtx=${report.reportedSettings.ctxSampleRate} | workletCh=${report.reportedSettings.workletChannels}`,
  );
  console.log(
    `VAD summary:    segments=${report.segments} | FP=${report.falsePositives} | splits=${report.splits} | missed=${report.missedLabels}`,
  );
  console.log("seg# | label# | seg [start, end] ms | shifted label [start, end] ms | startDeltaMs | endDeltaMs | onsetMs | vadEndMs");
  console.log("-----+--------+---------------------+-------------------------------+--------------+------------+---------+---------");
  for (const r of report.segmentRows) {
    const segSpan = `[${r.segStartMs}, ${r.segEndMs}]`.padEnd(19);
    const lblSpan = `[${r.labelStartMs}, ${r.labelEndMs}]`.padEnd(29);
    console.log(
      `${String(r.segmentIndex).padEnd(4)} | ${String(r.labelIndex).padEnd(6)} | ${segSpan} | ${lblSpan} | ${formatSignedMs(r.startDeltaMs).padEnd(12)} | ${formatSignedMs(r.endDeltaMs).padEnd(10)} | ${String(r.onsetConfirmMs).padEnd(7)} | ${r.vadEndMs}`,
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
  const sourceFloat = int16ToFloat32(parsedSource.samples as Int16Array);
  const sourceLabels = parseLabels(await readFile(SOURCE_LABELS_PATH, "utf8"));

  const { usedSoxr } = buildFakeMicWavWithFfmpeg(SOURCE_WAV_PATH, UPSAMPLED_48K_PATH);
  const fakeMicWav = parseWav(new Uint8Array(await readFile(UPSAMPLED_48K_PATH)));

  runViteBuild();
  const previewProc = startPreviewServer();
  let previewStderr = "";
  previewProc.stderr?.on("data", (chunk: Buffer) => {
    previewStderr += chunk.toString();
  });

  try {
    await waitForServer(PREVIEW_BASE_URL, 15000);

    let browser: Browser;
    let noloopFlagMode = "%noloop";
    try {
      browser = await launchFakeMicBrowser(true);
    } catch {
      noloopFlagMode = "fallback-no-suffix";
      browser = await launchFakeMicBrowser(false);
    }

    try {
      const reportOn = await runMode(
        browser,
        "on",
        sourceFloat,
        sourceLabels,
        fakeMicWav.durationMs,
      );
      const reportOff = await runMode(
        browser,
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
        `Fake-mic WAV: ${UPSAMPLED_48K_PATH} (${fakeMicWav.durationMs.toFixed(1)} ms @ ${fakeMicWav.sampleRate} Hz, ffmpeg resampler=${usedSoxr ? "soxr" : "default"}, chromeFlag=${noloopFlagMode})`,
      );
      printModeTable(reportOn);
      printModeTable(reportOff);
    } finally {
      await browser.close();
    }
  } finally {
    previewProc.kill("SIGTERM");
    if (previewStderr.trim().length > 0) {
      console.error(previewStderr.trim());
    }
  }
}

main().catch((err) => {
  console.error("=== Browser Capture + Silero VAD End-to-End Speech Smoke Test Report ===");
  console.error("Status: FAIL");
  console.error(err);
  process.exitCode = 1;
});
