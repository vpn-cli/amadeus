import { describe, expect, it } from "vitest";
import {
  estimateFrequencyZeroCrossing,
  singleBinDftMagnitude,
} from "./dft.js";
import { createResampler, float32ToInt16, int16ToFloat32 } from "./resampler.js";

function generateSine(
  freqHz: number,
  sampleRate: number,
  numSamples: number,
  amplitude = 0.8,
): Float32Array {
  const out = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return out;
}

describe("streaming resampler", () => {
  it.each([48000, 44100])(
    "preserves 1 kHz sine frequency when resampling from %i Hz to 16000 Hz",
    (inputRate) => {
      const resampler = createResampler({ inputRate, outputRate: 16000 });
      const input = generateSine(1000, inputRate, inputRate); // 1 second
      const output = resampler.process(input);

      // Skip initial 64-sample FIR startup transient
      const steady = output.subarray(64);
      const zcFreq = estimateFrequencyZeroCrossing(steady, 16000);
      const magAt1k = singleBinDftMagnitude(steady, 16000, 1000);
      const magAt2k = singleBinDftMagnitude(steady, 16000, 2000);

      expect(zcFreq).toBeGreaterThan(995);
      expect(zcFreq).toBeLessThan(1005);
      expect(magAt1k).toBeGreaterThan(0.75);
      expect(magAt2k).toBeLessThan(0.01);
    },
  );

  it.each([48000, 44100])(
    "attenuates a 10 kHz sine by at least 20 dB when resampling from %i Hz to 16000 Hz",
    (inputRate) => {
      const resampler = createResampler({ inputRate, outputRate: 16000 });
      const inputAmp = 0.8;
      const input = generateSine(10000, inputRate, inputRate, inputAmp);
      const output = resampler.process(input);

      // Skip initial FIR startup transient; 10 kHz would alias to 6 kHz at 16 kHz output
      const steady = output.subarray(64);
      let peak = 0;
      let sumSq = 0;
      for (let i = 0; i < steady.length; i++) {
        const s = steady[i] ?? 0;
        peak = Math.max(peak, Math.abs(s));
        sumSq += s * s;
      }
      const outputRms = Math.sqrt(sumSq / steady.length);
      const inputRms = inputAmp / Math.SQRT2;
      const attenuationDb = 20 * Math.log10(inputRms / Math.max(outputRms, 1e-12));
      const aliasBin = singleBinDftMagnitude(steady, 16000, 6000);

      expect(attenuationDb).toBeGreaterThanOrEqual(20);
      expect(peak).toBeLessThan(0.08);
      expect(aliasBin).toBeLessThan(0.08);
    },
  );

  it.each([48000, 44100])(
    "matches whole-signal output when processed in 128-sample chunks (%i Hz -> 16000 Hz)",
    (inputRate) => {
      const length = inputRate; // 1 second
      const signal = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        signal[i] =
          0.5 * Math.sin((2 * Math.PI * 440 * i) / inputRate) +
          0.3 * Math.cos((2 * Math.PI * 2100 * i) / inputRate);
      }

      const wholeResampler = createResampler({ inputRate, outputRate: 16000 });
      const wholeOutput = wholeResampler.process(signal);

      const chunkResampler = createResampler({ inputRate, outputRate: 16000 });
      const chunks: Float32Array[] = [];
      let totalChunkSamples = 0;
      for (let offset = 0; offset < signal.length; offset += 128) {
        const chunk = signal.subarray(offset, Math.min(offset + 128, signal.length));
        const out = chunkResampler.process(chunk);
        chunks.push(out);
        totalChunkSamples += out.length;
      }

      const joined = new Float32Array(totalChunkSamples);
      let writeOffset = 0;
      for (const c of chunks) {
        joined.set(c, writeOffset);
        writeOffset += c.length;
      }

      expect(joined.length).toBe(wholeOutput.length);
      let maxAbsDiff = 0;
      for (let i = 0; i < wholeOutput.length; i++) {
        const diff = Math.abs((joined[i] ?? 0) - (wholeOutput[i] ?? 0));
        if (diff > maxAbsDiff) {
          maxAbsDiff = diff;
        }
      }
      expect(maxAbsDiff).toBeLessThan(1e-6);
    },
  );

  it.each([48000, 44100, 16000])(
    "produces output length within +-1 sample per block for %i Hz -> 16000 Hz",
    (inputRate) => {
      const blockSize = 128;
      const blocks = 100;
      const resampler = createResampler({ inputRate, outputRate: 16000 });
      const inputBlock = new Float32Array(blockSize);

      let totalOut = 0;
      for (let b = 0; b < blocks; b++) {
        const out = resampler.process(inputBlock);
        const expectedBlockOut = (blockSize * 16000) / inputRate;
        expect(Math.abs(out.length - expectedBlockOut)).toBeLessThanOrEqual(1.1);
        totalOut += out.length;
      }

      const expectedTotal = (blocks * blockSize * 16000) / inputRate;
      expect(Math.abs(totalOut - expectedTotal)).toBeLessThanOrEqual(2);
    },
  );

  it("clamps and scales Float32 to Int16 and converts back", () => {
    const src = new Float32Array([-1.5, -1.0, -0.5, 0, 0.5, 1.0, 1.5, Number.NaN]);
    const pcm = float32ToInt16(src);
    expect(Array.from(pcm)).toEqual([
      -32768,
      -32768,
      -16384,
      0,
      16384,
      32767,
      32767,
      0,
    ]);

    const back = int16ToFloat32(pcm);
    expect(back[0]).toBe(-1);
    expect(back[3]).toBe(0);
    expect(back[5]).toBeCloseTo(32767 / 32768, 5);
  });
});
