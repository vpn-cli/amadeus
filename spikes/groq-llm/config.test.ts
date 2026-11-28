import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODELS_PATH,
  DEFAULT_SESSION_TIMEZONE,
  NEAR_MISS_SHIPPING_PROMPT,
  NEAR_MISS_TIME_PROMPT,
  PROMPT_PROFILES,
  PROMPT_VERSION,
  PROMPT_VERSION_V1,
  PROMPT_VERSION_V2,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_V1,
  SYSTEM_PROMPT_V2,
  TIME_TOOL_PROMPT_V2,
  TOOL_SCHEMA_VERSION_V1,
  TOOL_SCHEMA_VERSION_V2,
  TOOL_SCHEMA_VERSION_V3,
  VOICE_TOOLS,
  VOICE_TOOLS_V1,
  VOICE_TOOLS_V2,
  VOICE_TOOLS_V3,
  loadApiKeysConfig,
  loadModelsFile,
  loadSpikeConfig,
  parseDotEnv,
  parseTask3dModelFilter,
  type ModelsFileConfig,
} from "./config.js";

const NULL_MODELS: ModelsFileConfig = {
  groqFast: null,
  groqReliable: null,
  GROQ_MODEL_NOREASON: null,
  gemini: null,
};

const POPULATED_MODELS: ModelsFileConfig = {
  groqFast: "file-fast-model",
  groqReliable: "file-reliable-model",
  GROQ_MODEL_NOREASON: "file-noreason-model",
  gemini: "file-gemini-model",
};

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

  it("keeps voice-v1 and defines voice-v2 prompt and tool schema profiles", () => {
    expect(PROMPT_PROFILES["voice-v1"]).toEqual({
      promptVersion: PROMPT_VERSION_V1,
      toolSchemaVersion: TOOL_SCHEMA_VERSION_V1,
      systemPrompt: SYSTEM_PROMPT_V1,
      tools: VOICE_TOOLS_V1,
    });
    expect(PROMPT_PROFILES["voice-v2"]).toEqual({
      promptVersion: PROMPT_VERSION_V2,
      toolSchemaVersion: TOOL_SCHEMA_VERSION_V3,
      systemPrompt: SYSTEM_PROMPT_V2,
      tools: VOICE_TOOLS_V3,
    });
    expect(SYSTEM_PROMPT_V2.startsWith(SYSTEM_PROMPT_V1)).toBe(true);
    expect(SYSTEM_PROMPT_V2).toContain("Never ask for a timezone");
    expect(SYSTEM_PROMPT_V2).toContain(
      "Never say you are checking something unless you call the tool in the same reply.",
    );
    expect(TOOL_SCHEMA_VERSION_V2).toBe("tools-v2");
    expect(VOICE_TOOLS_V2[1]?.function.description).toContain("Asia/Kolkata");
    expect(VOICE_TOOLS_V3[1]?.function).toEqual({
      name: "get_current_time",
      description: "Call whenever the user asks for the current time or date.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });
    expect(DEFAULT_SESSION_TIMEZONE).toBe("Asia/Kolkata");
    expect(VOICE_TOOLS_V1[1]?.function.description).toBe(
      "Get the current time, optionally for a given IANA timezone.",
    );
    expect(TIME_TOOL_PROMPT_V2).toBe("Thanks, what time is it right now?");
    expect(NEAR_MISS_TIME_PROMPT).toBe("What's a good time of day to call customer support?");
    expect(NEAR_MISS_SHIPPING_PROMPT).toBe("How long does shipping usually take?");
  });

  it("loads valid models.json schema from disk", () => {
    const models = loadModelsFile(DEFAULT_MODELS_PATH);
    expect(Object.keys(models).sort()).toEqual([
      "GROQ_MODEL_NOREASON",
      "gemini",
      "groqFast",
      "groqReliable",
    ]);
  });

  it("requires GROQ_API_KEY and both Groq model IDs when models.json has nulls", () => {
    expect(() => loadSpikeConfig({}, NULL_MODELS)).toThrow();
    expect(() =>
      loadSpikeConfig(
        {
          GROQ_API_KEY: "gsk_test",
          GROQ_MODEL_FAST: "fast-model",
        },
        NULL_MODELS,
      ),
    ).toThrow(/GROQ_MODEL_RELIABLE/);

    const cfg = loadSpikeConfig(
      {
        GROQ_API_KEY: "gsk_test",
        GROQ_MODEL_FAST: "model-fast-id",
        GROQ_MODEL_RELIABLE: "model-reliable-id",
      },
      NULL_MODELS,
    );
    expect(cfg).toEqual({
      groqApiKey: "gsk_test",
      groqModelFast: "model-fast-id",
      groqModelReliable: "model-reliable-id",
      sessionTimezone: "Asia/Kolkata",
    });
  });

  it("uses models.json values as defaults and lets non-empty env vars override them", () => {
    const fromFile = loadSpikeConfig(
      {
        GROQ_API_KEY: "gsk_test",
        GEMINI_API_KEY: "AIza_test",
      },
      POPULATED_MODELS,
    );
    expect(fromFile).toEqual({
      groqApiKey: "gsk_test",
      groqModelFast: "file-fast-model",
      groqModelReliable: "file-reliable-model",
      groqModelNoReason: "file-noreason-model",
      geminiApiKey: "AIza_test",
      geminiModel: "file-gemini-model",
      sessionTimezone: "Asia/Kolkata",
    });

    const overridden = loadSpikeConfig(
      {
        GROQ_API_KEY: "gsk_test",
        GROQ_MODEL_FAST: "env-fast-model",
        GROQ_MODEL_RELIABLE: "   ",
        GROQ_MODEL_NOREASON: "env-noreason-model",
        GROQ_NOREASON_REASONING_EFFORT: "none",
        GEMINI_API_KEY: "AIza_test",
        GEMINI_MODEL: "env-gemini-model",
        SESSION_TIMEZONE: "America/New_York",
      },
      POPULATED_MODELS,
    );
    expect(overridden.groqModelFast).toBe("env-fast-model");
    expect(overridden.groqModelReliable).toBe("file-reliable-model");
    expect(overridden.groqModelNoReason).toBe("env-noreason-model");
    expect(overridden.groqNoReasonReasoningEffort).toBe("none");
    expect(overridden.geminiModel).toBe("env-gemini-model");
    expect(overridden.sessionTimezone).toBe("America/New_York");
  });

  it("requires GEMINI_MODEL when GEMINI_API_KEY is present and models.json gemini is null", () => {
    expect(() =>
      loadSpikeConfig(
        {
          GROQ_API_KEY: "gsk_test",
          GROQ_MODEL_FAST: "model-fast-id",
          GROQ_MODEL_RELIABLE: "model-reliable-id",
          GEMINI_API_KEY: "AIza_test",
        },
        NULL_MODELS,
      ),
    ).toThrow(/GEMINI_MODEL/);

    const cfg = loadSpikeConfig(
      {
        GROQ_API_KEY: "gsk_test",
        GROQ_MODEL_FAST: "model-fast-id",
        GROQ_MODEL_RELIABLE: "model-reliable-id",
        GEMINI_API_KEY: "AIza_test",
        GEMINI_MODEL: "gemini-model-id",
        GEMINI_REASONING_EFFORT: "minimal",
      },
      NULL_MODELS,
    );
    expect(cfg.geminiModel).toBe("gemini-model-id");
    expect(cfg.geminiReasoningEffort).toBe("minimal");
  });

  it("loads API keys without requiring model IDs for --list-models", () => {
    expect(() => loadApiKeysConfig({})).toThrow(/GROQ_API_KEY/);
    expect(loadApiKeysConfig({ GROQ_API_KEY: "gsk_test" })).toEqual({
      groqApiKey: "gsk_test",
    });
    expect(
      loadApiKeysConfig({ GROQ_API_KEY: "gsk_test", GEMINI_API_KEY: "AIza_test" }),
    ).toEqual({
      groqApiKey: "gsk_test",
      geminiApiKey: "AIza_test",
    });
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

  it("parses --models filter for Task 3d runs", () => {
    expect(parseTask3dModelFilter(["--task3d"])).toEqual([
      "qwen_none",
      "qwen_low",
      "gpt_oss_120b_low",
    ]);
    expect(parseTask3dModelFilter(["--task3d", "--models=120b"])).toEqual(["gpt_oss_120b_low"]);
    expect(parseTask3dModelFilter(["--task3d", "--models", "qwen"])).toEqual([
      "qwen_none",
      "qwen_low",
    ]);
    expect(parseTask3dModelFilter(["--models=openai/gpt-oss-120b,qwen_none"])).toEqual([
      "qwen_none",
      "gpt_oss_120b_low",
    ]);
    expect(() => parseTask3dModelFilter(["--models=bogus"])).toThrow(/Unknown --models target/);
  });
});
