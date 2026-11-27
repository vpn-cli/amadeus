export interface AlignmentOptions {
  sampleRate?: number;
  /** Exclusive upper bound on lag search in samples (defaults to reference.length). */
  maxLagSamples?: number;
  /** Coarse RMS envelope frame duration in ms (defaults to 10 ms). */
  envelopeMs?: number;
  /** Fine sample-level search half-width around coarse peak in ms (defaults to 20 ms). */
  fineRadiusMs?: number;
}

export interface AlignmentResult {
  lagSamples: number;
  peakNcc: number;
  envelopePeakNcc: number;
}

function computeRmsEnvelope(samples: Float32Array, frameSize: number): Float64Array {
  const frameCount = Math.floor(samples.length / frameSize);
  const env = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const start = f * frameSize;
    let sumSq = 0;
    for (let i = 0; i < frameSize; i++) {
      const s = samples[start + i] ?? 0;
      sumSq += s * s;
    }
    env[f] = Math.sqrt(sumSq / frameSize);
  }
  return env;
}

function normalizedCrossCorrelation(
  refCentered: Float64Array,
  refEnergy: number,
  target: ArrayLike<number>,
  offset: number,
): number {
  const n = refCentered.length;
  if (n === 0 || refEnergy <= 0) {
    return 0;
  }

  let targetSum = 0;
  for (let i = 0; i < n; i++) {
    targetSum += target[offset + i] ?? 0;
  }
  const targetMean = targetSum / n;

  let cross = 0;
  let targetEnergy = 0;
  for (let i = 0; i < n; i++) {
    const dy = (target[offset + i] ?? 0) - targetMean;
    cross += (refCentered[i] ?? 0) * dy;
    targetEnergy += dy * dy;
  }

  const denom = Math.sqrt(refEnergy * targetEnergy);
  if (denom <= 1e-18) {
    return 0;
  }
  return cross / denom;
}

function centerSeries(samples: ArrayLike<number>, length: number): {
  centered: Float64Array;
  energy: number;
} {
  let sum = 0;
  for (let i = 0; i < length; i++) {
    sum += samples[i] ?? 0;
  }
  const mean = sum / Math.max(1, length);

  const centered = new Float64Array(length);
  let energy = 0;
  for (let i = 0; i < length; i++) {
    const d = (samples[i] ?? 0) - mean;
    centered[i] = d;
    energy += d * d;
  }
  return { centered, energy };
}

/**
 * Pure two-stage signal alignment using normalized cross-correlation (NCC):
 * 1. Coarse search via NCC over 10 ms RMS envelopes across [0, maxLagSamples).
 * 2. Fine sample-level NCC within +-20 ms of the coarse peak.
 */
export function findAlignmentLag(
  reference: Float32Array,
  recording: Float32Array,
  options: AlignmentOptions = {},
): AlignmentResult {
  const sampleRate = options.sampleRate ?? 16000;
  const envelopeMs = options.envelopeMs ?? 10;
  const fineRadiusMs = options.fineRadiusMs ?? 20;

  if (reference.length === 0) {
    throw new Error("Reference signal must not be empty");
  }
  if (recording.length < reference.length) {
    throw new Error(
      `Recording (${recording.length} samples) is shorter than reference (${reference.length} samples)`,
    );
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`Invalid sampleRate: ${sampleRate}`);
  }

  const maxValidLag = recording.length - reference.length + 1;
  const requestedMaxLag = options.maxLagSamples ?? reference.length;
  const maxLagExclusive = Math.max(1, Math.min(requestedMaxLag, maxValidLag));

  const frameSize = Math.max(1, Math.round((sampleRate * envelopeMs) / 1000));
  const fineRadiusSamples = Math.max(1, Math.round((sampleRate * fineRadiusMs) / 1000));

  const refEnv = computeRmsEnvelope(reference, frameSize);
  const recEnv = computeRmsEnvelope(recording, frameSize);

  let fineStart = 0;
  let fineEnd = maxLagExclusive - 1;
  let envelopePeakNcc = 0;

  if (refEnv.length >= 2 && recEnv.length >= refEnv.length) {
    const maxCoarseLagExclusive = Math.max(
      1,
      Math.min(Math.ceil(maxLagExclusive / frameSize), recEnv.length - refEnv.length + 1),
    );
    const { centered: refEnvCentered, energy: refEnvEnergy } = centerSeries(
      refEnv,
      refEnv.length,
    );

    if (refEnvEnergy > 1e-18) {
      let bestCoarseFrame = 0;
      let bestCoarseNcc = -Infinity;

      for (let k = 0; k < maxCoarseLagExclusive; k++) {
        const ncc = normalizedCrossCorrelation(refEnvCentered, refEnvEnergy, recEnv, k);
        if (ncc > bestCoarseNcc) {
          bestCoarseNcc = ncc;
          bestCoarseFrame = k;
        }
      }

      if (Number.isFinite(bestCoarseNcc)) {
        envelopePeakNcc = bestCoarseNcc;
      }
      const coarseLagSamples = Math.min(bestCoarseFrame * frameSize, maxLagExclusive - 1);
      fineStart = Math.max(0, coarseLagSamples - fineRadiusSamples);
      fineEnd = Math.min(maxLagExclusive - 1, coarseLagSamples + fineRadiusSamples);
    }
  }

  const { centered: refCentered, energy: refEnergy } = centerSeries(
    reference,
    reference.length,
  );

  let bestLag = fineStart;
  let peakNcc = -Infinity;
  for (let lag = fineStart; lag <= fineEnd; lag++) {
    const ncc = normalizedCrossCorrelation(refCentered, refEnergy, recording, lag);
    if (ncc > peakNcc) {
      peakNcc = ncc;
      bestLag = lag;
    }
  }

  return {
    lagSamples: bestLag,
    peakNcc: Number.isFinite(peakNcc) ? peakNcc : 0,
    envelopePeakNcc,
  };
}
