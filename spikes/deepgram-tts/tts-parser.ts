import { z } from "zod";

export const SpeakCommandSchema = z.object({
  type: z.literal("Speak"),
  text: z.string(),
});

export const FlushCommandSchema = z.object({
  type: z.literal("Flush"),
});

export const ClearCommandSchema = z.object({
  type: z.literal("Clear"),
});

export const CloseCommandSchema = z.object({
  type: z.literal("Close"),
});

export type DeepgramTtsClientCommand =
  | z.infer<typeof SpeakCommandSchema>
  | z.infer<typeof FlushCommandSchema>
  | z.infer<typeof ClearCommandSchema>
  | z.infer<typeof CloseCommandSchema>;

export const DeepgramTtsMetadataSchema = z.object({
  type: z.literal("Metadata"),
  request_id: z.string(),
  model_name: z.string(),
  model_version: z.string(),
  model_uuid: z.string(),
  additional_model_uuids: z.array(z.string()).optional(),
});

export const DeepgramTtsFlushedSchema = z.object({
  type: z.literal("Flushed"),
  sequence_id: z.number().int(),
});

export const DeepgramTtsClearedSchema = z.object({
  type: z.literal("Cleared"),
  sequence_id: z.number().int(),
});

export const DeepgramTtsWarningRawSchema = z
  .object({
    type: z.literal("Warning"),
    description: z.string().optional(),
    code: z.string().optional(),
    warn_msg: z.string().optional(),
    warn_code: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

export const DeepgramTtsErrorRawSchema = z
  .object({
    type: z.literal("Error"),
    description: z.string().optional(),
    code: z.string().optional(),
    err_msg: z.string().optional(),
    err_code: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

export type DeepgramTtsMetadataMessage = z.infer<typeof DeepgramTtsMetadataSchema>;

export type NoticeCategory =
  | "flush_rate_limit"
  | "char_throughput"
  | "text_length"
  | "no_active_speech"
  | "unsupported_message"
  | "auth_or_permission"
  | "model_or_endpoint"
  | "rate_limit_429"
  | "server_error"
  | "other";

export interface ClassifiedServerNotice {
  readonly kind: "warning" | "error";
  readonly code: string;
  readonly description: string;
  readonly category: NoticeCategory;
  readonly raw: Record<string, unknown>;
}

export type ParsedDeepgramTtsMessage =
  | { readonly kind: "metadata"; readonly msg: DeepgramTtsMetadataMessage }
  | { readonly kind: "flushed"; readonly sequenceId: number }
  | { readonly kind: "cleared"; readonly sequenceId: number }
  | ClassifiedServerNotice
  | { readonly kind: "unknown"; readonly type: string; readonly raw: Record<string, unknown> };

export function classifyServerNotice(code: string, description: string): NoticeCategory {
  const haystack = `${code} ${description}`.toLowerCase();

  if (/flush/.test(haystack) && /(limit|many|20|60|cannot process|window|rate|throttl)/.test(haystack)) {
    return "flush_rate_limit";
  }
  if (/no_active_speech|no active speech/.test(haystack)) {
    return "no_active_speech";
  }
  if (/data-0001|throughput|2400|characters submitted in recent/.test(haystack)) {
    return "char_throughput";
  }
  if (/text_length|big-0000|big-0001|character limit|exceeds recommended length/.test(haystack)) {
    return "text_length";
  }
  if (/message-0000|data-0000|unsupported|not recognized|invalid command|unknown/.test(haystack)) {
    return "unsupported_message";
  }
  if (/401|403|unauth|invalid.*key|forbidden|permission/.test(haystack)) {
    return "auth_or_permission";
  }
  if (/404|model|endpoint|not supported|unavailable/.test(haystack)) {
    return "model_or_endpoint";
  }
  if (/429|too many requests|concurren/.test(haystack)) {
    return "rate_limit_429";
  }
  if (/internal_server_error|net-000|server error/.test(haystack)) {
    return "server_error";
  }
  return "other";
}

export function parseDeepgramTtsMessage(rawText: string): ParsedDeepgramTtsMessage {
  const obj = JSON.parse(rawText) as unknown;
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new Error("Deepgram TTS WS text message must be a JSON object");
  }
  const record = obj as Record<string, unknown>;
  const msgType = typeof record.type === "string" ? record.type : "unknown";

  if (msgType === "Metadata") {
    return { kind: "metadata", msg: DeepgramTtsMetadataSchema.parse(record) };
  }
  if (msgType === "Flushed") {
    const parsed = DeepgramTtsFlushedSchema.parse(record);
    return { kind: "flushed", sequenceId: parsed.sequence_id };
  }
  if (msgType === "Cleared") {
    const parsed = DeepgramTtsClearedSchema.parse(record);
    return { kind: "cleared", sequenceId: parsed.sequence_id };
  }
  if (msgType === "Warning") {
    const parsed = DeepgramTtsWarningRawSchema.parse(record);
    const code = parsed.code ?? parsed.warn_code ?? "UNKNOWN_WARNING";
    const description = parsed.description ?? parsed.warn_msg ?? parsed.message ?? "";
    return {
      kind: "warning",
      code,
      description,
      category: classifyServerNotice(code, description),
      raw: record,
    };
  }
  if (msgType === "Error") {
    const parsed = DeepgramTtsErrorRawSchema.parse(record);
    const code = parsed.code ?? parsed.err_code ?? "UNKNOWN_ERROR";
    const description = parsed.description ?? parsed.err_msg ?? parsed.message ?? "";
    return {
      kind: "error",
      code,
      description,
      category: classifyServerNotice(code, description),
      raw: record,
    };
  }

  return { kind: "unknown", type: msgType, raw: record };
}

export function serializeClientCommand(cmd: DeepgramTtsClientCommand): string {
  return JSON.stringify(cmd);
}

export type TtsMachineState =
  | "idle"
  | "streaming"
  | "flushing"
  | "discarding"
  | "closed"
  | "error";

export interface AudioChunkOutcome {
  readonly accepted: boolean;
  readonly discardedAfterClear: boolean;
}

export interface TurnMachineSnapshot {
  readonly state: TtsMachineState;
  readonly activeTurnAudioBytes: number;
  readonly activeTurnChunks: number;
  readonly postClearDiscardedBytes: number;
  readonly postClearDiscardedChunks: number;
  readonly clearToClearedMs: number | null;
  readonly flushedSequenceIds: readonly number[];
  readonly clearedSequenceIds: readonly number[];
  readonly warnings: readonly ClassifiedServerNotice[];
  readonly errors: readonly ClassifiedServerNotice[];
}

/**
 * Explicit turn state machine for a Deepgram TTS WebSocket connection.
 * Handles Clear -> discarding stale post-Clear audio until Cleared, then resets to idle.
 */
export class TtsTurnStateMachine {
  private state: TtsMachineState = "idle";
  private activeTurnAudioBytes = 0;
  private activeTurnChunks = 0;
  private clearSentAtMs: number | null = null;
  private clearToClearedMs: number | null = null;
  private postClearDiscardedBytes = 0;
  private postClearDiscardedChunks = 0;
  private readonly flushedSequenceIds: number[] = [];
  private readonly clearedSequenceIds: number[] = [];
  private readonly warnings: ClassifiedServerNotice[] = [];
  private readonly errors: ClassifiedServerNotice[] = [];

  getState(): TtsMachineState {
    return this.state;
  }

  startTurn(): void {
    if (this.state === "closed" || this.state === "error") {
      throw new Error(`Cannot start turn in state "${this.state}"`);
    }
    if (this.state === "discarding") {
      throw new Error("Cannot start turn while discarding post-Clear audio before Cleared");
    }
    this.state = "streaming";
    this.activeTurnAudioBytes = 0;
    this.activeTurnChunks = 0;
    this.clearSentAtMs = null;
    this.clearToClearedMs = null;
    this.postClearDiscardedBytes = 0;
    this.postClearDiscardedChunks = 0;
  }

  markFlushSent(): void {
    if (this.state === "streaming") {
      this.state = "flushing";
    }
  }

  markClearSent(atMs: number): void {
    if (this.state === "closed" || this.state === "error") return;
    this.state = "discarding";
    this.clearSentAtMs = atMs;
    this.postClearDiscardedBytes = 0;
    this.postClearDiscardedChunks = 0;
    this.clearToClearedMs = null;
  }

  onAudioChunk(bytes: number): AudioChunkOutcome {
    if (this.state === "discarding") {
      this.postClearDiscardedBytes += bytes;
      this.postClearDiscardedChunks += 1;
      return { accepted: false, discardedAfterClear: true };
    }
    if (this.state === "streaming" || this.state === "flushing") {
      this.activeTurnAudioBytes += bytes;
      this.activeTurnChunks += 1;
      return { accepted: true, discardedAfterClear: false };
    }
    return { accepted: false, discardedAfterClear: false };
  }

  onFlushed(sequenceId: number): void {
    this.flushedSequenceIds.push(sequenceId);
    if (this.state === "streaming" || this.state === "flushing") {
      this.state = "idle";
    }
  }

  onCleared(sequenceId: number, atMs: number): void {
    this.clearedSequenceIds.push(sequenceId);
    if (this.state === "discarding") {
      if (this.clearSentAtMs !== null) {
        this.clearToClearedMs = Math.max(0, atMs - this.clearSentAtMs);
      }
      this.state = "idle";
    }
  }

  onWarning(notice: ClassifiedServerNotice): void {
    this.warnings.push(notice);
  }

  onError(notice: ClassifiedServerNotice): void {
    this.errors.push(notice);
    this.state = "error";
  }

  onClose(): void {
    this.state = "closed";
  }

  snapshot(): TurnMachineSnapshot {
    return {
      state: this.state,
      activeTurnAudioBytes: this.activeTurnAudioBytes,
      activeTurnChunks: this.activeTurnChunks,
      postClearDiscardedBytes: this.postClearDiscardedBytes,
      postClearDiscardedChunks: this.postClearDiscardedChunks,
      clearToClearedMs: this.clearToClearedMs,
      flushedSequenceIds: [...this.flushedSequenceIds],
      clearedSequenceIds: [...this.clearedSequenceIds],
      warnings: [...this.warnings],
      errors: [...this.errors],
    };
  }
}
