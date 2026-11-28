import { describe, expect, it } from "vitest";
import {
  DEEPGRAM_DOC_ENDPOINTS,
  GROQ_WHISPER_ASD_LIMIT,
  GROQ_WHISPER_ASH_LIMIT,
  buildDeepgramListenUrl,
  evaluateSttQuota,
  loadSttSpikeConfig,
  parseDotEnv,
} from "./config.js";

describe("config", () => {
  it("lists only official Deepgram doc hosts", () => {
    expect(DEEPGRAM_DOC_ENDPOINTS.map((e) => e.host)).toEqual([
      "api.deepgram.com",
      "api.us.deepgram.com",
      "api.eu.deepgram.com",
      "api.au.deepgram.com",
      "api.in.deepgram.com",
    ]);
  });

  it("builds Deepgram Nova-3 linear16 16 kHz WebSocket URL", () => {
    const url = new URL(buildDeepgramListenUrl("api.deepgram.com"));
    expect(url.protocol).toBe("wss:");
    expect(url.hostname).toBe("api.deepgram.com");
    expect(url.pathname).toBe("/v1/listen");
    expect(url.searchParams.get("model")).toBe("nova-3");
    expect(url.searchParams.get("encoding")).toBe("linear16");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("channels")).toBe("1");
    expect(url.searchParams.get("interim_results")).toBe("true");
    expect(url.searchParams.get("smart_format")).toBe("true");
  });

  it("requires DEEPGRAM_API_KEY and loads optional overrides", () => {
    expect(() => loadSttSpikeConfig({})).toThrow(/DEEPGRAM_API_KEY/);
    const cfg = loadSttSpikeConfig({
      DEEPGRAM_API_KEY: "dg_test",
      GROQ_API_KEY: "gsk_test",
      DEEPGRAM_MAX_AUDIO_MINUTES: "10",
    });
    expect(cfg).toEqual({
      deepgramApiKey: "dg_test",
      groqApiKey: "gsk_test",
      deepgramModel: "nova-3",
      deepgramLanguage: "en",
      whisperModel: "whisper-large-v3-turbo",
      maxDeepgramAudioMinutes: 10,
      maxWhisperAudioSeconds: 600,
    });
  });

  it("stops when estimated Deepgram minutes or Groq Whisper audio-seconds exceed quota", () => {
    const ok = evaluateSttQuota({
      plannedDeepgramAudioSeconds: 240,
      plannedWhisperAudioSeconds: 70,
      plannedWhisperRequests: 20,
      usedWhisperSecondsLast1h: 100,
      usedWhisperSecondsLast24h: 200,
      usedWhisperRequestsLast24h: 50,
      maxDeepgramAudioMinutes: 15,
      maxWhisperAudioSeconds: 600,
    });
    expect(ok.ok).toBe(true);
    expect(ok.plannedDeepgramMinutes).toBeCloseTo(4, 6);

    const overDg = evaluateSttQuota({
      plannedDeepgramAudioSeconds: 1000,
      plannedWhisperAudioSeconds: 70,
      plannedWhisperRequests: 20,
      usedWhisperSecondsLast1h: 0,
      usedWhisperSecondsLast24h: 0,
      usedWhisperRequestsLast24h: 0,
      maxDeepgramAudioMinutes: 15,
      maxWhisperAudioSeconds: 600,
    });
    expect(overDg.ok).toBe(false);
    expect(overDg.reasons[0]).toMatch(/Deepgram audio/);

    const overAsh = evaluateSttQuota({
      plannedDeepgramAudioSeconds: 60,
      plannedWhisperAudioSeconds: 100,
      plannedWhisperRequests: 20,
      usedWhisperSecondsLast1h: GROQ_WHISPER_ASH_LIMIT - 50,
      usedWhisperSecondsLast24h: GROQ_WHISPER_ASD_LIMIT - 500,
      usedWhisperRequestsLast24h: 0,
      maxDeepgramAudioMinutes: 15,
      maxWhisperAudioSeconds: 600,
    });
    expect(overAsh.ok).toBe(false);
    expect(overAsh.reasons[0]).toMatch(/ASH/);
  });

  it("parses .env lines cleanly", () => {
    expect(parseDotEnv('DEEPGRAM_API_KEY="dg_abc"\n# comment\nEMPTY=\n')).toEqual({
      DEEPGRAM_API_KEY: "dg_abc",
      EMPTY: "",
    });
  });
});
