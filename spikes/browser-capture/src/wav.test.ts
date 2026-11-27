import { describe, expect, it } from "vitest";
import { encodeFloat32Wav, encodePcm16Wav, parseWav } from "./wav.js";

describe("wav encode/parse round trip", () => {
  it("round-trips PCM16LE mono 16 kHz with exact 44-byte header", () => {
    const samples = new Int16Array([0, 1000, -1000, 32767, -32768, 42]);
    const encoded = encodePcm16Wav(samples, 16000, 1);

    expect(encoded.byteLength).toBe(44 + samples.length * 2);

    const parsed = parseWav(encoded);
    expect(parsed.audioFormat).toBe(1);
    expect(parsed.format).toBe("pcm16");
    expect(parsed.sampleRate).toBe(16000);
    expect(parsed.channels).toBe(1);
    expect(parsed.bitsPerSample).toBe(16);
    expect(parsed.sampleCount).toBe(samples.length);
    expect(Array.from(parsed.samples)).toEqual(Array.from(samples));
  });

  it("round-trips chunked Int16Array frames identically to single buffer", () => {
    const c1 = new Int16Array([10, -20, 30]);
    const c2 = new Int16Array([40, -50, 60, 70]);
    const wav = encodePcm16Wav([c1, c2], 16000, 1);
    const parsed = parseWav(wav);

    expect(parsed.sampleCount).toBe(7);
    expect(parsed.sampleRate).toBe(16000);
    expect(parsed.bitsPerSample).toBe(16);
    expect(Array.from(parsed.samples)).toEqual([10, -20, 30, 40, -50, 60, 70]);
  });

  it("round-trips IEEE Float32 native-rate WAV", () => {
    const f1 = new Float32Array([0, 0.25, -0.5, 0.999]);
    const f2 = new Float32Array([-1, 0.125]);
    const wav = encodeFloat32Wav([f1, f2], 48000, 1);

    expect(wav.byteLength).toBe(44 + 6 * 4);

    const parsed = parseWav(wav);
    expect(parsed.audioFormat).toBe(3);
    expect(parsed.format).toBe("float32");
    expect(parsed.sampleRate).toBe(48000);
    expect(parsed.channels).toBe(1);
    expect(parsed.bitsPerSample).toBe(32);
    expect(parsed.sampleCount).toBe(6);
    expect(parsed.samples[0]).toBe(0);
    expect(parsed.samples[1]).toBeCloseTo(0.25, 6);
    expect(parsed.samples[2]).toBeCloseTo(-0.5, 6);
    expect(parsed.samples[3]).toBeCloseTo(0.999, 6);
    expect(parsed.samples[4]).toBe(-1);
    expect(parsed.samples[5]).toBeCloseTo(0.125, 6);
  });
});
