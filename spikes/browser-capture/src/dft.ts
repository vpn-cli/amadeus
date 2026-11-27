/**
 * Computes normalized single-bin DFT magnitude at targetHz for a real signal.
 * Output matches sinusoidal amplitude (e.g., unit-amplitude sine -> ~1.0).
 */
export function singleBinDftMagnitude(
  samples: ArrayLike<number>,
  sampleRate: number,
  targetHz: number,
): number {
  const n = samples.length;
  if (n === 0) {
    return 0;
  }
  const omega = (2 * Math.PI * targetHz) / sampleRate;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const x = samples[i] ?? 0;
    const angle = omega * i;
    re += x * Math.cos(angle);
    im -= x * Math.sin(angle);
  }
  return (2 * Math.hypot(re, im)) / n;
}

/**
 * Estimates frequency from positive-going zero crossings across the signal.
 */
export function estimateFrequencyZeroCrossing(
  samples: ArrayLike<number>,
  sampleRate: number,
): number {
  let firstCross = -1;
  let lastCross = -1;
  let cycles = 0;

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1] ?? 0;
    const curr = samples[i] ?? 0;
    if (prev <= 0 && curr > 0) {
      const frac = -prev / (curr - prev);
      const pos = i - 1 + frac;
      if (firstCross < 0) {
        firstCross = pos;
      } else {
        cycles += 1;
      }
      lastCross = pos;
    }
  }

  if (cycles === 0 || lastCross <= firstCross) {
    return 0;
  }
  return (cycles * sampleRate) / (lastCross - firstCross);
}
