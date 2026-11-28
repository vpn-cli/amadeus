import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOKENS_PER_REQUEST,
  GROQ_TPD_LIMIT,
  computeModelTokenBudget,
  estimateMedianTokensForModel,
  evaluateGroqTokenBudgets,
  getLedgerCoverageInfo,
  parseAssumeUsedArgs,
  parseUsageLedger,
  type UsageLedgerEntry,
} from "./usage-ledger.js";

describe("usage-ledger", () => {
  it("parses JSONL entries and skips blank or malformed lines", () => {
    const raw = [
      JSON.stringify({
        ts: "2026-11-28T10:00:00.000Z",
        model: "openai/gpt-oss-120b",
        prompt_tokens: 300,
        completion_tokens: 100,
        total_tokens: 400,
      }),
      "",
      "{not-json",
      JSON.stringify({
        ts: "2026-11-28T10:01:00.000Z",
        model: "qwen/qwen3.8-27b",
        prompt_tokens: 310,
        completion_tokens: 90,
        total_tokens: 400,
      }),
    ].join("\n");

    const parsed = parseUsageLedger(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.model).toBe("openai/gpt-oss-120b");
    expect(parsed[1]?.total_tokens).toBe(400);
  });

  it("defaults to 600 tokens/request when the ledger has no entries for a model", () => {
    const nowMs = Date.parse("2026-11-28T14:00:00.000Z");
    const budget = computeModelTokenBudget([], "openai/gpt-oss-120b", 75, nowMs);
    expect(budget).toEqual({
      model: "openai/gpt-oss-120b",
      plannedRequests: 75,
      ledgerSamples: 0,
      medianTokensPerRequest: DEFAULT_TOKENS_PER_REQUEST,
      estimatedTokensSource: "default_600",
      estimatedTokens: 45_000,
      usedLast24h: 0,
      projectedTotalTokens: 45_000,
      limitTpd: GROQ_TPD_LIMIT,
      withinLimit: true,
    });
  });

  it("uses median total_tokens from ledger and counts only last 24h usage", () => {
    const nowMs = Date.parse("2026-11-28T14:00:00.000Z");
    const entries: UsageLedgerEntry[] = [
      {
        // 25h old -> excluded from 24h usage, still contributes to median request size
        ts: "2026-11-27T12:59:59.000Z",
        model: "qwen/qwen3.8-27b",
        prompt_tokens: 300,
        completion_tokens: 100,
        total_tokens: 400,
      },
      {
        ts: "2026-11-28T10:00:00.000Z",
        model: "qwen/qwen3.8-27b",
        prompt_tokens: 350,
        completion_tokens: 150,
        total_tokens: 500,
      },
      {
        ts: "2026-11-28T12:00:00.000Z",
        model: "qwen/qwen3.8-27b",
        prompt_tokens: 450,
        completion_tokens: 150,
        total_tokens: 600,
      },
    ];

    const budget = computeModelTokenBudget(entries, "qwen/qwen3.8-27b", 10, nowMs);
    expect(budget.medianTokensPerRequest).toBe(500);
    expect(budget.estimatedTokensSource).toBe("ledger_median");
    expect(budget.estimatedTokens).toBe(5_000);
    expect(budget.usedLast24h).toBe(1_100);
    expect(budget.projectedTotalTokens).toBe(6_100);
    expect(budget.withinLimit).toBe(true);
  });

  it("aggregates multiple configs sharing a model and flags when 200k TPD would be exceeded", () => {
    const nowMs = Date.parse("2026-11-28T14:00:00.000Z");
    const entries: UsageLedgerEntry[] = [
      {
        ts: "2026-11-28T11:00:00.000Z",
        model: "qwen/qwen3.8-27b",
        prompt_tokens: 100_000,
        completion_tokens: 50_000,
        total_tokens: 150_000,
      },
      {
        ts: "2026-11-28T11:05:00.000Z",
        model: "qwen/qwen3.8-27b",
        prompt_tokens: 400,
        completion_tokens: 100,
        total_tokens: 500,
      },
    ];

    // Median of [500, 150000] is 75250 -> 2 planned configs * 71 = 142 -> way over 200k
    // Better realistic test: 300 small requests in 24h totaling 150,000 tokens (500 each)
    const realisticEntries: UsageLedgerEntry[] = Array.from({ length: 300 }, (_, i) => ({
      ts: new Date(nowMs - (i + 1) * 60_000).toISOString(),
      model: "qwen/qwen3.8-27b",
      prompt_tokens: 400,
      completion_tokens: 100,
      total_tokens: 500,
    }));

    const result = evaluateGroqTokenBudgets(
      realisticEntries,
      [
        { model: "qwen/qwen3.8-27b", plannedRequests: 71 },
        { model: "qwen/qwen3.8-27b", plannedRequests: 71 },
        { model: "openai/gpt-oss-120b", plannedRequests: 75 },
      ],
      nowMs,
    );

    expect(result.ok).toBe(false);
    expect(result.models).toHaveLength(2);
    expect(result.models[0]).toMatchObject({
      model: "qwen/qwen3.8-27b",
      plannedRequests: 142,
      usedLast24h: 150_000,
      estimatedTokens: 71_000,
      projectedTotalTokens: 221_000,
      withinLimit: false,
    });
    expect(result.models[1]).toMatchObject({
      model: "openai/gpt-oss-120b",
      plannedRequests: 75,
      usedLast24h: 0,
      estimatedTokens: 45_000,
      withinLimit: true,
    });
  });

  it("round-trips estimated entries, computes median excluding estimated rows, checks <24h coverage, and parses --assume-used", () => {
    const raw = [
      JSON.stringify({
        ts: "2026-11-28T10:00:00.000Z",
        model: "openai/gpt-oss-120b",
        prompt_tokens: 300,
        completion_tokens: 100,
        total_tokens: 400,
      }),
      JSON.stringify({
        ts: "2026-11-28T10:05:00.000Z",
        model: "openai/gpt-oss-120b",
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 400,
        estimated: true,
      }),
    ].join("\n");

    const parsed = parseUsageLedger(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.estimated).toBeUndefined();
    expect(parsed[1]?.estimated).toBe(true);

    expect(estimateMedianTokensForModel(parsed, "openai/gpt-oss-120b")).toEqual({
      tokens: 400,
      source: "ledger_median",
      samples: 1,
    });

    const young = getLedgerCoverageInfo(parsed, Date.parse("2026-11-28T14:00:00.000Z"));
    expect(young.isYoungerThan24h).toBe(true);
    expect(young.oldestTs).toBe("2026-11-28T10:00:00.000Z");

    const full = getLedgerCoverageInfo(parsed, Date.parse("2026-11-29T10:00:01.000Z"));
    expect(full.isYoungerThan24h).toBe(false);

    const assumed = parseAssumeUsedArgs([
      "--diagnose-ctime",
      "--assume-used",
      "openai/gpt-oss-120b=50000",
      "--assume-used=qwen/qwen3.8-27b=120000",
    ]);
    expect(assumed.get("openai/gpt-oss-120b")).toBe(50_000);
    expect(assumed.get("qwen/qwen3.8-27b")).toBe(120_000);

    const budget = computeModelTokenBudget(
      parsed,
      "openai/gpt-oss-120b",
      10,
      Date.parse("2026-11-28T14:00:00.000Z"),
      GROQ_TPD_LIMIT,
      assumed,
    );
    expect(budget.usedLast24h).toBe(50_800);
    expect(budget.assumedUsed).toBe(50_000);
    expect(budget.projectedTotalTokens).toBe(54_800);
  });
});
