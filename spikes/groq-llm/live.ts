import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { Agent, buildConnector, fetch, type Dispatcher, type Response } from "undici";
import { ZodError } from "zod";
import {
  PLAIN_PROMPT,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  TOOL_PROMPT,
  VOICE_TOOLS,
  loadApiKeysConfig,
  loadSpikeConfig,
  parseDotEnv,
  type ReasoningEffort,
  type SpikeEnvConfig,
} from "./config.js";
import { SentenceSplitter } from "./sentence-splitter.js";
import { SseParser } from "./sse.js";
import { formatMs, formatPct, summarize, type DistributionStats } from "./stats.js";
import {
  GroqStreamAccumulator,
  validateOrderStatusToolCalls,
  type ParsedStreamResult,
} from "./stream-parser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const OUT_DIR = path.join(__dirname, "out");
const RESULTS_PATH = path.join(OUT_DIR, "results.json");

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

const N_BASELINE = 10;
const N_PLAIN = 10;
const N_TOOL = 20;
const N_CANCEL = 5;
const GROQ_PACING_MS = 2100;
const GEMINI_PACING_MS = 4100;
const MAX_RATE_LIMIT_RETRIES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseWaitDurationMs(raw: string | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.ceil(Number(trimmed) * 1000);
  }
  let totalMs = 0;
  let matched = false;
  for (const m of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m)/gi)) {
    matched = true;
    const val = Number(m[1]);
    const unit = m[2]?.toLowerCase();
    if (unit === "ms") totalMs += val;
    else if (unit === "s") totalMs += val * 1000;
    else if (unit === "m") totalMs += val * 60_000;
  }
  return matched ? Math.ceil(totalMs) : null;
}

function computeRateLimitWaitMs(res: Response, bodyText: string): number {
  const retryAfter = parseWaitDurationMs(res.headers.get("retry-after"));
  if (retryAfter !== null) return Math.min(Math.max(retryAfter + 250, 1000), 65_000);
  const msgMatch = /try again in\s+([0-9.]+(?:ms|s|m))/i.exec(bodyText);
  const fromBody = parseWaitDurationMs(msgMatch?.[1] ?? null);
  if (fromBody !== null) return Math.min(Math.max(fromBody + 250, 1000), 65_000);
  const resetReq = parseWaitDurationMs(res.headers.get("x-ratelimit-reset-requests"));
  if (resetReq !== null) return Math.min(Math.max(resetReq + 250, 1000), 65_000);
  return 3000;
}

type HttpProtocol = "h1" | "h2" | "unknown";

interface InstrumentedAgent {
  readonly agent: Agent;
  readonly getConnectCount: () => number;
  readonly getSocketCount: () => number;
  readonly getLastProtocol: () => HttpProtocol;
  readonly close: () => Promise<void>;
}

interface HostBaseline {
  readonly host: string;
  readonly edgeLocation: string | null;
  readonly edgeRttMs: DistributionStats;
  readonly originRttMs: DistributionStats;
  readonly protocol: HttpProtocol;
  readonly rateLimitHeaders: Record<string, string>;
}

interface ModelProbeResult {
  readonly model: string;
  readonly isReasoningModel: boolean;
  readonly reasoningEffort: ReasoningEffort | "not_applicable";
  readonly reasoningFormat: "parsed" | "default";
}

interface PlainRunSample {
  readonly ttftMs: number | null;
  readonly firstSentenceAbsMs: number | null;
  readonly firstSentenceRelMs: number | null;
  readonly totalMs: number;
  readonly reasoningTokens: number;
  readonly wronglyCalledTool: boolean;
  readonly protocol: HttpProtocol;
  readonly cfRayLocation: string | null;
  readonly rateLimitHeaders: Record<string, string>;
}

interface ToolRunSample {
  readonly passed: boolean;
  readonly calledAnyTool: boolean;
  readonly calledExpectedTool: boolean;
  readonly validJsonArgs: boolean;
  readonly correctOrderId: boolean;
  readonly reason: string | null;
  readonly emittedContentBeforeToolCall: boolean;
  readonly preToolContentTtftMs: number | null;
  readonly totalMs: number;
  readonly reasoningTokens: number;
  readonly protocol: HttpProtocol;
  readonly cfRayLocation: string | null;
  readonly rateLimitHeaders: Record<string, string>;
}

interface CancelCycleSample {
  readonly abortedTtftMs: number;
  readonly deltasAfterAbort: number;
  readonly postAbortTtftMs: number | null;
  readonly newAgentConnections: number;
  readonly newSocketConnects: number;
  readonly protocol: HttpProtocol;
  readonly cfRayLocation: string | null;
}

function loadEnvFromRoot(): void {
  const candidates = [path.join(REPO_ROOT, ".env"), path.join(__dirname, ".env")];
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    const parsed = parseDotEnv(readFileSync(envPath, "utf8"));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) {
        process.env[k] = v;
      }
    }
  }
}

function createInstrumentedAgent(allowH2: boolean): InstrumentedAgent {
  let agentConnectCount = 0;
  let socketConnectCount = 0;
  let lastProtocol: HttpProtocol = "unknown";

  const baseConnector = buildConnector({ allowH2, keepAlive: true });
  const instrumentedConnector: buildConnector.connector = (opts, callback) => {
    baseConnector(opts, (err, socket) => {
      if (err) {
        callback(err, null);
        return;
      }
      socketConnectCount += 1;
      const tlsSock = socket as Partial<TLSSocket>;
      if (tlsSock.alpnProtocol === "h2") {
        lastProtocol = "h2";
      } else if (tlsSock.alpnProtocol === "http/1.1" || tlsSock.alpnProtocol === false) {
        lastProtocol = "h1";
      } else {
        lastProtocol = allowH2 ? "unknown" : "h1";
      }
      callback(null, socket);
    });
  };

  const agent = new Agent({
    allowH2,
    connect: instrumentedConnector,
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
  });
  agent.on("connect", (_origin: URL, _targets: readonly Dispatcher[]) => {
    agentConnectCount += 1;
  });

  return {
    agent,
    getConnectCount: () => agentConnectCount,
    getSocketCount: () => socketConnectCount,
    getLastProtocol: () => lastProtocol,
    close: () => agent.close(),
  };
}

function extractCfRayLocation(headers: Response["headers"]): string | null {
  const cfRay = headers.get("cf-ray");
  if (!cfRay) return null;
  const dashIdx = cfRay.lastIndexOf("-");
  return dashIdx >= 0 ? cfRay.slice(dashIdx) : cfRay;
}

function extractRateLimitHeaders(headers: Response["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith("x-ratelimit")) {
      out[key.toLowerCase()] = value;
    }
  });
  return out;
}

async function measureTcpConnectOnce(host: string, port: number): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const start = performance.now();
    const socket = net.createConnection({ host, port });
    socket.setTimeout(10_000);
    socket.once("connect", () => {
      const elapsed = performance.now() - start;
      socket.destroy();
      resolve(elapsed);
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`TCP connect timeout to ${host}:${port}`));
    });
    socket.once("error", (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

interface ListedModelInfo {
  readonly id: string;
  readonly ownedBy?: string;
  readonly active?: boolean;
  readonly contextWindow?: number;
}

async function listModels(
  baseUrl: string,
  apiKey: string,
  dispatcher: Agent,
): Promise<{
  readonly modelIds: string[];
  readonly models: ListedModelInfo[];
  readonly elapsedMs: number;
  readonly cfRayLocation: string | null;
  readonly rateLimitHeaders: Record<string, string>;
}> {
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}/models`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
    dispatcher,
  });
  const text = await res.text();
  const elapsedMs = performance.now() - t0;
  if (!res.ok) {
    throw new Error(`GET ${baseUrl}/models failed (${res.status}): ${text}`);
  }
  const parsed = JSON.parse(text) as {
    data?: Array<{
      id?: string;
      owned_by?: string;
      active?: boolean;
      context_window?: number;
    }>;
  };
  const models: ListedModelInfo[] = (parsed.data ?? [])
    .filter((m): m is { id: string; owned_by?: string; active?: boolean; context_window?: number } =>
      typeof m.id === "string" && m.id.length > 0,
    )
    .map((m) => ({
      id: m.id,
      ...(typeof m.owned_by === "string" ? { ownedBy: m.owned_by } : {}),
      ...(typeof m.active === "boolean" ? { active: m.active } : {}),
      ...(typeof m.context_window === "number" ? { contextWindow: m.context_window } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const modelIds = models.map((m) => m.id);
  return {
    modelIds,
    models,
    elapsedMs,
    cfRayLocation: extractCfRayLocation(res.headers),
    rateLimitHeaders: extractRateLimitHeaders(res.headers),
  };
}

async function measureBaseline(
  label: string,
  baseUrl: string,
  apiKey: string,
): Promise<{ readonly baseline: HostBaseline; readonly modelIds: string[] }> {
  const host = new URL(baseUrl).hostname;
  const edgeSamples: number[] = [];
  for (let i = 0; i < N_BASELINE; i += 1) {
    edgeSamples.push(await measureTcpConnectOnce(host, 443));
  }

  const instr = createInstrumentedAgent(false);
  try {
    // Pre-warm TCP+TLS+HTTP keep-alive before measuring warm origin RTT.
    const warmup = await listModels(baseUrl, apiKey, instr.agent);
    const originSamples: number[] = [];
    let edgeLocation = warmup.cfRayLocation;
    let rateLimits = warmup.rateLimitHeaders;

    for (let i = 0; i < N_BASELINE; i += 1) {
      const r = await listModels(baseUrl, apiKey, instr.agent);
      originSamples.push(r.elapsedMs);
      if (r.cfRayLocation) edgeLocation = r.cfRayLocation;
      if (Object.keys(r.rateLimitHeaders).length > 0) {
        rateLimits = { ...rateLimits, ...r.rateLimitHeaders };
      }
    }

    const baseline: HostBaseline = {
      host,
      edgeLocation,
      edgeRttMs: summarize(edgeSamples),
      originRttMs: summarize(originSamples),
      protocol: instr.getLastProtocol(),
      rateLimitHeaders: rateLimits,
    };

    console.log(
      `[Baseline:${label}] host=${host} edge=${edgeLocation ?? "none"} proto=${baseline.protocol} ` +
        `edgeRTT(med=${formatMs(baseline.edgeRttMs.median)}, p90=${formatMs(baseline.edgeRttMs.p90)}) ` +
        `originRTT(med=${formatMs(baseline.originRttMs.median)}, p90=${formatMs(baseline.originRttMs.p90)})`,
    );
    return { baseline, modelIds: warmup.modelIds };
  } finally {
    await instr.close();
  }
}

interface ChatRequestOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly prompt: string;
  readonly tools: typeof VOICE_TOOLS | undefined;
  readonly reasoningEffort?: ReasoningEffort | undefined;
  readonly reasoningFormat?: "parsed" | "default" | undefined;
  readonly dispatcher: Agent;
  readonly maxTokens?: number;
  readonly abortOnFirstContent?: boolean;
}

interface ChatStreamOutcome {
  readonly parsed: ParsedStreamResult;
  readonly ttftMs: number | null;
  readonly firstSentenceAbsMs: number | null;
  readonly firstSentenceRelMs: number | null;
  readonly totalMs: number;
  readonly deltasAfterAbort: number;
  readonly aborted: boolean;
  readonly cfRayLocation: string | null;
  readonly rateLimitHeaders: Record<string, string>;
}

async function runStreamingChat(opts: ChatRequestOptions): Promise<ChatStreamOutcome> {
  const controller = new AbortController();
  const bodyObj: Record<string, unknown> = {
    model: opts.model,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.2,
    max_tokens: opts.maxTokens ?? 150,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: opts.prompt },
    ],
  };
  if (opts.tools !== undefined) {
    bodyObj.tools = opts.tools;
  }
  if (opts.reasoningEffort !== undefined) {
    bodyObj.reasoning_effort = opts.reasoningEffort;
  }
  if (opts.reasoningFormat === "parsed") {
    bodyObj.reasoning_format = "parsed";
  }

  let res: Response | null = null;
  let tStart = 0;
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    tStart = performance.now();
    res = await fetch(`${opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyObj),
      dispatcher: opts.dispatcher,
      signal: controller.signal,
    });

    if (res.status !== 429) {
      break;
    }
    const errText = await res.text();
    if (attempt === MAX_RATE_LIMIT_RETRIES) {
      throw new Error(`POST ${opts.baseUrl}/chat/completions (${opts.model}) failed ${res.status}: ${errText}`);
    }
    const waitMs = computeRateLimitWaitMs(res, errText);
    console.warn(`[RateLimit] 429 on ${opts.model} (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}), waiting ${waitMs} ms`);
    await sleep(waitMs);
  }

  if (!res) {
    throw new Error("Fetch did not return a response");
  }
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`POST ${opts.baseUrl}/chat/completions (${opts.model}) failed ${res.status}: ${errText}`);
  }
  if (!res.body) {
    throw new Error("Response body was null");
  }

  const cfRayLocation = extractCfRayLocation(res.headers);
  const rateLimitHeaders = extractRateLimitHeaders(res.headers);

  const sse = new SseParser();
  const acc = new GroqStreamAccumulator();
  const splitter = new SentenceSplitter();

  let ttftMs: number | null = null;
  let firstSentenceAbsMs: number | null = null;
  let abortedAtMs: number | null = null;
  let deltasAfterAbort = 0;

  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const now = performance.now();
      const events = sse.push(value);
      for (const evt of events) {
        if (abortedAtMs !== null) {
          deltasAfterAbort += 1;
          continue;
        }
        const step = acc.pushEventData(evt.data);
        if (step.done) continue;
        if (step.isFirstContentDelta && ttftMs === null) {
          ttftMs = now - tStart;
        }
        if (step.contentDelta.length > 0) {
          const sentences = splitter.push(step.contentDelta);
          if (sentences.length > 0 && firstSentenceAbsMs === null) {
            firstSentenceAbsMs = now - tStart;
          }
        }
        if (opts.abortOnFirstContent && step.isFirstContentDelta) {
          abortedAtMs = now;
          controller.abort();
          break;
        }
      }
      if (abortedAtMs !== null) {
        break;
      }
    }
  } catch (err) {
    if (!(abortedAtMs !== null && err instanceof Error && err.name === "AbortError")) {
      throw err;
    }
  } finally {
    if (abortedAtMs !== null) {
      // Cancel/release reader cleanly and allow microtasks to flush any in-flight events.
      await reader.cancel().catch(() => undefined);
    } else {
      for (const evt of sse.flush()) {
        const step = acc.pushEventData(evt.data);
        if (!step.done && step.contentDelta.length > 0) {
          const sentences = splitter.push(step.contentDelta);
          if (sentences.length > 0 && firstSentenceAbsMs === null) {
            firstSentenceAbsMs = performance.now() - tStart;
          }
        }
      }
      const remaining = splitter.flush();
      if (remaining.length > 0 && firstSentenceAbsMs === null && ttftMs !== null) {
        firstSentenceAbsMs = performance.now() - tStart;
      }
    }
  }

  const totalMs = performance.now() - tStart;
  const firstSentenceRelMs =
    firstSentenceAbsMs !== null && ttftMs !== null ? firstSentenceAbsMs - ttftMs : null;

  return {
    parsed: acc.result(),
    ttftMs,
    firstSentenceAbsMs,
    firstSentenceRelMs,
    totalMs,
    deltasAfterAbort,
    aborted: abortedAtMs !== null,
    cfRayLocation,
    rateLimitHeaders,
  };
}

async function probeReasoningSettings(
  baseUrl: string,
  apiKey: string,
  model: string,
  overrideEffort: ReasoningEffort | undefined,
  allowReasoningFormat: boolean,
): Promise<ModelProbeResult> {
  const instr = createInstrumentedAgent(false);
  try {
    if (overrideEffort !== undefined) {
      let reasoningFormat: "parsed" | "default" = "default";
      if (allowReasoningFormat) {
        try {
          await runStreamingChat({
            baseUrl,
            apiKey,
            model,
            prompt: "Say ok.",
            tools: undefined,
            reasoningEffort: overrideEffort,
            reasoningFormat: "parsed",
            dispatcher: instr.agent,
            maxTokens: 16,
          });
          reasoningFormat = "parsed";
        } catch {
          await runStreamingChat({
            baseUrl,
            apiKey,
            model,
            prompt: "Say ok.",
            tools: undefined,
            reasoningEffort: overrideEffort,
            dispatcher: instr.agent,
            maxTokens: 16,
          });
        }
      }
      return {
        model,
        isReasoningModel: overrideEffort !== "none",
        reasoningEffort: overrideEffort,
        reasoningFormat,
      };
    }

    // Default probe without reasoning_effort to detect whether the model reasons by default.
    const defaultProbe = await runStreamingChat({
      baseUrl,
      apiKey,
      model,
      prompt: "Reply with the word ok.",
      tools: undefined,
      dispatcher: instr.agent,
      maxTokens: 24,
    });
    const hasReasoning =
      defaultProbe.parsed.reasoningDeltaCount > 0 ||
      (defaultProbe.parsed.usage.reasoningTokens ?? 0) > 0 ||
      defaultProbe.parsed.content.includes("<think>");

    if (!hasReasoning) {
      // Also check if Gemini-style thinking models accept minimal/none even when maxTokens=24 emitted 0 reasoning tokens.
      if (!allowReasoningFormat) {
        for (const effort of ["none", "minimal", "low"] as const) {
          try {
            await runStreamingChat({
              baseUrl,
              apiKey,
              model,
              prompt: "Reply with ok.",
              tools: undefined,
              reasoningEffort: effort,
              dispatcher: instr.agent,
              maxTokens: 16,
            });
            return {
              model,
              isReasoningModel: true,
              reasoningEffort: effort,
              reasoningFormat: "default",
            };
          } catch {
            // Try next lowest effort tier.
          }
        }
      }
      return {
        model,
        isReasoningModel: false,
        reasoningEffort: "not_applicable",
        reasoningFormat: "default",
      };
    }

    const efforts: readonly ReasoningEffort[] = ["none", "minimal", "low"];
    for (const effort of efforts) {
      if (allowReasoningFormat) {
        try {
          await runStreamingChat({
            baseUrl,
            apiKey,
            model,
            prompt: "Reply with ok.",
            tools: undefined,
            reasoningEffort: effort,
            reasoningFormat: "parsed",
            dispatcher: instr.agent,
            maxTokens: 16,
          });
          return {
            model,
            isReasoningModel: true,
            reasoningEffort: effort,
            reasoningFormat: "parsed",
          };
        } catch {
          // Fallback without reasoning_format below.
        }
      }
      try {
        await runStreamingChat({
          baseUrl,
          apiKey,
          model,
          prompt: "Reply with ok.",
          tools: undefined,
          reasoningEffort: effort,
          dispatcher: instr.agent,
          maxTokens: 16,
        });
        return {
          model,
          isReasoningModel: true,
          reasoningEffort: effort,
          reasoningFormat: "default",
        };
      } catch {
        // Try next effort tier.
      }
    }

    return {
      model,
      isReasoningModel: true,
      reasoningEffort: "not_applicable",
      reasoningFormat: "default",
    };
  } finally {
    await instr.close();
  }
}

function summarizePlainRuns(runs: readonly PlainRunSample[]) {
  const ttfts = runs.map((r) => r.ttftMs).filter((v): v is number => v !== null);
  const absFirst = runs.map((r) => r.firstSentenceAbsMs).filter((v): v is number => v !== null);
  const relFirst = runs.map((r) => r.firstSentenceRelMs).filter((v): v is number => v !== null);
  const totals = runs.map((r) => r.totalMs);
  const reasoning = runs.map((r) => r.reasoningTokens);
  const wrongToolCalls = runs.filter((r) => r.wronglyCalledTool).length;
  const protocols = [...new Set(runs.map((r) => r.protocol))];
  const edgeLocations = [...new Set(runs.map((r) => r.cfRayLocation).filter((v): v is string => v !== null))];
  const rateLimits = Object.assign({}, ...runs.map((r) => r.rateLimitHeaders));

  return {
    n: runs.length,
    ttftMs: summarize(ttfts),
    firstSentenceAbsMs: summarize(absFirst),
    firstSentenceRelMs: summarize(relFirst),
    totalMs: summarize(totals),
    reasoningTokens: summarize(reasoning),
    wrongToolCalls,
    wrongToolCallRate: formatPct(wrongToolCalls, runs.length),
    protocols,
    edgeLocations,
    rateLimitHeaders: rateLimits,
  };
}

function summarizeToolRuns(runs: readonly ToolRunSample[]) {
  const passedCount = runs.filter((r) => r.passed).length;
  const fillerRuns = runs.filter((r) => r.emittedContentBeforeToolCall);
  const fillerTtfts = fillerRuns
    .map((r) => r.preToolContentTtftMs)
    .filter((v): v is number => v !== null);
  const totals = runs.map((r) => r.totalMs);
  const reasoning = runs.map((r) => r.reasoningTokens);
  const protocols = [...new Set(runs.map((r) => r.protocol))];
  const edgeLocations = [...new Set(runs.map((r) => r.cfRayLocation).filter((v): v is string => v !== null))];
  const rateLimits = Object.assign({}, ...runs.map((r) => r.rateLimitHeaders));

  return {
    n: runs.length,
    passedCount,
    toolCorrectnessRate: formatPct(passedCount, runs.length),
    fillerCount: fillerRuns.length,
    fillerRate: formatPct(fillerRuns.length, runs.length),
    preToolContentTtftMs: summarize(fillerTtfts),
    totalMs: summarize(totals),
    reasoningTokens: summarize(reasoning),
    protocols,
    edgeLocations,
    rateLimitHeaders: rateLimits,
    failureReasons: runs.filter((r) => !r.passed).map((r) => r.reason),
  };
}

function summarizeCancelRuns(runs: readonly CancelCycleSample[], normalWarmTtftMedian: number | null) {
  const postTtfts = runs.map((r) => r.postAbortTtftMs).filter((v): v is number => v !== null);
  const reconnects = runs.filter((r) => r.newSocketConnects > 0 || r.newAgentConnections > 0).length;
  const maxDeltasAfterAbort = Math.max(0, ...runs.map((r) => r.deltasAfterAbort));
  const protocols = [...new Set(runs.map((r) => r.protocol))];
  const edgeLocations = [...new Set(runs.map((r) => r.cfRayLocation).filter((v): v is string => v !== null))];
  const postStats = summarize(postTtfts);
  const deltaVsWarmMedianMs =
    postStats.median !== null && normalWarmTtftMedian !== null
      ? postStats.median - normalWarmTtftMedian
      : null;

  return {
    n: runs.length,
    maxDeltasAfterAbort,
    reconnects,
    reconnectRate: formatPct(reconnects, runs.length),
    postAbortTtftMs: postStats,
    normalWarmTtftMedianMs: normalWarmTtftMedian,
    deltaVsWarmMedianMs,
    protocols,
    edgeLocations,
  };
}

async function runCancellationSuite(
  baseUrl: string,
  apiKey: string,
  probe: ModelProbeResult,
  allowH2: boolean,
  normalWarmTtftMedian: number | null,
) {
  const instr = createInstrumentedAgent(allowH2);
  try {
    // Pre-warm agent via /models before running cancellation cycles.
    await listModels(baseUrl, apiKey, instr.agent);
    const cycles: CancelCycleSample[] = [];
    const reasoningEffort =
      probe.reasoningEffort === "not_applicable" ? undefined : probe.reasoningEffort;

    for (let i = 0; i < N_CANCEL; i += 1) {
      await sleep(GROQ_PACING_MS * 2);
      const abortedRun = await runStreamingChat({
        baseUrl,
        apiKey,
        model: probe.model,
        prompt: PLAIN_PROMPT,
        tools: VOICE_TOOLS,
        reasoningEffort,
        reasoningFormat: probe.reasoningFormat,
        dispatcher: instr.agent,
        abortOnFirstContent: true,
      });
      if (!abortedRun.aborted) {
        throw new Error(
          `Cycle ${i + 1}: stream finished without emitting content before abort`,
        );
      }
      if (abortedRun.deltasAfterAbort > 0) {
        throw new Error(
          `Expected 0 deltas after abort, saw ${abortedRun.deltasAfterAbort} on cycle ${i + 1}`,
        );
      }

      const agentConnBefore = instr.getConnectCount();
      const sockConnBefore = instr.getSocketCount();
      const followUp = await runStreamingChat({
        baseUrl,
        apiKey,
        model: probe.model,
        prompt: PLAIN_PROMPT,
        tools: VOICE_TOOLS,
        reasoningEffort,
        reasoningFormat: probe.reasoningFormat,
        dispatcher: instr.agent,
      });

      cycles.push({
        abortedTtftMs: abortedRun.ttftMs ?? abortedRun.totalMs,
        deltasAfterAbort: abortedRun.deltasAfterAbort,
        postAbortTtftMs: followUp.ttftMs,
        newAgentConnections: instr.getConnectCount() - agentConnBefore,
        newSocketConnects: instr.getSocketCount() - sockConnBefore,
        protocol: instr.getLastProtocol(),
        cfRayLocation: followUp.cfRayLocation,
      });
    }

    return summarizeCancelRuns(cycles, normalWarmTtftMedian);
  } finally {
    await instr.close();
  }
}

async function benchmarkGroqModel(
  apiKey: string,
  probe: ModelProbeResult,
) {
  const reasoningEffort =
    probe.reasoningEffort === "not_applicable" ? undefined : probe.reasoningEffort;

  // Interleave cold (new Agent per request) and warm (shared pre-warmed Agent) runs.
  const warmInstr = createInstrumentedAgent(false);
  const coldRuns: PlainRunSample[] = [];
  const warmRuns: PlainRunSample[] = [];
  const toolRuns: ToolRunSample[] = [];

  try {
    await listModels(GROQ_BASE_URL, apiKey, warmInstr.agent);

    for (let i = 0; i < N_PLAIN; i += 1) {
      const coldInstr = createInstrumentedAgent(false);
      try {
        const coldRes = await runStreamingChat({
          baseUrl: GROQ_BASE_URL,
          apiKey,
          model: probe.model,
          prompt: PLAIN_PROMPT,
          tools: VOICE_TOOLS,
          reasoningEffort,
          reasoningFormat: probe.reasoningFormat,
          dispatcher: coldInstr.agent,
        });
        coldRuns.push({
          ttftMs: coldRes.ttftMs,
          firstSentenceAbsMs: coldRes.firstSentenceAbsMs,
          firstSentenceRelMs: coldRes.firstSentenceRelMs,
          totalMs: coldRes.totalMs,
          reasoningTokens: coldRes.parsed.usage.reasoningTokens ?? 0,
          wronglyCalledTool: coldRes.parsed.toolCalls.length > 0,
          protocol: coldInstr.getLastProtocol(),
          cfRayLocation: coldRes.cfRayLocation,
          rateLimitHeaders: coldRes.rateLimitHeaders,
        });
      } finally {
        await coldInstr.close();
      }
      await sleep(GROQ_PACING_MS);

      const warmRes = await runStreamingChat({
        baseUrl: GROQ_BASE_URL,
        apiKey,
        model: probe.model,
        prompt: PLAIN_PROMPT,
        tools: VOICE_TOOLS,
        reasoningEffort,
        reasoningFormat: probe.reasoningFormat,
        dispatcher: warmInstr.agent,
      });
      warmRuns.push({
        ttftMs: warmRes.ttftMs,
        firstSentenceAbsMs: warmRes.firstSentenceAbsMs,
        firstSentenceRelMs: warmRes.firstSentenceRelMs,
        totalMs: warmRes.totalMs,
        reasoningTokens: warmRes.parsed.usage.reasoningTokens ?? 0,
        wronglyCalledTool: warmRes.parsed.toolCalls.length > 0,
        protocol: warmInstr.getLastProtocol(),
        cfRayLocation: warmRes.cfRayLocation,
        rateLimitHeaders: warmRes.rateLimitHeaders,
      });
      await sleep(GROQ_PACING_MS);
    }

    for (let i = 0; i < N_TOOL; i += 1) {
      const toolRes = await runStreamingChat({
        baseUrl: GROQ_BASE_URL,
        apiKey,
        model: probe.model,
        prompt: TOOL_PROMPT,
        tools: VOICE_TOOLS,
        reasoningEffort,
        reasoningFormat: probe.reasoningFormat,
        dispatcher: warmInstr.agent,
      });
      const validation = validateOrderStatusToolCalls(toolRes.parsed.toolCalls);
      toolRuns.push({
        ...validation,
        emittedContentBeforeToolCall: toolRes.parsed.emittedContentBeforeToolCall,
        preToolContentTtftMs: toolRes.parsed.emittedContentBeforeToolCall ? toolRes.ttftMs : null,
        totalMs: toolRes.totalMs,
        reasoningTokens: toolRes.parsed.usage.reasoningTokens ?? 0,
        protocol: warmInstr.getLastProtocol(),
        cfRayLocation: toolRes.cfRayLocation,
        rateLimitHeaders: toolRes.rateLimitHeaders,
      });
      await sleep(GROQ_PACING_MS);
    }
  } finally {
    await warmInstr.close();
  }

  const coldSummary = summarizePlainRuns(coldRuns);
  const warmSummary = summarizePlainRuns(warmRuns);
  const toolSummary = summarizeToolRuns(toolRuns);
  const cancelH1 = await runCancellationSuite(
    GROQ_BASE_URL,
    apiKey,
    probe,
    false,
    warmSummary.ttftMs.median,
  );
  const cancelH2 = await runCancellationSuite(
    GROQ_BASE_URL,
    apiKey,
    probe,
    true,
    warmSummary.ttftMs.median,
  );

  return {
    settings: probe,
    scenarioA_cold: coldSummary,
    scenarioB_warm: warmSummary,
    scenarioC_tool: toolSummary,
    scenarioD_cancelH1: cancelH1,
    scenarioD_cancelH2: cancelH2,
  };
}

async function benchmarkGeminiScenarioB(
  apiKey: string,
  probe: ModelProbeResult,
) {
  const instr = createInstrumentedAgent(false);
  const runs: PlainRunSample[] = [];
  const reasoningEffort =
    probe.reasoningEffort === "not_applicable" ? undefined : probe.reasoningEffort;

  try {
    await listModels(GEMINI_BASE_URL, apiKey, instr.agent);
    for (let i = 0; i < N_PLAIN; i += 1) {
      const res = await runStreamingChat({
        baseUrl: GEMINI_BASE_URL,
        apiKey,
        model: probe.model,
        prompt: PLAIN_PROMPT,
        tools: VOICE_TOOLS,
        reasoningEffort,
        dispatcher: instr.agent,
      });
      runs.push({
        ttftMs: res.ttftMs,
        firstSentenceAbsMs: res.firstSentenceAbsMs,
        firstSentenceRelMs: res.firstSentenceRelMs,
        totalMs: res.totalMs,
        reasoningTokens: res.parsed.usage.reasoningTokens ?? 0,
        wronglyCalledTool: res.parsed.toolCalls.length > 0,
        protocol: instr.getLastProtocol(),
        cfRayLocation: res.cfRayLocation,
        rateLimitHeaders: res.rateLimitHeaders,
      });
      if (i + 1 < N_PLAIN) {
        await sleep(GEMINI_PACING_MS);
      }
    }
  } finally {
    await instr.close();
  }

  return {
    settings: probe,
    scenarioB_warm: summarizePlainRuns(runs),
  };
}

function printPlainSummary(label: string, s: ReturnType<typeof summarizePlainRuns>): void {
  console.log(
    `  ${label} (n=${s.n}, proto=${s.protocols.join(",") || "unknown"}, edge=${s.edgeLocations.join(",") || "none"}):`,
  );
  console.log(
    `    TTFT: med=${formatMs(s.ttftMs.median)} p90=${formatMs(s.ttftMs.p90)} | ` +
      `FirstSent(abs): med=${formatMs(s.firstSentenceAbsMs.median)} p90=${formatMs(s.firstSentenceAbsMs.p90)} | ` +
      `FirstSent(rel): med=${formatMs(s.firstSentenceRelMs.median)} p90=${formatMs(s.firstSentenceRelMs.p90)}`,
  );
  console.log(
    `    Total: med=${formatMs(s.totalMs.median)} p90=${formatMs(s.totalMs.p90)} | ` +
      `ReasoningTok: med=${s.reasoningTokens.median ?? 0} p90=${s.reasoningTokens.p90 ?? 0} | ` +
      `WrongToolCalls: ${s.wrongToolCallRate}`,
  );
  if (Object.keys(s.rateLimitHeaders).length > 0) {
    console.log(`    x-ratelimit: ${JSON.stringify(s.rateLimitHeaders)}`);
  }
}

function printModelReport(role: string, report: Awaited<ReturnType<typeof benchmarkGroqModel>>): void {
  console.log(
    `\n=== Groq [${role}] model=${report.settings.model} reasoning=${report.settings.reasoningEffort} format=${report.settings.reasoningFormat} ===`,
  );
  printPlainSummary("Scenario A (Cold)", report.scenarioA_cold);
  printPlainSummary("Scenario B (Warm)", report.scenarioB_warm);

  const c = report.scenarioC_tool;
  console.log(
    `  Scenario C (Tool n=${c.n}, proto=${c.protocols.join(",") || "unknown"}, edge=${c.edgeLocations.join(",") || "none"}):`,
  );
  console.log(
    `    ToolCorrectness(order_id=1042): ${c.toolCorrectnessRate} | ` +
      `PreToolFiller: ${c.fillerRate} (TTFT med=${formatMs(c.preToolContentTtftMs.median)} p90=${formatMs(c.preToolContentTtftMs.p90)})`,
  );
  console.log(
    `    Total: med=${formatMs(c.totalMs.median)} p90=${formatMs(c.totalMs.p90)} | ` +
      `ReasoningTok: med=${c.reasoningTokens.median ?? 0} p90=${c.reasoningTokens.p90 ?? 0}`,
  );
  if (c.failureReasons.length > 0) {
    console.log(`    ToolFailures: ${c.failureReasons.join(", ")}`);
  }
  if (Object.keys(c.rateLimitHeaders).length > 0) {
    console.log(`    x-ratelimit: ${JSON.stringify(c.rateLimitHeaders)}`);
  }

  for (const [tag, d] of [
    ["Scenario D (Cancel H1)", report.scenarioD_cancelH1],
    ["Scenario D (Cancel H2)", report.scenarioD_cancelH2],
  ] as const) {
    console.log(
      `  ${tag} (n=${d.n}, proto=${d.protocols.join(",") || "unknown"}, edge=${d.edgeLocations.join(",") || "none"}):`,
    );
    console.log(
      `    PostAbortTTFT: med=${formatMs(d.postAbortTtftMs.median)} p90=${formatMs(d.postAbortTtftMs.p90)} ` +
        `(vs Warm med ${formatMs(d.normalWarmTtftMedianMs)}, delta=${d.deltaVsWarmMedianMs !== null ? `${d.deltaVsWarmMedianMs.toFixed(1)} ms` : "n/a"}) | ` +
        `Reconnects: ${d.reconnectRate} | DeltasAfterAbortMax: ${d.maxDeltasAfterAbort}`,
    );
  }
}

function assertModelsPresent(provider: string, requested: readonly string[], available: readonly string[]): void {
  for (const id of requested) {
    if (!available.includes(id)) {
      throw new Error(
        `${provider} model '${id}' not found in live /models list. Available (${available.length}): ${available.join(", ")}`,
      );
    }
  }
}

async function printAvailableModels(): Promise<void> {
  loadEnvFromRoot();
  const keys = loadApiKeysConfig(process.env);
  const instr = createInstrumentedAgent(false);
  try {
    const groq = await listModels(GROQ_BASE_URL, keys.groqApiKey, instr.agent);
    console.log(`Groq models (${groq.models.length}, ${formatMs(groq.elapsedMs)}):`);
    for (const m of groq.models) {
      const meta = [
        m.ownedBy ? `owner=${m.ownedBy}` : null,
        m.contextWindow !== undefined ? `ctx=${m.contextWindow}` : null,
        m.active !== undefined ? `active=${m.active}` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" ");
      console.log(`  - ${m.id}${meta ? ` (${meta})` : ""}`);
    }

    if (keys.geminiApiKey) {
      const gem = await listModels(GEMINI_BASE_URL, keys.geminiApiKey, instr.agent);
      console.log(`\nGemini models (${gem.models.length}, ${formatMs(gem.elapsedMs)}):`);
      for (const m of gem.models) {
        console.log(`  - ${m.id}`);
      }
    } else {
      console.log("\nGemini models: skipped (GEMINI_API_KEY not set)");
    }
  } finally {
    await instr.close();
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--list-models")) {
    await printAvailableModels();
    return;
  }

  loadEnvFromRoot();
  const cfg: SpikeEnvConfig = loadSpikeConfig(process.env);

  const groqBase = await measureBaseline("Groq", GROQ_BASE_URL, cfg.groqApiKey);
  console.log(`Groq live models (${groqBase.modelIds.length}): ${groqBase.modelIds.join(", ")}`);
  assertModelsPresent("Groq", [cfg.groqModelFast, cfg.groqModelReliable], groqBase.modelIds);

  const fastProbe = await probeReasoningSettings(
    GROQ_BASE_URL,
    cfg.groqApiKey,
    cfg.groqModelFast,
    cfg.groqFastReasoningEffort,
    true,
  );
  const reliableProbe = await probeReasoningSettings(
    GROQ_BASE_URL,
    cfg.groqApiKey,
    cfg.groqModelReliable,
    cfg.groqReliableReasoningEffort,
    true,
  );

  const fastReport = await benchmarkGroqModel(cfg.groqApiKey, fastProbe);
  const reliableReport = await benchmarkGroqModel(cfg.groqApiKey, reliableProbe);

  printModelReport("FAST", fastReport);
  printModelReport("RELIABLE", reliableReport);

  let geminiBaseline: HostBaseline | null = null;
  let geminiModels: string[] = [];
  let geminiReport: Awaited<ReturnType<typeof benchmarkGeminiScenarioB>> | null = null;

  if (cfg.geminiApiKey && cfg.geminiModel) {
    const gemBase = await measureBaseline("Gemini", GEMINI_BASE_URL, cfg.geminiApiKey);
    geminiBaseline = gemBase.baseline;
    geminiModels = gemBase.modelIds;
    console.log(`Gemini live models (${geminiModels.length}): ${geminiModels.join(", ")}`);
    assertModelsPresent("Gemini", [cfg.geminiModel], geminiModels);

    const gemProbe = await probeReasoningSettings(
      GEMINI_BASE_URL,
      cfg.geminiApiKey,
      cfg.geminiModel,
      cfg.geminiReasoningEffort,
      false,
    );
    geminiReport = await benchmarkGeminiScenarioB(cfg.geminiApiKey, gemProbe);
    console.log(
      `\n=== Gemini [FAILOVER] model=${geminiReport.settings.model} thinking=${geminiReport.settings.reasoningEffort} ===`,
    );
    printPlainSummary("Scenario B (Warm)", geminiReport.scenarioB_warm);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    promptVersion: PROMPT_VERSION,
    systemPrompt: SYSTEM_PROMPT,
    baselines: {
      groq: groqBase.baseline,
      gemini: geminiBaseline,
    },
    availableModels: {
      groq: groqBase.modelIds,
      gemini: geminiModels,
    },
    groq: {
      fast: fastReport,
      reliable: reliableReport,
    },
    gemini: geminiReport,
  };
  writeFileSync(RESULTS_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`\nSaved live benchmark results to ${RESULTS_PATH}`);
}

function formatCliError(err: unknown): string {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const key = first?.path[0];
    if (key === "GROQ_API_KEY") {
      return "GROQ_API_KEY is missing: copy .env.example to .env at the repo root and set it";
    }
    if (key === "GROQ_MODEL_FAST") {
      return "GROQ_MODEL_FAST is missing: set it in .env or spikes/groq-llm/models.json (groqFast)";
    }
    if (key === "GROQ_MODEL_RELIABLE") {
      return "GROQ_MODEL_RELIABLE is missing: set it in .env or spikes/groq-llm/models.json (groqReliable)";
    }
    if (first) {
      return key !== undefined ? `${String(key)}: ${first.message}` : first.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

main().catch((err) => {
  console.error(formatCliError(err));
  process.exitCode = 1;
});
