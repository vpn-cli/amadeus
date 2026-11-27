import { describe, expect, it } from "vitest";
import { compareSegmentsToLabels, parseLabels } from "./labels.js";

describe("labels", () => {
  it("parses Audacity-style seconds labels and ignores comments/blank lines/BOM", () => {
    const raw = [
      "\uFEFF# Ground-truth intervals",
      "",
      "1.000\t4.513\tHello, can you check order 1042?",
      "5.713   7.883   Thanks, what time is it?",
      "9.000\t9.500",
    ].join("\n");

    const parsed = parseLabels(raw);
    expect(parsed).toEqual([
      {
        index: 1,
        startMs: 1000,
        endMs: 4513,
        durationMs: 3513,
        text: "Hello, can you check order 1042?",
      },
      {
        index: 2,
        startMs: 5713,
        endMs: 7883,
        durationMs: 2170,
        text: "Thanks, what time is it?",
      },
      {
        index: 3,
        startMs: 9000,
        endMs: 9500,
        durationMs: 500,
        text: "label_3",
      },
    ]);
  });

  it("rejects malformed or inverted label intervals", () => {
    expect(() => parseLabels("4.000\t2.000\tbad")).toThrow(/Invalid label timestamps/);
    expect(() => parseLabels("abc\t2.000\tbad")).toThrow(/Invalid label timestamps/);
    expect(() => parseLabels("onlyonefield")).toThrow(/Invalid label syntax/);
  });

  it("matches clean 1-to-1 segments with zero splits, false positives, or missed labels", () => {
    const labels = parseLabels("1.000\t4.513\tutt1\n5.713\t7.883\tutt2");
    const segments = [
      { index: 1, startMs: 700, endMs: 4544 },
      { index: 2, startMs: 5413, endMs: 7904 },
    ];

    const res = compareSegmentsToLabels(segments, labels);

    expect(res.matches).toHaveLength(2);
    expect(res.matches[0]).toMatchObject({
      overlapMs: 3513,
      startDeltaMs: -300,
      endDeltaMs: 31,
    });
    expect(res.splits).toEqual([]);
    expect(res.falsePositives).toEqual([]);
    expect(res.missedLabels).toEqual([]);
    expect(res.annotations.map((a) => a.kind)).toEqual(["match", "match"]);
  });

  it("reports extra overlapping segments on an already-matched label under splits (with gapMs), NOT falsePositives", () => {
    const labels = parseLabels("1.000\t5.000\tLong utterance with internal pause");
    const segments = [
      { index: 1, startMs: 700, endMs: 2200 },
      { index: 2, startMs: 2800, endMs: 3600 }, // gap = 2800 - 2200 = 600 ms
      { index: 3, startMs: 4200, endMs: 5050 }, // gap = 4200 - 3600 = 600 ms
    ];

    const res = compareSegmentsToLabels(segments, labels);

    expect(res.matches).toHaveLength(1);
    expect(res.matches[0]?.segment).toBe(segments[0]);

    expect(res.splits).toHaveLength(2);
    expect(res.splits[0]).toEqual({
      label: labels[0],
      segment: segments[1],
      previousSegment: segments[0],
      gapMs: 600,
      overlapMs: 800,
    });
    expect(res.splits[1]).toEqual({
      label: labels[0],
      segment: segments[2],
      previousSegment: segments[1],
      gapMs: 600,
      overlapMs: 800,
    });

    expect(res.falsePositives).toEqual([]);
    expect(res.missedLabels).toEqual([]);
    expect(res.annotations).toEqual([
      { kind: "match", labelIndices: [1], splitGapMs: null },
      { kind: "split", labelIndices: [1], splitGapMs: 600 },
      { kind: "split", labelIndices: [1], splitGapMs: 600 },
    ]);
  });

  it("tracks false positives and missed labels separately from splits", () => {
    const labels = parseLabels("1.000\t2.000\tutt1\n4.000\t5.000\tutt2");
    const segments = [
      { index: 1, startMs: 1000, endMs: 1400 },
      { index: 2, startMs: 1600, endMs: 2000 }, // split on utt1 (gap 200 ms)
      { index: 3, startMs: 7000, endMs: 7400 }, // false positive (overlaps nothing)
    ];

    const res = compareSegmentsToLabels(segments, labels);

    expect(res.matches).toHaveLength(1);
    expect(res.splits).toHaveLength(1);
    expect(res.splits[0]?.gapMs).toBe(200);
    expect(res.falsePositives).toEqual([segments[2]]);
    expect(res.missedLabels).toEqual([labels[1]]);
  });

  it("marks both labels matched when a single segment bridges two adjacent labels", () => {
    const labels = parseLabels("1.000\t2.000\tutt1\n2.300\t3.500\tutt2");
    const segments = [{ index: 1, startMs: 700, endMs: 3520 }];

    const res = compareSegmentsToLabels(segments, labels);

    expect(res.matches).toHaveLength(2);
    expect(res.splits).toEqual([]);
    expect(res.falsePositives).toEqual([]);
    expect(res.missedLabels).toEqual([]);
  });
});
