import { describe, expect, it } from "vitest";
import { encodePcm16Wav, parsePcm16WavBuffer } from "./wav.js";

describe("wav", () => {
  it("round-trips PCM16LE 16 kHz mono audio through RIFF/WAVE header", () => {
    const samples = 320;
    const pcm = new Uint8Array(samples * 2);
    const view = new DataView(pcm.buffer);
    for (let i = 0; i < samples; i += 1) {
      view.setInt16(i * 2, (i * 97) % 30000, true);
    }

    const wav = encodePcm16Wav(pcm, 16000, 1);
    expect(wav.byteLength).toBe(44 + pcm.byteLength);

    const decoded = parsePcm16WavBuffer(wav);
    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.channels).toBe(1);
    expect(decoded.bitsPerSample).toBe(16);
    expect(decoded.sampleCount).toBe(samples);
    expect(decoded.durationMs).toBeCloseTo(20, 6);
    expect(Buffer.from(decoded.pcmBytes)).toEqual(Buffer.from(pcm));
  });
});
