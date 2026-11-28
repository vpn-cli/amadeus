import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEEPGRAM_TTS_MAX_CHARS,
  DEFAULT_DEEPGRAM_TTS_MODEL,
  buildDeepgramSpeakRestUrl,
  buildDeepgramSpeakWsUrl,
  evaluateTtsCharBudget,
  loadTtsSpikeConfig,
  parseDotEnv,
} from "./config.js";

describe("deepgram-tts config", () => {
  it("builds WS /v1/speak URL with linear16 24kHz defaults", () => {
    const url = new URL(buildDeepgramSpeakWsUrl("api.in.deepgram.com"));
    expect(url.protocol).toBe("wss:");
    expect(url.hostname).toBe("api.in.deepgram.com");
    expect(url.pathname).toBe("/v1/speak");
    expect(url.searchParams.get("model")).toBe(DEFAULT_DEEPGRAM_TTS_MODEL);
    expect(url.searchParams.get("encoding")).toBe("linear16");
    expect(url.searchParams.get("sample_rate")).toBe("24000");
    expect(url.searchParams.get("container")).toBeNull();
  });

  it("builds REST /v1/speak URL with container=none and linear16 24kHz", () => {
    const url = new URL(
      buildDeepgramSpeakRestUrl("api.deepgram.com", { model: "aura-2-asteria-en" }),
    );
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("api.deepgram.com");
    expect(url.pathname).toBe("/v1/speak");
    expect(url.searchParams.get("model")).toBe("aura-2-asteria-en");
    expect(url.searchParams.get("encoding")).toBe("linear16");
    expect(url.searchParams.get("container")).toBe("none");
    expect(url.searchParams.get("sample_rate")).toBe("24000");
  });

  it("loads env defaults and overrides", () => {
    const cfgDefault = loadTtsSpikeConfig({ DEEPGRAM_API_KEY: "dg_test_key" });
    expect(cfgDefault).toEqual({
      deepgramApiKey: "dg_test_key",
      ttsModel: DEFAULT_DEEPGRAM_TTS_MODEL,
      maxChars: DEFAULT_DEEPGRAM_TTS_MAX_CHARS,
    });

    const cfgCustom = loadTtsSpikeConfig({
      DEEPGRAM_API_KEY: "dg_test_key",
      DEEPGRAM_TTS_MODEL: "aura-2-zeus-en",
      DEEPGRAM_TTS_MAX_CHARS: "18000",
    });
    expect(cfgCustom).toEqual({
      deepgramApiKey: "dg_test_key",
      ttsModel: "aura-2-zeus-en",
      maxChars: 18000,
    });
  });

  it("rejects missing DEEPGRAM_API_KEY and invalid DEEPGRAM_TTS_MAX_CHARS", () => {
    expect(() => loadTtsSpikeConfig({ DEEPGRAM_API_KEY: "  " })).toThrow();
    expect(() =>
      loadTtsSpikeConfig({ DEEPGRAM_API_KEY: "dg_k", DEEPGRAM_TTS_MAX_CHARS: "-5" }),
    ).toThrow();
  });

  it("parses .env lines and checks char budget", () => {
    const parsed = parseDotEnv('# comment\nDEEPGRAM_API_KEY="abc123"\nDEEPGRAM_TTS_MAX_CHARS=25000\n');
    expect(parsed.DEEPGRAM_API_KEY).toBe("abc123");
    expect(parsed.DEEPGRAM_TTS_MAX_CHARS).toBe("25000");

    const okRes = evaluateTtsCharBudget(15000, 25000);
    expect(okRes.ok).toBe(true);
    expect(okRes.estimatedUsd).toBeCloseTo(0.45, 4);

    const overRes = evaluateTtsCharBudget(26000, 25000);
    expect(overRes.ok).toBe(false);
    expect(overRes.reason).toContain("26000");
  });
});
