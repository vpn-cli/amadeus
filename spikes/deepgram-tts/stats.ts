export interface DistributionStats {
  readonly count: number;
  readonly min: number | null;
  readonly median: number | null;
  readonly p90: number | null;
  readonly max: number | null;
}

export function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] ?? null;

  const clampedQ = Math.min(1, Math.max(0, q));
  const pos = clampedQ * (sorted.length - 1);
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  const lowerVal = sorted[lower] ?? 0;
  const upperVal = sorted[upper] ?? lowerVal;
  if (lower === upper) return lowerVal;
  return lowerVal + (upperVal - lowerVal) * (pos - lower);
}

export function summarize(values: readonly number[]): DistributionStats {
  if (values.length === 0) {
    return { count: 0, min: null, median: null, p90: null, max: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted[sorted.length - 1] ?? null,
  };
}

export function formatMs(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)} ms`;
}

export function formatNum(value: number | null, digits = 2): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

export function formatPct(numerator: number, denominator: number): string {
  if (denominator === 0) return "0.0% (0/0)";
  const pct = (numerator / denominator) * 100;
  return `${pct.toFixed(1)}% (${numerator}/${denominator})`;
}
