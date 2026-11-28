import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { percentile } from "./stats.js";

export const GROQ_TPD_LIMIT = 200_000;
export const DEFAULT_TOKENS_PER_REQUEST = 600;
export const LEDGER_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface UsageLedgerEntry {
  readonly ts: string;
  readonly model: string;
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
  readonly estimated?: boolean;
}

export interface PlannedModelRequests {
  readonly model: string;
  readonly plannedRequests: number;
}

export interface ModelTokenBudget {
  readonly model: string;
  readonly plannedRequests: number;
  readonly ledgerSamples: number;
  readonly medianTokensPerRequest: number;
  readonly estimatedTokensSource: "ledger_median" | "default_600";
  readonly estimatedTokens: number;
  readonly usedLast24h: number;
  readonly assumedUsed?: number;
  readonly projectedTotalTokens: number;
  readonly limitTpd: number;
  readonly withinLimit: boolean;
}

export interface LedgerCoverageInfo {
  readonly entryCount: number;
  readonly oldestTs: string | null;
  readonly ageMs: number | null;
  readonly isYoungerThan24h: boolean;
}

function isValidLedgerRecord(value: unknown): value is UsageLedgerEntry {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.ts === "string" &&
    r.ts.trim().length > 0 &&
    typeof r.model === "string" &&
    r.model.trim().length > 0 &&
    typeof r.prompt_tokens === "number" &&
    Number.isFinite(r.prompt_tokens) &&
    r.prompt_tokens >= 0 &&
    typeof r.completion_tokens === "number" &&
    Number.isFinite(r.completion_tokens) &&
    r.completion_tokens >= 0 &&
    typeof r.total_tokens === "number" &&
    Number.isFinite(r.total_tokens) &&
    r.total_tokens >= 0 &&
    (r.estimated === undefined || typeof r.estimated === "boolean")
  );
}

/**
 * Parses a JSONL usage ledger string, skipping blank or malformed lines.
 */
export function parseUsageLedger(raw: string): UsageLedgerEntry[] {
  const entries: UsageLedgerEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isValidLedgerRecord(parsed)) {
        entries.push({
          ts: parsed.ts,
          model: parsed.model,
          prompt_tokens: parsed.prompt_tokens,
          completion_tokens: parsed.completion_tokens,
          total_tokens: parsed.total_tokens,
          ...(parsed.estimated !== undefined ? { estimated: parsed.estimated } : {}),
        });
      }
    } catch {
      // Ignore malformed trailing/corrupt lines so a partial write never blocks reads.
    }
  }
  return entries;
}

export function readUsageLedger(filePath: string): UsageLedgerEntry[] {
  if (!existsSync(filePath)) {
    return [];
  }
  return parseUsageLedger(readFileSync(filePath, "utf8"));
}

export function appendUsageLedgerEntry(filePath: string, entry: UsageLedgerEntry): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Computes the median total_tokens per request for a model from the ledger,
 * preferring measured (non-estimated) entries and falling back to DEFAULT_TOKENS_PER_REQUEST.
 */
export function estimateMedianTokensForModel(
  entries: readonly UsageLedgerEntry[],
  model: string,
): { readonly tokens: number; readonly source: "ledger_median" | "default_600"; readonly samples: number } {
  const modelEntries = entries.filter((e) => e.model === model);
  const measuredEntries = modelEntries.filter((e) => e.estimated !== true);
  const sourceEntries = measuredEntries.length > 0 ? measuredEntries : modelEntries;
  const median = percentile(
    sourceEntries.map((e) => e.total_tokens),
    0.5,
  );
  if (median !== null) {
    return {
      tokens: Math.ceil(median),
      source: "ledger_median",
      samples: sourceEntries.length,
    };
  }
  return {
    tokens: DEFAULT_TOKENS_PER_REQUEST,
    source: "default_600",
    samples: 0,
  };
}

/**
 * Reports whether the ledger covers a full 24h window based on its oldest entry timestamp.
 */
export function getLedgerCoverageInfo(
  entries: readonly UsageLedgerEntry[],
  nowMs: number = Date.now(),
): LedgerCoverageInfo {
  let oldestMs: number | null = null;
  let oldestTs: string | null = null;
  for (const entry of entries) {
    const tsMs = Date.parse(entry.ts);
    if (!Number.isFinite(tsMs)) continue;
    if (oldestMs === null || tsMs < oldestMs) {
      oldestMs = tsMs;
      oldestTs = entry.ts;
    }
  }
  if (oldestMs === null) {
    return {
      entryCount: entries.length,
      oldestTs: null,
      ageMs: null,
      isYoungerThan24h: true,
    };
  }
  const ageMs = Math.max(0, nowMs - oldestMs);
  return {
    entryCount: entries.length,
    oldestTs,
    ageMs,
    isYoungerThan24h: ageMs < LEDGER_WINDOW_MS,
  };
}

/**
 * Parses repeatable `--assume-used <model>=<tokens>` CLI flags.
 */
export function parseAssumeUsedArgs(argv: readonly string[]): ReadonlyMap<string, number> {
  const assumed = new Map<string, number>();
  const addSpec = (spec: string): void => {
    const eqIdx = spec.indexOf("=");
    if (eqIdx <= 0) {
      throw new Error(`Invalid --assume-used '${spec}': expected <model>=<tokens>`);
    }
    const model = spec.slice(0, eqIdx).trim();
    const rawTokens = spec.slice(eqIdx + 1).trim();
    if (model.length === 0) {
      throw new Error(`Invalid --assume-used '${spec}': model cannot be empty`);
    }
    if (!/^\d+$/.test(rawTokens)) {
      throw new Error(`Invalid --assume-used '${spec}': tokens must be a non-negative integer`);
    }
    const tokens = Number(rawTokens);
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      throw new Error(`Invalid --assume-used '${spec}': tokens must be a valid non-negative integer`);
    }
    assumed.set(model, (assumed.get(model) ?? 0) + tokens);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg.startsWith("--assume-used=")) {
      addSpec(arg.slice("--assume-used=".length));
    } else if (arg === "--assume-used") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--assume-used requires <model>=<tokens>");
      }
      addSpec(next);
      i += 1;
    }
  }
  return assumed;
}

/**
 * Computes 24h token usage, median-based estimate, and TPD headroom for one model.
 */
export function computeModelTokenBudget(
  entries: readonly UsageLedgerEntry[],
  model: string,
  plannedRequests: number,
  nowMs: number = Date.now(),
  limitTpd: number = GROQ_TPD_LIMIT,
  assumedUsedByModel?: ReadonlyMap<string, number>,
): ModelTokenBudget {
  const modelEntries = entries.filter((e) => e.model === model);
  const estimate = estimateMedianTokensForModel(entries, model);
  const medianTokensPerRequest = estimate.tokens;
  const estimatedTokensSource = estimate.source;
  const ledgerSamples = estimate.samples;
  const estimatedTokens = Math.ceil(plannedRequests * medianTokensPerRequest);

  const windowStartMs = nowMs - LEDGER_WINDOW_MS;
  let ledgerUsedLast24h = 0;
  for (const entry of modelEntries) {
    const tsMs = Date.parse(entry.ts);
    if (Number.isFinite(tsMs) && tsMs >= windowStartMs && tsMs <= nowMs + 60_000) {
      ledgerUsedLast24h += entry.total_tokens;
    }
  }

  const assumedUsed = assumedUsedByModel?.get(model) ?? 0;
  const usedLast24h = ledgerUsedLast24h + assumedUsed;
  const projectedTotalTokens = usedLast24h + estimatedTokens;
  return {
    model,
    plannedRequests,
    ledgerSamples,
    medianTokensPerRequest,
    estimatedTokensSource,
    estimatedTokens,
    usedLast24h,
    ...(assumedUsed > 0 ? { assumedUsed } : {}),
    projectedTotalTokens,
    limitTpd,
    withinLimit: projectedTotalTokens <= limitTpd,
  };
}

/**
 * Aggregates planned request counts per distinct model ID and checks each against the TPD limit.
 */
export function evaluateGroqTokenBudgets(
  entries: readonly UsageLedgerEntry[],
  plans: readonly PlannedModelRequests[],
  nowMs: number = Date.now(),
  limitTpd: number = GROQ_TPD_LIMIT,
  assumedUsedByModel?: ReadonlyMap<string, number>,
): { readonly models: readonly ModelTokenBudget[]; readonly ok: boolean } {
  const aggregated = new Map<string, number>();
  for (const plan of plans) {
    aggregated.set(plan.model, (aggregated.get(plan.model) ?? 0) + plan.plannedRequests);
  }

  const models: ModelTokenBudget[] = [];
  for (const [model, plannedRequests] of aggregated.entries()) {
    models.push(
      computeModelTokenBudget(entries, model, plannedRequests, nowMs, limitTpd, assumedUsedByModel),
    );
  }

  return {
    models,
    ok: models.every((m) => m.withinLimit),
  };
}
