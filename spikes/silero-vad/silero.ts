import * as ort from "onnxruntime-node";

export const SILERO_SAMPLE_RATE = 16000;
export const SILERO_WINDOW_SAMPLES = 512; // 32 ms at 16 kHz
export const SILERO_CONTEXT_SAMPLES = 64; // v5 rolling context tail
const STATE_SIZE = 2 * 1 * 128;

export class SileroVad {
  private readonly session: ort.InferenceSession;
  private state: ort.Tensor;
  private context = new Float32Array(SILERO_CONTEXT_SAMPLES);
  private readonly inputBuffer = new Float32Array(
    SILERO_CONTEXT_SAMPLES + SILERO_WINDOW_SAMPLES,
  );
  private readonly srTensor: ort.Tensor;

  private constructor(session: ort.InferenceSession) {
    this.session = session;
    this.state = new ort.Tensor("float32", new Float32Array(STATE_SIZE), [2, 1, 128]);
    // Silero v5 ONNX expects scalar int64 or [1] int64 depending on export;
    // initialized cleanly after verifying metadata or scalar BigInt64Array.
    this.srTensor = new ort.Tensor("int64", BigInt64Array.from([BigInt(SILERO_SAMPLE_RATE)]), []);
  }

  static async create(modelPath: string): Promise<SileroVad> {
    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
    });
    return new SileroVad(session);
  }

  get inputNames(): readonly string[] {
    return this.session.inputNames;
  }

  get outputNames(): readonly string[] {
    return this.session.outputNames;
  }

  reset(): void {
    this.context.fill(0);
    this.state = new ort.Tensor("float32", new Float32Array(STATE_SIZE), [2, 1, 128]);
  }

  async probability(window512: Float32Array): Promise<number> {
    if (window512.length !== SILERO_WINDOW_SAMPLES) {
      throw new Error(
        `SileroVad expects ${SILERO_WINDOW_SAMPLES} samples, got ${window512.length}`,
      );
    }

    // Prepend 64-sample tail from the previous frame -> 576 samples total
    this.inputBuffer.set(this.context, 0);
    this.inputBuffer.set(window512, SILERO_CONTEXT_SAMPLES);

    const inputTensor = new ort.Tensor("float32", this.inputBuffer, [
      1,
      SILERO_CONTEXT_SAMPLES + SILERO_WINDOW_SAMPLES,
    ]);

    const results = await this.session.run({
      input: inputTensor,
      state: this.state,
      sr: this.srTensor,
    });

    const outProb = results.output;
    const outState = results.stateN;
    if (!outProb || !outState) {
      throw new Error(
        `Unexpected Silero outputs: got [${Object.keys(results).join(", ")}]`,
      );
    }

    this.state = outState;
    this.context.set(this.inputBuffer.subarray(SILERO_WINDOW_SAMPLES));

    const probData = outProb.data as Float32Array;
    return probData[0] ?? 0;
  }

  async dispose(): Promise<void> {
    await this.session.release();
  }
}
