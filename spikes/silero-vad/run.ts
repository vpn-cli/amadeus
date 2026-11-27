import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DEFAULT_MODEL_PATH, ensureModel } from "./download-model.js";
import {
  SILERO_SAMPLE_RATE,
  SILERO_WINDOW_SAMPLES,
  SileroVad,
} from "./silero.js";
import { readPcm16Wav } from "./wav.js";

const FRAME_SAMPLES_20MS = 320; // Simulated WebSocket client frame size (20 ms @ 16 kHz)
const ONSET_THRESHOLD = 0.5;
const OFFSET_THRESHOLD = 0.35;
const MIN_SPEECH_MS = 250;
const END_SILENCE_MS = 550;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

function renderBar(prob: number, width = 24): string {
  const filled = Math.round(prob * width);
  return "#".repeat(filled) + ".".repeat(Math.max(0, width - filled));
}

async function main(): Promise<void> {
  const wavArg = process.argv[2];
  const wavPath = wavArg
    ? resolve(process.cwd(), wavArg)
    : resolve(import.meta.dirname, "out", "sample-16k.wav");

  const modelPath = await ensureModel(DEFAULT_MODEL_PATH);
  const vad = await SileroVad.create(modelPath);
  const wav = await readPcm16Wav(wavPath);

  console.log(`Loaded WAV: ${wavPath}`);
  console.log(`Duration: ${wav.durationMs.toFixed(0)} ms (${wav.float32.length} samples)`);
  console.log(`Model inputs: [${vad.inputNames.join(", ")}] -> outputs: [${vad.outputNames.join(", ")}]`);
  console.log("");

  // Re-chunk incoming 20ms (320-sample) frames into 32ms (512-sample) Silero windows
  let pending = new Float32Array(0);
  const inferenceTimesMs: number[] = [];
  const windowMs = (SILERO_WINDOW_SAMPLES / SILERO_SAMPLE_RATE) * 1000;

  let inSpeech = false;
  let speechStartMs = 0;
  let lastVoicedMs = 0;
  let windowIdx = 0;
  const segments: Array<{ startMs: number; endMs: number; durationMs: number }> = [];

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

      const currentMs = windowIdx * windowMs;
      const isVoiced = inSpeech ? prob >= OFFSET_THRESHOLD : prob >= ONSET_THRESHOLD;

      if (!inSpeech && isVoiced) {
        inSpeech = true;
        speechStartMs = currentMs;
        lastVoicedMs = currentMs + windowMs;
      } else if (inSpeech && isVoiced) {
        lastVoicedMs = currentMs + windowMs;
      } else if (inSpeech && !isVoiced) {
        if (currentMs + windowMs - lastVoicedMs >= END_SILENCE_MS) {
          const speechDuration = lastVoicedMs - speechStartMs;
          if (speechDuration >= MIN_SPEECH_MS) {
            segments.push({
              startMs: speechStartMs,
              endMs: lastVoicedMs,
              durationMs: speechDuration,
            });
          }
          inSpeech = false;
        }
      }

      if (windowIdx % 4 === 0 || prob >= ONSET_THRESHOLD) {
        const tag = inSpeech ? "SPEECH" : "      ";
        console.log(
          `${(currentMs / 1000).toFixed(2).padStart(6)}s | ${prob.toFixed(3)} | ${renderBar(prob)} | ${tag}`,
        );
      }

      windowIdx++;
    }
  }

  if (inSpeech) {
    const speechDuration = lastVoicedMs - speechStartMs;
    if (speechDuration >= MIN_SPEECH_MS) {
      segments.push({
        startMs: speechStartMs,
        endMs: lastVoicedMs,
        durationMs: speechDuration,
      });
    }
  }

  const sorted = [...inferenceTimesMs].sort((a, b) => a - b);
  const avg = sorted.reduce((acc, v) => acc + v, 0) / Math.max(1, sorted.length);

  console.log("\n--- Detected Speech Segments ---");
  for (const [i, seg] of segments.entries()) {
    console.log(
      `Segment ${i + 1}: ${(seg.startMs / 1000).toFixed(3)}s .. ${(seg.endMs / 1000).toFixed(3)}s (${seg.durationMs.toFixed(0)} ms)`,
    );
  }

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
