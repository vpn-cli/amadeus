import { z } from "zod";

export interface DeepgramEndpointSpec {
  readonly id: "default" | "us" | "eu" | "au" | "in";
  readonly regionLabel: string;
  readonly host: string;
}

/**
 * Official Deepgram API hosts listed in Deepgram regional-endpoints docs.
 */
export const DEEPGRAM_DOC_ENDPOINTS: readonly DeepgramEndpointSpec[] = [
  { id: "default", regionLabel: "Global (default)", host: "api.deepgram.com" },
  { id: "us", regionLabel: "United States", host: "api.us.deepgram.com" },
  { id: "eu", regionLabel: "European Union", host: "api.eu.deepgram.com" },
  { id: "au", regionLabel: "Australia", host: "api.au.deepgram.com" },
  { id: "in", regionLabel: "India", host: "api.in.deepgram.com" },
] as const;

export const DEFAULT_DEEPGRAM_MODEL = "nova-3" as const;
export const DEFAULT_DEEPGRAM_LANGUAGE = "en" as const;
export const DEFAULT_WHISPER_MODEL = "whisper-large-v3-turbo" as const;

// Groq whisper-large-v3-turbo free-tier limits (console.groq.com/docs/rate-limits)
export const GROQ_WHISPER_RPM_LIMIT = 20;
export const GROQ_WHISPER_RPD_LIMIT = 2000;
export const GROQ_WHISPER_ASH_LIMIT = 7200; // audio seconds per hour
export const GROQ_WHISPER_ASD_LIMIT = 28800; // audio seconds per day

// Conservative per-run budget ceilings for Phase 0 spike runs
export const DEFAULT_DEEPGRAM_RUN_AUDIO_MINUTES_LIMIT = 15;
export const DEFAULT_WHISPER_RUN_AUDIO_SECONDS_LIMIT = 600;

export interface DeepgramListenQueryOptions {
  readonly model?: string;
  readonly language?: string;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly interimResults?: boolean;
  readonly smartFormat?: boolean;
}

export function buildDeepgramListenUrl(
  host: string,
  options: DeepgramListenQueryOptions = {},
): string {
  const params = new URLSearchParams({
    model: options.model ?? DEFAULT_DEEPGRAM_MODEL,
    language: options.language ?? DEFAULT_DEEPGRAM_LANGUAGE,
    encoding: "linear16",
    sample_rate: String(options.sampleRate ?? 16000),
    channels: String(options.channels ?? 1),
    interim_results: String(options.interimResults ?? true),
    smart_format: String(options.smartFormat ?? true),
  });
  return `wss://${host}/v1/listen?${params.toString()}`;
}

export interface SttSpikeEnvConfig {
  readonly deepgramApiKey: string;
  readonly groqApiKey?: string;
  readonly deepgramModel: string;
  readonly deepgramLanguage: string;
  readonly whisperModel: string;
  readonly maxDeepgramAudioMinutes: number;
  readonly maxWhisperAudioSeconds: number;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

const SttSpikeEnvSchema = z.object({
  DEEPGRAM_API_KEY: z.string().trim().min(1, "DEEPGRAM_API_KEY is required"),
  GROQ_API_KEY: z.string().trim().min(1).optional(),
  DEEPGRAM_STT_MODEL: z.string().trim().min(1).optional(),
  DEEPGRAM_STT_LANGUAGE: z.string().trim().min(1).optional(),
  GROQ_WHISPER_MODEL: z.string().trim().min(1).optional(),
  DEEPGRAM_MAX_AUDIO_MINUTES: z.coerce.number().positive().optional(),
  GROQ_WHISPER_MAX_AUDIO_SECONDS: z.coerce.number().positive().optional(),
});

export function loadSttSpikeConfig(env: Record<string, string | undefined>): SttSpikeEnvConfig {
  const parsed = SttSpikeEnvSchema.parse({
    DEEPGRAM_API_KEY: emptyToUndefined(env.DEEPGRAM_API_KEY),
    GROQ_API_KEY: emptyToUndefined(env.GROQ_API_KEY),
    DEEPGRAM_STT_MODEL: emptyToUndefined(env.DEEPGRAM_STT_MODEL),
    DEEPGRAM_STT_LANGUAGE: emptyToUndefined(env.DEEPGRAM_STT_LANGUAGE),
    GROQ_WHISPER_MODEL: emptyToUndefined(env.GROQ_WHISPER_MODEL),
    DEEPGRAM_MAX_AUDIO_MINUTES: emptyToUndefined(env.DEEPGRAM_MAX_AUDIO_MINUTES),
    GROQ_WHISPER_MAX_AUDIO_SECONDS: emptyToUndefined(env.GROQ_WHISPER_MAX_AUDIO_SECONDS),
  });

  return {
    deepgramApiKey: parsed.DEEPGRAM_API_KEY,
    ...(parsed.GROQ_API_KEY !== undefined ? { groqApiKey: parsed.GROQ_API_KEY } : {}),
    deepgramModel: parsed.DEEPGRAM_STT_MODEL ?? DEFAULT_DEEPGRAM_MODEL,
    deepgramLanguage: parsed.DEEPGRAM_STT_LANGUAGE ?? DEFAULT_DEEPGRAM_LANGUAGE,
    whisperModel: parsed.GROQ_WHISPER_MODEL ?? DEFAULT_WHISPER_MODEL,
    maxDeepgramAudioMinutes:
      parsed.DEEPGRAM_MAX_AUDIO_MINUTES ?? DEFAULT_DEEPGRAM_RUN_AUDIO_MINUTES_LIMIT,
    maxWhisperAudioSeconds:
      parsed.GROQ_WHISPER_MAX_AUDIO_SECONDS ?? DEFAULT_WHISPER_RUN_AUDIO_SECONDS_LIMIT,
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

export interface SttQuotaCheckInput {
  readonly plannedDeepgramAudioSeconds: number;
  readonly plannedWhisperAudioSeconds: number;
  readonly plannedWhisperRequests: number;
  readonly usedWhisperSecondsLast1h: number;
  readonly usedWhisperSecondsLast24h: number;
  readonly usedWhisperRequestsLast24h: number;
  readonly maxDeepgramAudioMinutes: number;
  readonly maxWhisperAudioSeconds: number;
}

export interface SttQuotaCheckResult {
  readonly plannedDeepgramMinutes: number;
  readonly plannedWhisperSeconds: number;
  readonly projectedWhisperSeconds1h: number;
  readonly projectedWhisperSeconds24h: number;
  readonly projectedWhisperRequests24h: number;
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

/**
 * Verifies planned Deepgram audio minutes and Groq Whisper audio-seconds/requests
 * before starting any live benchmark audio.
 */
export function evaluateSttQuota(input: SttQuotaCheckInput): SttQuotaCheckResult {
  const plannedDeepgramMinutes = input.plannedDeepgramAudioSeconds / 60;
  const projectedWhisperSeconds1h =
    input.usedWhisperSecondsLast1h + input.plannedWhisperAudioSeconds;
  const projectedWhisperSeconds24h =
    input.usedWhisperSecondsLast24h + input.plannedWhisperAudioSeconds;
  const projectedWhisperRequests24h =
    input.usedWhisperRequestsLast24h + input.plannedWhisperRequests;

  const reasons: string[] = [];
  if (plannedDeepgramMinutes > input.maxDeepgramAudioMinutes) {
    reasons.push(
      `Deepgram audio ${plannedDeepgramMinutes.toFixed(2)} min exceeds per-run ceiling ${input.maxDeepgramAudioMinutes.toFixed(2)} min`,
    );
  }
  if (input.plannedWhisperAudioSeconds > input.maxWhisperAudioSeconds) {
    reasons.push(
      `Whisper audio ${input.plannedWhisperAudioSeconds.toFixed(1)} s exceeds per-run ceiling ${input.maxWhisperAudioSeconds.toFixed(1)} s`,
    );
  }
  if (projectedWhisperSeconds1h > GROQ_WHISPER_ASH_LIMIT) {
    reasons.push(
      `Whisper 1h projected audio ${projectedWhisperSeconds1h.toFixed(1)} s exceeds Groq ASH limit ${GROQ_WHISPER_ASH_LIMIT} s`,
    );
  }
  if (projectedWhisperSeconds24h > GROQ_WHISPER_ASD_LIMIT) {
    reasons.push(
      `Whisper 24h projected audio ${projectedWhisperSeconds24h.toFixed(1)} s exceeds Groq ASD limit ${GROQ_WHISPER_ASD_LIMIT} s`,
    );
  }
  if (projectedWhisperRequests24h > GROQ_WHISPER_RPD_LIMIT) {
    reasons.push(
      `Whisper 24h projected requests ${projectedWhisperRequests24h} exceeds Groq RPD limit ${GROQ_WHISPER_RPD_LIMIT}`,
    );
  }

  return {
    plannedDeepgramMinutes,
    plannedWhisperSeconds: input.plannedWhisperAudioSeconds,
    projectedWhisperSeconds1h,
    projectedWhisperSeconds24h,
    projectedWhisperRequests24h,
    ok: reasons.length === 0,
    reasons,
  };
}
