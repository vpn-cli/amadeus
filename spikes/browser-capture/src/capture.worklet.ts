import { createResampler, float32ToInt16, type StreamingResampler } from "./resampler";

const TARGET_SAMPLE_RATE = 16000;
const FRAME_SAMPLES_16K = 320; // 20 ms at 16 kHz
const RAW_FLUSH_TARGET = 1024; // ~21 ms at 48 kHz

export type WorkletInboundMessage = {
  type: "stop";
};

export type WorkletOutboundMessage =
  | {
      type: "meta";
      sampleRate: number;
      channelCount: number;
    }
  | {
      type: "frame";
      seq: number;
      pcm16: Int16Array;
      rms: number;
    }
  | {
      type: "raw";
      samples: Float32Array;
    };

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly nativeSampleRate: number;
  private readonly resampler: StreamingResampler;
  private readonly frameBuffer = new Float32Array(FRAME_SAMPLES_16K);
  private frameOffset = 0;
  private nextSeq = 0;

  private monoScratch = new Float32Array(128);
  private rawBuffer = new Float32Array(RAW_FLUSH_TARGET * 2);
  private rawOffset = 0;

  private reportedChannels = -1;
  private stopped = false;

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    const scopeRate = (globalThis as { sampleRate?: number }).sampleRate;
    const optRate = (options?.processorOptions as { sampleRate?: number } | undefined)
      ?.sampleRate;
    const rate =
      typeof scopeRate === "number" && scopeRate > 0
        ? scopeRate
        : typeof optRate === "number" && optRate > 0
          ? optRate
          : 48000;

    this.nativeSampleRate = rate;
    this.resampler = createResampler({
      inputRate: rate,
      outputRate: TARGET_SAMPLE_RATE,
    });

    this.port.onmessage = (event: MessageEvent<WorkletInboundMessage>) => {
      if (event.data?.type === "stop") {
        this.stopped = true;
        this.flushRaw();
        // Deliberately drop any trailing partial (< 320 samples) resampled frame.
        this.frameOffset = 0;
      }
    };
  }

  private flushRaw(): void {
    if (this.rawOffset === 0) {
      return;
    }
    const copy = this.rawBuffer.slice(0, this.rawOffset);
    this.rawOffset = 0;
    const msg: WorkletOutboundMessage = { type: "raw", samples: copy };
    this.port.postMessage(msg, [copy.buffer]);
  }

  private appendRaw(mono: Float32Array): void {
    const needed = this.rawOffset + mono.length;
    if (needed > this.rawBuffer.length) {
      const grown = new Float32Array(Math.max(this.rawBuffer.length * 2, needed));
      grown.set(this.rawBuffer.subarray(0, this.rawOffset));
      this.rawBuffer = grown;
    }
    this.rawBuffer.set(mono, this.rawOffset);
    this.rawOffset += mono.length;

    if (this.rawOffset >= RAW_FLUSH_TARGET) {
      this.flushRaw();
    }
  }

  override process(inputs: Float32Array[][]): boolean {
    if (this.stopped) {
      return false;
    }

    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const firstChannel = input[0];
    if (!firstChannel || firstChannel.length === 0) {
      return true;
    }

    const channelCount = input.length;
    const quantumLength = firstChannel.length;

    if (channelCount !== this.reportedChannels) {
      this.reportedChannels = channelCount;
      const meta: WorkletOutboundMessage = {
        type: "meta",
        sampleRate: this.nativeSampleRate,
        channelCount,
      };
      this.port.postMessage(meta);
    }

    let mono: Float32Array;
    if (channelCount === 1) {
      mono = firstChannel;
    } else {
      if (this.monoScratch.length < quantumLength) {
        this.monoScratch = new Float32Array(quantumLength);
      }
      for (let i = 0; i < quantumLength; i++) {
        let sum = 0;
        for (let ch = 0; ch < channelCount; ch++) {
          sum += input[ch]?.[i] ?? 0;
        }
        this.monoScratch[i] = sum / channelCount;
      }
      mono = this.monoScratch.subarray(0, quantumLength);
    }

    this.appendRaw(mono);

    const resampled = this.resampler.process(mono);
    let readIdx = 0;
    while (readIdx < resampled.length) {
      const space = FRAME_SAMPLES_16K - this.frameOffset;
      const toCopy = Math.min(space, resampled.length - readIdx);
      this.frameBuffer.set(
        resampled.subarray(readIdx, readIdx + toCopy),
        this.frameOffset,
      );
      this.frameOffset += toCopy;
      readIdx += toCopy;

      if (this.frameOffset === FRAME_SAMPLES_16K) {
        let sumSq = 0;
        for (let i = 0; i < FRAME_SAMPLES_16K; i++) {
          const s = this.frameBuffer[i] ?? 0;
          sumSq += s * s;
        }
        const rms = Math.sqrt(sumSq / FRAME_SAMPLES_16K);
        const pcm16 = float32ToInt16(this.frameBuffer);
        const seq = this.nextSeq++;
        const msg: WorkletOutboundMessage = {
          type: "frame",
          seq,
          pcm16,
          rms,
        };
        this.port.postMessage(msg, [pcm16.buffer]);
        this.frameOffset = 0;
      }
    }

    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
