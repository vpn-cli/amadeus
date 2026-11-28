import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { encodePcm16Wav, parseWavHeader, writePcm16Wav } from "./wav.js";

describe("wav", () => {
  it("encodes and parses a 24 kHz mono PCM16LE WAV header", () => {
    const pcm = new Uint8Array(48000); // 1000 ms @ 24 kHz mono 16-bit
    const wav = encodePcm16Wav(pcm);
    expect(wav.byteLength).toBe(44 + 48000);

    const parsed = parseWavHeader(wav);
    expect(parsed).toEqual({
      audioFormat: 1,
      channels: 1,
      sampleRate: 24000,
      bitsPerSample: 16,
      dataSize: 48000,
      durationMs: 1000,
    });
  });

  it("rejects odd-byte PCM buffers", () => {
    expect(() => encodePcm16Wav(new Uint8Array(101))).toThrow();
  });

  it("writes WAV file to disk", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dg-tts-wav-"));
    try {
      const target = path.join(tmpDir, "out.wav");
      const pcm = new Uint8Array(4800); // 100 ms
      await writePcm16Wav(target, pcm);
      const saved = await readFile(target);
      const parsed = parseWavHeader(saved);
      expect(parsed.sampleRate).toBe(24000);
      expect(parsed.durationMs).toBe(100);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
