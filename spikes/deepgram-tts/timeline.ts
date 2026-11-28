export const SAMPLE_RATE_24K = 24000;
export const CHANNELS_MONO = 1;
export const BYTES_PER_SAMPLE_16BIT = 2;
export const BYTES_PER_MS_24K_MONO_16BIT =
  (SAMPLE_RATE_24K * CHANNELS_MONO * BYTES_PER_SAMPLE_16BIT) / 1000; // 48 B/ms

export interface AudioChunkTiming {
  readonly arrivedAtMs: number;
  readonly bytes: number;
}

export interface PlaybackUnderrun {
  readonly chunkIndex: number;
  readonly gapStartMs: number;
  readonly gapEndMs: number;
  readonly starvedMs: number;
}

export interface PlaybackTimelineResult {
  readonly jitterBufferMs: number;
  readonly chunkCount: number;
  readonly totalBytes: number;
  readonly totalAudioMs: number;
  readonly firstChunkBytes: number;
  readonly firstChunkMs: number;
  readonly streamWallMs: number;
  /** Audio ms received per wall-clock ms (null if < 2 chunks or zero wall span). */
  readonly streamRtf: number | null;
  readonly underrunCount: number;
  readonly totalStarvedMs: number;
  readonly underruns: readonly PlaybackUnderrun[];
}

export interface RawPcmFormatCheck {
  readonly hasRiffHeader: boolean;
  readonly evenByteLength: boolean;
  readonly totalBytes: number;
  readonly durationMs: number;
  readonly charsPerSec: number | null;
  readonly plausibleDuration: boolean;
  readonly ok: boolean;
}

export function bytesToAudioMs(bytes: number): number {
  return bytes / BYTES_PER_MS_24K_MONO_16BIT;
}

/**
 * Simulates continuous 24 kHz mono PCM16LE playback starting at
 * `firstAudioArrivedAtMs + jitterBufferMs` and computes underrun count,
 * total starved ms, first chunk duration, and streaming real-time factor.
 */
export function computePlaybackTimeline(
  chunks: readonly AudioChunkTiming[],
  jitterBufferMs: number,
): PlaybackTimelineResult {
  if (chunks.length === 0) {
    return {
      jitterBufferMs,
      chunkCount: 0,
      totalBytes: 0,
      totalAudioMs: 0,
      firstChunkBytes: 0,
      firstChunkMs: 0,
      streamWallMs: 0,
      streamRtf: null,
      underrunCount: 0,
      totalStarvedMs: 0,
      underruns: [],
    };
  }

  const first = chunks[0]!;
  const last = chunks[chunks.length - 1]!;
  const t0 = first.arrivedAtMs;

  let totalBytes = 0;
  for (const c of chunks) {
    totalBytes += c.bytes;
  }
  const totalAudioMs = bytesToAudioMs(totalBytes);
  const firstChunkBytes = first.bytes;
  const firstChunkMs = bytesToAudioMs(firstChunkBytes);

  const playbackStartWall = t0 + jitterBufferMs;
  let playCursorWall = playbackStartWall + firstChunkMs;
  const underruns: PlaybackUnderrun[] = [];
  let totalStarvedMs = 0;

  for (let i = 1; i < chunks.length; i += 1) {
    const chunk = chunks[i]!;
    const durMs = bytesToAudioMs(chunk.bytes);
    if (chunk.arrivedAtMs > playCursorWall) {
      const starvedMs = chunk.arrivedAtMs - playCursorWall;
      underruns.push({
        chunkIndex: i,
        gapStartMs: playCursorWall - t0,
        gapEndMs: chunk.arrivedAtMs - t0,
        starvedMs,
      });
      totalStarvedMs += starvedMs;
      playCursorWall = chunk.arrivedAtMs + durMs;
    } else {
      playCursorWall += durMs;
    }
  }

  const streamWallMs = Math.max(0, last.arrivedAtMs - t0);
  const streamRtf = chunks.length >= 2 && streamWallMs > 0 ? totalAudioMs / streamWallMs : null;

  return {
    jitterBufferMs,
    chunkCount: chunks.length,
    totalBytes,
    totalAudioMs,
    firstChunkBytes,
    firstChunkMs,
    streamWallMs,
    streamRtf,
    underrunCount: underruns.length,
    totalStarvedMs,
    underruns,
  };
}

/**
 * Verifies raw WS/REST containerless PCM16LE 24 kHz mono audio:
 * no RIFF/WAVE header, even byte count, and plausible speaking duration.
 */
export function checkRawPcm24kFormat(
  pcmBytes: Uint8Array,
  spokenText: string,
): RawPcmFormatCheck {
  const buf = Buffer.isBuffer(pcmBytes)
    ? pcmBytes
    : Buffer.from(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength);

  const hasRiffHeader =
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WAVE";
  const evenByteLength = buf.length % 2 === 0;
  const totalBytes = buf.length;
  const durationMs = bytesToAudioMs(totalBytes);
  const trimmedLen = spokenText.trim().length;
  const charsPerSec = durationMs > 0 && trimmedLen > 0 ? trimmedLen / (durationMs / 1000) : null;
  const plausibleDuration =
    trimmedLen === 0
      ? durationMs >= 0
      : durationMs >= 200 && charsPerSec !== null && charsPerSec >= 3 && charsPerSec <= 40;

  return {
    hasRiffHeader,
    evenByteLength,
    totalBytes,
    durationMs,
    charsPerSec,
    plausibleDuration,
    ok: !hasRiffHeader && evenByteLength && totalBytes > 0 && plausibleDuration,
  };
}
