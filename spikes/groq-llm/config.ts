import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const PROMPT_VERSION_V1 = "voice-v1" as const;
export const PROMPT_VERSION_V2 = "voice-v2" as const;
export const PROMPT_VERSION = PROMPT_VERSION_V1;

export const TOOL_SCHEMA_VERSION_V1 = "tools-v1" as const;
export const TOOL_SCHEMA_VERSION_V2 = "tools-v2" as const;
export const TOOL_SCHEMA_VERSION_V3 = "tools-v3" as const;
export const TOOL_SCHEMA_VERSION = TOOL_SCHEMA_VERSION_V1;

export const DEFAULT_SESSION_TIMEZONE = "Asia/Kolkata" as const;

export type PromptVersion = typeof PROMPT_VERSION_V1 | typeof PROMPT_VERSION_V2;
export type ToolSchemaVersion =
  | typeof TOOL_SCHEMA_VERSION_V1
  | typeof TOOL_SCHEMA_VERSION_V2
  | typeof TOOL_SCHEMA_VERSION_V3;

export const SYSTEM_PROMPT_V1 =
  "You are a concise voice support assistant. Reply in one or two short natural spoken sentences using plain text only, with no markdown, symbols, or lists.";

export const SYSTEM_PROMPT_V2 =
  `${SYSTEM_PROMPT_V1} You can use tools. When the user asks for the time or date, or about an order, call the matching tool immediately. Never ask for a timezone; the time tool defaults to the user's local timezone. Never say you are checking something unless you call the tool in the same reply.`;

export const SYSTEM_PROMPT = SYSTEM_PROMPT_V1;

export const PLAIN_PROMPT =
  "Explain in two short sentences why the sky looks blue during the day.";

export const TIME_TOOL_PROMPT = "What time is it?";

export const TIME_TOOL_PROMPT_V2 = "Thanks, what time is it right now?";

export const ORDER_TOOL_PROMPT =
  "Can you check the status of my order number one zero four two?";

export const NEAR_MISS_TIME_PROMPT =
  "What's a good time of day to call customer support?";

export const NEAR_MISS_SHIPPING_PROMPT =
  "How long does shipping usually take?";

export const TOOL_PROMPT = ORDER_TOOL_PROMPT;

export const EXPECTED_ORDER_ID = "1042" as const;

export const OrderStatusArgsSchema = z.object({
  order_id: z.string().trim().min(1),
});

export const CurrentTimeArgsSchema = z.object({
  timezone: z.string().trim().min(1).nullish(),
});

export const CurrentTimeV3ArgsSchema = z.object({}).strict();

export interface OpenAiToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export const VOICE_TOOLS_V1: readonly OpenAiToolDefinition[] = [
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

export const VOICE_TOOLS_V2: readonly OpenAiToolDefinition[] = [
  VOICE_TOOLS_V1[0]!,
  {
    type: "function",
    function: {
      name: "get_current_time",
      description:
        "Call whenever the user asks for the current time or date. timezone is optional; omit it to use the user's local timezone (Asia/Kolkata).",
      parameters: {
        type: "object",
        properties: {
          timezone: {
            type: ["string", "null"],
            description: "Optional IANA timezone name such as 'Asia/Kolkata' or 'UTC'.",
          },
        },
        additionalProperties: false,
      },
    },
  },
];

export const VOICE_TOOLS_V3: readonly OpenAiToolDefinition[] = [
  VOICE_TOOLS_V1[0]!,
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Call whenever the user asks for the current time or date.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
];

export const VOICE_TOOLS = VOICE_TOOLS_V1;

export interface PromptProfile {
  readonly promptVersion: PromptVersion;
  readonly toolSchemaVersion: ToolSchemaVersion;
  readonly systemPrompt: string;
  readonly tools: readonly OpenAiToolDefinition[];
}

export const PROMPT_PROFILES: Readonly<Record<PromptVersion, PromptProfile>> = {
  "voice-v1": {
    promptVersion: PROMPT_VERSION_V1,
    toolSchemaVersion: TOOL_SCHEMA_VERSION_V1,
    systemPrompt: SYSTEM_PROMPT_V1,
    tools: VOICE_TOOLS_V1,
  },
  "voice-v2": {
    promptVersion: PROMPT_VERSION_V2,
    toolSchemaVersion: TOOL_SCHEMA_VERSION_V3,
    systemPrompt: SYSTEM_PROMPT_V2,
    tools: VOICE_TOOLS_V3,
  },
};

export const GROQ_SERVICE_TIERS = ["on_demand", "auto", "flex", "performance"] as const;
export type GroqServiceTier = (typeof GROQ_SERVICE_TIERS)[number];

export const TASK3D_MODEL_IDS = ["qwen_none", "qwen_low", "gpt_oss_120b_low"] as const;
export type Task3dModelId = (typeof TASK3D_MODEL_IDS)[number];

const TASK3D_MODEL_ALIASES: Readonly<Record<string, readonly Task3dModelId[]>> = {
  all: TASK3D_MODEL_IDS,
  qwen: ["qwen_none", "qwen_low"],
  "qwen/qwen3.8-27b": ["qwen_none", "qwen_low"],
  qwen_none: ["qwen_none"],
  qwen_low: ["qwen_low"],
  "120b": ["gpt_oss_120b_low"],
  "gpt-oss-120b": ["gpt_oss_120b_low"],
  "openai/gpt-oss-120b": ["gpt_oss_120b_low"],
  gpt_oss_120b_low: ["gpt_oss_120b_low"],
};

/**
 * Parses `--models=...` (or `--models ...`) for `--task3d` runs.
 * Defaults to all Task 3d model configs when omitted.
 */
export function parseTask3dModelFilter(argv: readonly string[]): readonly Task3dModelId[] {
  let rawValue: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg.startsWith("--models=")) {
      rawValue = arg.slice("--models=".length);
    } else if (arg === "--models") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--models requires a comma-separated value (e.g. 120b, qwen, all)");
      }
      rawValue = next;
      i += 1;
    }
  }
  if (rawValue === null) {
    return TASK3D_MODEL_IDS;
  }

  const tokens = rawValue
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new Error("--models cannot be empty (valid: all, 120b, qwen, qwen_none, qwen_low)");
  }

  const selected = new Set<Task3dModelId>();
  for (const token of tokens) {
    const mapped = TASK3D_MODEL_ALIASES[token];
    if (mapped === undefined) {
      throw new Error(
        `Unknown --models target '${token}' (valid: all, 120b, qwen, qwen_none, qwen_low, openai/gpt-oss-120b, qwen/qwen3.8-27b)`,
      );
    }
    for (const id of mapped) {
      selected.add(id);
    }
  }
  return TASK3D_MODEL_IDS.filter((id) => selected.has(id));
}

export const ReasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const ModelsFileSchema = z.object({
  groqFast: z.string().trim().min(1).nullable(),
  groqReliable: z.string().trim().min(1).nullable(),
  GROQ_MODEL_NOREASON: z.string().trim().min(1).nullable().optional(),
  groqNoReason: z.string().trim().min(1).nullable().optional(),
  gemini: z.string().trim().min(1).nullable(),
});
export type ModelsFileConfig = z.infer<typeof ModelsFileSchema>;

const EMPTY_MODELS: ModelsFileConfig = {
  groqFast: null,
  groqReliable: null,
  GROQ_MODEL_NOREASON: null,
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
  readonly groqModelNoReason?: string;
  readonly groqFastReasoningEffort?: ReasoningEffort;
  readonly groqReliableReasoningEffort?: ReasoningEffort;
  readonly groqNoReasonReasoningEffort?: ReasoningEffort;
  readonly geminiModel?: string;
  readonly geminiReasoningEffort?: ReasoningEffort;
  readonly sessionTimezone: string;
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
  GROQ_MODEL_NOREASON: z.string().trim().min(1).optional(),
  GROQ_FAST_REASONING_EFFORT: ReasoningEffortSchema.optional(),
  GROQ_RELIABLE_REASONING_EFFORT: ReasoningEffortSchema.optional(),
  GROQ_NOREASON_REASONING_EFFORT: ReasoningEffortSchema.optional(),
  GEMINI_API_KEY: z.string().trim().min(1).optional(),
  GEMINI_MODEL: z.string().trim().min(1).optional(),
  GEMINI_REASONING_EFFORT: ReasoningEffortSchema.optional(),
  SESSION_TIMEZONE: z.string().trim().min(1).optional(),
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
  const noReasonFromFile = models.GROQ_MODEL_NOREASON ?? models.groqNoReason ?? undefined;
  const parsed = SpikeEnvInputSchema.parse({
    GROQ_API_KEY: emptyToUndefined(env.GROQ_API_KEY),
    GROQ_MODEL_FAST: emptyToUndefined(env.GROQ_MODEL_FAST) ?? models.groqFast ?? undefined,
    GROQ_MODEL_RELIABLE: emptyToUndefined(env.GROQ_MODEL_RELIABLE) ?? models.groqReliable ?? undefined,
    GROQ_MODEL_NOREASON: emptyToUndefined(env.GROQ_MODEL_NOREASON) ?? noReasonFromFile,
    GROQ_FAST_REASONING_EFFORT: emptyToUndefined(env.GROQ_FAST_REASONING_EFFORT),
    GROQ_RELIABLE_REASONING_EFFORT: emptyToUndefined(env.GROQ_RELIABLE_REASONING_EFFORT),
    GROQ_NOREASON_REASONING_EFFORT: emptyToUndefined(env.GROQ_NOREASON_REASONING_EFFORT),
    GEMINI_API_KEY: emptyToUndefined(env.GEMINI_API_KEY),
    GEMINI_MODEL: emptyToUndefined(env.GEMINI_MODEL) ?? models.gemini ?? undefined,
    GEMINI_REASONING_EFFORT: emptyToUndefined(env.GEMINI_REASONING_EFFORT),
    SESSION_TIMEZONE: emptyToUndefined(env.SESSION_TIMEZONE),
  });

  if (parsed.GEMINI_API_KEY !== undefined && parsed.GEMINI_MODEL === undefined) {
    throw new Error("GEMINI_MODEL is required when GEMINI_API_KEY is set (set env var or models.json gemini)");
  }

  return {
    groqApiKey: parsed.GROQ_API_KEY,
    groqModelFast: parsed.GROQ_MODEL_FAST,
    groqModelReliable: parsed.GROQ_MODEL_RELIABLE,
    ...(parsed.GROQ_MODEL_NOREASON !== undefined
      ? { groqModelNoReason: parsed.GROQ_MODEL_NOREASON }
      : {}),
    ...(parsed.GROQ_FAST_REASONING_EFFORT !== undefined
      ? { groqFastReasoningEffort: parsed.GROQ_FAST_REASONING_EFFORT }
      : {}),
    ...(parsed.GROQ_RELIABLE_REASONING_EFFORT !== undefined
      ? { groqReliableReasoningEffort: parsed.GROQ_RELIABLE_REASONING_EFFORT }
      : {}),
    ...(parsed.GROQ_NOREASON_REASONING_EFFORT !== undefined
      ? { groqNoReasonReasoningEffort: parsed.GROQ_NOREASON_REASONING_EFFORT }
      : {}),
    ...(parsed.GEMINI_API_KEY !== undefined ? { geminiApiKey: parsed.GEMINI_API_KEY } : {}),
    ...(parsed.GEMINI_MODEL !== undefined ? { geminiModel: parsed.GEMINI_MODEL } : {}),
    ...(parsed.GEMINI_REASONING_EFFORT !== undefined
      ? { geminiReasoningEffort: parsed.GEMINI_REASONING_EFFORT }
      : {}),
    sessionTimezone: parsed.SESSION_TIMEZONE ?? DEFAULT_SESSION_TIMEZONE,
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
