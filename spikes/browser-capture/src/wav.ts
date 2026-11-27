export type WavSampleFormat = "pcm16" | "float32";

export interface ParsedWav {
  audioFormat: number;
  format: WavSampleFormat;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  sampleCount: number;
  durationMs: number;
  samples: Int16Array | Float32Array;
}

const WAV_HEADER_BYTES = 44;
const PCM_FORMAT_INT = 1;
const PCM_FORMAT_IEEE_FLOAT = 3;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += String.fromCharCode(bytes[offset + i] ?? 0);
  }
  return result;
}

function writeWavHeader(
  view: DataView,
  opts: {
    audioFormat: number;
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    dataByteLength: number;
  },
): void {
  const bytesPerSample = opts.bitsPerSample / 8;
  const blockAlign = opts.channels * bytesPerSample;
  const byteRate = opts.sampleRate * blockAlign;

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + opts.dataByteLength, true);
  writeAscii(view, 8, "WAVE");

  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, opts.audioFormat, true);
  view.setUint16(22, opts.channels, true);
  view.setUint32(24, opts.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, opts.bitsPerSample, true);

  writeAscii(view, 36, "data");
  view.setUint32(40, opts.dataByteLength, true);
}

function normalizeInt16Chunks(
  input: Int16Array | readonly Int16Array[],
): readonly Int16Array[] {
  return input instanceof Int16Array ? [input] : input;
}

function normalizeFloat32Chunks(
  input: Float32Array | readonly Float32Array[],
): readonly Float32Array[] {
  return input instanceof Float32Array ? [input] : input;
}

/**
 * Encodes PCM16LE samples into a standard 44-byte header RIFF/WAVE buffer.
 */
export function encodePcm16Wav(
  samples: Int16Array | readonly Int16Array[],
  sampleRate: number,
  channels = 1,
): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error(`Invalid sampleRate: ${sampleRate}`);
  }
  if (!Number.isInteger(channels) || channels <= 0) {
    throw new Error(`Invalid channels: ${channels}`);
  }

  const chunks = normalizeInt16Chunks(samples);
  let totalSamples = 0;
  for (const chunk of chunks) {
    totalSamples += chunk.length;
  }

  const dataByteLength = totalSamples * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataByteLength);
  const view = new DataView(buffer);

  writeWavHeader(view, {
    audioFormat: PCM_FORMAT_INT,
    sampleRate,
    channels,
    bitsPerSample: 16,
    dataByteLength,
  });

  let byteOffset = WAV_HEADER_BYTES;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      view.setInt16(byteOffset, chunk[i] ?? 0, true);
      byteOffset += 2;
    }
  }

  return new Uint8Array(buffer);
}

/**
 * Encodes 32-bit IEEE Float samples into a standard 44-byte header RIFF/WAVE buffer.
 */
export function encodeFloat32Wav(
  samples: Float32Array | readonly Float32Array[],
  sampleRate: number,
  channels = 1,
): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error(`Invalid sampleRate: ${sampleRate}`);
  }
  if (!Number.isInteger(channels) || channels <= 0) {
    throw new Error(`Invalid channels: ${channels}`);
  }

  const chunks = normalizeFloat32Chunks(samples);
  let totalSamples = 0;
  for (const chunk of chunks) {
    totalSamples += chunk.length;
  }

  const dataByteLength = totalSamples * 4;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataByteLength);
  const view = new DataView(buffer);

  writeWavHeader(view, {
    audioFormat: PCM_FORMAT_IEEE_FLOAT,
    sampleRate,
    channels,
    bitsPerSample: 32,
    dataByteLength,
  });

  let byteOffset = WAV_HEADER_BYTES;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      view.setFloat32(byteOffset, chunk[i] ?? 0, true);
      byteOffset += 4;
    }
  }

  return new Uint8Array(buffer);
}

/**
 * Parses a RIFF/WAVE buffer (PCM16LE or IEEE Float32LE) into typed samples and metadata.
 */
export function parseWav(bytes: Uint8Array): ParsedWav {
  if (bytes.byteLength < WAV_HEADER_BYTES) {
    throw new Error(`WAV buffer too short: ${bytes.byteLength} bytes`);
  }
  if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WAVE") {
    throw new Error("Invalid RIFF/WAVE header");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let foundFmt = false;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataByteLength = 0;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;

    if (chunkId === "fmt ") {
      if (bodyStart + 16 > bytes.byteLength) {
        throw new Error("Truncated fmt chunk");
      }
      audioFormat = view.getUint16(bodyStart, true);
      channels = view.getUint16(bodyStart + 2, true);
      sampleRate = view.getUint32(bodyStart + 4, true);
      bitsPerSample = view.getUint16(bodyStart + 14, true);
      foundFmt = true;
    } else if (chunkId === "data") {
      dataStart = bodyStart;
      dataByteLength = chunkSize;
      break;
    }

    // RIFF chunks are word-aligned (padded to an even byte count).
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (!foundFmt || dataStart < 0) {
    throw new Error("Missing fmt or data chunk in WAV");
  }
  if (dataStart + dataByteLength > bytes.byteLength) {
    throw new Error(
      `Truncated WAV data chunk: expected ${dataByteLength} bytes, got ${bytes.byteLength - dataStart}`,
    );
  }
  if (channels <= 0 || sampleRate <= 0) {
    throw new Error(`Invalid WAV format metadata: ch=${channels}, sr=${sampleRate}`);
  }

  if (audioFormat === PCM_FORMAT_INT && bitsPerSample === 16) {
    const sampleCount = Math.floor(dataByteLength / 2);
    const samples = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      samples[i] = view.getInt16(dataStart + i * 2, true);
    }
    const frameCount = sampleCount / channels;
    return {
      audioFormat,
      format: "pcm16",
      sampleRate,
      channels,
      bitsPerSample,
      sampleCount,
      durationMs: (frameCount / sampleRate) * 1000,
      samples,
    };
  }

  if (audioFormat === PCM_FORMAT_IEEE_FLOAT && bitsPerSample === 32) {
    const sampleCount = Math.floor(dataByteLength / 4);
    const samples = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      samples[i] = view.getFloat32(dataStart + i * 4, true);
    }
    const frameCount = sampleCount / channels;
    return {
      audioFormat,
      format: "float32",
      sampleRate,
      channels,
      bitsPerSample,
      sampleCount,
      durationMs: (frameCount / sampleRate) * 1000,
      samples,
    };
  }

  throw new Error(
    `Unsupported WAV format: audioFormat=${audioFormat}, bitsPerSample=${bitsPerSample}`,
  );
}
