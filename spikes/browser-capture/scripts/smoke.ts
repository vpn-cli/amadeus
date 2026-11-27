import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { singleBinDftMagnitude } from "../src/dft.js";
import { float32ToInt16, int16ToFloat32 } from "../src/resampler.js";
import { encodePcm16Wav, parseWav } from "../src/wav.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPIKE_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(SPIKE_ROOT, "out");
const FIXTURE_PATH = path.join(OUT_DIR, "smoke-input-48k.wav");
const OUTPUT_WAV_PATH = path.join(OUT_DIR, "smoke-output-16k.wav");
const PREVIEW_PORT = 4173;
const PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}/`;

function createSmokeFixture(): Uint8Array {
  const sampleRate = 48000;
  const toneSeconds = 4;
  const silenceSeconds = 1;
  const totalSamples = (toneSeconds + silenceSeconds) * sampleRate;
  const floatSamples = new Float32Array(totalSamples);

  const toneSamples = toneSeconds * sampleRate;
  for (let i = 0; i < toneSamples; i++) {
    floatSamples[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
  }

  return encodePcm16Wav(float32ToInt16(floatSamples), sampleRate, 1);
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

function findDominantFrequency(samples: Float32Array, sampleRate: number): {
  peakHz: number;
  peakMag: number;
  magAt1000Hz: number;
  maxOtherMag: number;
  maxOtherHz: number;
} {
  let peakHz = 0;
  let peakMag = -1;
  let maxOtherMag = 0;
  let maxOtherHz = 0;

  for (let hz = 100; hz <= 7500; hz += 50) {
    const mag = singleBinDftMagnitude(samples, sampleRate, hz);
    if (mag > peakMag) {
      peakMag = mag;
      peakHz = hz;
    }
    if (Math.abs(hz - 1000) > 100 && mag > maxOtherMag) {
      maxOtherMag = mag;
      maxOtherHz = hz;
    }
  }
  const magAt1000Hz = singleBinDftMagnitude(samples, sampleRate, 1000);
  return { peakHz, peakMag, magAt1000Hz, maxOtherMag, maxOtherHz };
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(FIXTURE_PATH, createSmokeFixture());

  const previewProc = startPreviewServer();
  let previewStderr = "";
  previewProc.stderr?.on("data", (chunk: Buffer) => {
    previewStderr += chunk.toString();
  });

  const browserErrors: string[] = [];

  try {
    await waitForServer(PREVIEW_URL, 15000);

    const browser = await chromium.launch({
      headless: true,
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-audio-capture=${FIXTURE_PATH}`,
      ],
    });

    try {
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();

      page.on("pageerror", (err) => {
        browserErrors.push(`pageerror: ${err.message}`);
      });
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          browserErrors.push(`console.error: ${msg.text()}`);
        }
      });

      await page.goto(PREVIEW_URL, { waitUntil: "networkidle" });

      await page.click("#start-btn");
      await page.waitForSelector('#status-text[data-state="recording"]', {
        timeout: 10000,
      });
      await page.waitForFunction(
        () => Number(document.getElementById("received-frames")?.textContent ?? "0") >= 1,
        null,
        { timeout: 10000 },
      );

      const startedPerfMs = performance.now();
      await page.waitForTimeout(5000);
      await page.click("#stop-btn");
      const stoppedPerfMs = performance.now();

      await page.waitForSelector('#status-text[data-state="stopped"]', {
        timeout: 10000,
      });

      const recordedWallMs = stoppedPerfMs - startedPerfMs;
      const ctxSampleRateText =
        (await page.textContent("#ctx-sample-rate"))?.trim() ?? "";
      const inputChannelsText =
        (await page.textContent("#input-channels"))?.trim() ?? "";
      const receivedFramesText =
        (await page.textContent("#received-frames"))?.trim() ?? "0";
      const droppedFramesText =
        (await page.textContent("#dropped-frames"))?.trim() ?? "-1";
      const clockDriftText =
        (await page.textContent("#clock-drift"))?.trim() ?? "";

      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.click("#download-wav-btn"),
      ]);
      await download.saveAs(OUTPUT_WAV_PATH);

      const wavBytes = new Uint8Array(await readFile(OUTPUT_WAV_PATH));
      const parsed = parseWav(wavBytes);
      const droppedFrames = Number(droppedFramesText);
      const receivedFrames = Number(receivedFramesText);

      assert(
        browserErrors.length === 0,
        `Browser errors observed:\n${browserErrors.join("\n")}`,
      );
      assert(parsed.sampleRate === 16000, `Expected 16000 Hz, got ${parsed.sampleRate}`);
      assert(parsed.channels === 1, `Expected 1 channel, got ${parsed.channels}`);
      assert(parsed.bitsPerSample === 16, `Expected 16-bit, got ${parsed.bitsPerSample}`);
      assert(
        parsed.sampleCount % 320 === 0,
        `Expected whole 320-sample frames, got ${parsed.sampleCount} samples`,
      );
      assert(droppedFrames === 0, `Expected 0 seq gaps, got ${droppedFrames}`);

      const durationDeltaMs = Math.abs(parsed.durationMs - recordedWallMs);
      assert(
        durationDeltaMs <= 40,
        `Duration delta ${durationDeltaMs.toFixed(1)} ms exceeds +-40 ms (wav=${parsed.durationMs.toFixed(1)} ms, wall=${recordedWallMs.toFixed(1)} ms)`,
      );

      assert(
        parsed.samples instanceof Int16Array,
        "Expected Int16Array samples in parsed WAV",
      );
      const floatSamples = int16ToFloat32(parsed.samples as Int16Array);
      const dft = findDominantFrequency(floatSamples, 16000);
      const snrRatio = dft.magAt1000Hz / Math.max(dft.maxOtherMag, 1e-6);
      assert(
        Math.abs(dft.peakHz - 1000) <= 50,
        `Expected dominant frequency ~1000 Hz, got ${dft.peakHz} Hz`,
      );
      assert(
        dft.magAt1000Hz > 0.05 && snrRatio > 10,
        `Expected dominant 1000 Hz DFT bin (mag=${dft.magAt1000Hz.toFixed(4)}, ratio=${snrRatio.toFixed(1)}x vs ${dft.maxOtherHz} Hz)`,
      );

      console.log("=== Browser Capture Smoke Test Report ===");
      console.log(`Status:            PASS`);
      console.log(`Preview URL:       ${PREVIEW_URL}`);
      console.log(`AudioContext rate: ${ctxSampleRateText}`);
      console.log(`Input channels:    ${inputChannelsText}`);
      console.log(`Received frames:   ${receivedFrames} (${receivedFrames * 20} ms)`);
      console.log(`Seq gaps (drops):  ${droppedFrames}`);
      console.log(`Clock drift UI:    ${clockDriftText}`);
      console.log(
        `WAV header:        ${parsed.sampleRate} Hz, ${parsed.channels} ch, ${parsed.bitsPerSample}-bit, ${parsed.sampleCount} samples`,
      );
      console.log(
        `Duration check:    wav=${parsed.durationMs.toFixed(1)} ms vs recorded=${recordedWallMs.toFixed(1)} ms (delta=${durationDeltaMs.toFixed(1)} ms <= 40 ms)`,
      );
      console.log(
        `DFT frequency:     peak=${dft.peakHz} Hz, mag@1000Hz=${dft.magAt1000Hz.toFixed(4)}, nextMax=${dft.maxOtherMag.toFixed(4)}@${dft.maxOtherHz}Hz (${snrRatio.toFixed(1)}x)`,
      );
      console.log(`Saved output WAV:  ${OUTPUT_WAV_PATH}`);
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
  console.error("=== Browser Capture Smoke Test Report ===");
  console.error("Status: FAIL");
  console.error(err);
  process.exitCode = 1;
});
