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
  readonly projectedTotalTokens: number;
  readonly limitTpd: number;
  readonly withinLimit: boolean;
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
    r.total_tokens >= 0
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
 * Computes 24h token usage, median-based estimate, and TPD headroom for one model.
 */
export function computeModelTokenBudget(
  entries: readonly UsageLedgerEntry[],
  model: string,
  plannedRequests: number,
  nowMs: number = Date.now(),
  limitTpd: number = GROQ_TPD_LIMIT,
): ModelTokenBudget {
  const modelEntries = entries.filter((e) => e.model === model);
  const ledgerSamples = modelEntries.length;
  const medianFromLedger = percentile(
    modelEntries.map((e) => e.total_tokens),
    0.5,
  );
  const medianTokensPerRequest =
    medianFromLedger !== null ? medianFromLedger : DEFAULT_TOKENS_PER_REQUEST;
  const estimatedTokensSource =
    medianFromLedger !== null ? "ledger_median" : "default_600";
  const estimatedTokens = Math.ceil(plannedRequests * medianTokensPerRequest);

  const windowStartMs = nowMs - LEDGER_WINDOW_MS;
  let usedLast24h = 0;
  for (const entry of modelEntries) {
    const tsMs = Date.parse(entry.ts);
    if (Number.isFinite(tsMs) && tsMs >= windowStartMs && tsMs <= nowMs + 60_000) {
      usedLast24h += entry.total_tokens;
    }
  }

  const projectedTotalTokens = usedLast24h + estimatedTokens;
  return {
    model,
    plannedRequests,
    ledgerSamples,
    medianTokensPerRequest,
    estimatedTokensSource,
    estimatedTokens,
    usedLast24h,
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
): { readonly models: readonly ModelTokenBudget[]; readonly ok: boolean } {
  const aggregated = new Map<string, number>();
  for (const plan of plans) {
    aggregated.set(plan.model, (aggregated.get(plan.model) ?? 0) + plan.plannedRequests);
  }

  const models: ModelTokenBudget[] = [];
  for (const [model, plannedRequests] of aggregated.entries()) {
    models.push(computeModelTokenBudget(entries, model, plannedRequests, nowMs, limitTpd));
  }

  return {
    models,
    ok: models.every((m) => m.withinLimit),
  };
}
