import { describe, expect, it } from "vitest";
import {
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  VOICE_TOOLS,
  loadSpikeConfig,
  parseDotEnv,
} from "./config.js";

describe("config", () => {
  it("defines a short plain-text voice system prompt with a version", () => {
    expect(PROMPT_VERSION.length).toBeGreaterThan(0);
    expect(SYSTEM_PROMPT).not.toMatch(/[#*`]|^\s*[-1]\./m);
    const sentences = SYSTEM_PROMPT.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    expect(sentences.length).toBeGreaterThanOrEqual(1);
    expect(sentences.length).toBeLessThanOrEqual(2);
    expect(VOICE_TOOLS.map((t) => t.function.name)).toEqual([
      "get_order_status",
      "get_current_time",
    ]);
  });

  it("requires GROQ_API_KEY and both Groq model env vars without hardcoded defaults", () => {
    expect(() => loadSpikeConfig({})).toThrow();
    expect(() =>
      loadSpikeConfig({
        GROQ_API_KEY: "gsk_test",
        GROQ_MODEL_FAST: "fast-model",
      }),
    ).toThrow();

    const cfg = loadSpikeConfig({
      GROQ_API_KEY: "gsk_test",
      GROQ_MODEL_FAST: "model-fast-id",
      GROQ_MODEL_RELIABLE: "model-reliable-id",
    });
    expect(cfg).toEqual({
      groqApiKey: "gsk_test",
      groqModelFast: "model-fast-id",
      groqModelReliable: "model-reliable-id",
    });
  });

  it("requires GEMINI_MODEL when GEMINI_API_KEY is present", () => {
    expect(() =>
      loadSpikeConfig({
        GROQ_API_KEY: "gsk_test",
        GROQ_MODEL_FAST: "model-fast-id",
        GROQ_MODEL_RELIABLE: "model-reliable-id",
        GEMINI_API_KEY: "AIza_test",
      }),
    ).toThrow(/GEMINI_MODEL/);

    const cfg = loadSpikeConfig({
      GROQ_API_KEY: "gsk_test",
      GROQ_MODEL_FAST: "model-fast-id",
      GROQ_MODEL_RELIABLE: "model-reliable-id",
      GEMINI_API_KEY: "AIza_test",
      GEMINI_MODEL: "gemini-model-id",
      GEMINI_REASONING_EFFORT: "minimal",
    });
    expect(cfg.geminiModel).toBe("gemini-model-id");
    expect(cfg.geminiReasoningEffort).toBe("minimal");
  });

  it("parses .env lines cleanly", () => {
    expect(
      parseDotEnv('# comment\nGROQ_API_KEY="gsk_123"\nGROQ_MODEL_FAST=fast\nEMPTY=\n'),
    ).toEqual({
      GROQ_API_KEY: "gsk_123",
      GROQ_MODEL_FAST: "fast",
      EMPTY: "",
    });
  });
});
