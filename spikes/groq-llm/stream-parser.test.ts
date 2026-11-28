import { describe, expect, it } from "vitest";
import {
  GroqStreamAccumulator,
  detectClaimedCheckWithoutToolCall,
  isDailyRateLimitBody,
  validateCurrentTimeToolCalls,
  validateOrderStatusToolCalls,
} from "./stream-parser.js";

describe("GroqStreamAccumulator", () => {
  it("ignores empty content and reasoning chunks for TTFT and tracks reasoning tokens", () => {
    const acc = new GroqStreamAccumulator();

    const s1 = acc.pushEventData(
      JSON.stringify({ choices: [{ delta: { role: "assistant", content: "" } }] }),
    );
    expect(s1.isFirstContentDelta).toBe(false);

    const s2 = acc.pushEventData(
      JSON.stringify({ choices: [{ delta: { reasoning: "Thinking..." } }] }),
    );
    expect(s2.isFirstContentDelta).toBe(false);
    expect(s2.reasoningDelta).toBe("Thinking...");

    const s3 = acc.pushEventData(
      JSON.stringify({ choices: [{ delta: { content: "   " } }] }),
    );
    expect(s3.isFirstContentDelta).toBe(false);

    const s4 = acc.pushEventData(
      JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }),
    );
    expect(s4.isFirstContentDelta).toBe(true);

    const s5 = acc.pushEventData(
      JSON.stringify({
        choices: [{ delta: { content: " there." }, finish_reason: "stop" }],
        x_groq: {
          usage: {
            prompt_tokens: 12,
            completion_tokens: 8,
            total_tokens: 20,
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        },
      }),
    );
    expect(s5.isFirstContentDelta).toBe(false);
    expect(acc.pushEventData("[DONE]").done).toBe(true);

    const res = acc.result();
    expect(res.content).toBe("   Hello there.");
    expect(res.reasoning).toBe("Thinking...");
    expect(res.finishReason).toBe("stop");
    expect(res.usage).toEqual({
      promptTokens: 12,
      completionTokens: 8,
      totalTokens: 20,
      reasoningTokens: 5,
      queueTimeMs: null,
      promptTimeMs: null,
      completionTimeMs: null,
      totalTimeMs: null,
    });
    expect(res.emittedContentBeforeToolCall).toBe(false);
  });

  it("extracts Groq server-side queue/prompt/completion/total timings in milliseconds", () => {
    const acc = new GroqStreamAccumulator();
    acc.pushEventData(
      JSON.stringify({
        choices: [{ delta: { content: "Hi." }, finish_reason: "stop" }],
        x_groq: {
          id: "req_123",
          usage: {
            queue_time: 0.042,
            prompt_tokens: 50,
            prompt_time: 0.0085,
            completion_tokens: 10,
            completion_time: 0.0195,
            total_tokens: 60,
            total_time: 0.028,
          },
        },
      }),
    );
    acc.pushEventData("[DONE]");
    const res = acc.result();
    expect(res.usage.queueTimeMs).toBeCloseTo(42, 6);
    expect(res.usage.promptTimeMs).toBeCloseTo(8.5, 6);
    expect(res.usage.completionTimeMs).toBeCloseTo(19.5, 6);
    expect(res.usage.totalTimeMs).toBeCloseTo(28, 6);
  });

  it("assembles fragmented tool calls by index and detects pre-tool filler content", () => {
    const acc = new GroqStreamAccumulator();

    acc.pushEventData(
      JSON.stringify({ choices: [{ delta: { content: "Let me check " } }] }),
    );
    acc.pushEventData(
      JSON.stringify({ choices: [{ delta: { content: "that for you." } }] }),
    );
    acc.pushEventData(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc",
                  type: "function",
                  function: { name: "get_order_", arguments: '{"order_' },
                },
              ],
            },
          },
        ],
      }),
    );
    acc.pushEventData(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { name: "status", arguments: 'id":"1042"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );

    const res = acc.result();
    expect(res.emittedContentBeforeToolCall).toBe(true);
    expect(res.content).toBe("Let me check that for you.");
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]).toEqual({
      index: 0,
      id: "call_abc",
      type: "function",
      name: "get_order_status",
      rawArguments: '{"order_id":"1042"}',
      parsedArguments: { order_id: "1042" },
      validJson: true,
    });

    const validation = validateOrderStatusToolCalls(res.toolCalls);
    expect(validation).toEqual({
      calledAnyTool: true,
      calledExpectedTool: true,
      validJsonArgs: true,
      validArgsSchema: true,
      correctOrderId: true,
      passed: true,
      reason: null,
    });
  });

  it("flags wrong tool, invalid json, and wrong order_id", () => {
    expect(
      validateOrderStatusToolCalls([
        {
          index: 0,
          id: "1",
          type: "function",
          name: "get_current_time",
          rawArguments: "{}",
          parsedArguments: {},
          validJson: true,
        },
      ]).reason,
    ).toBe("wrong_tool:get_current_time");

    expect(
      validateOrderStatusToolCalls([
        {
          index: 0,
          id: "1",
          type: "function",
          name: "get_order_status",
          rawArguments: "{bad",
          parsedArguments: null,
          validJson: false,
        },
      ]).reason,
    ).toBe("invalid_json");

    expect(
      validateOrderStatusToolCalls([
        {
          index: 0,
          id: "1",
          type: "function",
          name: "get_order_status",
          rawArguments: '{"order_id":"1043"}',
          parsedArguments: { order_id: "1043" },
          validJson: true,
        },
      ]),
    ).toMatchObject({
      calledExpectedTool: true,
      validJsonArgs: true,
      validArgsSchema: true,
      correctOrderId: false,
      passed: false,
      reason: "wrong_order_id:1043",
    });
  });

  it("validates get_current_time tool calls with optional timezone", () => {
    expect(
      validateCurrentTimeToolCalls([
        {
          index: 0,
          id: "t1",
          type: "function",
          name: "get_current_time",
          rawArguments: "{}",
          parsedArguments: {},
          validJson: true,
        },
      ]),
    ).toEqual({
      calledAnyTool: true,
      calledExpectedTool: true,
      validJsonArgs: true,
      validArgsSchema: true,
      correctOrderId: false,
      passed: true,
      reason: null,
    });

    expect(
      validateCurrentTimeToolCalls([
        {
          index: 0,
          id: "t2",
          type: "function",
          name: "get_current_time",
          rawArguments: '{"timezone":"Asia/Kolkata"}',
          parsedArguments: { timezone: "Asia/Kolkata" },
          validJson: true,
        },
      ]).passed,
    ).toBe(true);

    expect(
      validateCurrentTimeToolCalls([
        {
          index: 0,
          id: "t2b",
          type: "function",
          name: "get_current_time",
          rawArguments: '{"timezone":null}',
          parsedArguments: { timezone: null },
          validJson: true,
        },
      ]).passed,
    ).toBe(true);

    expect(
      validateCurrentTimeToolCalls([
        {
          index: 0,
          id: "t3",
          type: "function",
          name: "get_current_time",
          rawArguments: '{"timezone":""}',
          parsedArguments: { timezone: "" },
          validJson: true,
        },
      ]).reason,
    ).toBe("schema_mismatch");

    expect(
      validateCurrentTimeToolCalls([
        {
          index: 0,
          id: "t4",
          type: "function",
          name: "get_order_status",
          rawArguments: '{"order_id":"1042"}',
          parsedArguments: { order_id: "1042" },
          validJson: true,
        },
      ]).reason,
    ).toBe("wrong_tool:get_order_status");
  });

  it("detects replies claiming to check without a tool call", () => {
    expect(
      detectClaimedCheckWithoutToolCall("I'm checking the status of order 1042 right now.", 0),
    ).toBe(true);
    expect(detectClaimedCheckWithoutToolCall("Let me check that for you.", 0)).toBe(true);
    expect(detectClaimedCheckWithoutToolCall("I'll look that up right away.", 0)).toBe(true);
    expect(detectClaimedCheckWithoutToolCall("Let me check that for you.", 1)).toBe(false);
    expect(
      detectClaimedCheckWithoutToolCall(
        "You can check your confirmation email for tracking details.",
        0,
      ),
    ).toBe(false);
    expect(
      detectClaimedCheckWithoutToolCall(
        "Standard shipping usually takes three to five business days.",
        0,
      ),
    ).toBe(false);
  });

  it("classifies recorded SSE error events (e.g. Groq tool_use_failed) as stream_error, never no_tool_call", () => {
    const acc = new GroqStreamAccumulator();

    const s1 = acc.pushEventData(
      JSON.stringify({
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      }),
    );
    expect(s1.error).toBeNull();

    const s2 = acc.pushEventData(
      JSON.stringify({
        choices: [{ index: 0, delta: { reasoning: "We need to call get_current_time." }, finish_reason: null }],
      }),
    );
    expect(s2.error).toBeNull();

    const s3 = acc.pushEventData(
      JSON.stringify({
        error: {
          message:
            "Tool call validation failed: tool call validation failed: parameters for tool get_current_time did not match schema: errors: [`/timezone`: expected string, but got null]",
          type: "invalid_request_error",
          code: "tool_use_failed",
          failed_generation:
            '{"name": "get_current_time", "arguments": {\n  "timezone": null\n}}',
          status_code: 400,
        },
      }),
      "error",
    );
    expect(s3.error).toEqual({
      message:
        "Tool call validation failed: tool call validation failed: parameters for tool get_current_time did not match schema: errors: [`/timezone`: expected string, but got null]",
      type: "invalid_request_error",
      code: "tool_use_failed",
      failedGeneration:
        '{"name": "get_current_time", "arguments": {\n  "timezone": null\n}}',
      statusCode: 400,
    });

    const res = acc.result();
    expect(res.streamError).toEqual(s3.error);
    expect(res.toolCalls).toHaveLength(0);
    expect(res.usage.totalTokens).toBeNull();

    const validation = validateCurrentTimeToolCalls(res.toolCalls, res.streamError);
    expect(validation.passed).toBe(false);
    expect(validation.reason).toMatch(/^stream_error:/);
    expect(validation.reason).toContain("tool_use_failed");
    expect(validation.reason).toContain("expected string, but got null");
    expect(validation.reason).not.toBe("no_tool_call");
  });

  it("distinguishes daily TPD/RPD 429 errors from short TPM/RPM bursts", () => {
    expect(
      isDailyRateLimitBody(
        '{"error":{"message":"Rate limit reached for model `qwen/qwen3.8-27b` on tokens per day (TPD): Limit 200000, Used 199622"}}',
      ),
    ).toBe(true);
    expect(
      isDailyRateLimitBody('{"error":{"message":"Rate limit reached on requests per day (RPD)"}}'),
    ).toBe(true);
    expect(
      isDailyRateLimitBody('{"error":{"message":"Rate limit reached on tokens per minute (TPM)"}}'),
    ).toBe(false);
  });
});
