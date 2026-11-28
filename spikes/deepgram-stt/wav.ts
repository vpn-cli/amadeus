import { readFile } from "node:fs/promises";

export const EXPECTED_SAMPLE_RATE = 16000;
export const EXPECTED_CHANNELS = 1;
export const EXPECTED_BITS_PER_SAMPLE = 16;

export interface Pcm16WavData {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly pcmBytes: Uint8Array;
  readonly sampleCount: number;
  readonly durationMs: number;
}

/**
 * Reads a PCM16LE mono 16 kHz RIFF/WAVE file into raw little-endian PCM bytes.
 */
export async function readPcm16Wav(filePath: string): Promise<Pcm16WavData> {
  const buf = await readFile(filePath);
  return parsePcm16WavBuffer(buf, filePath);
}

export function parsePcm16WavBuffer(buf: Uint8Array, label = "<buffer>"): Pcm16WavData {
  const nodeBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (nodeBuf.length < 44) {
    throw new Error(`WAV file too short: ${label}`);
  }
  if (nodeBuf.toString("ascii", 0, 4) !== "RIFF" || nodeBuf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Invalid RIFF/WAVE header in ${label}`);
  }

  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataLength = 0;

  while (offset + 8 <= nodeBuf.length) {
    const chunkId = nodeBuf.toString("ascii", offset, offset + 4);
    const chunkSize = nodeBuf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;

    if (chunkId === "fmt ") {
      audioFormat = nodeBuf.readUInt16LE(bodyStart);
      channels = nodeBuf.readUInt16LE(bodyStart + 2);
      sampleRate = nodeBuf.readUInt32LE(bodyStart + 4);
      bitsPerSample = nodeBuf.readUInt16LE(bodyStart + 14);
    } else if (chunkId === "data") {
      dataStart = bodyStart;
      dataLength = chunkSize;
      break;
    }

    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (
    audioFormat !== 1 ||
    channels !== EXPECTED_CHANNELS ||
    sampleRate !== EXPECTED_SAMPLE_RATE ||
    bitsPerSample !== EXPECTED_BITS_PER_SAMPLE
  ) {
    throw new Error(
      `Expected PCM16LE mono 16 kHz WAV, got format=${audioFormat}, ch=${channels}, sr=${sampleRate}, bits=${bitsPerSample}`,
    );
  }
  if (dataStart < 0 || dataStart + dataLength > nodeBuf.length) {
    throw new Error(`Missing or truncated data chunk in ${label}`);
  }

  const usableBytes = dataLength - (dataLength % 2);
  const pcmBytes = new Uint8Array(
    nodeBuf.buffer.slice(nodeBuf.byteOffset + dataStart, nodeBuf.byteOffset + dataStart + usableBytes),
  );
  const sampleCount = usableBytes / 2;

  return {
    sampleRate,
    channels,
    bitsPerSample,
    pcmBytes,
    sampleCount,
    durationMs: (sampleCount / sampleRate) * 1000,
  };
}

/**
 * Wraps raw PCM16LE bytes into a 44-byte RIFF/WAVE buffer for Whisper upload.
 */
export function encodePcm16Wav(
  pcmBytes: Uint8Array,
  sampleRate: number = EXPECTED_SAMPLE_RATE,
  channels: number = EXPECTED_CHANNELS,
): Buffer {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmBytes.byteLength;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, Buffer.from(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength)]);
}
