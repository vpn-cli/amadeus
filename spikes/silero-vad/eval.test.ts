import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  VAD_END_BUDGET_MS,
  evaluateSegments,
  formatSummaryLine,
  loadSidecarLabels,
  median,
  percentile,
  renderCombinedSummaryTable,
  renderLabelComparisonTable,
  renderPerSegmentErrorTable,
  summarizeVadRun,
} from "./eval.js";
import { parseLabels } from "./labels.js";
import type { DetectedSegment } from "./segmenter.js";

function makeSeg(
  overrides: Partial<DetectedSegment> & { index: number; startMs: number; endMs: number },
): DetectedSegment {
  return {
    confirmedAtMs: overrides.startMs + 256,
    decidedAtMs: overrides.endMs + 576,
    durationMs: overrides.endMs - overrides.startMs,
    onsetConfirmMs: 256,
    vadEndMs: 576,
    endReason: "silence",
    ...overrides,
  };
}

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

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

  it("summarizes clean, error-containing, empty-label, and missing-label runs with VAD end budget", () => {
    const labels = parseLabels("1.000\t2.000\tutt1\n3.000\t4.000\tutt2");
    const segs = [
      makeSeg({ index: 1, startMs: 1000, endMs: 1400, onsetConfirmMs: 256, vadEndMs: 544 }),
      makeSeg({ index: 2, startMs: 1600, endMs: 2020, onsetConfirmMs: 320, vadEndMs: 576 }), // split on utt1
      makeSeg({ index: 3, startMs: 5000, endMs: 5400, onsetConfirmMs: 288, vadEndMs: 608 }), // FP, over budget
    ];
    const cmp = evaluateSegments(segs, labels);

    const summary = summarizeVadRun("speech.wav", segs, cmp);
    expect(summary).toEqual({
      file: "speech.wav",
      segments: 3,
      splits: 1,
      falsePositives: 1,
      missedLabels: 1,
      maxOnsetConfirmMs: 320,
      medianVadEndMs: 576,
      maxVadEndMs: 608,
      withinVadEndBudget: false,
    });

    const withinBudget = summarizeVadRun("ok.wav", [segs[0]!, segs[1]!], cmp);
    expect(withinBudget.maxVadEndMs).toBe(576);
    expect(withinBudget.withinVadEndBudget).toBe(true);
    expect(VAD_END_BUDGET_MS).toBe(576);

    const cleanNoise = summarizeVadRun("noise-only.wav", [], evaluateSegments([], []));
    expect(cleanNoise).toEqual({
      file: "noise-only.wav",
      segments: 0,
      splits: 0,
      falsePositives: 0,
      missedLabels: 0,
      maxOnsetConfirmMs: null,
      medianVadEndMs: null,
      maxVadEndMs: null,
      withinVadEndBudget: null,
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
      maxVadEndMs: 544,
      withinVadEndBudget: true,
    });

    const table = renderCombinedSummaryTable([cleanNoise, summary, withinBudget, noLabels]);
    expect(table[0]).toContain("file");
    expect(table[0]).toContain("segments");
    expect(table[0]).toContain("splits");
    expect(table[0]).toContain("falsePositives");
    expect(table[0]).toContain("missedLabels");
    expect(table[0]).toContain("max onsetConfirmMs");
    expect(table[0]).toContain("median vadEndMs");
    expect(table[0]).toContain("max vadEndMs");
    expect(table[0]).toContain("vadEndBudget");
    expect(table[2]).toContain("noise-only.wav");
    expect(table[2]).toContain(" - ");
    expect(table[3]).toContain("OVER (>576ms)");
    expect(table[4]).toContain("OK (<=576ms)");
    expect(table[5]).toContain("n/a");

    expect(formatSummaryLine(withinBudget)).toContain("vadEndBudget=OK (<=576ms)");
  });

  it("renders per-segment error table with confirmedAtMs, decidedAtMs, splits, FPs, and missed labels", () => {
    const labels = parseLabels("1.000\t2.000\tfirst utterance\n3.000\t4.000\tmissed utterance");
    const segs = [
      makeSeg({ index: 1, startMs: 1000, endMs: 1400, confirmedAtMs: 1256, decidedAtMs: 1976 }),
      makeSeg({ index: 2, startMs: 1600, endMs: 2020, confirmedAtMs: 1856, decidedAtMs: 2596 }),
      makeSeg({ index: 3, startMs: 5000, endMs: 5400, confirmedAtMs: 5256, decidedAtMs: 5976 }),
    ];
    const cmp = evaluateSegments(segs, labels);
    const lines = renderPerSegmentErrorTable(segs, cmp).join("\n");

    expect(lines).toContain("confirmedAtMs");
    expect(lines).toContain("decidedAtMs");
    expect(lines).toContain("1256");
    expect(lines).toContain("1976");
    expect(lines).toContain("MATCH");
    expect(lines).toContain("-600");
    expect(lines).toContain("SPLIT");
    expect(lines).toContain("gap=+200ms after seg #1 (endDelta=+20ms)");
    expect(lines).toContain("FALSE_POSITIVE");
    expect(lines).toContain("Missed labels:");
    expect(lines).toContain("missed utterance");

    const labelTable = renderLabelComparisonTable(labels, cmp!).join("\n");
    expect(labelTable).toContain("first utterance");
    expect(labelTable).toContain("MISSED");

    const emptyLines = renderPerSegmentErrorTable([], evaluateSegments([], [])).join("\n");
    expect(emptyLines).toBe("(no speech segments detected)");
  });

  it("treats a 0-byte <name>.labels.txt as 'labels present, zero speech' so every segment is FALSE_POSITIVE", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-empty-labels-"));
    tempDirs.push(dir);
    const wavPath = join(dir, "noise.wav");
    const labelsPath = join(dir, "noise.labels.txt");
    await writeFile(wavPath, Buffer.alloc(0));
    await writeFile(labelsPath, Buffer.alloc(0)); // 0-byte file

    const loaded = await loadSidecarLabels(wavPath);
    expect(loaded.labelsPath).toBe(labelsPath);
    expect(loaded.labels).toEqual([]);

    const segs = [
      makeSeg({ index: 1, startMs: 400, endMs: 800 }),
      makeSeg({ index: 2, startMs: 1500, endMs: 1900 }),
    ];
    const cmp = evaluateSegments(segs, loaded.labels);
    expect(cmp).not.toBeNull();
    expect(cmp!.falsePositives).toHaveLength(2);
    expect(cmp!.matches).toEqual([]);
    expect(cmp!.splits).toEqual([]);
    expect(cmp!.missedLabels).toEqual([]);

    const summary = summarizeVadRun("noise.wav", segs, cmp);
    expect(summary.falsePositives).toBe(2);
    expect(summary.splits).toBe(0);
    expect(summary.missedLabels).toBe(0);

    const table = renderPerSegmentErrorTable(segs, cmp).join("\n");
    expect(table).toContain("FALSE_POSITIVE");
    expect(table).not.toContain("NO_LABELS");
  });

  it("treats a missing <name>.labels.txt as 'no comparison' (null comparison, n/a summary, NO_LABELS rows)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-missing-labels-"));
    tempDirs.push(dir);
    const wavPath = join(dir, "unlabeled.wav");
    await writeFile(wavPath, Buffer.alloc(0));

    const loaded = await loadSidecarLabels(wavPath);
    expect(loaded.labelsPath).toBeNull();
    expect(loaded.labels).toBeNull();

    const segs = [makeSeg({ index: 1, startMs: 400, endMs: 800 })];
    const cmp = evaluateSegments(segs, loaded.labels);
    expect(cmp).toBeNull();

    const summary = summarizeVadRun("unlabeled.wav", segs, cmp);
    expect(summary.splits).toBeNull();
    expect(summary.falsePositives).toBeNull();
    expect(summary.missedLabels).toBeNull();

    const summaryTable = renderCombinedSummaryTable([summary]).join("\n");
    expect(summaryTable).toContain("n/a");

    const perSegTable = renderPerSegmentErrorTable(segs, cmp).join("\n");
    expect(perSegTable).toContain("NO_LABELS");
    expect(perSegTable).toContain("missing .labels.txt");
    expect(perSegTable).not.toContain("FALSE_POSITIVE");
  });
});
