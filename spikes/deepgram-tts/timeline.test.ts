import { describe, expect, it } from "vitest";
import {
  BYTES_PER_MS_24K_MONO_16BIT,
  bytesToAudioMs,
  checkRawPcm24kFormat,
  computePlaybackTimeline,
} from "./timeline.js";

describe("timeline", () => {
  it("converts 24 kHz mono PCM16LE bytes to ms at 48 B/ms", () => {
    expect(BYTES_PER_MS_24K_MONO_16BIT).toBe(48);
    expect(bytesToAudioMs(4800)).toBe(100);
    expect(bytesToAudioMs(48_000)).toBe(1000);
  });

  it("computes zero underruns when chunks arrive faster than playback", () => {
    // 2 chunks of 500 ms each (24000 bytes), arriving 100 ms apart
    const chunks = [
      { arrivedAtMs: 1000, bytes: 24000 },
      { arrivedAtMs: 1100, bytes: 24000 },
    ];
    const j0 = computePlaybackTimeline(chunks, 0);
    expect(j0.firstChunkMs).toBe(500);
    expect(j0.totalAudioMs).toBe(1000);
    expect(j0.streamWallMs).toBe(100);
    expect(j0.streamRtf).toBeCloseTo(10, 4);
    expect(j0.underrunCount).toBe(0);
    expect(j0.totalStarvedMs).toBe(0);

    const j100 = computePlaybackTimeline(chunks, 100);
    expect(j100.underrunCount).toBe(0);
    expect(j100.totalStarvedMs).toBe(0);
  });

  it("computes underrun count and starved ms for J=0 vs J=100 across sentence gaps", () => {
    // Sentence 1: 2 chunks of 200 ms each (total 400 ms), arriving at t=100, 120
    // Sentence 2: arrives at t=550 (50 ms starved at J=0, 0 starved at J=100!)
    // Sentence 3: arrives at t=1200 after 400 ms of s2 (ends at 950 at J=0 -> 250 ms starved; ends at 1000 at J=100 -> 200 ms starved)
    const chunks = [
      { arrivedAtMs: 100, bytes: 200 * 48 },
      { arrivedAtMs: 120, bytes: 200 * 48 },
      { arrivedAtMs: 550, bytes: 400 * 48 },
      { arrivedAtMs: 1200, bytes: 200 * 48 },
    ];

    const j0 = computePlaybackTimeline(chunks, 0);
    expect(j0.firstChunkMs).toBe(200);
    expect(j0.totalAudioMs).toBe(1000);
    expect(j0.underrunCount).toBe(2);
    expect(j0.totalStarvedMs).toBeCloseTo(50 + 250, 4);
    expect(j0.underruns[0]?.starvedMs).toBeCloseTo(50, 4);
    expect(j0.underruns[1]?.starvedMs).toBeCloseTo(250, 4);

    const j100 = computePlaybackTimeline(chunks, 100);
    expect(j100.underrunCount).toBe(1);
    expect(j100.totalStarvedMs).toBeCloseTo(200, 4);
    expect(j100.underruns[0]?.starvedMs).toBeCloseTo(200, 4);
  });

  it("returns null streamRtf when only one chunk arrives", () => {
    const res = computePlaybackTimeline([{ arrivedAtMs: 500, bytes: 4800 }], 0);
    expect(res.streamRtf).toBeNull();
    expect(res.firstChunkMs).toBe(100);
    expect(res.underrunCount).toBe(0);
  });

  it("verifies raw PCM format rejects RIFF headers and odd byte counts", () => {
    const valid = new Uint8Array(48000 * 2); // 2000 ms for 28 chars (~14 chars/s)
    expect(checkRawPcm24kFormat(valid, "Your order 1042 has shipped.").ok).toBe(true);

    const odd = new Uint8Array(48001);
    expect(checkRawPcm24kFormat(odd, "Your order 1042 has shipped.").evenByteLength).toBe(false);
    expect(checkRawPcm24kFormat(odd, "Your order 1042 has shipped.").ok).toBe(false);

    const riff = Buffer.alloc(48000);
    riff.write("RIFF", 0, "ascii");
    riff.write("WAVE", 8, "ascii");
    const riffCheck = checkRawPcm24kFormat(riff, "Your order 1042 has shipped.");
    expect(riffCheck.hasRiffHeader).toBe(true);
    expect(riffCheck.ok).toBe(false);
  });
});
