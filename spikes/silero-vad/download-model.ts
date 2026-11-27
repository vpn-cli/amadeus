import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as ort from "onnxruntime-node";

export const SILERO_MODEL_TAG = "v6.3";
export const SILERO_MODEL_SHA256 =
  "f6f4407b41e05e277e7f5cfd9b9ae957b1dfe763c6076a934734c0b448e09b31";

const MODEL_URL = `https://raw.githubusercontent.com/snakers4/silero-vad/${SILERO_MODEL_TAG}/src/silero_vad/data/silero_vad.onnx`;

export const DEFAULT_MODEL_PATH = resolve(import.meta.dirname, "out", "silero_vad.onnx");

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function ensureModel(modelPath = DEFAULT_MODEL_PATH): Promise<string> {
  try {
    const info = await stat(modelPath);
    if (info.size > 0) {
      const existing = await readFile(modelPath);
      const actualHash = sha256Hex(existing);
      if (actualHash === SILERO_MODEL_SHA256) {
        return modelPath;
      }
      console.warn(
        `Existing model at ${modelPath} has SHA-256 ${actualHash}, expected ${SILERO_MODEL_SHA256}; re-downloading ${SILERO_MODEL_TAG}...`,
      );
    }
  } catch {
    // Download below if missing
  }

  await mkdir(dirname(modelPath), { recursive: true });
  console.log(`Downloading Silero VAD ${SILERO_MODEL_TAG} ONNX model from ${MODEL_URL}...`);
  const res = await fetch(MODEL_URL);
  if (!res.ok) {
    throw new Error(`Failed to download model: ${res.status} ${res.statusText}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const actualHash = sha256Hex(bytes);
  if (actualHash !== SILERO_MODEL_SHA256) {
    throw new Error(
      `SHA-256 mismatch for Silero VAD ${SILERO_MODEL_TAG}: expected ${SILERO_MODEL_SHA256}, got ${actualHash}`,
    );
  }

  await writeFile(modelPath, bytes);
  console.log(`Saved ${bytes.byteLength} bytes to ${modelPath} (sha256: ${actualHash})`);
  return modelPath;
}

if (import.meta.url === new URL(`file:///${process.argv[1]?.replace(/\\/g, "/")}`).href) {
  const path = await ensureModel();
  const session = await ort.InferenceSession.create(path);
  console.log(`Model tag: ${SILERO_MODEL_TAG} (sha256: ${SILERO_MODEL_SHA256})`);
  console.log("Model inputs:", session.inputNames);
  console.log("Model input metadata:", session.inputMetadata);
  console.log("Model outputs:", session.outputNames);
  console.log("Model output metadata:", session.outputMetadata);
  await session.release();
}
