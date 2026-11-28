import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const PROMPT_VERSION = "voice-v1" as const;

export const SYSTEM_PROMPT =
  "You are a concise voice support assistant. Reply in one or two short natural spoken sentences using plain text only, with no markdown, symbols, or lists.";

export const PLAIN_PROMPT =
  "Explain in two short sentences why the sky looks blue during the day.";

export const TIME_TOOL_PROMPT = "What time is it?";

export const ORDER_TOOL_PROMPT =
  "Can you check the status of my order number one zero four two?";

export const TOOL_PROMPT = ORDER_TOOL_PROMPT;

export const EXPECTED_ORDER_ID = "1042" as const;

export const OrderStatusArgsSchema = z.object({
  order_id: z.string().trim().min(1),
});

export const CurrentTimeArgsSchema = z.object({
  timezone: z.string().trim().min(1).optional(),
});

export interface OpenAiToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export const VOICE_TOOLS: readonly OpenAiToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "get_order_status",
      description: "Look up the current shipping or fulfillment status of a customer order by its order ID.",
      parameters: {
        type: "object",
        properties: {
          order_id: {
            type: "string",
            description: "The numeric or alphanumeric order identifier, e.g. '1042'.",
          },
        },
        required: ["order_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Get the current time, optionally for a given IANA timezone.",
      parameters: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description: "Optional IANA timezone name such as 'Asia/Kolkata' or 'UTC'.",
          },
        },
        additionalProperties: false,
      },
    },
  },
];

export const ReasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const ModelsFileSchema = z.object({
  groqFast: z.string().trim().min(1).nullable(),
  groqReliable: z.string().trim().min(1).nullable(),
  gemini: z.string().trim().min(1).nullable(),
});
export type ModelsFileConfig = z.infer<typeof ModelsFileSchema>;

const EMPTY_MODELS: ModelsFileConfig = {
  groqFast: null,
  groqReliable: null,
  gemini: null,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MODELS_PATH = path.join(__dirname, "models.json");

export function loadModelsFile(filePath: string = DEFAULT_MODELS_PATH): ModelsFileConfig {
  if (!existsSync(filePath)) {
    return EMPTY_MODELS;
  }
  const raw = readFileSync(filePath, "utf8");
  return ModelsFileSchema.parse(JSON.parse(raw) as unknown);
}

export interface SpikeApiKeysConfig {
  readonly groqApiKey: string;
  readonly geminiApiKey?: string;
}

const SpikeApiKeysInputSchema = z.object({
  GROQ_API_KEY: z.string().trim().min(1, "GROQ_API_KEY is required"),
  GEMINI_API_KEY: z.string().trim().min(1).optional(),
});

export interface SpikeEnvConfig extends SpikeApiKeysConfig {
  readonly groqModelFast: string;
  readonly groqModelReliable: string;
  readonly groqFastReasoningEffort?: ReasoningEffort;
  readonly groqReliableReasoningEffort?: ReasoningEffort;
  readonly geminiModel?: string;
  readonly geminiReasoningEffort?: ReasoningEffort;
}

const SpikeEnvInputSchema = z.object({
  GROQ_API_KEY: z.string().trim().min(1, "GROQ_API_KEY is required"),
  GROQ_MODEL_FAST: z
    .string()
    .trim()
    .min(1, "GROQ_MODEL_FAST is required (set env var or models.json groqFast)"),
  GROQ_MODEL_RELIABLE: z
    .string()
    .trim()
    .min(1, "GROQ_MODEL_RELIABLE is required (set env var or models.json groqReliable)"),
  GROQ_FAST_REASONING_EFFORT: ReasoningEffortSchema.optional(),
  GROQ_RELIABLE_REASONING_EFFORT: ReasoningEffortSchema.optional(),
  GEMINI_API_KEY: z.string().trim().min(1).optional(),
  GEMINI_MODEL: z.string().trim().min(1).optional(),
  GEMINI_REASONING_EFFORT: ReasoningEffortSchema.optional(),
});

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function loadApiKeysConfig(env: Record<string, string | undefined>): SpikeApiKeysConfig {
  const parsed = SpikeApiKeysInputSchema.parse({
    GROQ_API_KEY: emptyToUndefined(env.GROQ_API_KEY),
    GEMINI_API_KEY: emptyToUndefined(env.GEMINI_API_KEY),
  });
  return {
    groqApiKey: parsed.GROQ_API_KEY,
    ...(parsed.GEMINI_API_KEY !== undefined ? { geminiApiKey: parsed.GEMINI_API_KEY } : {}),
  };
}

export function loadSpikeConfig(
  env: Record<string, string | undefined>,
  models: ModelsFileConfig = loadModelsFile(),
): SpikeEnvConfig {
  const parsed = SpikeEnvInputSchema.parse({
    GROQ_API_KEY: emptyToUndefined(env.GROQ_API_KEY),
    GROQ_MODEL_FAST: emptyToUndefined(env.GROQ_MODEL_FAST) ?? models.groqFast ?? undefined,
    GROQ_MODEL_RELIABLE: emptyToUndefined(env.GROQ_MODEL_RELIABLE) ?? models.groqReliable ?? undefined,
    GROQ_FAST_REASONING_EFFORT: emptyToUndefined(env.GROQ_FAST_REASONING_EFFORT),
    GROQ_RELIABLE_REASONING_EFFORT: emptyToUndefined(env.GROQ_RELIABLE_REASONING_EFFORT),
    GEMINI_API_KEY: emptyToUndefined(env.GEMINI_API_KEY),
    GEMINI_MODEL: emptyToUndefined(env.GEMINI_MODEL) ?? models.gemini ?? undefined,
    GEMINI_REASONING_EFFORT: emptyToUndefined(env.GEMINI_REASONING_EFFORT),
  });

  if (parsed.GEMINI_API_KEY !== undefined && parsed.GEMINI_MODEL === undefined) {
    throw new Error("GEMINI_MODEL is required when GEMINI_API_KEY is set (set env var or models.json gemini)");
  }

  return {
    groqApiKey: parsed.GROQ_API_KEY,
    groqModelFast: parsed.GROQ_MODEL_FAST,
    groqModelReliable: parsed.GROQ_MODEL_RELIABLE,
    ...(parsed.GROQ_FAST_REASONING_EFFORT !== undefined
      ? { groqFastReasoningEffort: parsed.GROQ_FAST_REASONING_EFFORT }
      : {}),
    ...(parsed.GROQ_RELIABLE_REASONING_EFFORT !== undefined
      ? { groqReliableReasoningEffort: parsed.GROQ_RELIABLE_REASONING_EFFORT }
      : {}),
    ...(parsed.GEMINI_API_KEY !== undefined ? { geminiApiKey: parsed.GEMINI_API_KEY } : {}),
    ...(parsed.GEMINI_MODEL !== undefined ? { geminiModel: parsed.GEMINI_MODEL } : {}),
    ...(parsed.GEMINI_REASONING_EFFORT !== undefined
      ? { geminiReasoningEffort: parsed.GEMINI_REASONING_EFFORT }
      : {}),
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
