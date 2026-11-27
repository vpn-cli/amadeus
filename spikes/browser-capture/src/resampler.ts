export interface ResamplerOptions {
  inputRate: number;
  outputRate: number;
}

export interface StreamingResampler {
  readonly inputRate: number;
  readonly outputRate: number;
  process(input: Float32Array): Float32Array;
  reset(): void;
}

/**
 * Zero-order modified Bessel function of the first kind I0(x),
 * used to compute Kaiser window coefficients.
 */
function besselI0(x: number): number {
  let sum = 1.0;
  let term = 1.0;
  const halfX = x * 0.5;
  for (let k = 1; k <= 30; k++) {
    const ratio = halfX / k;
    term *= ratio * ratio;
    sum += term;
    if (term < 1e-12 * sum) {
      break;
    }
  }
  return sum;
}

/**
 * Builds an odd-length linear-phase Kaiser-windowed sinc low-pass FIR kernel.
 * Cutoff is chosen below output Nyquist so frequencies above outputRate / 2
 * (e.g. 10 kHz when outputRate = 16 kHz) are strongly attenuated.
 */
function designLowPassTaps(inputRate: number, outputRate: number): Float32Array {
  const cutoffHz = Math.min(0.42 * outputRate, 0.45 * inputRate);
  const fNorm = cutoffHz / inputRate;
  // Scale tap count with inputRate so transition width in Hz stays narrow even at 96 kHz.
  let tapCount = Math.max(63, Math.ceil((63 * inputRate) / 48000));
  if (tapCount % 2 === 0) {
    tapCount += 1;
  }
  tapCount = Math.min(tapCount, 127);

  const beta = 6.5;
  const invI0Beta = 1.0 / besselI0(beta);
  const center = (tapCount - 1) / 2;
  const taps = new Float32Array(tapCount);

  let gainSum = 0;
  for (let n = 0; n < tapCount; n++) {
    const m = n - center;
    const sinc =
      m === 0
        ? 2 * fNorm
        : Math.sin(2 * Math.PI * fNorm * m) / (Math.PI * m);
    const normPos = m / center;
    const arg = Math.max(0, 1 - normPos * normPos);
    const window = besselI0(beta * Math.sqrt(arg)) * invI0Beta;
    const coeff = sinc * window;
    taps[n] = coeff;
    gainSum += coeff;
  }

  for (let n = 0; n < tapCount; n++) {
    taps[n] = (taps[n] ?? 0) / gainSum;
  }

  return taps;
}

/**
 * Creates a pure streaming audio resampler with anti-aliasing low-pass FIR
 * filtering and Catmull-Rom cubic fractional-position interpolation.
 *
 * Filter state and fractional sample cursor persist across calls so processing
 * in 128-sample AudioWorklet render quanta matches single-buffer processing
 * without block-boundary clicks.
 */
export function createResampler(options: ResamplerOptions): StreamingResampler {
  const { inputRate, outputRate } = options;
  if (!Number.isFinite(inputRate) || inputRate <= 0) {
    throw new Error(`Invalid inputRate: ${inputRate}`);
  }
  if (!Number.isFinite(outputRate) || outputRate <= 0) {
    throw new Error(`Invalid outputRate: ${outputRate}`);
  }

  if (inputRate === outputRate) {
    return {
      inputRate,
      outputRate,
      process(input: Float32Array): Float32Array {
        return input.slice();
      },
      reset(): void {
        // Stateless passthrough
      },
    };
  }

  const taps = designLowPassTaps(inputRate, outputRate);
  const tapCount = taps.length;
  const delayLen = tapCount - 1;
  const step = inputRate / outputRate;

  const firHistory = new Float32Array(delayLen);
  const interpHistory = new Float32Array(3);
  let filteredScratch = new Float32Array(256);
  let totalInputProcessed = 0;
  let nextOutputIdx = 0;

  function ensureScratch(len: number): Float32Array {
    if (filteredScratch.length < len) {
      filteredScratch = new Float32Array(len);
    }
    return filteredScratch;
  }

  function updateHistory(
    buf: Float32Array,
    src: Float32Array,
    srcLen: number,
  ): void {
    const cap = buf.length;
    if (cap === 0 || srcLen === 0) {
      return;
    }
    if (srcLen >= cap) {
      buf.set(src.subarray(srcLen - cap, srcLen));
      return;
    }
    buf.copyWithin(0, srcLen);
    buf.set(src.subarray(0, srcLen), cap - srcLen);
  }

  return {
    inputRate,
    outputRate,

    process(input: Float32Array): Float32Array {
      const len = input.length;
      if (len === 0) {
        return new Float32Array(0);
      }

      const filtered = ensureScratch(len);

      // 1. Apply causal streaming FIR low-pass filter across block boundary.
      const boundaryEnd = Math.min(len, delayLen);
      for (let n = 0; n < boundaryEnd; n++) {
        let acc = 0;
        for (let k = 0; k < tapCount; k++) {
          const srcIdx = n - k;
          const sample =
            srcIdx < 0
              ? (firHistory[delayLen + srcIdx] ?? 0)
              : (input[srcIdx] ?? 0);
          acc += (taps[k] ?? 0) * sample;
        }
        filtered[n] = acc;
      }

      for (let n = boundaryEnd; n < len; n++) {
        let acc = 0;
        for (let k = 0; k < tapCount; k++) {
          acc += (taps[k] ?? 0) * (input[n - k] ?? 0);
        }
        filtered[n] = acc;
      }

      updateHistory(firHistory, input, len);

      // 2. Resample filtered signal with Catmull-Rom cubic interpolation.
      // Requires y[i - 1], y[i], y[i + 1], y[i + 2] -> stop when pos >= len - 2.
      const maxPos = len - 2;
      const firstPos = nextOutputIdx * step - totalInputProcessed;
      if (firstPos >= maxPos) {
        updateHistory(interpHistory, filtered, len);
        totalInputProcessed += len;
        return new Float32Array(0);
      }

      const maxOut = Math.ceil((maxPos - firstPos) / step) + 1;
      const out = new Float32Array(maxOut);
      let outLen = 0;

      const getFiltered = (idx: number): number =>
        idx < 0 ? (interpHistory[3 + idx] ?? 0) : (filtered[idx] ?? 0);

      while (true) {
        const pos = nextOutputIdx * step - totalInputProcessed;
        if (pos >= maxPos) {
          break;
        }
        const i = Math.floor(pos);
        const t = pos - i;

        const y0 = getFiltered(i - 1);
        const y1 = getFiltered(i);
        const y2 = getFiltered(i + 1);
        const y3 = getFiltered(i + 2);

        const a0 = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
        const a1 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
        const a2 = -0.5 * y0 + 0.5 * y2;
        const a3 = y1;

        out[outLen++] = ((a0 * t + a1) * t + a2) * t + a3;
        nextOutputIdx += 1;
      }

      updateHistory(interpHistory, filtered, len);
      totalInputProcessed += len;

      return outLen === out.length ? out : out.subarray(0, outLen);
    },

    reset(): void {
      firHistory.fill(0);
      interpHistory.fill(0);
      totalInputProcessed = 0;
      nextOutputIdx = 0;
    },
  };
}

/**
 * Clamps Float32 samples to [-1, 1] and converts to signed 16-bit PCM.
 */
export function float32ToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const raw = input[i] ?? 0;
    const clamped = Number.isNaN(raw) ? 0 : Math.max(-1, Math.min(1, raw));
    out[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
  }
  return out;
}

/**
 * Converts signed 16-bit PCM samples to normalized Float32 in [-1, 1).
 */
export function int16ToFloat32(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = (input[i] ?? 0) / 32768;
  }
  return out;
}
