import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEGMENTER_CONFIG,
  type SegmenterEvent,
  VadSegmenter,
  segmentProbabilities,
} from "./segmenter.js";

function repeat(prob: number, count: number): number[] {
  return Array.from({ length: count }, () => prob);
}

describe("VadSegmenter", () => {
  it("detects a clean utterance with backdated pre-roll start, onsetConfirmMs, and vadEndMs", () => {
    // 20 windows (640 ms) silence + 12 windows (384 ms) speech + 20 windows (640 ms) silence
    const probs = [...repeat(0.05, 20), ...repeat(0.9, 12), ...repeat(0.05, 20)];
    const { events, segments } = segmentProbabilities(probs);

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "speech_start",
      reason: "onset",
      startMs: 340, // 640 ms onset - 300 ms pre-roll
      onsetMs: 640,
      confirmMs: 896, // 640 + 8 * 32 ms = 896 ms (>= 250 ms)
      onsetConfirmMs: 256,
    });
    expect(events[1]).toEqual({
      type: "speech_end",
      reason: "silence",
      startMs: 340,
      endMs: 1024, // 640 + 12 * 32 ms
      durationMs: 684,
      detectMs: 1600, // 1024 + 18 * 32 ms (576 ms >= 550 ms)
      vadEndMs: 576,
    });
    expect(segments).toHaveLength(1);
    expect(segments[0]?.endReason).toBe("silence");
  });

  it("ignores short noise bursts below minSpeechMs", () => {
    // 10 silent + 7 voiced (224 ms < 250 ms) + 20 silent
    const probs = [...repeat(0.05, 10), ...repeat(0.85, 7), ...repeat(0.05, 20)];
    const { events, segments } = segmentProbabilities(probs);

    expect(events).toEqual([]);
    expect(segments).toEqual([]);
  });

  it("keeps ONE segment with the original backdated start when speech has a single 32 ms dip during the first 250 ms", () => {
    // 20 windows (640 ms) silence -> onset at 640 ms, original backdated start = 340 ms
    // Then 3 voiced (96 ms) -> 1 window (32 ms) dip below offset -> 9 voiced (288 ms) -> 18 silence (576 ms)
    const probs = [
      ...repeat(0.05, 20),
      ...repeat(0.85, 3),
      0.1, // 32 ms plosive/dip below offsetThreshold (0.35)
      ...repeat(0.85, 9),
      ...repeat(0.05, 20),
    ];

    const { events, segments } = segmentProbabilities(probs);

    expect(segments).toHaveLength(1);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "speech_start",
      reason: "onset",
      startMs: 340, // original backdated start preserved (640 - 300)
      onsetMs: 640,
      confirmMs: 928, // 640 + (8 voiced + 1 dip) * 32 ms = 640 + 288 ms
      onsetConfirmMs: 288,
    });
    expect(events[1]).toMatchObject({
      type: "speech_end",
      reason: "silence",
      startMs: 340,
      endMs: 1056, // 640 + 13 * 32 ms
      vadEndMs: 576,
    });
  });

  it("tolerates pending dips up to pendingGapMs (96 ms = 3 windows) and resets to idle only when exceeded (> 96 ms)", () => {
    // Case A: exactly 3 windows (96 ms) dip while pending -> survives and confirms
    const probs3Dip = [
      ...repeat(0.05, 15), // onset at 480 ms -> backdated 180 ms
      ...repeat(0.8, 2),
      ...repeat(0.1, 3), // 96 ms dip (== pendingGapMs, not > pendingGapMs)
      ...repeat(0.8, 6), // total voiced = 8 windows (256 ms >= 250 ms)
      ...repeat(0.05, 20),
    ];
    const resA = segmentProbabilities(probs3Dip);
    expect(resA.segments).toHaveLength(1);
    expect(resA.segments[0]?.startMs).toBe(180);
    expect(resA.segments[0]?.onsetConfirmMs).toBe(352); // (2 + 3 + 6) * 32 ms

    // Case B: 4 windows (128 ms > 96 ms) dip while pending -> resets to idle
    const probs4Dip = [
      ...repeat(0.05, 15),
      ...repeat(0.8, 2),
      ...repeat(0.1, 4), // 128 ms > 96 ms -> reset to idle
      ...repeat(0.4, 5), // between offset (0.35) and onset (0.5): must NOT re-trigger from idle
      ...repeat(0.05, 20),
    ];
    const resB = segmentProbabilities(probs4Dip);
    expect(resB.events).toEqual([]);
    expect(resB.segments).toEqual([]);
  });

  it("maintains hysteresis between offsetThreshold and onsetThreshold once speaking", () => {
    // 10 silent + 8 onset (0.8) + 10 mid-level (0.42 >= 0.35) + 18 silent
    const probs = [
      ...repeat(0.05, 10),
      ...repeat(0.8, 8),
      ...repeat(0.42, 10),
      ...repeat(0.05, 18),
    ];
    const { segments } = segmentProbabilities(probs);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      startMs: 20, // 320 - 300
      endMs: 896, // 320 + 18 * 32
      endReason: "silence",
    });
  });

  it("forces speech_end with reason 'max_duration' when maxSpeechMs is exceeded", () => {
    // Default maxSpeechMs is 30000 ms (937.5 windows -> exceeded on 938th window = 30016 ms)
    const seg = new VadSegmenter();
    expect(seg.config.maxSpeechMs).toBe(30000);
    expect(DEFAULT_SEGMENTER_CONFIG.maxSpeechMs).toBe(30000);

    const events: SegmenterEvent[] = [];
    for (let i = 0; i < 937; i++) {
      events.push(...seg.push(0.9));
    }
    expect(events).toHaveLength(1); // Only speech_start so far (29984 ms <= 30000 ms)
    expect(seg.state).toBe("speaking");

    // 938th window (30016 ms > 30000 ms) forces max_duration end
    const onLimit = seg.push(0.9);
    expect(onLimit).toEqual([
      {
        type: "speech_end",
        reason: "max_duration",
        startMs: 0,
        endMs: 30016,
        durationMs: 30016,
        detectMs: 30016,
        vadEndMs: 0,
      },
    ]);
    expect(seg.state).toBe("idle");

    // Continued speech after forced cut produces a non-overlapping second segment
    for (let i = 0; i < 10; i++) {
      events.push(...seg.push(0.9));
    }
    events.push(...seg.flush());
    const last = events[events.length - 1];
    expect(last).toMatchObject({
      type: "speech_end",
      reason: "flush",
      startMs: 30016,
    });
  });

  it("emits speech_end with reason 'flush' when stream ends mid-utterance, and discards pending on flush", () => {
    const segSpeaking = new VadSegmenter();
    const evs: SegmenterEvent[] = [];
    for (const p of [...repeat(0.05, 10), ...repeat(0.8, 10), ...repeat(0.05, 3)]) {
      evs.push(...segSpeaking.push(p));
    }
    const flushed = segSpeaking.flush();
    expect(flushed).toEqual([
      {
        type: "speech_end",
        reason: "flush",
        startMs: 20, // 320 - 300
        endMs: 640, // 320 + 10 * 32
        durationMs: 620,
        detectMs: 736, // 640 + 3 * 32
        vadEndMs: 96,
      },
    ]);
    expect(segSpeaking.flush()).toEqual([]);

    const segPending = new VadSegmenter();
    for (const p of repeat(0.8, 4)) {
      expect(segPending.push(p)).toEqual([]);
    }
    expect(segPending.state).toBe("pending");
    expect(segPending.flush()).toEqual([]);
    expect(segPending.state).toBe("idle");
  });

  it("clamps backdated startMs so adjacent segments never overlap", () => {
    // Seg 1: 0..320ms speech, 576ms silence (18 windows) -> detects end at 896ms
    // Immediately 1 window later (at 896ms), Seg 2 starts: 896 - 300 = 596ms (> 320ms end of Seg 1),
    // OR with preRollMs = 700ms: 896 - 700 = 196ms < 320ms -> clamped to 320ms!
    const probs = [
      ...repeat(0.9, 10), // 0..320
      ...repeat(0.05, 18), // 320..896 -> ends Seg 1 at 320
      ...repeat(0.9, 10), // 896..1216
      ...repeat(0.05, 18), // 1216..1792 -> ends Seg 2 at 1216
    ];
    const { segments } = segmentProbabilities(probs, { preRollMs: 700 });

    expect(segments).toHaveLength(2);
    expect(segments[0]?.endMs).toBe(320);
    expect(segments[1]?.startMs).toBe(320);
  });

  it("tracks time internally as integer sample counts without floating-point drift", () => {
    // 1000 windows at 16 kHz * 512 samples = exact integer ms multiples
    const seg = new VadSegmenter();
    for (let i = 0; i < 1000; i++) {
      seg.push(0.01);
    }
    expect(seg.processedSamples).toBe(512000);

    for (let i = 0; i < 8; i++) {
      seg.push(0.9);
    }
    const endEvents = [...Array.from({ length: 18 }, () => seg.push(0.01))].flat();
    expect(endEvents).toEqual([
      {
        type: "speech_end",
        reason: "silence",
        startMs: 31700, // 32000 - 300
        endMs: 32256, // 32000 + 256
        durationMs: 556,
        detectMs: 32832, // 32256 + 576
        vadEndMs: 576,
      },
    ]);
  });
});
