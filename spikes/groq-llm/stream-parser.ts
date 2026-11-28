import {
  CurrentTimeArgsSchema,
  EXPECTED_ORDER_ID,
  OrderStatusArgsSchema,
} from "./config.js";

export interface RawToolCallDelta {
  readonly index?: number;
  readonly id?: string;
  readonly type?: string;
  readonly function?: {
    readonly name?: string;
    readonly arguments?: string;
  };
}

export interface RawStreamUsage {
  readonly queue_time?: number;
  readonly prompt_time?: number;
  readonly completion_time?: number;
  readonly total_time?: number;
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
  readonly completion_tokens_details?: {
    readonly reasoning_tokens?: number;
  };
}

export interface StreamErrorInfo {
  readonly message: string;
  readonly code: string | null;
  readonly type: string | null;
  readonly failedGeneration: string | null;
  readonly statusCode: number | null;
}

export interface RawStreamError {
  readonly message?: string;
  readonly type?: string;
  readonly code?: string;
  readonly failed_generation?: string;
  readonly status_code?: number;
}

export interface RawChatCompletionChunk {
  readonly id?: string;
  readonly model?: string;
  readonly error?: RawStreamError | string;
  readonly choices?: ReadonlyArray<{
    readonly index?: number;
    readonly finish_reason?: string | null;
    readonly delta?: {
      readonly role?: string;
      readonly content?: string | null;
      readonly reasoning?: string | null;
      readonly reasoning_content?: string | null;
      readonly tool_calls?: ReadonlyArray<RawToolCallDelta>;
    };
  }>;
  readonly usage?: RawStreamUsage;
  readonly x_groq?: {
    readonly id?: string;
    readonly usage?: RawStreamUsage;
  };
}

export interface AssembledToolCall {
  readonly index: number;
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly rawArguments: string;
  readonly parsedArguments: unknown;
  readonly validJson: boolean;
}

export interface StreamUsage {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly queueTimeMs: number | null;
  readonly promptTimeMs: number | null;
  readonly completionTimeMs: number | null;
  readonly totalTimeMs: number | null;
}

function secondsToMs(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value * 1000 : null;
}

export interface StreamDeltaStep {
  readonly done: boolean;
  readonly contentDelta: string;
  readonly isFirstContentDelta: boolean;
  readonly reasoningDelta: string;
  readonly hasToolCallDelta: boolean;
  readonly finishReason: string | null;
  readonly error: StreamErrorInfo | null;
}

export interface ParsedStreamResult {
  readonly content: string;
  readonly reasoning: string;
  readonly toolCalls: readonly AssembledToolCall[];
  readonly finishReason: string | null;
  readonly streamError: StreamErrorInfo | null;
  readonly usage: StreamUsage;
  readonly emittedContentBeforeToolCall: boolean;
  readonly chunkCount: number;
  readonly contentDeltaCount: number;
  readonly reasoningDeltaCount: number;
}

export interface ToolValidationResult {
  readonly calledAnyTool: boolean;
  readonly calledExpectedTool: boolean;
  readonly validJsonArgs: boolean;
  readonly validArgsSchema: boolean;
  readonly correctOrderId: boolean;
  readonly passed: boolean;
  readonly reason: string | null;
}

interface MutableToolCall {
  index: number;
  id: string;
  type: string;
  name: string;
  rawArguments: string;
}

/**
 * Pure OpenAI-compatible SSE payload parser and tool-call assembler.
 * Distinguishes reasoning deltas from spoken content deltas and tracks
 * whether content arrived before a tool call.
 */
export class GroqStreamAccumulator {
  private content = "";
  private reasoning = "";
  private readonly toolCalls = new Map<number, MutableToolCall>();
  private finishReason: string | null = null;
  private streamError: StreamErrorInfo | null = null;
  private usage: StreamUsage = {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    reasoningTokens: null,
    queueTimeMs: null,
    promptTimeMs: null,
    completionTimeMs: null,
    totalTimeMs: null,
  };
  private seenNonEmptyContent = false;
  private seenToolCall = false;
  private emittedContentBeforeToolCall = false;
  private chunkCount = 0;
  private contentDeltaCount = 0;
  private reasoningDeltaCount = 0;

  pushEventData(data: string, eventName?: string): StreamDeltaStep {
    const trimmed = data.trim();
    if (trimmed === "[DONE]") {
      return {
        done: true,
        contentDelta: "",
        isFirstContentDelta: false,
        reasoningDelta: "",
        hasToolCallDelta: false,
        finishReason: this.finishReason,
        error: null,
      };
    }

    let chunk: RawChatCompletionChunk;
    try {
      chunk = JSON.parse(trimmed) as RawChatCompletionChunk;
    } catch (err) {
      if (eventName === "error") {
        const streamErr: StreamErrorInfo = {
          message: trimmed.length > 0 ? trimmed : "SSE error event",
          code: null,
          type: null,
          failedGeneration: null,
          statusCode: null,
        };
        this.streamError = streamErr;
        return {
          done: false,
          contentDelta: "",
          isFirstContentDelta: false,
          reasoningDelta: "",
          hasToolCallDelta: false,
          finishReason: this.finishReason,
          error: streamErr,
        };
      }
      throw err;
    }

    this.chunkCount += 1;

    if (chunk.error !== undefined || eventName === "error") {
      const rawErr = chunk.error;
      let streamErr: StreamErrorInfo;
      if (typeof rawErr === "object" && rawErr !== null) {
        streamErr = {
          message:
            typeof rawErr.message === "string" && rawErr.message.trim().length > 0
              ? rawErr.message
              : JSON.stringify(rawErr),
          code: typeof rawErr.code === "string" ? rawErr.code : null,
          type: typeof rawErr.type === "string" ? rawErr.type : null,
          failedGeneration:
            typeof rawErr.failed_generation === "string" ? rawErr.failed_generation : null,
          statusCode: typeof rawErr.status_code === "number" ? rawErr.status_code : null,
        };
      } else if (typeof rawErr === "string") {
        streamErr = {
          message: rawErr,
          code: null,
          type: null,
          failedGeneration: null,
          statusCode: null,
        };
      } else {
        streamErr = {
          message: trimmed.length > 0 ? trimmed : "SSE error event",
          code: null,
          type: null,
          failedGeneration: null,
          statusCode: null,
        };
      }
      this.streamError = streamErr;
      return {
        done: false,
        contentDelta: "",
        isFirstContentDelta: false,
        reasoningDelta: "",
        hasToolCallDelta: false,
        finishReason: this.finishReason,
        error: streamErr,
      };
    }

    const usageSource = chunk.usage ?? chunk.x_groq?.usage;
    if (usageSource !== undefined) {
      this.usage = {
        promptTokens: usageSource.prompt_tokens ?? this.usage.promptTokens,
        completionTokens: usageSource.completion_tokens ?? this.usage.completionTokens,
        totalTokens: usageSource.total_tokens ?? this.usage.totalTokens,
        reasoningTokens:
          usageSource.completion_tokens_details?.reasoning_tokens ?? this.usage.reasoningTokens,
        queueTimeMs: secondsToMs(usageSource.queue_time) ?? this.usage.queueTimeMs,
        promptTimeMs: secondsToMs(usageSource.prompt_time) ?? this.usage.promptTimeMs,
        completionTimeMs: secondsToMs(usageSource.completion_time) ?? this.usage.completionTimeMs,
        totalTimeMs: secondsToMs(usageSource.total_time) ?? this.usage.totalTimeMs,
      };
    }

    const choice = chunk.choices?.[0];
    if (choice === undefined) {
      return {
        done: false,
        contentDelta: "",
        isFirstContentDelta: false,
        reasoningDelta: "",
        hasToolCallDelta: false,
        finishReason: this.finishReason,
        error: null,
      };
    }

    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      this.finishReason = choice.finish_reason;
    }

    const delta = choice.delta;
    const reasoningDelta = delta?.reasoning ?? delta?.reasoning_content ?? "";
    if (reasoningDelta.length > 0) {
      this.reasoning += reasoningDelta;
      this.reasoningDeltaCount += 1;
    }

    const contentDelta = delta?.content ?? "";
    let isFirstContentDelta = false;
    if (contentDelta.length > 0) {
      this.content += contentDelta;
      this.contentDeltaCount += 1;
      // Ignore pure leading whitespace before real text begins.
      if (!this.seenNonEmptyContent && this.content.trim().length > 0) {
        this.seenNonEmptyContent = true;
        isFirstContentDelta = true;
      }
    }

    let hasToolCallDelta = false;
    if (delta?.tool_calls !== undefined && delta.tool_calls.length > 0) {
      hasToolCallDelta = true;
      if (!this.seenToolCall) {
        this.seenToolCall = true;
        if (this.seenNonEmptyContent) {
          this.emittedContentBeforeToolCall = true;
        }
      }
      for (const tcDelta of delta.tool_calls) {
        const index = tcDelta.index ?? 0;
        let current = this.toolCalls.get(index);
        if (current === undefined) {
          current = {
            index,
            id: "",
            type: tcDelta.type ?? "function",
            name: "",
            rawArguments: "",
          };
          this.toolCalls.set(index, current);
        }
        if (tcDelta.id !== undefined) current.id += tcDelta.id;
        if (tcDelta.type !== undefined) current.type = tcDelta.type;
        if (tcDelta.function?.name !== undefined) current.name += tcDelta.function.name;
        if (tcDelta.function?.arguments !== undefined) {
          current.rawArguments += tcDelta.function.arguments;
        }
      }
    }

    return {
      done: false,
      contentDelta,
      isFirstContentDelta,
      reasoningDelta,
      hasToolCallDelta,
      finishReason: this.finishReason,
      error: null,
    };
  }

  result(): ParsedStreamResult {
    const assembled: AssembledToolCall[] = [...this.toolCalls.values()]
      .sort((a, b) => a.index - b.index)
      .map((tc) => {
        let parsedArguments: unknown = null;
        let validJson = false;
        try {
          parsedArguments = JSON.parse(tc.rawArguments);
          validJson = true;
        } catch {
          validJson = false;
        }
        return {
          index: tc.index,
          id: tc.id,
          type: tc.type,
          name: tc.name,
          rawArguments: tc.rawArguments,
          parsedArguments,
          validJson,
        };
      });

    return {
      content: this.content,
      reasoning: this.reasoning,
      toolCalls: assembled,
      finishReason: this.finishReason,
      streamError: this.streamError,
      usage: this.usage,
      emittedContentBeforeToolCall: this.emittedContentBeforeToolCall,
      chunkCount: this.chunkCount,
      contentDeltaCount: this.contentDeltaCount,
      reasoningDeltaCount: this.reasoningDeltaCount,
    };
  }
}

export function formatStreamErrorReason(streamError: StreamErrorInfo): string {
  const codePrefix = streamError.code ? `[${streamError.code}] ` : "";
  return `stream_error: ${codePrefix}${streamError.message}`;
}

function validateToolCallWithSchema<T>(
  toolCalls: readonly AssembledToolCall[],
  expectedToolName: string,
  schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false } },
  checkArgs?: (data: T) => { readonly ok: boolean; readonly correctOrderId: boolean; readonly failReason: string },
  streamError?: StreamErrorInfo | null,
): ToolValidationResult {
  if (streamError !== undefined && streamError !== null) {
    return {
      calledAnyTool: false,
      calledExpectedTool: false,
      validJsonArgs: false,
      validArgsSchema: false,
      correctOrderId: false,
      passed: false,
      reason: formatStreamErrorReason(streamError),
    };
  }

  if (toolCalls.length === 0) {
    return {
      calledAnyTool: false,
      calledExpectedTool: false,
      validJsonArgs: false,
      validArgsSchema: false,
      correctOrderId: false,
      passed: false,
      reason: "no_tool_call",
    };
  }

  const target = toolCalls.find((tc) => tc.name === expectedToolName);
  if (target === undefined) {
    return {
      calledAnyTool: true,
      calledExpectedTool: false,
      validJsonArgs: false,
      validArgsSchema: false,
      correctOrderId: false,
      passed: false,
      reason: `wrong_tool:${toolCalls[0]?.name ?? "unknown"}`,
    };
  }

  if (!target.validJson) {
    return {
      calledAnyTool: true,
      calledExpectedTool: true,
      validJsonArgs: false,
      validArgsSchema: false,
      correctOrderId: false,
      passed: false,
      reason: "invalid_json",
    };
  }

  const parsed = schema.safeParse(target.parsedArguments);
  if (!parsed.success) {
    return {
      calledAnyTool: true,
      calledExpectedTool: true,
      validJsonArgs: true,
      validArgsSchema: false,
      correctOrderId: false,
      passed: false,
      reason: "schema_mismatch",
    };
  }

  if (checkArgs === undefined) {
    return {
      calledAnyTool: true,
      calledExpectedTool: true,
      validJsonArgs: true,
      validArgsSchema: true,
      correctOrderId: false,
      passed: true,
      reason: null,
    };
  }

  const checked = checkArgs(parsed.data);
  return {
    calledAnyTool: true,
    calledExpectedTool: true,
    validJsonArgs: true,
    validArgsSchema: true,
    correctOrderId: checked.correctOrderId,
    passed: checked.ok,
    reason: checked.ok ? null : checked.failReason,
  };
}

export function validateOrderStatusToolCalls(
  toolCalls: readonly AssembledToolCall[],
  streamError?: StreamErrorInfo | null,
): ToolValidationResult {
  return validateToolCallWithSchema(
    toolCalls,
    "get_order_status",
    OrderStatusArgsSchema,
    (data) => {
      const correctOrderId = data.order_id === EXPECTED_ORDER_ID;
      return {
        ok: correctOrderId,
        correctOrderId,
        failReason: `wrong_order_id:${data.order_id}`,
      };
    },
    streamError,
  );
}

export function validateCurrentTimeToolCalls(
  toolCalls: readonly AssembledToolCall[],
  streamError?: StreamErrorInfo | null,
): ToolValidationResult {
  return validateToolCallWithSchema(
    toolCalls,
    "get_current_time",
    CurrentTimeArgsSchema,
    undefined,
    streamError,
  );
}

const CLAIMED_CHECK_PATTERN =
  /\b(?:checking|let me check|let me look(?:\s+(?:that|this|it))?\s+up|let me verify|i(?:'ll| will| am|'m)\s+(?:check|look(?:\s+(?:that|this|it))?\s+up|verify)|looking\s+(?:that|this|it)\s+up)\b/i;

/**
 * Detects replies that claim to be checking or looking something up
 * when no tool call was actually emitted.
 */
export function detectClaimedCheckWithoutToolCall(
  content: string,
  toolCallCount: number,
): boolean {
  if (toolCallCount > 0) return false;
  return CLAIMED_CHECK_PATTERN.test(content);
}

/**
 * Returns true when an HTTP 429 body indicates a daily token/request quota
 * (TPD/RPD) rather than a short per-minute (RPM/TPM) burst limit.
 */
export function isDailyRateLimitBody(bodyText: string): boolean {
  return /\((?:TPD|RPD)\)|tokens per day|requests per day/i.test(bodyText);
}
