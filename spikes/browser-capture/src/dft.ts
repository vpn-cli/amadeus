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

export interface FftPeakResult {
  fftSize: number;
  binHz: number;
  peakFreqHz: number;
  peakAmplitude: number;
  peakDb: number;
}

/**
 * In-place iterative Cooley-Tukey radix-2 complex FFT (power-of-two length).
 */
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n <= 1 || (n & (n - 1)) !== 0) {
    throw new Error(`FFT size must be a power of two > 1, got ${n}`);
  }

  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while ((j & bit) !== 0) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      const ti = im[i]!;
      re[i] = re[j]!;
      im[i] = im[j]!;
      re[j] = tr;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wStepRe = Math.cos(angle);
    const wStepIm = Math.sin(angle);

    for (let start = 0; start < n; start += len) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < halfLen; k++) {
        const even = start + k;
        const odd = even + halfLen;
        const oddRe = re[odd]!;
        const oddIm = im[odd]!;
        const tRe = wRe * oddRe - wIm * oddIm;
        const tIm = wRe * oddIm + wIm * oddRe;

        re[odd] = re[even]! - tRe;
        im[odd] = im[even]! - tIm;
        re[even] = re[even]! + tRe;
        im[even] = im[even]! + tIm;

        const nextWRe = wRe * wStepRe - wIm * wStepIm;
        wIm = wRe * wStepIm + wIm * wStepRe;
        wRe = nextWRe;
      }
    }
  }
}

/**
 * Computes a Hann-windowed FFT over `fftSize` samples (largest power of two <= samples.length
 * if omitted) and returns the largest non-DC spectral peak (bins >= 3 to skip DC main-lobe leakage).
 */
export function findLargestNonDcPeakHannFft(
  samples: ArrayLike<number>,
  sampleRate: number,
  fftSize?: number,
): FftPeakResult {
  const n =
    fftSize ??
    (1 << Math.floor(Math.log2(Math.max(8, samples.length))));
  if (n < 8 || (n & (n - 1)) !== 0) {
    throw new Error(`fftSize must be a power of two >= 8, got ${n}`);
  }
  if (samples.length < n) {
    throw new Error(`Need at least ${n} samples for FFT, got ${samples.length}`);
  }

  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let windowSum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
    windowSum += w;
    re[i] = (samples[i] ?? 0) * w;
  }

  fftInPlace(re, im);

  const half = n >> 1;
  let peakBin = 3;
  let peakAmplitude = -1;

  for (let k = 3; k <= half; k++) {
    const mag = Math.hypot(re[k]!, im[k]!);
    const amp = k === half ? mag / windowSum : (2 * mag) / windowSum;
    if (amp > peakAmplitude) {
      peakAmplitude = amp;
      peakBin = k;
    }
  }

  const binHz = sampleRate / n;
  return {
    fftSize: n,
    binHz,
    peakFreqHz: peakBin * binHz,
    peakAmplitude,
    peakDb: 20 * Math.log10(Math.max(peakAmplitude, 1e-12)),
  };
}
