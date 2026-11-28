export const PRE_ROLL_MS = 100;
export const VAD_END_TAIL_MS = 576;
export const STREAM_FRAME_MS = 20;
export const SAMPLE_RATE_HZ = 16000;
export const BYTES_PER_SAMPLE = 2;
export const FRAME_BYTES_20MS = (SAMPLE_RATE_HZ * STREAM_FRAME_MS * BYTES_PER_SAMPLE) / 1000; // 640 bytes

export type DeliveryMode = "burst_at_confirm" | "realtime_paced";

export interface VadSegmentSpec {
  readonly index: number;
  readonly startMs: number;
  readonly confirmedAtMs: number;
  readonly endMs: number;
  readonly decidedAtMs: number;
  readonly expectedText: string;
  readonly expectedOrderId: string | null;
}

export interface SlicedTurnAudio {
  readonly mode: DeliveryMode;
  readonly sliceStartMs: number;
  readonly confirmMs: number;
  readonly sliceEndMs: number;
  readonly totalBytes: number;
  readonly totalDurationMs: number;
  readonly burstBytes: number;
  readonly burstDurationMs: number;
  readonly burstChunk: Uint8Array | null;
  readonly realtimeFrames: readonly Uint8Array[];
  readonly fullPcmBytes: Uint8Array;
}

function msToEvenByteOffset(ms: number, maxBytes: number): number {
  const sample = Math.round((ms * SAMPLE_RATE_HZ) / 1000);
  const clampedSample = Math.max(0, Math.min(Math.floor(maxBytes / BYTES_PER_SAMPLE), sample));
  return clampedSample * BYTES_PER_SAMPLE;
}

function splitInto20msFrames(bytes: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += FRAME_BYTES_20MS) {
    const end = Math.min(offset + FRAME_BYTES_20MS, bytes.byteLength);
    frames.push(bytes.subarray(offset, end));
  }
  return frames;
}

/**
 * Purely slices real PCM16LE audio from (start - 100 ms) through (end + 576 ms).
 * Never pads with synthetic silence; clips only if the source file ends early.
 */
export function sliceTurnAudio(
  fullPcmBytes: Uint8Array,
  segment: VadSegmentSpec,
  mode: DeliveryMode,
  options: {
    readonly preRollMs?: number;
    readonly endTailMs?: number;
  } = {},
): SlicedTurnAudio {
  const preRollMs = options.preRollMs ?? PRE_ROLL_MS;
  const endTailMs = options.endTailMs ?? VAD_END_TAIL_MS;

  const totalSamples = Math.floor(fullPcmBytes.byteLength / BYTES_PER_SAMPLE);
  const maxAudioMs = (totalSamples / SAMPLE_RATE_HZ) * 1000;

  const requestedStartMs = Math.max(0, segment.startMs - preRollMs);
  const requestedEndMs = segment.endMs + endTailMs;
  if (requestedEndMs > maxAudioMs + 0.5) {
    throw new RangeError(
      `Segment #${segment.index} end+tail (${requestedEndMs} ms) exceeds real audio duration (${maxAudioMs.toFixed(1)} ms)`,
    );
  }
  const clampedConfirmMs = Math.max(requestedStartMs, Math.min(requestedEndMs, segment.confirmedAtMs));

  const startByte = msToEvenByteOffset(requestedStartMs, fullPcmBytes.byteLength);
  const confirmByte = msToEvenByteOffset(clampedConfirmMs, fullPcmBytes.byteLength);
  const endByte = msToEvenByteOffset(requestedEndMs, fullPcmBytes.byteLength);

  const turnSlice = fullPcmBytes.subarray(startByte, endByte);
  const totalBytes = turnSlice.byteLength;
  const totalDurationMs = (totalBytes / BYTES_PER_SAMPLE / SAMPLE_RATE_HZ) * 1000;

  if (mode === "realtime_paced") {
    return {
      mode,
      sliceStartMs: requestedStartMs,
      confirmMs: clampedConfirmMs,
      sliceEndMs: requestedEndMs,
      totalBytes,
      totalDurationMs,
      burstBytes: 0,
      burstDurationMs: 0,
      burstChunk: null,
      realtimeFrames: splitInto20msFrames(turnSlice),
      fullPcmBytes: turnSlice,
    };
  }

  const burstBytesLen = Math.max(0, confirmByte - startByte);
  const burstChunk = burstBytesLen > 0 ? fullPcmBytes.subarray(startByte, confirmByte) : null;
  const postConfirmSlice = fullPcmBytes.subarray(confirmByte, endByte);

  return {
    mode,
    sliceStartMs: requestedStartMs,
    confirmMs: clampedConfirmMs,
    sliceEndMs: requestedEndMs,
    totalBytes,
    totalDurationMs,
    burstBytes: burstBytesLen,
    burstDurationMs: (burstBytesLen / BYTES_PER_SAMPLE / SAMPLE_RATE_HZ) * 1000,
    burstChunk,
    realtimeFrames: splitInto20msFrames(postConfirmSlice),
    fullPcmBytes: turnSlice,
  };
}
