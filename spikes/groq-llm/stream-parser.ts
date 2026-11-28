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

export interface RawChatCompletionChunk {
  readonly id?: string;
  readonly model?: string;
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
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
    readonly completion_tokens_details?: {
      readonly reasoning_tokens?: number;
    };
  };
  readonly x_groq?: {
    readonly usage?: {
      readonly prompt_tokens?: number;
      readonly completion_tokens?: number;
      readonly total_tokens?: number;
      readonly completion_tokens_details?: {
        readonly reasoning_tokens?: number;
      };
    };
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
}

export interface StreamDeltaStep {
  readonly done: boolean;
  readonly contentDelta: string;
  readonly isFirstContentDelta: boolean;
  readonly reasoningDelta: string;
  readonly hasToolCallDelta: boolean;
  readonly finishReason: string | null;
}

export interface ParsedStreamResult {
  readonly content: string;
  readonly reasoning: string;
  readonly toolCalls: readonly AssembledToolCall[];
  readonly finishReason: string | null;
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
  private usage: StreamUsage = {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    reasoningTokens: null,
  };
  private seenNonEmptyContent = false;
  private seenToolCall = false;
  private emittedContentBeforeToolCall = false;
  private chunkCount = 0;
  private contentDeltaCount = 0;
  private reasoningDeltaCount = 0;

  pushEventData(data: string): StreamDeltaStep {
    const trimmed = data.trim();
    if (trimmed === "[DONE]") {
      return {
        done: true,
        contentDelta: "",
        isFirstContentDelta: false,
        reasoningDelta: "",
        hasToolCallDelta: false,
        finishReason: this.finishReason,
      };
    }

    const chunk = JSON.parse(trimmed) as RawChatCompletionChunk;
    this.chunkCount += 1;

    const usageSource = chunk.usage ?? chunk.x_groq?.usage;
    if (usageSource !== undefined) {
      this.usage = {
        promptTokens: usageSource.prompt_tokens ?? this.usage.promptTokens,
        completionTokens: usageSource.completion_tokens ?? this.usage.completionTokens,
        totalTokens: usageSource.total_tokens ?? this.usage.totalTokens,
        reasoningTokens:
          usageSource.completion_tokens_details?.reasoning_tokens ?? this.usage.reasoningTokens,
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
      usage: this.usage,
      emittedContentBeforeToolCall: this.emittedContentBeforeToolCall,
      chunkCount: this.chunkCount,
      contentDeltaCount: this.contentDeltaCount,
      reasoningDeltaCount: this.reasoningDeltaCount,
    };
  }
}

function validateToolCallWithSchema<T>(
  toolCalls: readonly AssembledToolCall[],
  expectedToolName: string,
  schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false } },
  checkArgs?: (data: T) => { readonly ok: boolean; readonly correctOrderId: boolean; readonly failReason: string },
): ToolValidationResult {
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
): ToolValidationResult {
  return validateToolCallWithSchema(toolCalls, "get_order_status", OrderStatusArgsSchema, (data) => {
    const correctOrderId = data.order_id === EXPECTED_ORDER_ID;
    return {
      ok: correctOrderId,
      correctOrderId,
      failReason: `wrong_order_id:${data.order_id}`,
    };
  });
}

export function validateCurrentTimeToolCalls(
  toolCalls: readonly AssembledToolCall[],
): ToolValidationResult {
  return validateToolCallWithSchema(toolCalls, "get_current_time", CurrentTimeArgsSchema);
}
