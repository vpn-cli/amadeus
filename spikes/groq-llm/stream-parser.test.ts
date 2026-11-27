import { describe, expect, it } from "vitest";
import { GroqStreamAccumulator, validateOrderStatusToolCalls } from "./stream-parser.js";

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
    });
    expect(res.emittedContentBeforeToolCall).toBe(false);
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
      correctOrderId: false,
      passed: false,
      reason: "wrong_order_id:1043",
    });
  });
});
