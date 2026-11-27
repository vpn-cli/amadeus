import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as ort from "onnxruntime-node";

const MODEL_URL =
  "https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx";

export const DEFAULT_MODEL_PATH = resolve(import.meta.dirname, "out", "silero_vad.onnx");

export async function ensureModel(modelPath = DEFAULT_MODEL_PATH): Promise<string> {
  try {
    const info = await stat(modelPath);
    if (info.size > 0) {
      return modelPath;
    }
  } catch {
    // Download below if missing
  }

  await mkdir(dirname(modelPath), { recursive: true });
  console.log(`Downloading Silero VAD v5 ONNX model from ${MODEL_URL}...`);
  const res = await fetch(MODEL_URL);
  if (!res.ok) {
    throw new Error(`Failed to download model: ${res.status} ${res.statusText}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  await writeFile(modelPath, bytes);
  console.log(`Saved ${bytes.byteLength} bytes to ${modelPath}`);
  return modelPath;
}

if (import.meta.url === new URL(`file:///${process.argv[1]?.replace(/\\/g, "/")}`).href) {
  const path = await ensureModel();
  const session = await ort.InferenceSession.create(path);
  console.log("Model inputs:", session.inputNames);
  console.log("Model input metadata:", session.inputMetadata);
  console.log("Model outputs:", session.outputNames);
  console.log("Model output metadata:", session.outputMetadata);
}
