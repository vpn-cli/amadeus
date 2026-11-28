import { describe, expect, it } from "vitest";
import {
  FRAME_BYTES_20MS,
  sliceTurnAudio,
  type VadSegmentSpec,
} from "./audio-slicer.js";

function makeTestPcmBytes(durationMs: number): Uint8Array {
  const sampleCount = Math.round((durationMs * 16000) / 1000);
  const buf = new Uint8Array(sampleCount * 2);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < sampleCount; i += 1) {
    view.setInt16(i * 2, i % 32000, true);
  }
  return buf;
}

const SEG_1: VadSegmentSpec = {
  index: 1,
  startMs: 1024,
  confirmedAtMs: 1280,
  endMs: 4544,
  decidedAtMs: 5120,
  expectedText: "Hello, can you check the status of order one zero four two?",
  expectedOrderId: "1042",
};

describe("audio-slicer", () => {
  it("slices (start - 100 ms) through (end + 576 ms) with confirm burst + 20 ms frames", () => {
    const pcm = makeTestPcmBytes(9000);
    const sliced = sliceTurnAudio(pcm, SEG_1, "burst_at_confirm");

    expect(sliced.sliceStartMs).toBe(924);
    expect(sliced.confirmMs).toBe(1280);
    expect(sliced.sliceEndMs).toBe(5120);
    expect(sliced.burstDurationMs).toBe(356);
    expect(sliced.burstBytes).toBe(11392); // 356 ms * 32 bytes/ms
    expect(sliced.burstChunk?.byteLength).toBe(11392);
    expect(sliced.totalDurationMs).toBe(4196);
    expect(sliced.totalBytes).toBe(4196 * 32);

    const frameBytesSum = sliced.realtimeFrames.reduce((acc, f) => acc + f.byteLength, 0);
    expect(sliced.burstBytes + frameBytesSum).toBe(sliced.totalBytes);
    expect(sliced.realtimeFrames[0]?.byteLength).toBe(FRAME_BYTES_20MS);
    expect(sliced.realtimeFrames).toHaveLength(192); // (5120 - 1280) / 20 = 192 frames
    expect(sliced.fullPcmBytes.byteLength).toBe(sliced.totalBytes);
  });

  it("slices full real-time 20 ms frames from (start - 100 ms) in realtime_paced mode", () => {
    const pcm = makeTestPcmBytes(9000);
    const sliced = sliceTurnAudio(pcm, SEG_1, "realtime_paced");

    expect(sliced.burstChunk).toBeNull();
    expect(sliced.burstBytes).toBe(0);
    expect(sliced.totalDurationMs).toBe(4196);
    const frameBytesSum = sliced.realtimeFrames.reduce((acc, f) => acc + f.byteLength, 0);
    expect(frameBytesSum).toBe(sliced.totalBytes);
    // 4196 ms = 209 * 20 ms + 16 ms tail
    expect(sliced.realtimeFrames).toHaveLength(210);
    expect(sliced.realtimeFrames[0]?.byteLength).toBe(640);
    expect(sliced.realtimeFrames[209]?.byteLength).toBe(16 * 32);
  });

  it("throws if real audio ends before (end + 576 ms) instead of padding synthetic silence", () => {
    const shortPcm = makeTestPcmBytes(4800);
    expect(() => sliceTurnAudio(shortPcm, SEG_1, "burst_at_confirm")).toThrow(
      /exceeds real audio duration/,
    );
  });
});
