import { describe, expect, it } from "vitest";
import {
  estimateFrequencyZeroCrossing,
  findLargestNonDcPeakHannFft,
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

function processInBlocks(
  resampler: ReturnType<typeof createResampler>,
  signal: Float32Array,
  blockSize = 128,
): Float32Array {
  const chunks: Float32Array[] = [];
  let total = 0;
  for (let offset = 0; offset < signal.length; offset += blockSize) {
    const out = resampler.process(
      signal.subarray(offset, Math.min(offset + blockSize, signal.length)),
    );
    chunks.push(out);
    total += out.length;
  }
  const joined = new Float32Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    joined.set(chunk, pos);
    pos += chunk.length;
  }
  return joined;
}

function computeRms(samples: Float32Array): number {
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] ?? 0;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / Math.max(1, samples.length));
}

describe("streaming resampler", () => {
  it.each([48000, 44100])(
    "preserves 1 kHz sine frequency when resampling from %i Hz to 16000 Hz",
    (inputRate) => {
      const resampler = createResampler({ inputRate, outputRate: 16000 });
      const input = generateSine(1000, inputRate, inputRate); // 1 second
      const output = processInBlocks(resampler, input, 128);

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
    "keeps 1 kHz (+-0.5 dB) and 3.4 kHz (+-1 dB) passband level and attenuates 10 kHz stopband >= 40 dB in 128-sample blocks (%i Hz -> 16000 Hz)",
    (inputRate) => {
      const amplitude = 0.5;
      const durationSec = 2.2; // >= 2 s; leaves > 32768 samples after 100 ms transient discard
      const numSamples = Math.round(inputRate * durationSec);
      const discardSamples = 1600; // 100 ms at 16000 Hz
      const fftSize = 32768;
      const inputRms = amplitude / Math.SQRT2;

      const out1k = processInBlocks(
        createResampler({ inputRate, outputRate: 16000 }),
        generateSine(1000, inputRate, numSamples, amplitude),
        128,
      ).subarray(discardSamples);

      const out3k4 = processInBlocks(
        createResampler({ inputRate, outputRate: 16000 }),
        generateSine(3400, inputRate, numSamples, amplitude),
        128,
      ).subarray(discardSamples);

      const out10k = processInBlocks(
        createResampler({ inputRate, outputRate: 16000 }),
        generateSine(10000, inputRate, numSamples, amplitude),
        128,
      ).subarray(discardSamples);

      const gain1kDb = 20 * Math.log10(computeRms(out1k) / inputRms);
      const gain3k4Db = 20 * Math.log10(computeRms(out3k4) / inputRms);

      const peak1k = findLargestNonDcPeakHannFft(out1k, 16000, fftSize);
      const peak10k = findLargestNonDcPeakHannFft(out10k, 16000, fftSize);
      const stopbandAttenDb =
        20 * Math.log10(peak1k.peakAmplitude / Math.max(peak10k.peakAmplitude, 1e-12));

      expect(Math.abs(gain1kDb)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(gain3k4Db)).toBeLessThanOrEqual(1.0);
      expect(Math.abs(peak1k.peakFreqHz - 1000)).toBeLessThanOrEqual(2);
      expect(stopbandAttenDb).toBeGreaterThanOrEqual(40);
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
      const joined = processInBlocks(
        createResampler({ inputRate, outputRate: 16000 }),
        signal,
        128,
      );

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

  it("ignores DC offset and locates the dominant spectral peak via Hann-windowed FFT", () => {
    const sampleRate = 16000;
    const fftSize = 4096;
    const sig = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      sig[i] = 0.7 + 0.25 * Math.sin((2 * Math.PI * 6000 * i) / sampleRate);
    }
    const peak = findLargestNonDcPeakHannFft(sig, sampleRate, fftSize);
    expect(Math.abs(peak.peakFreqHz - 6000)).toBeLessThanOrEqual(sampleRate / fftSize);
    expect(peak.peakAmplitude).toBeCloseTo(0.25, 2);
  });
});
