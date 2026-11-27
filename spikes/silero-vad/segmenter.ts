export type SegmenterState = "idle" | "pending" | "speaking";

export type SpeechStartReason = "onset";
export type SpeechEndReason = "silence" | "max_duration" | "flush";

export interface SegmenterConfig {
  sampleRate: number;
  windowSamples: number;
  onsetThreshold: number;
  offsetThreshold: number;
  minSpeechMs: number;
  endSilenceMs: number;
  pendingGapMs: number;
  maxSpeechMs: number;
}

export const DEFAULT_SEGMENTER_CONFIG: SegmenterConfig = {
  sampleRate: 16000,
  windowSamples: 512,
  onsetThreshold: 0.5,
  offsetThreshold: 0.35,
  minSpeechMs: 250,
  endSilenceMs: 550,
  pendingGapMs: 96,
  maxSpeechMs: 30000,
};

export interface SpeechStartEvent {
  type: "speech_start";
  reason: SpeechStartReason;
  startMs: number;
  confirmedAtMs: number;
  onsetConfirmMs: number;
}

export interface SpeechEndEvent {
  type: "speech_end";
  reason: SpeechEndReason;
  startMs: number;
  endMs: number;
  durationMs: number;
  decidedAtMs: number;
  vadEndMs: number;
}

export type SegmenterEvent = SpeechStartEvent | SpeechEndEvent;

export interface DetectedSegment {
  index: number;
  startMs: number;
  confirmedAtMs: number;
  endMs: number;
  decidedAtMs: number;
  durationMs: number;
  onsetConfirmMs: number;
  vadEndMs: number;
  endReason: SpeechEndReason;
}

function msToSamples(ms: number, sampleRate: number): number {
  return Math.round((ms * sampleRate) / 1000);
}

function samplesToMs(samples: number, sampleRate: number): number {
  return Math.round((samples * 1000) / sampleRate);
}

/**
 * Pure sample-accurate hysteresis speech segmenter.
 * All internal positions and durations are tracked as integer sample counts;
 * conversion to milliseconds occurs strictly when emitting events.
 * Emits unpadded boundaries (`startMs` = start of first positive window);
 * pre-roll audio forwarding belongs to the downstream STT forwarding layer.
 */
export class VadSegmenter {
  readonly config: SegmenterConfig;

  private readonly minSpeechSamples: number;
  private readonly endSilenceSamples: number;
  private readonly pendingGapLimitSamples: number;
  private readonly maxSpeechSamples: number;

  private currentState: SegmenterState = "idle";
  private totalSamples = 0;

  private pendingOnsetSample = 0;
  private pendingVoicedSamples = 0;
  private pendingGapSamples = 0;
  private lastVoicedSample = 0;

  constructor(config: Partial<SegmenterConfig> = {}) {
    this.config = { ...DEFAULT_SEGMENTER_CONFIG, ...config };
    const {
      sampleRate,
      windowSamples,
      onsetThreshold,
      offsetThreshold,
      minSpeechMs,
      endSilenceMs,
      pendingGapMs,
      maxSpeechMs,
    } = this.config;

    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new RangeError(`sampleRate must be a positive integer, got ${sampleRate}`);
    }
    if (!Number.isInteger(windowSamples) || windowSamples <= 0) {
      throw new RangeError(`windowSamples must be a positive integer, got ${windowSamples}`);
    }
    if (offsetThreshold < 0 || onsetThreshold > 1 || offsetThreshold > onsetThreshold) {
      throw new RangeError(
        `Invalid thresholds: offset=${offsetThreshold}, onset=${onsetThreshold}`,
      );
    }
    if (minSpeechMs < 0 || endSilenceMs < 0 || pendingGapMs < 0 || maxSpeechMs <= 0) {
      throw new RangeError("Timing configuration values must be non-negative (maxSpeechMs > 0)");
    }

    this.minSpeechSamples = msToSamples(minSpeechMs, sampleRate);
    this.endSilenceSamples = msToSamples(endSilenceMs, sampleRate);
    this.pendingGapLimitSamples = msToSamples(pendingGapMs, sampleRate);
    this.maxSpeechSamples = msToSamples(maxSpeechMs, sampleRate);
  }

  get state(): SegmenterState {
    return this.currentState;
  }

  get processedSamples(): number {
    return this.totalSamples;
  }

  reset(): void {
    this.currentState = "idle";
    this.totalSamples = 0;
    this.clearPending();
  }

  push(probability: number): SegmenterEvent[] {
    if (!Number.isFinite(probability)) {
      throw new RangeError(`probability must be a finite number, got ${probability}`);
    }

    const windowStartSample = this.totalSamples;
    const windowEndSample = windowStartSample + this.config.windowSamples;
    this.totalSamples = windowEndSample;

    const events: SegmenterEvent[] = [];

    if (this.currentState === "idle") {
      if (probability >= this.config.onsetThreshold) {
        this.currentState = "pending";
        this.pendingOnsetSample = windowStartSample;
        this.pendingVoicedSamples = this.config.windowSamples;
        this.pendingGapSamples = 0;
        this.lastVoicedSample = windowEndSample;
        this.maybePromotePending(windowEndSample, events);
      }
      return events;
    }

    if (this.currentState === "pending") {
      if (probability >= this.config.offsetThreshold) {
        this.pendingGapSamples = 0;
        this.pendingVoicedSamples += this.config.windowSamples;
        this.lastVoicedSample = windowEndSample;
        this.maybePromotePending(windowEndSample, events);
      } else {
        this.pendingGapSamples += this.config.windowSamples;
        if (this.pendingGapSamples > this.pendingGapLimitSamples) {
          this.clearPending();
        }
      }
      return events;
    }

    // state === "speaking"
    const isVoiced = probability >= this.config.offsetThreshold;
    if (isVoiced) {
      this.lastVoicedSample = windowEndSample;
    }

    if (!isVoiced && windowEndSample - this.lastVoicedSample >= this.endSilenceSamples) {
      events.push(this.emitSpeechEnd("silence", this.lastVoicedSample, windowEndSample));
      return events;
    }

    if (windowEndSample - this.pendingOnsetSample > this.maxSpeechSamples) {
      events.push(this.emitSpeechEnd("max_duration", this.lastVoicedSample, windowEndSample));
    }

    return events;
  }

  flush(): SegmenterEvent[] {
    if (this.currentState === "speaking") {
      return [this.emitSpeechEnd("flush", this.lastVoicedSample, this.totalSamples)];
    }
    if (this.currentState === "pending") {
      this.clearPending();
    }
    return [];
  }

  private maybePromotePending(windowEndSample: number, events: SegmenterEvent[]): void {
    if (this.pendingVoicedSamples < this.minSpeechSamples) {
      return;
    }

    this.currentState = "speaking";
    const sr = this.config.sampleRate;
    events.push({
      type: "speech_start",
      reason: "onset",
      startMs: samplesToMs(this.pendingOnsetSample, sr),
      confirmedAtMs: samplesToMs(windowEndSample, sr),
      onsetConfirmMs: samplesToMs(windowEndSample - this.pendingOnsetSample, sr),
    });

    if (windowEndSample - this.pendingOnsetSample > this.maxSpeechSamples) {
      events.push(this.emitSpeechEnd("max_duration", this.lastVoicedSample, windowEndSample));
    }
  }

  private emitSpeechEnd(
    reason: SpeechEndReason,
    endSample: number,
    decidedAtSample: number,
  ): SpeechEndEvent {
    const sr = this.config.sampleRate;
    const event: SpeechEndEvent = {
      type: "speech_end",
      reason,
      startMs: samplesToMs(this.pendingOnsetSample, sr),
      endMs: samplesToMs(endSample, sr),
      durationMs: samplesToMs(endSample - this.pendingOnsetSample, sr),
      decidedAtMs: samplesToMs(decidedAtSample, sr),
      vadEndMs: samplesToMs(decidedAtSample - endSample, sr),
    };
    this.clearPending();
    return event;
  }

  private clearPending(): void {
    this.currentState = "idle";
    this.pendingOnsetSample = 0;
    this.pendingVoicedSamples = 0;
    this.pendingGapSamples = 0;
    this.lastVoicedSample = 0;
  }
}

export function collectSegmentsFromEvents(events: readonly SegmenterEvent[]): DetectedSegment[] {
  const segments: DetectedSegment[] = [];
  let activeStart: SpeechStartEvent | null = null;

  for (const ev of events) {
    if (ev.type === "speech_start") {
      activeStart = ev;
    } else if (ev.type === "speech_end" && activeStart !== null) {
      segments.push({
        index: segments.length + 1,
        startMs: ev.startMs,
        confirmedAtMs: activeStart.confirmedAtMs,
        endMs: ev.endMs,
        decidedAtMs: ev.decidedAtMs,
        durationMs: ev.durationMs,
        onsetConfirmMs: activeStart.onsetConfirmMs,
        vadEndMs: ev.vadEndMs,
        endReason: ev.reason,
      });
      activeStart = null;
    }
  }

  return segments;
}

export function segmentProbabilities(
  probabilities: readonly number[],
  config: Partial<SegmenterConfig> = {},
): { events: SegmenterEvent[]; segments: DetectedSegment[] } {
  const segmenter = new VadSegmenter(config);
  const events: SegmenterEvent[] = [];
  for (const prob of probabilities) {
    events.push(...segmenter.push(prob));
  }
  events.push(...segmenter.flush());
  return {
    events,
    segments: collectSegmentsFromEvents(events),
  };
}
