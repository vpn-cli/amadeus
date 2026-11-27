import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { singleBinDftMagnitude } from "../src/dft.js";
import { float32ToInt16, int16ToFloat32 } from "../src/resampler.js";
import { encodePcm16Wav } from "../src/wav.js";
import {
  TARGET_SAMPLE_RATE,
  assert,
  runCaptureSession,
  withFakeMicBrowserPreview,
} from "./capture-runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPIKE_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(SPIKE_ROOT, "out");
const FIXTURE_PATH = path.join(OUT_DIR, "smoke-input-48k.wav");
const OUTPUT_WAV_PATH = path.join(OUT_DIR, "smoke-output-16k.wav");

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

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(FIXTURE_PATH, createSmokeFixture());

  await withFakeMicBrowserPreview(
    { spikeRoot: SPIKE_ROOT, fakeMicWavPath: FIXTURE_PATH },
    async ({ browser, previewUrl }) => {
      const result = await runCaptureSession({
        browser,
        url: previewUrl,
        outputWavPath: OUTPUT_WAV_PATH,
        stopCondition: { kind: "duration", durationMs: 5000 },
      });

      const durationDeltaMs = Math.abs(result.parsed.durationMs - result.recordedWallMs);
      assert(
        durationDeltaMs <= 40,
        `Duration delta ${durationDeltaMs.toFixed(1)} ms exceeds +-40 ms (wav=${result.parsed.durationMs.toFixed(1)} ms, wall=${result.recordedWallMs.toFixed(1)} ms)`,
      );

      const floatSamples = int16ToFloat32(result.pcm16);
      const dft = findDominantFrequency(floatSamples, TARGET_SAMPLE_RATE);
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
      console.log(`Preview URL:       ${previewUrl}`);
      console.log(`AudioContext rate: ${result.ctxSampleRate}`);
      console.log(`Input channels:    ${result.workletChannels}`);
      console.log(
        `Received frames:   ${result.receivedFrames} (${result.receivedFrames * 20} ms)`,
      );
      console.log(`Seq gaps (drops):  ${result.seqGaps}`);
      console.log(`Clock drift UI:    ${result.clockDriftText}`);
      console.log(
        `WAV header:        ${result.parsed.sampleRate} Hz, ${result.parsed.channels} ch, ${result.parsed.bitsPerSample}-bit, ${result.parsed.sampleCount} samples`,
      );
      console.log(
        `Duration check:    wav=${result.parsed.durationMs.toFixed(1)} ms vs recorded=${result.recordedWallMs.toFixed(1)} ms (delta=${durationDeltaMs.toFixed(1)} ms <= 40 ms)`,
      );
      console.log(
        `DFT frequency:     peak=${dft.peakHz} Hz, mag@1000Hz=${dft.magAt1000Hz.toFixed(4)}, nextMax=${dft.maxOtherMag.toFixed(4)}@${dft.maxOtherHz}Hz (${snrRatio.toFixed(1)}x)`,
      );
      console.log(`Saved output WAV:  ${OUTPUT_WAV_PATH}`);
    },
  );
}

main().catch((err) => {
  console.error("=== Browser Capture Smoke Test Report ===");
  console.error("Status: FAIL");
  console.error(err);
  process.exitCode = 1;
});
