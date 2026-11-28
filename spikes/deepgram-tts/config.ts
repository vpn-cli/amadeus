import { z } from "zod";

export interface DeepgramTtsHostSpec {
  readonly id: "in" | "default";
  readonly regionLabel: string;
  readonly host: string;
}

/**
 * Primary comparison hosts: India regional vs Global default.
 */
export const DEEPGRAM_TTS_HOSTS: readonly DeepgramTtsHostSpec[] = [
  { id: "in", regionLabel: "India", host: "api.in.deepgram.com" },
  { id: "default", regionLabel: "Global (default)", host: "api.deepgram.com" },
] as const;

export const DEFAULT_DEEPGRAM_TTS_MODEL = "aura-2-thalia-en" as const;
export const DEFAULT_DEEPGRAM_TTS_ENCODING = "linear16" as const;
export const DEFAULT_DEEPGRAM_TTS_SAMPLE_RATE = 24000;
export const DEFAULT_DEEPGRAM_TTS_MAX_CHARS = 25000;

// Documented Deepgram /v1/speak WebSocket limits
export const DEEPGRAM_WS_FLUSH_LIMIT_COUNT = 20;
export const DEEPGRAM_WS_FLUSH_LIMIT_WINDOW_MS = 60_000;
export const DEEPGRAM_WS_THROUGHPUT_CHARS_PER_MIN = 2400;
export const DEEPGRAM_WS_MAX_INPUT_CHARS_PER_MESSAGE = 2000;
export const DEEPGRAM_AURA2_USD_PER_1K_CHARS = 0.03;

export interface DeepgramSpeakUrlOptions {
  readonly model?: string;
  readonly encoding?: string;
  readonly sampleRate?: number;
}

export function buildDeepgramSpeakWsUrl(
  host: string,
  options: DeepgramSpeakUrlOptions = {},
): string {
  const params = new URLSearchParams({
    model: options.model ?? DEFAULT_DEEPGRAM_TTS_MODEL,
    encoding: options.encoding ?? DEFAULT_DEEPGRAM_TTS_ENCODING,
    sample_rate: String(options.sampleRate ?? DEFAULT_DEEPGRAM_TTS_SAMPLE_RATE),
  });
  return `wss://${host}/v1/speak?${params.toString()}`;
}

export function buildDeepgramSpeakRestUrl(
  host: string,
  options: DeepgramSpeakUrlOptions = {},
): string {
  const params = new URLSearchParams({
    model: options.model ?? DEFAULT_DEEPGRAM_TTS_MODEL,
    encoding: options.encoding ?? DEFAULT_DEEPGRAM_TTS_ENCODING,
    container: "none",
    sample_rate: String(options.sampleRate ?? DEFAULT_DEEPGRAM_TTS_SAMPLE_RATE),
  });
  return `https://${host}/v1/speak?${params.toString()}`;
}

export interface TtsSpikeEnvConfig {
  readonly deepgramApiKey: string;
  readonly ttsModel: string;
  readonly maxChars: number;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

const TtsSpikeEnvSchema = z.object({
  DEEPGRAM_API_KEY: z.string().trim().min(1, "DEEPGRAM_API_KEY is required"),
  DEEPGRAM_TTS_MODEL: z.string().trim().min(1).optional(),
  DEEPGRAM_TTS_MAX_CHARS: z.coerce.number().int().positive().optional(),
});

export function loadTtsSpikeConfig(env: Record<string, string | undefined>): TtsSpikeEnvConfig {
  const parsed = TtsSpikeEnvSchema.parse({
    DEEPGRAM_API_KEY: emptyToUndefined(env.DEEPGRAM_API_KEY),
    DEEPGRAM_TTS_MODEL: emptyToUndefined(env.DEEPGRAM_TTS_MODEL),
    DEEPGRAM_TTS_MAX_CHARS: emptyToUndefined(env.DEEPGRAM_TTS_MAX_CHARS),
  });

  return {
    deepgramApiKey: parsed.DEEPGRAM_API_KEY,
    ttsModel: parsed.DEEPGRAM_TTS_MODEL ?? DEFAULT_DEEPGRAM_TTS_MODEL,
    maxChars: parsed.DEEPGRAM_TTS_MAX_CHARS ?? DEFAULT_DEEPGRAM_TTS_MAX_CHARS,
  };
}

export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) {
      result[key] = value;
    }
  }
  return result;
}

export interface TtsCharBudgetResult {
  readonly plannedChars: number;
  readonly maxChars: number;
  readonly estimatedUsd: number;
  readonly ok: boolean;
  readonly reason: string | null;
}

export function evaluateTtsCharBudget(
  plannedChars: number,
  maxChars: number,
): TtsCharBudgetResult {
  const estimatedUsd = (plannedChars / 1000) * DEEPGRAM_AURA2_USD_PER_1K_CHARS;
  if (plannedChars > maxChars) {
    return {
      plannedChars,
      maxChars,
      estimatedUsd,
      ok: false,
      reason: `Planned characters (${plannedChars}) exceed DEEPGRAM_TTS_MAX_CHARS (${maxChars})`,
    };
  }
  return {
    plannedChars,
    maxChars,
    estimatedUsd,
    ok: true,
    reason: null,
  };
}
