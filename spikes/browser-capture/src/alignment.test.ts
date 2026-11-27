import { describe, expect, it } from "vitest";
import { findAlignmentLag } from "./alignment.js";

function makeSyntheticSpeechLikeSignal(sampleRate: number, durationSec: number): Float32Array {
  const totalSamples = Math.round(sampleRate * durationSec);
  const out = new Float32Array(totalSamples);

  // Two distinct speech-like bursts separated by silence so coarse RMS + fine phase are unambiguous.
  const bursts = [
    { startSec: 0.4, endSec: 1.5, f1: 220, f2: 670, modHz: 4.5 },
    { startSec: 2.1, endSec: 2.9, f1: 310, f2: 940, modHz: 6.0 },
  ];

  for (const burst of bursts) {
    const s0 = Math.round(burst.startSec * sampleRate);
    const s1 = Math.min(totalSamples, Math.round(burst.endSec * sampleRate));
    for (let i = s0; i < s1; i++) {
      const t = (i - s0) / sampleRate;
      const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * burst.modHz * t);
      out[i] =
        0.5 *
        env *
        (0.6 * Math.sin(2 * Math.PI * burst.f1 * t) +
          0.4 * Math.sin(2 * Math.PI * burst.f2 * t));
    }
  }

  return out;
}

describe("findAlignmentLag", () => {
  it("recovers exact lag and peakNcc > 0.9 for a delayed signal with 0.5x gain change", () => {
    const sampleRate = 16000;
    const reference = makeSyntheticSpeechLikeSignal(sampleRate, 3.5);
    const trueLag = 12347; // Non-frame-aligned lag (~771.69 ms)

    // Simulate looped recording of 2x source duration with 0.5x gain change
    const recording = new Float32Array(reference.length * 2);
    for (let i = 0; i < recording.length; i++) {
      const srcIdx =
        ((i - trueLag) % reference.length + reference.length) % reference.length;
      recording[i] = 0.5 * (reference[srcIdx] ?? 0);
    }

    const result = findAlignmentLag(reference, recording, {
      sampleRate,
      maxLagSamples: reference.length,
    });

    expect(result.lagSamples).toBe(trueLag);
    expect(result.peakNcc).toBeGreaterThan(0.9);
    expect(result.envelopePeakNcc).toBeGreaterThan(0.9);
  });

  it("handles zero lag and returns peakNcc close to 1", () => {
    const sampleRate = 16000;
    const reference = makeSyntheticSpeechLikeSignal(sampleRate, 2.5);
    const recording = new Float32Array(reference.length * 2);
    recording.set(reference, 0);
    recording.set(reference, reference.length);

    const result = findAlignmentLag(reference, recording, { sampleRate });
    expect(result.lagSamples).toBe(0);
    expect(result.peakNcc).toBeGreaterThan(0.99);
    expect(result.envelopePeakNcc).toBeGreaterThan(0.99);
  });

  it("recovers lag via envelope NCC even when carrier waveform decorrelates sample-level NCC", () => {
    const sampleRate = 16000;
    const reference = makeSyntheticSpeechLikeSignal(sampleRate, 3.0);
    const trueLag = 16000; // 1000 ms
    const recording = new Float32Array(reference.length + trueLag + 8000);
    // Same amplitude envelope on bursts [0.4..1.5] and [2.1..2.9], but different harmonic carrier frequencies
    const bursts = [
      { startSec: 0.4, endSec: 1.5, f1: 370, f2: 1130, modHz: 4.5 },
      { startSec: 2.1, endSec: 2.9, f1: 490, f2: 1410, modHz: 6.0 },
    ];
    for (const burst of bursts) {
      const s0 = Math.round(burst.startSec * sampleRate);
      const s1 = Math.round(burst.endSec * sampleRate);
      for (let i = s0; i < s1; i++) {
        const t = (i - s0) / sampleRate;
        const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * burst.modHz * t);
        recording[trueLag + i] =
          0.5 *
          env *
          (0.6 * Math.sin(2 * Math.PI * burst.f1 * t) +
            0.4 * Math.sin(2 * Math.PI * burst.f2 * t));
      }
    }

    const result = findAlignmentLag(reference, recording, {
      sampleRate,
      maxLagSamples: 48001,
    });
    expect(Math.abs(result.lagSamples - trueLag)).toBeLessThanOrEqual(320);
    expect(result.envelopePeakNcc).toBeGreaterThan(0.99);
    expect(result.peakNcc).toBeLessThan(0.6);
  });

  it("throws when recording is shorter than reference", () => {
    const reference = new Float32Array(1600);
    const recording = new Float32Array(800);
    expect(() => findAlignmentLag(reference, recording)).toThrow(/shorter than reference/i);
  });
});
