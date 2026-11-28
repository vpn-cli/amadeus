import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const TTS_WAV_SAMPLE_RATE = 24000;
export const TTS_WAV_CHANNELS = 1;
export const TTS_WAV_BITS_PER_SAMPLE = 16;

export interface ParsedWavHeader {
  readonly audioFormat: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly bitsPerSample: number;
  readonly dataSize: number;
  readonly durationMs: number;
}

/**
 * Wraps raw PCM16LE mono 24 kHz bytes in a 44-byte RIFF/WAVE header.
 */
export function encodePcm16Wav(
  pcmBytes: Uint8Array,
  sampleRate: number = TTS_WAV_SAMPLE_RATE,
  channels: number = TTS_WAV_CHANNELS,
): Buffer {
  if (pcmBytes.byteLength % 2 !== 0) {
    throw new Error(`PCM16LE buffer length must be even, got ${pcmBytes.byteLength}`);
  }
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
  header.writeUInt16LE(TTS_WAV_BITS_PER_SAMPLE, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([
    header,
    Buffer.from(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength),
  ]);
}

export async function writePcm16Wav(
  filePath: string,
  pcmBytes: Uint8Array,
  sampleRate: number = TTS_WAV_SAMPLE_RATE,
  channels: number = TTS_WAV_CHANNELS,
): Promise<Buffer> {
  const wavBuf = encodePcm16Wav(pcmBytes, sampleRate, channels);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, wavBuf);
  return wavBuf;
}

export function parseWavHeader(buf: Uint8Array): ParsedWavHeader {
  const nodeBuf = Buffer.isBuffer(buf)
    ? buf
    : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (nodeBuf.length < 44) {
    throw new Error("WAV buffer shorter than 44 bytes");
  }
  if (nodeBuf.toString("ascii", 0, 4) !== "RIFF" || nodeBuf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Invalid RIFF/WAVE header");
  }
  const audioFormat = nodeBuf.readUInt16LE(20);
  const channels = nodeBuf.readUInt16LE(22);
  const sampleRate = nodeBuf.readUInt32LE(24);
  const bitsPerSample = nodeBuf.readUInt16LE(34);
  const dataSize = nodeBuf.readUInt32LE(40);
  const sampleCount = dataSize / (channels * (bitsPerSample / 8));
  return {
    audioFormat,
    channels,
    sampleRate,
    bitsPerSample,
    dataSize,
    durationMs: (sampleCount / sampleRate) * 1000,
  };
}
