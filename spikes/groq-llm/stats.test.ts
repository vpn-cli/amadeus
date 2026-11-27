import { describe, expect, it } from "vitest";
import { formatMs, formatPct, percentile, summarize } from "./stats.js";

describe("stats", () => {
  it("computes median and p90 accurately", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 0.5)).toBe(55);
    expect(percentile(values, 0.9)).toBe(91);
    expect(summarize(values)).toEqual({
      count: 10,
      min: 10,
      median: 55,
      p90: 91,
      max: 100,
    });
  });

  it("handles empty and single-element arrays", () => {
    expect(summarize([])).toEqual({
      count: 0,
      min: null,
      median: null,
      p90: null,
      max: null,
    });
    expect(summarize([42])).toEqual({
      count: 1,
      min: 42,
      median: 42,
      p90: 42,
      max: 42,
    });
    expect(formatMs(null)).toBe("n/a");
    expect(formatMs(12.34)).toBe("12.3 ms");
    expect(formatPct(19, 20)).toBe("95.0% (19/20)");
  });
});
