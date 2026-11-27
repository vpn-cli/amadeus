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
  it("emits unpadded startMs equal to the first positive window start sample with no offset", () => {
    // 20 windows (20 * 512 = 10240 samples = 640 ms) silence + 12 windows (384 ms) speech + 20 windows silence
    const probs = [...repeat(0.05, 20), ...repeat(0.9, 12), ...repeat(0.05, 20)];
    const { events, segments } = segmentProbabilities(probs);

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "speech_start",
      reason: "onset",
      startMs: 640, // exact first positive window start (10240 / 16), zero pre-roll offset
      confirmedAtMs: 896, // 640 + 8 * 32 ms = 896 ms (>= 250 ms)
      onsetConfirmMs: 256,
    });
    expect(events[1]).toEqual({
      type: "speech_end",
      reason: "silence",
      startMs: 640,
      endMs: 1024, // 640 + 12 * 32 ms
      durationMs: 384,
      decidedAtMs: 1600, // 1024 + 18 * 32 ms (576 ms >= 550 ms)
      vadEndMs: 576,
    });
    expect(segments).toEqual([
      {
        index: 1,
        startMs: 640,
        confirmedAtMs: 896,
        endMs: 1024,
        decidedAtMs: 1600,
        durationMs: 384,
        onsetConfirmMs: 256,
        vadEndMs: 576,
        endReason: "silence",
      },
    ]);
  });

  it("ignores short noise bursts below minSpeechMs", () => {
    // 10 silent + 7 voiced (224 ms < 250 ms) + 20 silent
    const probs = [...repeat(0.05, 10), ...repeat(0.85, 7), ...repeat(0.05, 20)];
    const { events, segments } = segmentProbabilities(probs);

    expect(events).toEqual([]);
    expect(segments).toEqual([]);
  });

  it("keeps ONE segment with the original unpadded startMs when speech has a single 32 ms dip during the first 250 ms", () => {
    // 20 windows (640 ms) silence -> first positive window at 640 ms
    // Then 3 voiced (96 ms) -> 1 window (32 ms) dip below offset -> 9 voiced (288 ms) -> 20 silence
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
      startMs: 640, // original first positive window start preserved
      confirmedAtMs: 928, // 640 + (8 voiced + 1 dip) * 32 ms = 640 + 288 ms
      onsetConfirmMs: 288,
    });
    expect(events[1]).toMatchObject({
      type: "speech_end",
      reason: "silence",
      startMs: 640,
      endMs: 1056, // 640 + 13 * 32 ms
      decidedAtMs: 1632,
      vadEndMs: 576,
    });
  });

  it("tolerates pending dips up to pendingGapMs (96 ms = 3 windows) and resets to idle only when exceeded (> 96 ms)", () => {
    // Case A: exactly 3 windows (96 ms) dip while pending -> survives and confirms
    const probs3Dip = [
      ...repeat(0.05, 15), // first positive window at 480 ms
      ...repeat(0.8, 2),
      ...repeat(0.1, 3), // 96 ms dip (== pendingGapMs, not > pendingGapMs)
      ...repeat(0.8, 6), // total voiced = 8 windows (256 ms >= 250 ms)
      ...repeat(0.05, 20),
    ];
    const resA = segmentProbabilities(probs3Dip);
    expect(resA.segments).toHaveLength(1);
    expect(resA.segments[0]?.startMs).toBe(480);
    expect(resA.segments[0]?.confirmedAtMs).toBe(832); // 480 + 352
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
      startMs: 320,
      confirmedAtMs: 576,
      endMs: 896, // 320 + 18 * 32
      decidedAtMs: 1472,
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
        decidedAtMs: 30016,
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
        startMs: 320,
        endMs: 640, // 320 + 10 * 32
        durationMs: 320,
        decidedAtMs: 736, // 640 + 3 * 32
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

  it("produces non-overlapping consecutive segments at exact window boundaries", () => {
    const probs = [
      ...repeat(0.9, 10), // 0..320
      ...repeat(0.05, 18), // 320..896 -> ends Seg 1 at 320 (decidedAt 896)
      ...repeat(0.9, 10), // 896..1216 -> Seg 2 starts at exact 896
      ...repeat(0.05, 18), // 1216..1792 -> ends Seg 2 at 1216
    ];
    const { segments } = segmentProbabilities(probs);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ startMs: 0, endMs: 320, decidedAtMs: 896 });
    expect(segments[1]).toMatchObject({ startMs: 896, endMs: 1216, decidedAtMs: 1792 });
  });

  it("tracks time internally as integer sample counts without floating-point drift", () => {
    // 1000 windows at 16 kHz * 512 samples = 512000 samples = 32000 ms exact
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
        startMs: 32000,
        endMs: 32256, // 32000 + 256
        durationMs: 256,
        decidedAtMs: 32832, // 32256 + 576
        vadEndMs: 576,
      },
    ]);
  });

  it("validates configuration parameters and rejects non-finite probabilities", () => {
    expect(() => new VadSegmenter({ sampleRate: 0 })).toThrow(RangeError);
    expect(() => new VadSegmenter({ onsetThreshold: 0.3, offsetThreshold: 0.5 })).toThrow(
      RangeError,
    );
    expect(() => new VadSegmenter({ maxSpeechMs: 0 })).toThrow(RangeError);
    const seg = new VadSegmenter();
    expect(() => seg.push(Number.NaN)).toThrow(RangeError);
  });

  it("bridges a short dip during speaking (< endSilenceMs) without splitting", () => {
    // 10 silent (320 ms) + 10 speech (320 ms) + 17 dip (544 ms < 550 ms) + 6 speech + 18 silent (576 ms)
    const probs = [
      ...repeat(0.05, 10),
      ...repeat(0.9, 10),
      ...repeat(0.1, 17),
      ...repeat(0.9, 6),
      ...repeat(0.05, 18),
    ];
    const { segments } = segmentProbabilities(probs);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      startMs: 320,
      confirmedAtMs: 576,
      endMs: 1376, // (10 + 10 + 17 + 6) * 32
      decidedAtMs: 1952,
      endReason: "silence",
    });
  });

  it("handles hysteresis oscillation between offsetThreshold and onsetThreshold", () => {
    // From idle: oscillating between 0.35 and 0.49 never reaches onsetThreshold (0.5)
    const idleOsc = Array.from({ length: 10 }, () => [0.36, 0.49, 0.35, 0.48]).flat();
    expect(segmentProbabilities(idleOsc)).toEqual({ events: [], segments: [] });

    // Once speaking: oscillating inside [0.35, 0.49] for > 550 ms keeps speech alive
    const speakingOsc = [
      ...repeat(0.05, 10),
      ...repeat(0.85, 8),
      ...Array.from({ length: 4 }, () => [0.35, 0.49, 0.38, 0.46, 0.36, 0.47]).flat(),
      ...repeat(0.05, 18),
    ];
    const { segments } = segmentProbabilities(speakingOsc);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      startMs: 320,
      confirmedAtMs: 576,
      endMs: 1344, // (10 + 8 + 24) * 32
      decidedAtMs: 1920,
      endReason: "silence",
    });
  });

  it("produces zero events and zero segments on noise-only sub-onset input", () => {
    const noise = Array.from({ length: 20 }, () => [0.02, 0.15, 0.33, 0.48, 0.25, 0.41]).flat();
    const seg = new VadSegmenter();
    const events: SegmenterEvent[] = [];
    for (const p of noise) {
      events.push(...seg.push(p));
    }
    events.push(...seg.flush());

    expect(events).toEqual([]);
    expect(seg.state).toBe("idle");
  });
});
