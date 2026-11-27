import { describe, expect, it } from "vitest";
import {
  median,
  percentile,
  renderCombinedSummaryTable,
  renderPerSegmentErrorTable,
  summarizeVadRun,
} from "./eval.js";
import { compareSegmentsToLabels, parseLabels } from "./labels.js";
import type { DetectedSegment } from "./segmenter.js";

function makeSeg(overrides: Partial<DetectedSegment> & { index: number; startMs: number; endMs: number }): DetectedSegment {
  return {
    durationMs: overrides.endMs - overrides.startMs,
    onsetMs: overrides.startMs + 300,
    confirmMs: overrides.startMs + 556,
    onsetConfirmMs: 256,
    detectMs: overrides.endMs + 576,
    vadEndMs: 576,
    endReason: "silence",
    ...overrides,
  };
}

describe("eval reporting helpers", () => {
  it("computes median and percentile accurately for empty, odd, and even arrays", () => {
    expect(median([])).toBe(0);
    expect(median([576])).toBe(576);
    expect(median([544, 608, 576])).toBe(576);
    expect(median([544, 576])).toBe(560);

    expect(percentile([], 50)).toBe(0);
    expect(percentile([10, 20, 30, 40], 50)).toBe(30);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
  });

  it("summarizes clean, error-containing, empty-label, and missing-label runs", () => {
    const labels = parseLabels("1.000\t2.000\tutt1\n3.000\t4.000\tutt2");
    const segs = [
      makeSeg({ index: 1, startMs: 700, endMs: 1400, onsetConfirmMs: 256, vadEndMs: 544 }),
      makeSeg({ index: 2, startMs: 1600, endMs: 2020, onsetConfirmMs: 320, vadEndMs: 576 }), // split on utt1
      makeSeg({ index: 3, startMs: 5000, endMs: 5400, onsetConfirmMs: 288, vadEndMs: 608 }), // FP
    ];
    const cmp = compareSegmentsToLabels(segs, labels);

    const summary = summarizeVadRun("speech.wav", segs, cmp);
    expect(summary).toEqual({
      file: "speech.wav",
      segments: 3,
      splits: 1,
      falsePositives: 1,
      missedLabels: 1,
      maxOnsetConfirmMs: 320,
      medianVadEndMs: 576,
    });

    const cleanNoise = summarizeVadRun("noise-only.wav", [], compareSegmentsToLabels([], []));
    expect(cleanNoise).toEqual({
      file: "noise-only.wav",
      segments: 0,
      splits: 0,
      falsePositives: 0,
      missedLabels: 0,
      maxOnsetConfirmMs: null,
      medianVadEndMs: null,
    });

    const noLabels = summarizeVadRun("unlabeled.wav", [segs[0]!], null);
    expect(noLabels).toEqual({
      file: "unlabeled.wav",
      segments: 1,
      splits: null,
      falsePositives: null,
      missedLabels: null,
      maxOnsetConfirmMs: 256,
      medianVadEndMs: 544,
    });

    const table = renderCombinedSummaryTable([cleanNoise, summary, noLabels]);
    expect(table[0]).toContain("file");
    expect(table[0]).toContain("segments");
    expect(table[0]).toContain("splits");
    expect(table[0]).toContain("falsePositives");
    expect(table[0]).toContain("missedLabels");
    expect(table[0]).toContain("max onsetConfirmMs");
    expect(table[0]).toContain("median vadEndMs");
    expect(table[2]).toContain("noise-only.wav");
    expect(table[2]).toContain(" - ");
    expect(table[3]).toContain("320");
    expect(table[4]).toContain("n/a");
  });

  it("renders per-segment error table with matches, splits, false positives, and missed labels", () => {
    const labels = parseLabels("1.000\t2.000\tfirst utterance\n3.000\t4.000\tmissed utterance");
    const segs = [
      makeSeg({ index: 1, startMs: 700, endMs: 1400 }),
      makeSeg({ index: 2, startMs: 1600, endMs: 2020 }),
      makeSeg({ index: 3, startMs: 5000, endMs: 5400 }),
    ];
    const cmp = compareSegmentsToLabels(segs, labels);
    const lines = renderPerSegmentErrorTable(segs, cmp).join("\n");

    expect(lines).toContain("MATCH");
    expect(lines).toContain("-300");
    expect(lines).toContain("-600");
    expect(lines).toContain("SPLIT");
    expect(lines).toContain("gap=+200ms after seg #1 (endDelta=+20ms)");
    expect(lines).toContain("FALSE_POSITIVE");
    expect(lines).toContain("Missed labels:");
    expect(lines).toContain("missed utterance");

    const emptyLines = renderPerSegmentErrorTable([], compareSegmentsToLabels([], [])).join("\n");
    expect(emptyLines).toBe("(no speech segments detected)");
  });
});
