import { readFile } from "node:fs/promises";

export interface WavData {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  pcm16: Int16Array;
  float32: Float32Array;
  durationMs: number;
}

export async function readPcm16Wav(filePath: string): Promise<WavData> {
  const buf = await readFile(filePath);
  if (buf.length < 44) {
    throw new Error(`WAV file too short: ${filePath}`);
  }
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Invalid RIFF/WAVE header in ${filePath}`);
  }

  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataLength = 0;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;

    if (chunkId === "fmt ") {
      audioFormat = buf.readUInt16LE(bodyStart);
      channels = buf.readUInt16LE(bodyStart + 2);
      sampleRate = buf.readUInt32LE(bodyStart + 4);
      bitsPerSample = buf.readUInt16LE(bodyStart + 14);
    } else if (chunkId === "data") {
      dataStart = bodyStart;
      dataLength = chunkSize;
      break;
    }

    // WAV chunks are word-aligned (padded to even byte boundary)
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (audioFormat !== 1 || channels !== 1 || sampleRate !== 16000 || bitsPerSample !== 16) {
    throw new Error(
      `Expected PCM16 mono 16kHz WAV, got format=${audioFormat}, ch=${channels}, sr=${sampleRate}, bits=${bitsPerSample}`,
    );
  }
  if (dataStart < 0 || dataStart + dataLength > buf.length) {
    throw new Error(`Missing or truncated data chunk in ${filePath}`);
  }

  const sampleCount = Math.floor(dataLength / 2);
  const pcm16 = new Int16Array(sampleCount);
  const float32 = new Float32Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    const sample = buf.readInt16LE(dataStart + i * 2);
    pcm16[i] = sample;
    float32[i] = sample / 32768;
  }

  return {
    sampleRate,
    channels,
    bitsPerSample,
    pcm16,
    float32,
    durationMs: (sampleCount / sampleRate) * 1000,
  };
}
