import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { Agent, buildConnector, fetch, type Dispatcher, type Response } from "undici";
import { ZodError } from "zod";
import {
  CurrentTimeArgsSchema,
  GROQ_SERVICE_TIERS,
  NEAR_MISS_SHIPPING_PROMPT,
  NEAR_MISS_TIME_PROMPT,
  ORDER_TOOL_PROMPT,
  OrderStatusArgsSchema,
  PLAIN_PROMPT,
  PROMPT_VERSION,
  PROMPT_VERSION_V2,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_V2,
  TASK3D_MODEL_IDS,
  TIME_TOOL_PROMPT,
  TIME_TOOL_PROMPT_V2,
  TOOL_SCHEMA_VERSION_V1,
  TOOL_SCHEMA_VERSION_V2,
  VOICE_TOOLS,
  VOICE_TOOLS_V2,
  loadApiKeysConfig,
  loadSpikeConfig,
  parseDotEnv,
  parseTask3dModelFilter,
  type GroqServiceTier,
  type OpenAiToolDefinition,
  type ReasoningEffort,
  type SpikeEnvConfig,
  type Task3dModelId,
} from "./config.js";
import { SentenceSplitter } from "./sentence-splitter.js";
import { SseParser } from "./sse.js";
import { formatMs, formatPct, summarize, type DistributionStats } from "./stats.js";
import {
  GroqStreamAccumulator,
  detectClaimedCheckWithoutToolCall,
  isDailyRateLimitBody,
  validateCurrentTimeToolCalls,
  validateOrderStatusToolCalls,
  type AssembledToolCall,
  type ParsedStreamResult,
  type ToolValidationResult,
} from "./stream-parser.js";
import {
  GROQ_TPD_LIMIT,
  appendUsageLedgerEntry,
  evaluateGroqTokenBudgets,
  readUsageLedger,
  type ModelTokenBudget,
  type PlannedModelRequests,
} from "./usage-ledger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const OUT_DIR = path.join(__dirname, "out");
const RESULTS_PATH = path.join(OUT_DIR, "results.json");
const TASK3C_RESULTS_PATH = path.join(OUT_DIR, "task3c-results.json");
const TASK3D_RESULTS_PATH = path.join(OUT_DIR, "task3d-results.json");
const USAGE_LEDGER_PATH = path.join(OUT_DIR, "usage-ledger.jsonl");

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

const N_BASELINE = 10;
const N_RUNS = 20;
const N_TASK3C = 10;
const N_TASK3D = 10;
const GROQ_REQUESTS_PER_ITERATION = 11; // A(1) + B(1) + B-h2(1) + C-time(2) + C-order(2) + D-h1(2) + D-h2(2)
const GROQ_PACING_MS = 2400; // <= 25 RPM per model (free tier: 30 RPM, 8,000 TPM)
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

interface SocketConnectEvent {
  readonly dnsMs: number;
  readonly tcpMs: number;
  readonly tlsMs: number;
  readonly totalConnectMs: number;
  readonly protocol: HttpProtocol;
  readonly reusedTlsSession: boolean;
}

interface RequestConnectionMetrics {
  readonly newSocket: boolean;
  readonly socketsOpened: number;
  readonly dnsMs: number;
  readonly tcpMs: number;
  readonly tlsMs: number;
  readonly totalConnectMs: number;
  readonly protocol: HttpProtocol;
  readonly reusedTlsSession: boolean;
}

interface InstrumentedAgent {
  readonly agent: Agent;
  readonly getConnectCount: () => number;
  readonly getSocketCount: () => number;
  readonly getConnectEventsCount: () => number;
  readonly getConnectEventsSince: (startIndex: number) => readonly SocketConnectEvent[];
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

interface ModelProbeWithBudget {
  readonly probe: ModelProbeResult;
  readonly probeRequestsSpent: number;
  readonly rateLimitHeaders: Record<string, string>;
}

interface RequestBudgetEntry {
  readonly role: string;
  readonly model: string;
  readonly plannedLoopRequests: number;
  readonly probeRequestsSpent: number;
  readonly totalRequests: number;
  readonly remainingRequestsSource: "/models" | "/chat/completions" | "unavailable";
  readonly remainingRequests: number | null;
  readonly limitRequests: number | null;
  readonly resetRequests: string | null;
  readonly enoughForRun: boolean;
}

interface PlainRunSample {
  readonly ttftMs: number | null;
  readonly firstAnyTokenMs: number | null;
  readonly firstSentenceAbsMs: number | null;
  readonly firstSentenceRelMs: number | null;
  readonly totalMs: number;
  readonly reasoningTokens: number;
  readonly wronglyCalledTool: boolean;
  readonly serverQueueMs: number | null;
  readonly serverPromptMs: number | null;
  readonly serverCompletionMs: number | null;
  readonly serverPreFirstTokenMs: number | null;
  readonly serverPreContentEstMs: number | null;
  readonly networkFirstTokenMs: number | null;
  readonly networkContentTtftMs: number | null;
  readonly connection: RequestConnectionMetrics;
  readonly protocol: HttpProtocol;
  readonly cfRayLocation: string | null;
  readonly groqRegion: string | null;
  readonly serverTimingHeader: string | null;
  readonly rateLimitHeaders: Record<string, string>;
}

interface ToolRunSample {
  readonly passed: boolean;
  readonly calledAnyTool: boolean;
  readonly calledExpectedTool: boolean;
  readonly validJsonArgs: boolean;
  readonly validArgsSchema: boolean;
  readonly correctOrderId: boolean;
  readonly reason: string | null;
  readonly emittedContentBeforeToolCall: boolean;
  readonly preToolContentTtftMs: number | null;
  readonly req1TtftMs: number | null;
  readonly req1FirstAnyTokenMs: number | null;
  readonly req1Content: string;
  readonly req1FinishReason: string | null;
  readonly req1ServerQueueMs: number | null;
  readonly req2ServerQueueMs: number | null;
  readonly tToolCallMs: number | null;
  readonly tExecMs: number | null;
  readonly followupTtftMs: number | null;
  readonly followupFirstSentenceAbsMs: number | null;
  readonly followupSucceeded: boolean;
  readonly e2eMs: number | null;
  readonly totalMs: number;
  readonly reasoningTokensReq1: number;
  readonly reasoningTokensReq2: number;
  readonly connectionReq1: RequestConnectionMetrics;
  readonly connectionReq2: RequestConnectionMetrics | null;
  readonly protocol: HttpProtocol;
  readonly cfRayLocation: string | null;
  readonly groqRegion: string | null;
  readonly rateLimitHeaders: Record<string, string>;
}

interface CancelCycleSample {
  readonly abortedTtftMs: number;
  readonly deltasAfterAbort: number;
  readonly postAbortTtftMs: number | null;
  readonly newAgentConnections: number;
  readonly newSocketConnects: number;
  readonly abortedConnection: RequestConnectionMetrics;
  readonly followUpConnection: RequestConnectionMetrics;
  readonly protocol: HttpProtocol;
  readonly cfRayLocation: string | null;
}

type ChatMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly tool_calls: ReadonlyArray<{
        readonly id: string;
        readonly type: string;
        readonly function: { readonly name: string; readonly arguments: string };
      }>;
    }
  | { readonly role: "tool"; readonly tool_call_id: string; readonly content: string };

class PerModelRatePacer {
  private readonly nextAllowedAt = new Map<string, number>();

  async waitForModel(model: string): Promise<void> {
    const next = this.nextAllowedAt.get(model);
    if (next === undefined) return;
    const delay = next - performance.now();
    if (delay > 0) {
      await sleep(delay);
    }
  }

  recordRequests(model: string, requestCount: number, pacingMs: number): void {
    this.nextAllowedAt.set(model, performance.now() + requestCount * pacingMs);
  }
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

function createInstrumentedAgent(
  allowH2: boolean,
  options: { readonly disableSessionCache?: boolean } = {},
): InstrumentedAgent {
  let agentConnectCount = 0;
  let socketConnectCount = 0;
  let lastProtocol: HttpProtocol = "unknown";
  const connectEvents: SocketConnectEvent[] = [];

  const baseConnector = buildConnector({
    allowH2,
    keepAlive: true,
    ...(options.disableSessionCache ? { maxCachedSessions: 0 } : {}),
  });
  const instrumentedConnector: buildConnector.connector = (opts, callback) => {
    const t0 = performance.now();
    let tLookup: number | null = null;
    let tTcp: number | null = null;
    const isHttps = opts.protocol === "https:";

    const pendingSocket = baseConnector(opts, (err, socket) => {
      const tDone = performance.now();
      if (err || !socket) {
        callback(err, null);
        return;
      }
      socketConnectCount += 1;
      const tlsSock = socket as Partial<TLSSocket>;
      let protocol: HttpProtocol;
      if (tlsSock.alpnProtocol === "h2") {
        protocol = "h2";
      } else if (tlsSock.alpnProtocol === "http/1.1" || tlsSock.alpnProtocol === false) {
        protocol = "h1";
      } else {
        protocol = allowH2 ? "unknown" : "h1";
      }
      lastProtocol = protocol;

      const dnsMs = tLookup !== null ? Math.max(0, tLookup - t0) : 0;
      const tcpMs = tTcp !== null ? Math.max(0, tTcp - (tLookup ?? t0)) : 0;
      const tlsMs = isHttps ? Math.max(0, tDone - (tTcp ?? tLookup ?? t0)) : 0;
      const totalConnectMs = Math.max(0, tDone - t0);
      const reusedTlsSession =
        typeof tlsSock.isSessionReused === "function" ? tlsSock.isSessionReused() : false;

      connectEvents.push({
        dnsMs,
        tcpMs,
        tlsMs,
        totalConnectMs,
        protocol,
        reusedTlsSession,
      });
      callback(null, socket);
    }) as unknown as net.Socket | undefined;

    if (pendingSocket && typeof pendingSocket.once === "function") {
      pendingSocket.once("lookup", () => {
        tLookup = performance.now();
      });
      pendingSocket.once("connect", () => {
        tTcp = performance.now();
      });
    }
  };

  const agent = new Agent({
    allowH2,
    connections: 1,
    connect: instrumentedConnector,
    keepAliveTimeout: 120_000,
    keepAliveMaxTimeout: 300_000,
  });
  agent.on("connect", (_origin: URL, _targets: readonly Dispatcher[]) => {
    agentConnectCount += 1;
  });

  return {
    agent,
    getConnectCount: () => agentConnectCount,
    getSocketCount: () => socketConnectCount,
    getConnectEventsCount: () => connectEvents.length,
    getConnectEventsSince: (startIndex: number) => connectEvents.slice(startIndex),
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

function extractGroqRegion(headers: Response["headers"]): string | null {
  const region = headers.get("x-groq-region");
  return region && region.trim().length > 0 ? region.trim() : null;
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
    .filter(
      (m): m is { id: string; owned_by?: string; active?: boolean; context_window?: number } =>
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
        `/models control-plane RTT (not the inference path)(med=${formatMs(baseline.originRttMs.median)}, p90=${formatMs(baseline.originRttMs.p90)})`,
    );
    return { baseline, modelIds: warmup.modelIds };
  } finally {
    await instr.close();
  }
}

type ToolChoiceOption = "auto" | "required" | "none";

interface ChatRequestOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly prompt?: string;
  readonly messages?: readonly ChatMessage[];
  readonly tools: readonly OpenAiToolDefinition[] | undefined;
  readonly toolChoice?: ToolChoiceOption;
  readonly reasoningEffort?: ReasoningEffort | "default" | undefined;
  readonly reasoningFormat?: "parsed" | "default" | undefined;
  readonly serviceTier?: GroqServiceTier | undefined;
  readonly instr: InstrumentedAgent;
  readonly maxTokens?: number;
  readonly abortOnFirstContent?: boolean;
}

interface ChatStreamOutcome {
  readonly parsed: ParsedStreamResult;
  readonly startTimestampMs: number;
  readonly firstContentTimestampMs: number | null;
  readonly firstAnyTokenMs: number | null;
  readonly ttftMs: number | null;
  readonly toolCallAssembledMs: number | null;
  readonly firstSentenceAbsMs: number | null;
  readonly firstSentenceRelMs: number | null;
  readonly totalMs: number;
  readonly rateLimitWaitMs: number;
  readonly deltasAfterAbort: number;
  readonly aborted: boolean;
  readonly connection: RequestConnectionMetrics;
  readonly cfRayLocation: string | null;
  readonly groqRegion: string | null;
  readonly serverTimingHeader: string | null;
  readonly rateLimitHeaders: Record<string, string>;
}

function buildConnectionMetrics(
  events: readonly SocketConnectEvent[],
  fallbackProtocol: HttpProtocol,
): RequestConnectionMetrics {
  const first = events[0];
  if (first === undefined) {
    return {
      newSocket: false,
      socketsOpened: 0,
      dnsMs: 0,
      tcpMs: 0,
      tlsMs: 0,
      totalConnectMs: 0,
      protocol: fallbackProtocol,
      reusedTlsSession: false,
    };
  }
  return {
    newSocket: true,
    socketsOpened: events.length,
    dnsMs: first.dnsMs,
    tcpMs: first.tcpMs,
    tlsMs: first.tlsMs,
    totalConnectMs: first.totalConnectMs,
    protocol: first.protocol,
    reusedTlsSession: first.reusedTlsSession,
  };
}

function assertColdConnection(label: string, conn: RequestConnectionMetrics): void {
  if (!conn.newSocket || conn.socketsOpened !== 1) {
    throw new Error(
      `Cold connection bug (${label}): expected 1 new socket, got newSocket=${conn.newSocket} socketsOpened=${conn.socketsOpened}`,
    );
  }
  if (conn.tlsMs <= 0) {
    throw new Error(
      `Cold connection bug (${label}): expected non-zero TLS handshake ms, got tlsMs=${conn.tlsMs}`,
    );
  }
}

function assertWarmConnection(label: string, conn: RequestConnectionMetrics): void {
  if (conn.newSocket || conn.socketsOpened !== 0) {
    throw new Error(
      `Warm connection bug (${label}): expected socket reuse (0 new sockets), got newSocket=${conn.newSocket} socketsOpened=${conn.socketsOpened}`,
    );
  }
}

function buildChatRequestBody(
  opts: Pick<
    ChatRequestOptions,
    | "model"
    | "systemPrompt"
    | "prompt"
    | "messages"
    | "tools"
    | "toolChoice"
    | "reasoningEffort"
    | "reasoningFormat"
    | "serviceTier"
    | "maxTokens"
  >,
): Record<string, unknown> {
  const messages: readonly ChatMessage[] =
    opts.messages ?? [
      { role: "system", content: opts.systemPrompt ?? SYSTEM_PROMPT },
      { role: "user", content: opts.prompt ?? PLAIN_PROMPT },
    ];
  const bodyObj: Record<string, unknown> = {
    model: opts.model,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.2,
    max_tokens: opts.maxTokens ?? 150,
    messages,
  };
  if (opts.tools !== undefined) {
    bodyObj.tools = opts.tools;
    bodyObj.tool_choice = opts.toolChoice ?? "auto";
  }
  if (opts.reasoningEffort !== undefined) {
    bodyObj.reasoning_effort = opts.reasoningEffort;
  }
  if (opts.reasoningFormat === "parsed") {
    bodyObj.reasoning_format = "parsed";
  }
  if (opts.serviceTier !== undefined) {
    bodyObj.service_tier = opts.serviceTier;
  }
  return bodyObj;
}

async function runStreamingChat(opts: ChatRequestOptions): Promise<ChatStreamOutcome> {
  const controller = new AbortController();
  const bodyObj = buildChatRequestBody(opts);

  let res: Response | null = null;
  let tStart = 0;
  let rateLimitWaitMs = 0;
  let connectEventsStartIdx = 0;
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    connectEventsStartIdx = opts.instr.getConnectEventsCount();
    tStart = performance.now();
    res = await fetch(`${opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyObj),
      dispatcher: opts.instr.agent,
      signal: controller.signal,
    });

    if (res.status !== 429) {
      break;
    }
    const errText = await res.text();
    if (isDailyRateLimitBody(errText)) {
      throw new Error(
        `Daily quota exhausted on ${opts.model} (429): ${errText}`,
      );
    }
    if (attempt === MAX_RATE_LIMIT_RETRIES) {
      throw new Error(
        `POST ${opts.baseUrl}/chat/completions (${opts.model}) failed ${res.status}: ${errText}`,
      );
    }
    const waitMs = computeRateLimitWaitMs(res, errText);
    rateLimitWaitMs += waitMs;
    console.warn(
      `[RateLimit] 429 on ${opts.model} (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}), waiting ${waitMs} ms`,
    );
    await sleep(waitMs);
  }

  if (!res) {
    throw new Error("Fetch did not return a response");
  }
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `POST ${opts.baseUrl}/chat/completions (${opts.model}) failed ${res.status}: ${errText}`,
    );
  }
  if (!res.body) {
    throw new Error("Response body was null");
  }

  const cfRayLocation = extractCfRayLocation(res.headers);
  const groqRegion = extractGroqRegion(res.headers);
  const serverTimingHeader = res.headers.get("server-timing");
  const rateLimitHeaders = extractRateLimitHeaders(res.headers);

  const sse = new SseParser();
  const acc = new GroqStreamAccumulator();
  const splitter = new SentenceSplitter();

  let firstContentTimestampMs: number | null = null;
  let firstAnyTokenMs: number | null = null;
  let ttftMs: number | null = null;
  let toolCallAssembledMs: number | null = null;
  let lastToolDeltaTimestampMs: number | null = null;
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
        if (
          firstAnyTokenMs === null &&
          (step.reasoningDelta.length > 0 || step.isFirstContentDelta || step.hasToolCallDelta)
        ) {
          firstAnyTokenMs = now - tStart;
        }
        if (step.hasToolCallDelta) {
          lastToolDeltaTimestampMs = now;
        }
        if (step.finishReason === "tool_calls" && toolCallAssembledMs === null) {
          toolCallAssembledMs = now - tStart;
        }
        if (step.isFirstContentDelta && ttftMs === null) {
          firstContentTimestampMs = now;
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
      await reader.cancel().catch(() => undefined);
    } else {
      const flushNow = performance.now();
      for (const evt of sse.flush()) {
        const step = acc.pushEventData(evt.data);
        if (step.done) continue;
        if (
          firstAnyTokenMs === null &&
          (step.reasoningDelta.length > 0 || step.isFirstContentDelta || step.hasToolCallDelta)
        ) {
          firstAnyTokenMs = flushNow - tStart;
        }
        if (step.hasToolCallDelta) {
          lastToolDeltaTimestampMs = flushNow;
        }
        if (step.finishReason === "tool_calls" && toolCallAssembledMs === null) {
          toolCallAssembledMs = flushNow - tStart;
        }
        if (step.isFirstContentDelta && ttftMs === null) {
          firstContentTimestampMs = flushNow;
          ttftMs = flushNow - tStart;
        }
        if (step.contentDelta.length > 0) {
          const sentences = splitter.push(step.contentDelta);
          if (sentences.length > 0 && firstSentenceAbsMs === null) {
            firstSentenceAbsMs = flushNow - tStart;
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
  const parsed = acc.result();
  if (toolCallAssembledMs === null && parsed.toolCalls.length > 0) {
    toolCallAssembledMs =
      lastToolDeltaTimestampMs !== null ? lastToolDeltaTimestampMs - tStart : totalMs;
  }

  const firstSentenceRelMs =
    firstSentenceAbsMs !== null && ttftMs !== null ? firstSentenceAbsMs - ttftMs : null;
  const connection = buildConnectionMetrics(
    opts.instr.getConnectEventsSince(connectEventsStartIdx),
    opts.instr.getLastProtocol(),
  );

  if (
    opts.baseUrl === GROQ_BASE_URL &&
    (parsed.usage.totalTokens !== null ||
      parsed.usage.promptTokens !== null ||
      parsed.usage.completionTokens !== null)
  ) {
    const promptTokens = parsed.usage.promptTokens ?? 0;
    const completionTokens = parsed.usage.completionTokens ?? 0;
    const totalTokens = parsed.usage.totalTokens ?? promptTokens + completionTokens;
    appendUsageLedgerEntry(USAGE_LEDGER_PATH, {
      ts: new Date().toISOString(),
      model: opts.model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    });
  }

  return {
    parsed,
    startTimestampMs: tStart,
    firstContentTimestampMs,
    firstAnyTokenMs,
    ttftMs,
    toolCallAssembledMs,
    firstSentenceAbsMs,
    firstSentenceRelMs,
    totalMs,
    rateLimitWaitMs,
    deltasAfterAbort,
    aborted: abortedAtMs !== null,
    connection,
    cfRayLocation,
    groqRegion,
    serverTimingHeader,
    rateLimitHeaders,
  };
}

function executeLocalTool(toolCall: AssembledToolCall): {
  readonly output: string;
  readonly execMs: number;
} {
  const t0 = performance.now();
  let payload: Record<string, unknown>;
  if (toolCall.name === "get_current_time") {
    const parsed = CurrentTimeArgsSchema.safeParse(toolCall.parsedArguments);
    const requestedTz = parsed.success ? (parsed.data.timezone ?? "Asia/Kolkata") : "Asia/Kolkata";
    let usedTz = requestedTz;
    let formatted: string;
    try {
      formatted = new Intl.DateTimeFormat("en-US", {
        timeZone: requestedTz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      }).format(new Date());
    } catch {
      usedTz = "UTC";
      formatted = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      }).format(new Date());
    }
    payload = { time: formatted, timezone: usedTz };
  } else if (toolCall.name === "get_order_status") {
    const parsed = OrderStatusArgsSchema.safeParse(toolCall.parsedArguments);
    const orderId = parsed.success ? parsed.data.order_id : "unknown";
    payload = { order_id: orderId, status: "shipped", eta: "tomorrow by 6 PM" };
  } else {
    payload = { error: `Unknown tool: ${toolCall.name}` };
  }
  const output = JSON.stringify(payload);
  const execMs = performance.now() - t0;
  return { output, execMs };
}

async function probeReasoningSettings(
  baseUrl: string,
  apiKey: string,
  model: string,
  overrideEffort: ReasoningEffort | undefined,
  allowReasoningFormat: boolean,
): Promise<ModelProbeWithBudget> {
  const instr = createInstrumentedAgent(false);
  let probeRequestsSpent = 0;
  let lastHeaders: Record<string, string> = {};

  const doProbe = async (
    prompt: string,
    maxTokens: number,
    reasoningEffort?: ReasoningEffort,
    reasoningFormat?: "parsed" | "default",
  ) => {
    probeRequestsSpent += 1;
    const outcome = await runStreamingChat({
      baseUrl,
      apiKey,
      model,
      prompt,
      tools: undefined,
      reasoningEffort,
      reasoningFormat,
      instr,
      maxTokens,
    });
    if (Object.keys(outcome.rateLimitHeaders).length > 0) {
      lastHeaders = outcome.rateLimitHeaders;
    }
    return outcome;
  };

  try {
    if (overrideEffort !== undefined) {
      let reasoningFormat: "parsed" | "default" = "default";
      if (allowReasoningFormat && overrideEffort !== "none") {
        try {
          await doProbe("Say ok.", 16, overrideEffort, "parsed");
          reasoningFormat = "parsed";
        } catch {
          await doProbe("Say ok.", 16, overrideEffort, undefined);
        }
      } else {
        await doProbe("Say ok.", 16, overrideEffort, undefined);
      }
      return {
        probe: {
          model,
          isReasoningModel: overrideEffort !== "none",
          reasoningEffort: overrideEffort,
          reasoningFormat,
        },
        probeRequestsSpent,
        rateLimitHeaders: lastHeaders,
      };
    }

    const defaultProbe = await doProbe("Reply with the word ok.", 24);
    const hasReasoning =
      defaultProbe.parsed.reasoningDeltaCount > 0 ||
      (defaultProbe.parsed.usage.reasoningTokens ?? 0) > 0 ||
      defaultProbe.parsed.content.includes("<think>");

    if (!hasReasoning) {
      if (!allowReasoningFormat) {
        for (const effort of ["none", "minimal", "low"] as const) {
          try {
            await doProbe("Reply with ok.", 16, effort);
            return {
              probe: {
                model,
                isReasoningModel: true,
                reasoningEffort: effort,
                reasoningFormat: "default",
              },
              probeRequestsSpent,
              rateLimitHeaders: lastHeaders,
            };
          } catch {
            // Try next lowest effort tier.
          }
        }
      }
      return {
        probe: {
          model,
          isReasoningModel: false,
          reasoningEffort: "not_applicable",
          reasoningFormat: "default",
        },
        probeRequestsSpent,
        rateLimitHeaders: lastHeaders,
      };
    }

    const efforts: readonly ReasoningEffort[] = ["none", "minimal", "low"];
    for (const effort of efforts) {
      if (allowReasoningFormat && effort !== "none") {
        try {
          await doProbe("Reply with ok.", 16, effort, "parsed");
          return {
            probe: {
              model,
              isReasoningModel: true,
              reasoningEffort: effort,
              reasoningFormat: "parsed",
            },
            probeRequestsSpent,
            rateLimitHeaders: lastHeaders,
          };
        } catch {
          // Fallback without reasoning_format below.
        }
      }
      try {
        await doProbe("Reply with ok.", 16, effort);
        return {
          probe: {
            model,
            isReasoningModel: effort !== "none",
            reasoningEffort: effort,
            reasoningFormat: "default",
          },
          probeRequestsSpent,
          rateLimitHeaders: lastHeaders,
        };
      } catch {
        // Try next effort tier.
      }
    }

    return {
      probe: {
        model,
        isReasoningModel: true,
        reasoningEffort: "not_applicable",
        reasoningFormat: "default",
      },
      probeRequestsSpent,
      rateLimitHeaders: lastHeaders,
    };
  } finally {
    await instr.close();
  }
}

function summarizeConnectionMetrics(conns: readonly RequestConnectionMetrics[]) {
  const newSocketConns = conns.filter((c) => c.newSocket);
  return {
    n: conns.length,
    newSockets: newSocketConns.length,
    newSocketRate: formatPct(newSocketConns.length, conns.length),
    dnsMs: summarize(newSocketConns.map((c) => c.dnsMs)),
    tcpMs: summarize(newSocketConns.map((c) => c.tcpMs)),
    tlsMs: summarize(newSocketConns.map((c) => c.tlsMs)),
    totalConnectMs: summarize(newSocketConns.map((c) => c.totalConnectMs)),
  };
}

function summarizePlainRuns(runs: readonly PlainRunSample[]) {
  const ttfts = runs.map((r) => r.ttftMs).filter((v): v is number => v !== null);
  const firstAnyTokens = runs.map((r) => r.firstAnyTokenMs).filter((v): v is number => v !== null);
  const absFirst = runs.map((r) => r.firstSentenceAbsMs).filter((v): v is number => v !== null);
  const relFirst = runs.map((r) => r.firstSentenceRelMs).filter((v): v is number => v !== null);
  const totals = runs.map((r) => r.totalMs);
  const reasoning = runs.map((r) => r.reasoningTokens);
  const serverQueues = runs.map((r) => r.serverQueueMs).filter((v): v is number => v !== null);
  const serverPrompts = runs.map((r) => r.serverPromptMs).filter((v): v is number => v !== null);
  const serverCompletions = runs.map((r) => r.serverCompletionMs).filter((v): v is number => v !== null);
  const serverPreFirstTokens = runs
    .map((r) => r.serverPreFirstTokenMs)
    .filter((v): v is number => v !== null);
  const serverPreContentEsts = runs
    .map((r) => r.serverPreContentEstMs)
    .filter((v): v is number => v !== null);
  const networkFirstTokens = runs
    .map((r) => r.networkFirstTokenMs)
    .filter((v): v is number => v !== null);
  const networkContentTtfts = runs
    .map((r) => r.networkContentTtftMs)
    .filter((v): v is number => v !== null);
  const wrongToolCalls = runs.filter((r) => r.wronglyCalledTool).length;
  const protocols = [...new Set(runs.map((r) => r.protocol))];
  const edgeLocations = [
    ...new Set(runs.map((r) => r.cfRayLocation).filter((v): v is string => v !== null)),
  ];
  const groqRegions = [
    ...new Set(runs.map((r) => r.groqRegion).filter((v): v is string => v !== null)),
  ];
  const serverTimingHeaders = [
    ...new Set(runs.map((r) => r.serverTimingHeader).filter((v): v is string => v !== null)),
  ];
  const rateLimits = Object.assign({}, ...runs.map((r) => r.rateLimitHeaders));

  return {
    n: runs.length,
    ttftMs: summarize(ttfts),
    firstAnyTokenMs: summarize(firstAnyTokens),
    firstSentenceAbsMs: summarize(absFirst),
    firstSentenceRelMs: summarize(relFirst),
    totalMs: summarize(totals),
    reasoningTokens: summarize(reasoning),
    serverTimings: {
      available: serverPreFirstTokens.length > 0,
      sampleCount: serverPreFirstTokens.length,
      queueTimeMs: summarize(serverQueues),
      promptTimeMs: summarize(serverPrompts),
      completionTimeMs: summarize(serverCompletions),
      serverPreFirstTokenMs: summarize(serverPreFirstTokens),
      serverPreContentEstMs: summarize(serverPreContentEsts),
      networkFirstTokenMs: summarize(networkFirstTokens),
      networkContentTtftMs: summarize(networkContentTtfts),
    },
    wrongToolCalls,
    wrongToolCallRate: formatPct(wrongToolCalls, runs.length),
    connection: summarizeConnectionMetrics(runs.map((r) => r.connection)),
    protocols,
    edgeLocations,
    groqRegions,
    serverTimingHeaders,
    rateLimitHeaders: rateLimits,
  };
}

function summarizeToolRuns(
  utterance: string,
  prompt: string,
  expectedTool: string,
  runs: readonly ToolRunSample[],
) {
  const passedCount = runs.filter((r) => r.passed).length;
  const fillerRuns = runs.filter((r) => r.emittedContentBeforeToolCall);
  const fillerTtfts = fillerRuns
    .map((r) => r.preToolContentTtftMs)
    .filter((v): v is number => v !== null);
  const followupSuccessCount = runs.filter((r) => r.followupSucceeded).length;
  const req1Ttfts = runs.map((r) => r.req1TtftMs).filter((v): v is number => v !== null);
  const req1FirstAnyTokens = runs
    .map((r) => r.req1FirstAnyTokenMs)
    .filter((v): v is number => v !== null);
  const tToolCalls = runs.map((r) => r.tToolCallMs).filter((v): v is number => v !== null);
  const tExecs = runs.map((r) => r.tExecMs).filter((v): v is number => v !== null);
  const followupTtfts = runs.map((r) => r.followupTtftMs).filter((v): v is number => v !== null);
  const e2es = runs.map((r) => r.e2eMs).filter((v): v is number => v !== null);
  const totals = runs.map((r) => r.totalMs);
  const reasoningReq1 = runs.map((r) => r.reasoningTokensReq1);
  const reasoningReq2 = runs.map((r) => r.reasoningTokensReq2);
  const protocols = [...new Set(runs.map((r) => r.protocol))];
  const edgeLocations = [
    ...new Set(runs.map((r) => r.cfRayLocation).filter((v): v is string => v !== null)),
  ];
  const groqRegions = [
    ...new Set(runs.map((r) => r.groqRegion).filter((v): v is string => v !== null)),
  ];
  const rateLimits = Object.assign({}, ...runs.map((r) => r.rateLimitHeaders));
  const req2Conns = runs
    .map((r) => r.connectionReq2)
    .filter((c): c is RequestConnectionMetrics => c !== null);

  return {
    utterance,
    prompt,
    expectedTool,
    n: runs.length,
    passedCount,
    toolCorrectnessRate: formatPct(passedCount, runs.length),
    followupSucceededCount: followupSuccessCount,
    followupSuccessRate: formatPct(followupSuccessCount, runs.length),
    fillerCount: fillerRuns.length,
    fillerRate: formatPct(fillerRuns.length, runs.length),
    preToolContentTtftMs: summarize(fillerTtfts),
    req1TtftMs: summarize(req1Ttfts),
    req1FirstAnyTokenMs: summarize(req1FirstAnyTokens),
    tToolCallMs: summarize(tToolCalls),
    tExecMs: summarize(tExecs),
    followupTtftMs: summarize(followupTtfts),
    e2eMs: summarize(e2es),
    totalMs: summarize(totals),
    reasoningTokensReq1: summarize(reasoningReq1),
    reasoningTokensReq2: summarize(reasoningReq2),
    connectionReq1: summarizeConnectionMetrics(runs.map((r) => r.connectionReq1)),
    connectionReq2: summarizeConnectionMetrics(req2Conns),
    protocols,
    edgeLocations,
    groqRegions,
    rateLimitHeaders: rateLimits,
    failureReasons: runs.filter((r) => !r.passed).map((r) => r.reason),
    plainTextSamples: runs
      .filter((r) => !r.calledAnyTool && r.req1Content.length > 0)
      .slice(0, 3)
      .map((r) => ({
        content: r.req1Content,
        finishReason: r.req1FinishReason,
        ttftMs: r.req1TtftMs,
      })),
  };
}

function summarizeCancelRuns(
  runs: readonly CancelCycleSample[],
  warmBaselineLabel: string,
  normalWarmTtftMedian: number | null,
) {
  const postTtfts = runs.map((r) => r.postAbortTtftMs).filter((v): v is number => v !== null);
  const reconnects = runs.filter((r) => r.newSocketConnects > 0 || r.newAgentConnections > 0).length;
  const maxDeltasAfterAbort = Math.max(0, ...runs.map((r) => r.deltasAfterAbort));
  const protocols = [...new Set(runs.map((r) => r.protocol))];
  const edgeLocations = [
    ...new Set(runs.map((r) => r.cfRayLocation).filter((v): v is string => v !== null)),
  ];
  const postStats = summarize(postTtfts);
  const deltaVsWarmMedianMs =
    postStats.median !== null && normalWarmTtftMedian !== null
      ? postStats.median - normalWarmTtftMedian
      : null;

  return {
    n: runs.length,
    warmBaselineLabel,
    maxDeltasAfterAbort,
    reconnects,
    reconnectRate: formatPct(reconnects, runs.length),
    postAbortTtftMs: postStats,
    normalWarmTtftMedianMs: normalWarmTtftMedian,
    deltaVsWarmMedianMs,
    followUpConnection: summarizeConnectionMetrics(runs.map((r) => r.followUpConnection)),
    protocols,
    edgeLocations,
  };
}

async function runToolTurn(
  apiKey: string,
  probe: ModelProbeResult,
  warmInstr: InstrumentedAgent,
  prompt: string,
  validate: (toolCalls: readonly AssembledToolCall[]) => ToolValidationResult,
  label: string,
  toolChoiceReq1: ToolChoiceOption = "auto",
  options: {
    readonly systemPrompt?: string;
    readonly tools?: readonly OpenAiToolDefinition[];
    readonly serviceTier?: GroqServiceTier;
  } = {},
): Promise<ToolRunSample> {
  const reasoningEffort =
    probe.reasoningEffort === "not_applicable" ? undefined : probe.reasoningEffort;
  const systemPrompt = options.systemPrompt ?? SYSTEM_PROMPT;
  const tools = options.tools ?? VOICE_TOOLS;

  const req1 = await runStreamingChat({
    baseUrl: GROQ_BASE_URL,
    apiKey,
    model: probe.model,
    systemPrompt,
    prompt,
    tools,
    toolChoice: toolChoiceReq1,
    reasoningEffort,
    reasoningFormat: probe.reasoningFormat,
    serviceTier: options.serviceTier,
    instr: warmInstr,
  });
  assertWarmConnection(`${label}:req1`, req1.connection);

  const validation = validate(req1.parsed.toolCalls);
  let tExecMs: number | null = null;
  let followupTtftMs: number | null = null;
  let followupFirstSentenceAbsMs: number | null = null;
  let followupSucceeded = false;
  let e2eMs: number | null = null;
  let req2Connection: RequestConnectionMetrics | null = null;
  let req2ServerQueueMs: number | null = null;
  let reasoningTokensReq2 = 0;
  let totalMs = req1.totalMs;
  let cfRayLocation = req1.cfRayLocation;
  let groqRegion = req1.groqRegion;
  let rateLimitHeaders = req1.rateLimitHeaders;

  if (validation.passed && req1.parsed.toolCalls.length > 0) {
    const toolMessages: ChatMessage[] = [];
    let execAccum = 0;
    for (const tc of req1.parsed.toolCalls) {
      const exec = executeLocalTool(tc);
      execAccum += exec.execMs;
      toolMessages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: exec.output,
      });
    }
    tExecMs = execAccum;

    const followupMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
      {
        role: "assistant",
        content: req1.parsed.content.length > 0 ? req1.parsed.content : null,
        tool_calls: req1.parsed.toolCalls.map((tc) => ({
          id: tc.id,
          type: tc.type || "function",
          function: {
            name: tc.name,
            arguments: tc.rawArguments,
          },
        })),
      },
      ...toolMessages,
    ];

    const req2 = await runStreamingChat({
      baseUrl: GROQ_BASE_URL,
      apiKey,
      model: probe.model,
      messages: followupMessages,
      tools,
      toolChoice: "auto",
      reasoningEffort,
      reasoningFormat: probe.reasoningFormat,
      serviceTier: options.serviceTier,
      instr: warmInstr,
    });
    assertWarmConnection(`${label}:req2`, req2.connection);

    req2Connection = req2.connection;
    req2ServerQueueMs = req2.parsed.usage.queueTimeMs;
    followupTtftMs = req2.ttftMs;
    followupFirstSentenceAbsMs = req2.firstSentenceAbsMs;
    followupSucceeded = req2.ttftMs !== null && req2.parsed.toolCalls.length === 0;
    e2eMs =
      req2.firstContentTimestampMs !== null
        ? req2.firstContentTimestampMs - req1.startTimestampMs - req2.rateLimitWaitMs
        : null;
    reasoningTokensReq2 = req2.parsed.usage.reasoningTokens ?? 0;
    totalMs = req1.totalMs + execAccum + req2.totalMs;
    if (req2.cfRayLocation) cfRayLocation = req2.cfRayLocation;
    if (req2.groqRegion) groqRegion = req2.groqRegion;
    rateLimitHeaders = { ...rateLimitHeaders, ...req2.rateLimitHeaders };
  }

  return {
    ...validation,
    emittedContentBeforeToolCall: req1.parsed.emittedContentBeforeToolCall,
    preToolContentTtftMs: req1.parsed.emittedContentBeforeToolCall ? req1.ttftMs : null,
    req1TtftMs: req1.ttftMs,
    req1FirstAnyTokenMs: req1.firstAnyTokenMs,
    req1Content: req1.parsed.content,
    req1FinishReason: req1.parsed.finishReason,
    req1ServerQueueMs: req1.parsed.usage.queueTimeMs,
    req2ServerQueueMs,
    tToolCallMs: req1.toolCallAssembledMs,
    tExecMs,
    followupTtftMs,
    followupFirstSentenceAbsMs,
    followupSucceeded,
    e2eMs,
    totalMs,
    reasoningTokensReq1: req1.parsed.usage.reasoningTokens ?? 0,
    reasoningTokensReq2,
    connectionReq1: req1.connection,
    connectionReq2: req2Connection,
    protocol: req1.connection.protocol,
    cfRayLocation,
    groqRegion,
    rateLimitHeaders,
  };
}

function toPlainRunSample(res: ChatStreamOutcome): PlainRunSample {
  const queueMs = res.parsed.usage.queueTimeMs;
  const promptMs = res.parsed.usage.promptTimeMs;
  const completionMs = res.parsed.usage.completionTimeMs;
  const reasoningTokens = res.parsed.usage.reasoningTokens ?? 0;
  const completionTokens = res.parsed.usage.completionTokens ?? 0;
  const serverPreFirstTokenMs =
    queueMs !== null && promptMs !== null ? queueMs + promptMs : null;
  const reasoningEstMs =
    reasoningTokens > 0 && completionTokens > 0 && completionMs !== null
      ? completionMs * (reasoningTokens / completionTokens)
      : 0;
  const serverPreContentEstMs =
    serverPreFirstTokenMs !== null ? serverPreFirstTokenMs + reasoningEstMs : null;
  const networkFirstTokenMs =
    res.firstAnyTokenMs !== null && serverPreFirstTokenMs !== null
      ? res.firstAnyTokenMs - serverPreFirstTokenMs
      : null;
  const networkContentTtftMs =
    res.ttftMs !== null && serverPreContentEstMs !== null
      ? res.ttftMs - serverPreContentEstMs
      : null;

  return {
    ttftMs: res.ttftMs,
    firstAnyTokenMs: res.firstAnyTokenMs,
    firstSentenceAbsMs: res.firstSentenceAbsMs,
    firstSentenceRelMs: res.firstSentenceRelMs,
    totalMs: res.totalMs,
    reasoningTokens,
    wronglyCalledTool: res.parsed.toolCalls.length > 0,
    serverQueueMs: queueMs,
    serverPromptMs: promptMs,
    serverCompletionMs: completionMs,
    serverPreFirstTokenMs,
    serverPreContentEstMs,
    networkFirstTokenMs,
    networkContentTtftMs,
    connection: res.connection,
    protocol: res.connection.protocol,
    cfRayLocation: res.cfRayLocation,
    groqRegion: res.groqRegion,
    serverTimingHeader: res.serverTimingHeader,
    rateLimitHeaders: res.rateLimitHeaders,
  };
}

async function runSingleCancelCycle(
  apiKey: string,
  probe: ModelProbeResult,
  instr: InstrumentedAgent,
  allowH2: boolean,
  iteration: number,
): Promise<CancelCycleSample> {
  const reasoningEffort =
    probe.reasoningEffort === "not_applicable" ? undefined : probe.reasoningEffort;

  const abortedRun = await runStreamingChat({
    baseUrl: GROQ_BASE_URL,
    apiKey,
    model: probe.model,
    prompt: PLAIN_PROMPT,
    tools: VOICE_TOOLS,
    reasoningEffort,
    reasoningFormat: probe.reasoningFormat,
    instr,
    abortOnFirstContent: true,
  });
  assertWarmConnection(
    `${probe.model}:D-${allowH2 ? "h2" : "h1"}[${iteration}]:aborted`,
    abortedRun.connection,
  );
  if (!abortedRun.aborted) {
    throw new Error(
      `${probe.model} D-${allowH2 ? "h2" : "h1"} cycle ${iteration + 1}: stream finished without emitting content before abort`,
    );
  }
  if (abortedRun.deltasAfterAbort > 0) {
    throw new Error(
      `${probe.model} D-${allowH2 ? "h2" : "h1"} cycle ${iteration + 1}: expected 0 deltas after abort, saw ${abortedRun.deltasAfterAbort}`,
    );
  }

  const agentConnBefore = instr.getConnectCount();
  const sockConnBefore = instr.getSocketCount();
  const followUp = await runStreamingChat({
    baseUrl: GROQ_BASE_URL,
    apiKey,
    model: probe.model,
    prompt: PLAIN_PROMPT,
    tools: VOICE_TOOLS,
    reasoningEffort,
    reasoningFormat: probe.reasoningFormat,
    instr,
  });

  // Yield briefly so undici returns the finished HTTP/1.1 keep-alive socket before the next iteration.
  await sleep(25);

  return {
    abortedTtftMs: abortedRun.ttftMs ?? abortedRun.totalMs,
    deltasAfterAbort: abortedRun.deltasAfterAbort,
    postAbortTtftMs: followUp.ttftMs,
    newAgentConnections: instr.getConnectCount() - agentConnBefore,
    newSocketConnects: instr.getSocketCount() - sockConnBefore,
    abortedConnection: abortedRun.connection,
    followUpConnection: followUp.connection,
    protocol: followUp.connection.protocol,
    cfRayLocation: followUp.cfRayLocation,
  };
}

interface GroqCandidateSpec {
  readonly role: "fast" | "reliable" | "noreason";
  readonly model: string;
  readonly probeWithBudget: ModelProbeWithBudget;
}

interface ModelBuckets {
  readonly coldRuns: PlainRunSample[];
  readonly warmH1Runs: PlainRunSample[];
  readonly warmH2Runs: PlainRunSample[];
  readonly toolTimeRuns: ToolRunSample[];
  readonly toolOrderRuns: ToolRunSample[];
  readonly cancelH1Runs: CancelCycleSample[];
  readonly cancelH2Runs: CancelCycleSample[];
}

function buildGroqModelReport(
  probe: ModelProbeResult,
  buckets: ModelBuckets,
) {
  const coldSummary = summarizePlainRuns(buckets.coldRuns);
  const warmSummary = summarizePlainRuns(buckets.warmH1Runs);
  const warmH2Summary = summarizePlainRuns(buckets.warmH2Runs);
  const toolTimeSummary = summarizeToolRuns(
    "time",
    TIME_TOOL_PROMPT,
    "get_current_time",
    buckets.toolTimeRuns,
  );
  const toolOrderSummary = summarizeToolRuns(
    "order",
    ORDER_TOOL_PROMPT,
    "get_order_status",
    buckets.toolOrderRuns,
  );
  const cancelH1 = summarizeCancelRuns(
    buckets.cancelH1Runs,
    "B: Warm H1",
    warmSummary.ttftMs.median,
  );
  const cancelH2 = summarizeCancelRuns(
    buckets.cancelH2Runs,
    "B-h2: Warm H2",
    warmH2Summary.ttftMs.median,
  );

  return {
    settings: probe,
    scenarioA_cold: coldSummary,
    scenarioB_warm: warmSummary,
    scenarioB_warmH2: warmH2Summary,
    scenarioC_tool_time: toolTimeSummary,
    scenarioC_tool_order: toolOrderSummary,
    scenarioD_cancelH1: cancelH1,
    scenarioD_cancelH2: cancelH2,
  };
}

async function runInterleavedGroqSuite(
  apiKey: string,
  candidates: readonly GroqCandidateSpec[],
) {
  const warmH1Instr = createInstrumentedAgent(false);
  const warmH2Instr = createInstrumentedAgent(true);
  const cancelH2Instr = createInstrumentedAgent(true);
  const pacer = new PerModelRatePacer();

  const bucketsByRole = new Map<string, ModelBuckets>();
  for (const c of candidates) {
    bucketsByRole.set(c.role, {
      coldRuns: [],
      warmH1Runs: [],
      warmH2Runs: [],
      toolTimeRuns: [],
      toolOrderRuns: [],
      cancelH1Runs: [],
      cancelH2Runs: [],
    });
  }

  try {
    await listModels(GROQ_BASE_URL, apiKey, warmH1Instr.agent);
    await listModels(GROQ_BASE_URL, apiKey, warmH2Instr.agent);
    await listModels(GROQ_BASE_URL, apiKey, cancelH2Instr.agent);

    for (let i = 0; i < N_RUNS; i += 1) {
      const iterStart = performance.now();

      // Scenario A: Cold (h1, fresh Agent + disabled TLS session cache per request)
      for (const c of candidates) {
        const probe = c.probeWithBudget.probe;
        const reasoningEffort =
          probe.reasoningEffort === "not_applicable" ? undefined : probe.reasoningEffort;
        await pacer.waitForModel(c.model);
        const coldInstr = createInstrumentedAgent(false, { disableSessionCache: true });
        try {
          const coldRes = await runStreamingChat({
            baseUrl: GROQ_BASE_URL,
            apiKey,
            model: probe.model,
            prompt: PLAIN_PROMPT,
            tools: VOICE_TOOLS,
            reasoningEffort,
            reasoningFormat: probe.reasoningFormat,
            instr: coldInstr,
          });
          assertColdConnection(`${probe.model}:A[${i}]`, coldRes.connection);
          bucketsByRole.get(c.role)?.coldRuns.push(toPlainRunSample(coldRes));
        } finally {
          await coldInstr.close();
        }
        pacer.recordRequests(c.model, 1, GROQ_PACING_MS);
      }

      // Scenario B: Warm H1
      for (const c of candidates) {
        const probe = c.probeWithBudget.probe;
        const reasoningEffort =
          probe.reasoningEffort === "not_applicable" ? undefined : probe.reasoningEffort;
        await pacer.waitForModel(c.model);
        const warmH1Res = await runStreamingChat({
          baseUrl: GROQ_BASE_URL,
          apiKey,
          model: probe.model,
          prompt: PLAIN_PROMPT,
          tools: VOICE_TOOLS,
          reasoningEffort,
          reasoningFormat: probe.reasoningFormat,
          instr: warmH1Instr,
        });
        assertWarmConnection(`${probe.model}:B-h1[${i}]`, warmH1Res.connection);
        bucketsByRole.get(c.role)?.warmH1Runs.push(toPlainRunSample(warmH1Res));
        pacer.recordRequests(c.model, 1, GROQ_PACING_MS);
      }

      // Scenario B-h2: Warm H2
      for (const c of candidates) {
        const probe = c.probeWithBudget.probe;
        const reasoningEffort =
          probe.reasoningEffort === "not_applicable" ? undefined : probe.reasoningEffort;
        await pacer.waitForModel(c.model);
        const warmH2Res = await runStreamingChat({
          baseUrl: GROQ_BASE_URL,
          apiKey,
          model: probe.model,
          prompt: PLAIN_PROMPT,
          tools: VOICE_TOOLS,
          reasoningEffort,
          reasoningFormat: probe.reasoningFormat,
          instr: warmH2Instr,
        });
        assertWarmConnection(`${probe.model}:B-h2[${i}]`, warmH2Res.connection);
        bucketsByRole.get(c.role)?.warmH2Runs.push(toPlainRunSample(warmH2Res));
        pacer.recordRequests(c.model, 1, GROQ_PACING_MS);
      }

      // Scenario C (time): "What time is it?" -> get_current_time + follow-up
      for (const c of candidates) {
        const probe = c.probeWithBudget.probe;
        await pacer.waitForModel(c.model);
        const sample = await runToolTurn(
          apiKey,
          probe,
          warmH1Instr,
          TIME_TOOL_PROMPT,
          validateCurrentTimeToolCalls,
          `${probe.model}:C-time[${i}]`,
        );
        bucketsByRole.get(c.role)?.toolTimeRuns.push(sample);
        pacer.recordRequests(c.model, sample.connectionReq2 ? 2 : 1, GROQ_PACING_MS);
      }

      // Scenario C (order): "order one zero four two" -> get_order_status + follow-up
      for (const c of candidates) {
        const probe = c.probeWithBudget.probe;
        await pacer.waitForModel(c.model);
        const sample = await runToolTurn(
          apiKey,
          probe,
          warmH1Instr,
          ORDER_TOOL_PROMPT,
          validateOrderStatusToolCalls,
          `${probe.model}:C-order[${i}]`,
        );
        bucketsByRole.get(c.role)?.toolOrderRuns.push(sample);
        pacer.recordRequests(c.model, sample.connectionReq2 ? 2 : 1, GROQ_PACING_MS);
      }

      // Scenario D-h1: Cancel H1 (fresh pre-warmed Agent per cycle so abort teardown doesn't pollute next cycle)
      for (const c of candidates) {
        const probe = c.probeWithBudget.probe;
        await pacer.waitForModel(c.model);
        const cancelH1Instr = createInstrumentedAgent(false);
        try {
          await listModels(GROQ_BASE_URL, apiKey, cancelH1Instr.agent);
          const sample = await runSingleCancelCycle(apiKey, probe, cancelH1Instr, false, i);
          bucketsByRole.get(c.role)?.cancelH1Runs.push(sample);
        } finally {
          await cancelH1Instr.close();
        }
        pacer.recordRequests(c.model, 2, GROQ_PACING_MS);
      }

      // Scenario D-h2: Cancel H2
      for (const c of candidates) {
        const probe = c.probeWithBudget.probe;
        await pacer.waitForModel(c.model);
        const sample = await runSingleCancelCycle(apiKey, probe, cancelH2Instr, true, i);
        bucketsByRole.get(c.role)?.cancelH2Runs.push(sample);
        pacer.recordRequests(c.model, 2, GROQ_PACING_MS);
      }

      const elapsedSec = ((performance.now() - iterStart) / 1000).toFixed(1);
      console.log(
        `[RoundRobin] completed iteration ${i + 1}/${N_RUNS} across ${candidates.length} Groq models in ${elapsedSec} s`,
      );
    }
  } finally {
    await Promise.all([
      warmH1Instr.close(),
      warmH2Instr.close(),
      cancelH2Instr.close(),
    ]);
  }

  const reports = new Map<string, ReturnType<typeof buildGroqModelReport>>();
  for (const c of candidates) {
    const buckets = bucketsByRole.get(c.role);
    if (!buckets) continue;
    reports.set(c.role, buildGroqModelReport(c.probeWithBudget.probe, buckets));
  }
  return reports;
}

async function benchmarkGeminiScenarioB(
  apiKey: string,
  probe: ModelProbeResult,
  nRuns: number = N_RUNS,
) {
  const instr = createInstrumentedAgent(false);
  const runs: PlainRunSample[] = [];
  const reasoningEffort =
    probe.reasoningEffort === "not_applicable" ? undefined : probe.reasoningEffort;

  try {
    await listModels(GEMINI_BASE_URL, apiKey, instr.agent);
    for (let i = 0; i < nRuns; i += 1) {
      const res = await runStreamingChat({
        baseUrl: GEMINI_BASE_URL,
        apiKey,
        model: probe.model,
        prompt: PLAIN_PROMPT,
        tools: VOICE_TOOLS,
        reasoningEffort,
        instr,
      });
      assertWarmConnection(`${probe.model}:B-h1[${i}]`, res.connection);
      runs.push(toPlainRunSample(res));
      if (i + 1 < nRuns) {
        await sleep(GEMINI_PACING_MS);
      }
    }
  } finally {
    await instr.close();
  }

  const warmSummary = summarizePlainRuns(runs);
  return {
    settings: probe,
    scenarioB_warm: warmSummary,
  };
}

function checkGroqTokenBudget(
  plans: readonly PlannedModelRequests[],
  ledgerPath: string = USAGE_LEDGER_PATH,
): readonly ModelTokenBudget[] {
  const entries = readUsageLedger(ledgerPath);
  const evaluation = evaluateGroqTokenBudgets(entries, plans);

  console.log(
    `\n=== Groq Token Budget Check (limit=${GROQ_TPD_LIMIT.toLocaleString("en-US")} TPD/model) ===`,
  );
  console.log(`  Ledger: ${ledgerPath} (${entries.length} recorded requests)`);
  for (const b of evaluation.models) {
    const estDetail =
      b.estimatedTokensSource === "ledger_median"
        ? `median=${b.medianTokensPerRequest} tok/req from ${b.ledgerSamples} ledger samples`
        : `default=${b.medianTokensPerRequest} tok/req (no ledger data)`;
    console.log(
      `  ${b.model}: planned=${b.plannedRequests} reqs | est=${b.estimatedTokens} tok (${estDetail}) | ` +
        `used_24h=${b.usedLast24h} tok | projected=${b.projectedTotalTokens}/${b.limitTpd} -> ${b.withinLimit ? "OK" : "STOP"}`,
    );
  }

  if (!evaluation.ok) {
    const over = evaluation.models
      .filter((m) => !m.withinLimit)
      .map(
        (m) =>
          `${m.model}: used_24h=${m.usedLast24h} + est=${m.estimatedTokens} = ${m.projectedTotalTokens} > ${m.limitTpd}`,
      )
      .join("; ");
    throw new Error(
      `Stopping before live run: estimated token usage would exceed Groq 200,000 TPD limit (${over})`,
    );
  }

  return evaluation.models;
}

function checkGroqRequestBudget(
  modelsBaselineHeaders: Record<string, string>,
  candidates: readonly GroqCandidateSpec[],
  plannedRequestsByRole?: ReadonlyMap<string, number>,
  budgetNote?: string,
): {
  readonly modelsEndpointHasRateLimitHeaders: boolean;
  readonly entries: readonly RequestBudgetEntry[];
} {
  const modelsEndpointRemainingRaw = modelsBaselineHeaders["x-ratelimit-remaining-requests"];
  const modelsEndpointHasRateLimitHeaders = modelsEndpointRemainingRaw !== undefined;
  const defaultPlanned = N_RUNS * GROQ_REQUESTS_PER_ITERATION;

  console.log("\n=== Groq Request Budget Check ===");
  console.log(
    `  /models x-ratelimit-remaining-requests: ${modelsEndpointRemainingRaw ?? "not returned by Groq GET /models (per-model limits are returned on POST /chat/completions)"}`,
  );
  console.log(
    budgetNote ??
      `  Planned per Groq model: N=${N_RUNS} x ${GROQ_REQUESTS_PER_ITERATION} req/iter ` +
        `(A=1, B=1, B-h2=1, C-time=2, C-order=2, D-h1=2, D-h2=2) = ${defaultPlanned} loop requests`,
  );

  const entries: RequestBudgetEntry[] = [];
  const insufficient: RequestBudgetEntry[] = [];

  for (const c of candidates) {
    const plannedLoopRequests = plannedRequestsByRole?.get(c.role) ?? defaultPlanned;
    const hdrs = c.probeWithBudget.rateLimitHeaders;
    const remStr = modelsEndpointRemainingRaw ?? hdrs["x-ratelimit-remaining-requests"];
    const limStr = hdrs["x-ratelimit-limit-requests"];
    const resetStr = hdrs["x-ratelimit-reset-requests"] ?? null;
    const remainingRequests =
      remStr !== undefined && /^\d+$/.test(remStr) ? Number(remStr) : null;
    const limitRequests =
      limStr !== undefined && /^\d+$/.test(limStr) ? Number(limStr) : null;
    const remainingRequestsSource: RequestBudgetEntry["remainingRequestsSource"] =
      modelsEndpointRemainingRaw !== undefined
        ? "/models"
        : remStr !== undefined
          ? "/chat/completions"
          : "unavailable";
    const enoughForRun =
      remainingRequests !== null && remainingRequests >= plannedLoopRequests;

    const entry: RequestBudgetEntry = {
      role: c.role,
      model: c.model,
      plannedLoopRequests,
      probeRequestsSpent: c.probeWithBudget.probeRequestsSpent,
      totalRequests: plannedLoopRequests + c.probeWithBudget.probeRequestsSpent,
      remainingRequestsSource,
      remainingRequests,
      limitRequests,
      resetRequests: resetStr,
      enoughForRun,
    };
    entries.push(entry);

    console.log(
      `  [${c.role.toUpperCase()}] ${c.model}: loop=${plannedLoopRequests}, probe=${c.probeWithBudget.probeRequestsSpent}, ` +
        `total=${entry.totalRequests} | remaining=${remainingRequests ?? "unknown"}/${limitRequests ?? "?"} ` +
        `(source=${remainingRequestsSource}, reset=${resetStr ?? "n/a"}) -> ${enoughForRun ? "OK" : "STOP"}`,
    );

    if (!enoughForRun) {
      insufficient.push(entry);
    }
  }

  if (insufficient.length > 0) {
    const detail = insufficient
      .map(
        (e) =>
          `${e.model}: needs ${e.plannedLoopRequests} loop requests, remaining=${e.remainingRequests ?? "unknown"} (reset=${e.resetRequests ?? "unknown"})`,
      )
      .join("; ");
    throw new Error(
      `Insufficient daily request budget for N=${N_RUNS} (refusing to silently lower N): ${detail}`,
    );
  }

  return { modelsEndpointHasRateLimitHeaders, entries };
}

function formatConnectionLine(c: ReturnType<typeof summarizeConnectionMetrics>): string {
  if (c.newSockets === 0) {
    return `NewSocket: ${c.newSocketRate}`;
  }
  return (
    `NewSocket: ${c.newSocketRate} | ` +
    `DNS med=${formatMs(c.dnsMs.median)} p90=${formatMs(c.dnsMs.p90)} | ` +
    `TCP med=${formatMs(c.tcpMs.median)} p90=${formatMs(c.tcpMs.p90)} | ` +
    `TLS med=${formatMs(c.tlsMs.median)} p90=${formatMs(c.tlsMs.p90)}`
  );
}

function printPlainSummary(label: string, s: ReturnType<typeof summarizePlainRuns>): void {
  const regionTag = s.groqRegions.length > 0 ? `, region=${s.groqRegions.join(",")}` : "";
  console.log(
    `  ${label} (n=${s.n}, proto=${s.protocols.join(",") || "unknown"}, edge=${s.edgeLocations.join(",") || "none"}${regionTag}):`,
  );
  console.log(
    `    TTFT(content): med=${formatMs(s.ttftMs.median)} p90=${formatMs(s.ttftMs.p90)} | ` +
      `FirstToken(any): med=${formatMs(s.firstAnyTokenMs.median)} p90=${formatMs(s.firstAnyTokenMs.p90)} | ` +
      `FirstSent(abs): med=${formatMs(s.firstSentenceAbsMs.median)} p90=${formatMs(s.firstSentenceAbsMs.p90)} | ` +
      `FirstSent(rel): med=${formatMs(s.firstSentenceRelMs.median)} p90=${formatMs(s.firstSentenceRelMs.p90)}`,
  );
  if (s.serverTimings.available) {
    console.log(
      `    ServerTimings(usage): queue med=${formatMs(s.serverTimings.queueTimeMs.median)} | ` +
        `prompt med=${formatMs(s.serverTimings.promptTimeMs.median)} | ` +
        `completion med=${formatMs(s.serverTimings.completionTimeMs.median)} | ` +
        `preToken(queue+prompt) med=${formatMs(s.serverTimings.serverPreFirstTokenMs.median)} p90=${formatMs(s.serverTimings.serverPreFirstTokenMs.p90)} | ` +
        `preContentEst med=${formatMs(s.serverTimings.serverPreContentEstMs.median)}`,
    );
    console.log(
      `    NetworkSplit: net(FirstToken - queue+prompt) med=${formatMs(s.serverTimings.networkFirstTokenMs.median)} p90=${formatMs(s.serverTimings.networkFirstTokenMs.p90)} | ` +
        `net(TTFT - preContentEst) med=${formatMs(s.serverTimings.networkContentTtftMs.median)} p90=${formatMs(s.serverTimings.networkContentTtftMs.p90)}`,
    );
  } else {
    console.log(
      `    ServerTimings: unavailable in usage (server-timing header: ${s.serverTimingHeaders.join(", ") || "none"})`,
    );
  }
  console.log(
    `    Total: med=${formatMs(s.totalMs.median)} p90=${formatMs(s.totalMs.p90)} | ` +
      `ReasoningTok: med=${s.reasoningTokens.median ?? 0} p90=${s.reasoningTokens.p90 ?? 0} | ` +
      `WrongToolCalls: ${s.wrongToolCallRate}`,
  );
  console.log(`    Conn: ${formatConnectionLine(s.connection)}`);
  if (Object.keys(s.rateLimitHeaders).length > 0) {
    console.log(`    x-ratelimit: ${JSON.stringify(s.rateLimitHeaders)}`);
  }
}

function printToolSummary(label: string, c: ReturnType<typeof summarizeToolRuns>): void {
  const regionTag = c.groqRegions.length > 0 ? `, region=${c.groqRegions.join(",")}` : "";
  console.log(
    `  ${label} (n=${c.n}, proto=${c.protocols.join(",") || "unknown"}, edge=${c.edgeLocations.join(",") || "none"}${regionTag}):`,
  );
  console.log(
    `    Correct(${c.expectedTool}): ${c.toolCorrectnessRate} | ` +
      `FollowupOK: ${c.followupSuccessRate} | ` +
      `PreToolFiller: ${c.fillerRate}`,
  );
  console.log(
    `    req1_first_token: med=${formatMs(c.req1FirstAnyTokenMs.median)} p90=${formatMs(c.req1FirstAnyTokenMs.p90)} | ` +
      `req1_ttft(content): med=${formatMs(c.req1TtftMs.median)} p90=${formatMs(c.req1TtftMs.p90)} | ` +
      `t_toolcall: med=${formatMs(c.tToolCallMs.median)} p90=${formatMs(c.tToolCallMs.p90)}`,
  );
  console.log(
    `    t_exec: med=${formatMs(c.tExecMs.median)} p90=${formatMs(c.tExecMs.p90)} | ` +
      `followup_ttft: med=${formatMs(c.followupTtftMs.median)} p90=${formatMs(c.followupTtftMs.p90)} | ` +
      `e2e: med=${formatMs(c.e2eMs.median)} p90=${formatMs(c.e2eMs.p90)}`,
  );
  console.log(
    `    ReasoningTok(req1/req2): med=${c.reasoningTokensReq1.median ?? 0}/${c.reasoningTokensReq2.median ?? 0} | ` +
      `ConnReq1(${c.connectionReq1.newSocketRate}) ConnReq2(${c.connectionReq2.newSocketRate})`,
  );
  if (c.failureReasons.length > 0) {
    console.log(`    ToolFailures: ${c.failureReasons.join(", ")}`);
  }
}

function printModelReport(
  role: string,
  report: ReturnType<typeof buildGroqModelReport>,
): void {
  console.log(
    `\n=== Groq [${role}] model=${report.settings.model} reasoning=${report.settings.reasoningEffort} format=${report.settings.reasoningFormat} ===`,
  );
  printPlainSummary("Scenario A (Cold)", report.scenarioA_cold);
  printPlainSummary("Scenario B (Warm H1)", report.scenarioB_warm);
  printPlainSummary("Scenario B-h2 (Warm H2)", report.scenarioB_warmH2);
  printToolSummary("Scenario C (Tool: time)", report.scenarioC_tool_time);
  printToolSummary("Scenario C (Tool: order)", report.scenarioC_tool_order);

  for (const [tag, d] of [
    ["Scenario D (Cancel H1)", report.scenarioD_cancelH1],
    ["Scenario D (Cancel H2)", report.scenarioD_cancelH2],
  ] as const) {
    console.log(
      `  ${tag} (n=${d.n}, proto=${d.protocols.join(",") || "unknown"}, edge=${d.edgeLocations.join(",") || "none"}):`,
    );
    console.log(
      `    PostAbortTTFT: med=${formatMs(d.postAbortTtftMs.median)} p90=${formatMs(d.postAbortTtftMs.p90)} ` +
        `(vs ${d.warmBaselineLabel} med ${formatMs(d.normalWarmTtftMedianMs)}, delta=${d.deltaVsWarmMedianMs !== null ? `${d.deltaVsWarmMedianMs.toFixed(1)} ms` : "n/a"}) | ` +
        `Reconnects: ${d.reconnectRate} | DeltasAfterAbortMax: ${d.maxDeltasAfterAbort}`,
    );
    console.log(`    FollowUpConn: ${formatConnectionLine(d.followUpConnection)}`);
  }
}

function assertModelsPresent(
  provider: string,
  requested: readonly string[],
  available: readonly string[],
): void {
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

async function runTask3cDiagnosis(): Promise<void> {
  loadEnvFromRoot();
  const cfg: SpikeEnvConfig = loadSpikeConfig(process.env);
  if (!cfg.groqModelNoReason) {
    throw new Error("GROQ_MODEL_NOREASON is required for --task3c");
  }
  const qwenModel = cfg.groqModelNoReason;

  checkGroqTokenBudget([
    { model: cfg.groqModelFast, plannedRequests: N_TASK3C + 2 },
    { model: cfg.groqModelReliable, plannedRequests: N_TASK3C + 2 },
    { model: qwenModel, plannedRequests: N_TASK3C + 3 * 2 * N_TASK3C * 2 + 4 },
  ]);

  const groqBase = await measureBaseline("Groq", GROQ_BASE_URL, cfg.groqApiKey);
  const requestedGroqModels = [cfg.groqModelFast, cfg.groqModelReliable, qwenModel];
  assertModelsPresent("Groq", requestedGroqModels, groqBase.modelIds);

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
  const qwenNoneProbe = await probeReasoningSettings(
    GROQ_BASE_URL,
    cfg.groqApiKey,
    qwenModel,
    cfg.groqNoReasonReasoningEffort ?? "none",
    true,
  );
  // Probe lowest non-none active reasoning setting ("low"; "minimal" -> 400, "default" -> 0 reasoning tokens).
  const qwenLowProbe = await probeReasoningSettings(
    GROQ_BASE_URL,
    cfg.groqApiKey,
    qwenModel,
    "low",
    true,
  );

  const groqCandidates: GroqCandidateSpec[] = [
    { role: "fast", model: cfg.groqModelFast, probeWithBudget: fastProbe },
    { role: "reliable", model: cfg.groqModelReliable, probeWithBudget: reliableProbe },
    {
      role: "noreason",
      model: qwenModel,
      probeWithBudget: {
        probe: qwenNoneProbe.probe,
        probeRequestsSpent: qwenNoneProbe.probeRequestsSpent + qwenLowProbe.probeRequestsSpent,
        rateLimitHeaders: qwenLowProbe.rateLimitHeaders,
      },
    },
  ];

  // Planned requests: N=10 warm H2 per model, plus 3 variants x 2 scenarios x N=10 x up to 2 reqs on qwen.
  const plannedMap = new Map<string, number>([
    ["fast", N_TASK3C],
    ["reliable", N_TASK3C],
    ["noreason", N_TASK3C + 3 * 2 * N_TASK3C * 2],
  ]);
  const budget = checkGroqRequestBudget(
    groqBase.baseline.rateLimitHeaders,
    groqCandidates,
    plannedMap,
    `  Planned Task 3c: fast=${N_TASK3C} (warm H2), reliable=${N_TASK3C} (warm H2), noreason=${N_TASK3C + 120} (10 warm H2 + max 120 across 3 qwen tool variants x 2 utterances x N=${N_TASK3C})`,
  );

  // Part 2b: Fresh N=10 interleaved warm H2 run per Groq model to extract server-side timings.
  const warmH2Instr = createInstrumentedAgent(true);
  const pacer = new PerModelRatePacer();
  const warmH2Buckets = new Map<string, PlainRunSample[]>([
    ["fast", []],
    ["reliable", []],
    ["noreason", []],
  ]);

  try {
    await listModels(GROQ_BASE_URL, cfg.groqApiKey, warmH2Instr.agent);
    for (let i = 0; i < N_TASK3C; i += 1) {
      for (const c of groqCandidates) {
        const probe = c.probeWithBudget.probe;
        const reasoningEffort =
          probe.reasoningEffort === "not_applicable" ? undefined : probe.reasoningEffort;
        await pacer.waitForModel(c.model);
        const res = await runStreamingChat({
          baseUrl: GROQ_BASE_URL,
          apiKey: cfg.groqApiKey,
          model: probe.model,
          prompt: PLAIN_PROMPT,
          tools: VOICE_TOOLS,
          reasoningEffort,
          reasoningFormat: probe.reasoningFormat,
          instr: warmH2Instr,
        });
        assertWarmConnection(`${probe.model}:3c-B-h2[${i}]`, res.connection);
        warmH2Buckets.get(c.role)?.push(toPlainRunSample(res));
        pacer.recordRequests(c.model, 1, GROQ_PACING_MS);
      }
      console.log(`[Task3c:WarmH2] completed iteration ${i + 1}/${N_TASK3C}`);
    }
  } finally {
    await warmH2Instr.close();
  }

  console.log("\n=== Task 3c Part 2: Server-Side Timing Split (Fresh N=10 Warm H2 per Groq model) ===");
  const warmH2Summaries = new Map<string, ReturnType<typeof summarizePlainRuns>>();
  for (const c of groqCandidates) {
    const summary = summarizePlainRuns(warmH2Buckets.get(c.role) ?? []);
    warmH2Summaries.set(c.role, summary);
    console.log(`\n  [${c.role.toUpperCase()}] ${c.model} (reasoning=${c.probeWithBudget.probe.reasoningEffort})`);
    printPlainSummary("Scenario B-h2 (Warm H2)", summary);
  }

  let geminiBaseline: HostBaseline | null = null;
  let geminiWarmB: Awaited<ReturnType<typeof benchmarkGeminiScenarioB>> | null = null;
  if (cfg.geminiApiKey && cfg.geminiModel) {
    const gemBase = await measureBaseline("Gemini", GEMINI_BASE_URL, cfg.geminiApiKey);
    geminiBaseline = gemBase.baseline;
    assertModelsPresent("Gemini", [cfg.geminiModel], gemBase.modelIds);
    const gemProbe = await probeReasoningSettings(
      GEMINI_BASE_URL,
      cfg.geminiApiKey,
      cfg.geminiModel,
      cfg.geminiReasoningEffort,
      false,
    );
    geminiWarmB = await benchmarkGeminiScenarioB(cfg.geminiApiKey, gemProbe.probe, N_TASK3C);
    console.log(`\n  [GEMINI] ${cfg.geminiModel} (thinking=${gemProbe.probe.reasoningEffort})`);
    printPlainSummary("Scenario B (Warm H1)", geminiWarmB.scenarioB_warm);
  }

  // Part 1a: Exact request body for one tool-path request to qwen (no headers, no key).
  const sampleToolBody = buildChatRequestBody({
    model: qwenModel,
    prompt: TIME_TOOL_PROMPT,
    tools: VOICE_TOOLS,
    toolChoice: "auto",
    reasoningEffort: qwenNoneProbe.probe.reasoningEffort === "not_applicable" ? undefined : qwenNoneProbe.probe.reasoningEffort,
    reasoningFormat: qwenNoneProbe.probe.reasoningFormat,
  });
  console.log("\n=== Task 3c Part 1a: Exact Request Body (qwen tool-path, no headers, no key) ===");
  console.log(JSON.stringify(sampleToolBody, null, 2));

  // Part 1d: Rerun C-time and C-order on qwen only, N=10 each, in 3 variants.
  const variants: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly probe: ModelProbeResult;
    readonly toolChoiceReq1: ToolChoiceOption;
  }> = [
    {
      id: "v1_as_before",
      label: "(i) as before (reasoning=none, tool_choice=auto)",
      probe: qwenNoneProbe.probe,
      toolChoiceReq1: "auto",
    },
    {
      id: "v2_tool_choice_required",
      label: "(ii) tool_choice=required (reasoning=none)",
      probe: qwenNoneProbe.probe,
      toolChoiceReq1: "required",
    },
    {
      id: "v3_reasoning_low",
      label: "(iii) reasoning_effort=low (lowest non-none, tool_choice=auto)",
      probe: qwenLowProbe.probe,
      toolChoiceReq1: "auto",
    },
  ];

  const qwenVariantResults: Array<{
    readonly id: string;
    readonly label: string;
    readonly settings: ModelProbeResult;
    readonly toolChoiceReq1: ToolChoiceOption;
    readonly cTime: ReturnType<typeof summarizeToolRuns>;
    readonly cOrder: ReturnType<typeof summarizeToolRuns>;
  }> = [];

  const qwenInstr = createInstrumentedAgent(true);
  // Tool turns send ~950 tokens across req1+req2; pace at 4000 ms/req (8000 ms/turn) to stay under Groq's 8,000 TPM free-tier cap.
  const qwenToolPacingMs = 4000;
  try {
    await listModels(GROQ_BASE_URL, cfg.groqApiKey, qwenInstr.agent);
    for (const variant of variants) {
      const timeRuns: ToolRunSample[] = [];
      const orderRuns: ToolRunSample[] = [];
      for (let i = 0; i < N_TASK3C; i += 1) {
        await pacer.waitForModel(qwenModel);
        const tSample = await runToolTurn(
          cfg.groqApiKey,
          variant.probe,
          qwenInstr,
          TIME_TOOL_PROMPT,
          validateCurrentTimeToolCalls,
          `${qwenModel}:${variant.id}:C-time[${i}]`,
          variant.toolChoiceReq1,
        );
        timeRuns.push(tSample);
        pacer.recordRequests(qwenModel, tSample.connectionReq2 ? 2 : 1, qwenToolPacingMs);

        await pacer.waitForModel(qwenModel);
        const oSample = await runToolTurn(
          cfg.groqApiKey,
          variant.probe,
          qwenInstr,
          ORDER_TOOL_PROMPT,
          validateOrderStatusToolCalls,
          `${qwenModel}:${variant.id}:C-order[${i}]`,
          variant.toolChoiceReq1,
        );
        orderRuns.push(oSample);
        pacer.recordRequests(qwenModel, oSample.connectionReq2 ? 2 : 1, qwenToolPacingMs);
      }

      const cTime = summarizeToolRuns("time", TIME_TOOL_PROMPT, "get_current_time", timeRuns);
      const cOrder = summarizeToolRuns("order", ORDER_TOOL_PROMPT, "get_order_status", orderRuns);
      qwenVariantResults.push({
        id: variant.id,
        label: variant.label,
        settings: variant.probe,
        toolChoiceReq1: variant.toolChoiceReq1,
        cTime,
        cOrder,
      });

      console.log(`\n=== Task 3c Part 1d [${variant.label}] ===`);
      printToolSummary("Scenario C-time", cTime);
      printToolSummary("Scenario C-order", cOrder);

      if (variant.id === "v1_as_before") {
        console.log("\n=== Task 3c Part 1b: Full text of 3 plain-text replies per utterance (variant i) ===");
        console.log("  C-time plain-text samples:");
        cTime.plainTextSamples.forEach((s, idx) => {
          console.log(`    [${idx + 1}] finish_reason=${s.finishReason} ttft=${formatMs(s.ttftMs)} text=${JSON.stringify(s.content)}`);
        });
        console.log("  C-order plain-text samples:");
        cOrder.plainTextSamples.forEach((s, idx) => {
          console.log(`    [${idx + 1}] finish_reason=${s.finishReason} ttft=${formatMs(s.ttftMs)} text=${JSON.stringify(s.content)}`);
        });
      }
      if (variant.id === "v3_reasoning_low") {
        const orderFillers = orderRuns.filter((r) => r.emittedContentBeforeToolCall).slice(0, 3);
        if (orderFillers.length > 0) {
          console.log("  C-order pre-tool filler samples (variant iii):");
          orderFillers.forEach((s, idx) => {
            console.log(`    [${idx + 1}] preToolTtft=${formatMs(s.preToolContentTtftMs)} text=${JSON.stringify(s.req1Content)}`);
          });
        }
      }
    }
  } finally {
    await qwenInstr.close();
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    promptVersion: PROMPT_VERSION,
    toolSchemaVersion: TOOL_SCHEMA_VERSION_V1,
    nTask3c: N_TASK3C,
    budget,
    baselines: {
      groqControlPlane: groqBase.baseline,
      geminiControlPlane: geminiBaseline,
    },
    warmH2ServerTimingSplit: {
      fast: warmH2Summaries.get("fast") ?? null,
      reliable: warmH2Summaries.get("reliable") ?? null,
      noreason: warmH2Summaries.get("noreason") ?? null,
      geminiWarmB,
    },
    qwenDiagnosis: {
      sampleToolRequestBody: sampleToolBody,
      variants: qwenVariantResults,
    },
  };
  writeFileSync(TASK3C_RESULTS_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`\nSaved Task 3c results to ${TASK3C_RESULTS_PATH}`);
}

interface Task3dPromptSpec {
  readonly id: "c_time" | "c_order" | "plain" | "near_miss_1" | "near_miss_2";
  readonly label: string;
  readonly prompt: string;
  readonly expectTool: string | null;
  readonly validate?: (toolCalls: readonly AssembledToolCall[]) => ToolValidationResult;
}

interface Task3dModelSpec {
  readonly id: Task3dModelId;
  readonly label: string;
  readonly model: string;
  readonly probe: ModelProbeResult;
  readonly pacingMs: number;
}

interface Task3dCellSample {
  readonly correct: boolean;
  readonly calledAnyTool: boolean;
  readonly wrongOrUnwantedToolCall: boolean;
  readonly claimedToCheckWithoutToolCall: boolean;
  readonly emittedPreToolFiller: boolean;
  readonly followupSucceeded: boolean | null;
  readonly failureReason: string | null;
  readonly req1Content: string;
  readonly req1FinishReason: string | null;
  readonly req1FirstAnyTokenMs: number | null;
  readonly req1TtftMs: number | null;
  readonly tToolCallMs: number | null;
  readonly followupTtftMs: number | null;
  readonly e2eMs: number | null;
  readonly req1ServerQueueMs: number | null;
  readonly req2ServerQueueMs: number | null;
  readonly groqRegion: string | null;
  readonly cfRayLocation: string | null;
}

interface ServiceTierProbeResult {
  readonly tier: GroqServiceTier;
  readonly allowed: boolean;
  readonly detail: string;
}

function summarizeTask3dCell(
  modelSpec: Task3dModelSpec,
  promptSpec: Task3dPromptSpec,
  runs: readonly Task3dCellSample[],
) {
  const correctCount = runs.filter((r) => r.correct).length;
  const wrongOrUnwantedCount = runs.filter((r) => r.wrongOrUnwantedToolCall).length;
  const claimedToCheckRuns = runs.filter((r) => r.claimedToCheckWithoutToolCall);
  const fillerRuns = runs.filter((r) => r.emittedPreToolFiller);
  const followupTotal = runs.filter((r) => r.followupSucceeded !== null).length;
  const followupOk = runs.filter((r) => r.followupSucceeded === true).length;

  const req1FirstTokens = runs
    .map((r) => r.req1FirstAnyTokenMs)
    .filter((v): v is number => v !== null);
  const req1Ttfts = runs.map((r) => r.req1TtftMs).filter((v): v is number => v !== null);
  const tToolCalls = runs.map((r) => r.tToolCallMs).filter((v): v is number => v !== null);
  const followupTtfts = runs.map((r) => r.followupTtftMs).filter((v): v is number => v !== null);
  const e2es = runs.map((r) => r.e2eMs).filter((v): v is number => v !== null);
  const req1QueueTimes = runs
    .map((r) => r.req1ServerQueueMs)
    .filter((v): v is number => v !== null);

  return {
    modelId: modelSpec.id,
    modelLabel: modelSpec.label,
    model: modelSpec.model,
    reasoningEffort: modelSpec.probe.reasoningEffort,
    promptId: promptSpec.id,
    promptLabel: promptSpec.label,
    prompt: promptSpec.prompt,
    expectTool: promptSpec.expectTool,
    n: runs.length,
    correctCount,
    correctRate: formatPct(correctCount, runs.length),
    wrongOrUnwantedToolCallCount: wrongOrUnwantedCount,
    wrongOrUnwantedToolCallRate: formatPct(wrongOrUnwantedCount, runs.length),
    claimedToCheckCount: claimedToCheckRuns.length,
    claimedToCheckRate: formatPct(claimedToCheckRuns.length, runs.length),
    claimedToCheckSamples: claimedToCheckRuns.slice(0, 3).map((r) => r.req1Content),
    preToolFillerCount: fillerRuns.length,
    preToolFillerRate: formatPct(fillerRuns.length, runs.length),
    preToolFillerSamples: fillerRuns.slice(0, 3).map((r) => r.req1Content),
    followupSucceededCount: followupOk,
    followupSuccessRate: followupTotal > 0 ? formatPct(followupOk, followupTotal) : null,
    req1FirstAnyTokenMs: summarize(req1FirstTokens),
    req1TtftMs: summarize(req1Ttfts),
    tToolCallMs: summarize(tToolCalls),
    followupTtftMs: summarize(followupTtfts),
    e2eMs: summarize(e2es),
    req1QueueTimeMs: summarize(req1QueueTimes),
    failureReasons: runs
      .map((r) => r.failureReason)
      .filter((v): v is string => v !== null),
    noToolReplySamples: runs
      .filter((r) => !r.calledAnyTool && r.req1Content.length > 0)
      .slice(0, 3)
      .map((r) => ({
        content: r.req1Content,
        finishReason: r.req1FinishReason,
        claimedToCheck: r.claimedToCheckWithoutToolCall,
      })),
  };
}

function printTask3dCellSummary(c: ReturnType<typeof summarizeTask3dCell>): void {
  const e2eStr =
    c.expectTool !== null
      ? `e2e(med/p90)=${formatMs(c.e2eMs.median)} / ${formatMs(c.e2eMs.p90)} | ` +
        `t_toolcall=${formatMs(c.tToolCallMs.median)} | followup_ttft=${formatMs(c.followupTtftMs.median)} | FollowupOK=${c.followupSuccessRate ?? "n/a"}`
      : `e2e=n/a (no-tool path) | req1_ttft(content)=${formatMs(c.req1TtftMs.median)} / ${formatMs(c.req1TtftMs.p90)}`;
  console.log(
    `  [${c.modelLabel}] ${c.promptLabel} (n=${c.n}, expect=${c.expectTool ?? "none"}):`,
  );
  console.log(
    `    Correct=${c.correctRate} | Wrong/UnwantedTool=${c.wrongOrUnwantedToolCallRate} | ` +
      `ClaimedCheckNoTool=${c.claimedToCheckRate} | PreToolFiller=${c.preToolFillerRate}`,
  );
  console.log(
    `    req1_first_token(med/p90)=${formatMs(c.req1FirstAnyTokenMs.median)} / ${formatMs(c.req1FirstAnyTokenMs.p90)} | ${e2eStr}`,
  );
  if (c.preToolFillerSamples.length > 0) {
    c.preToolFillerSamples.forEach((sample, idx) => {
      console.log(`    PreToolFillerSample[${idx + 1}]: ${JSON.stringify(sample)}`);
    });
  }
  if (c.claimedToCheckSamples.length > 0) {
    c.claimedToCheckSamples.forEach((sample, idx) => {
      console.log(`    ClaimedCheckSample[${idx + 1}]: ${JSON.stringify(sample)}`);
    });
  }
  if (c.failureReasons.length > 0) {
    console.log(`    Failures: ${c.failureReasons.join(", ")}`);
  }
}

async function probeGroqServiceTiers(
  apiKey: string,
  reliableProbe: ModelProbeResult,
): Promise<{
  readonly probes: readonly ServiceTierProbeResult[];
  readonly latestHeaders: Record<string, string>;
}> {
  const instr = createInstrumentedAgent(true);
  const probes: ServiceTierProbeResult[] = [];
  let latestHeaders: Record<string, string> = {};
  const reasoningEffort =
    reliableProbe.reasoningEffort === "not_applicable" ? undefined : reliableProbe.reasoningEffort;

  try {
    await listModels(GROQ_BASE_URL, apiKey, instr.agent);
    for (const tier of GROQ_SERVICE_TIERS) {
      try {
        const res = await runStreamingChat({
          baseUrl: GROQ_BASE_URL,
          apiKey,
          model: reliableProbe.model,
          systemPrompt: SYSTEM_PROMPT_V2,
          prompt: PLAIN_PROMPT,
          tools: undefined,
          reasoningEffort,
          reasoningFormat: reliableProbe.reasoningFormat,
          serviceTier: tier,
          instr,
          maxTokens: 16,
        });
        if (Object.keys(res.rateLimitHeaders).length > 0) {
          latestHeaders = res.rateLimitHeaders;
        }
        probes.push({ tier, allowed: true, detail: "HTTP 200 OK" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        probes.push({ tier, allowed: false, detail: msg });
      }
      await sleep(2500);
    }
  } finally {
    await instr.close();
  }
  return { probes, latestHeaders };
}

async function runTask3dExperiment(): Promise<void> {
  loadEnvFromRoot();
  const cfg: SpikeEnvConfig = loadSpikeConfig(process.env);
  const selectedIds = parseTask3dModelFilter(process.argv.slice(2));
  const runQwenNone = selectedIds.includes("qwen_none");
  const runQwenLow = selectedIds.includes("qwen_low");
  const runQwen = runQwenNone || runQwenLow;
  const run120b = selectedIds.includes("gpt_oss_120b_low");

  if (runQwen && !cfg.groqModelNoReason) {
    throw new Error("GROQ_MODEL_NOREASON is required when running qwen in --task3d");
  }
  const qwenModel = cfg.groqModelNoReason ?? "";
  const reliableModel = cfg.groqModelReliable;

  const qwenNonePlanned = runQwenNone ? 2 * N_TASK3D + 2 * N_TASK3D + 3 * N_TASK3D : 0; // 70 max
  const qwenLowPlanned = runQwenLow ? 2 * N_TASK3D + 2 * N_TASK3D + 3 * N_TASK3D : 0; // 70 max
  const qwenPlannedMax = qwenNonePlanned + qwenLowPlanned;
  const reliableMatrixPlannedMax = run120b ? 2 * N_TASK3D + 2 * N_TASK3D + 3 * N_TASK3D : 0; // 70 max

  const tokenPlans: PlannedModelRequests[] = [];
  if (runQwen) {
    const qwenProbeEst = (runQwenNone ? 1 : 0) + (runQwenLow ? 1 : 0);
    tokenPlans.push({ model: qwenModel, plannedRequests: qwenPlannedMax + qwenProbeEst });
  }
  if (run120b) {
    tokenPlans.push({
      model: reliableModel,
      plannedRequests: reliableMatrixPlannedMax + 1 + GROQ_SERVICE_TIERS.length,
    });
  }
  const tokenBudget = checkGroqTokenBudget(tokenPlans);

  const groqBase = await measureBaseline("Groq", GROQ_BASE_URL, cfg.groqApiKey);
  const requiredModels = [
    ...(runQwen ? [qwenModel] : []),
    ...(run120b ? [reliableModel] : []),
  ];
  assertModelsPresent("Groq", requiredModels, groqBase.modelIds);

  const qwenNoneProbe = runQwenNone
    ? await probeReasoningSettings(GROQ_BASE_URL, cfg.groqApiKey, qwenModel, "none", true)
    : null;
  const qwenLowProbe = runQwenLow
    ? await probeReasoningSettings(GROQ_BASE_URL, cfg.groqApiKey, qwenModel, "low", true)
    : null;
  const reliableProbe = run120b
    ? await probeReasoningSettings(
        GROQ_BASE_URL,
        cfg.groqApiKey,
        reliableModel,
        cfg.groqReliableReasoningEffort ?? "low",
        true,
      )
    : null;

  // Preliminary budget guard before running service_tier probes.
  const latestQwenHeaders = qwenLowProbe?.rateLimitHeaders ?? qwenNoneProbe?.rateLimitHeaders ?? {};
  const qwenRemainingRaw = latestQwenHeaders["x-ratelimit-remaining-requests"];
  const reliableRemainingRaw = reliableProbe?.rateLimitHeaders["x-ratelimit-remaining-requests"];
  const qwenPreliminaryRem = qwenRemainingRaw && /^\d+$/.test(qwenRemainingRaw) ? Number(qwenRemainingRaw) : null;
  const reliablePreliminaryRem =
    reliableRemainingRaw && /^\d+$/.test(reliableRemainingRaw) ? Number(reliableRemainingRaw) : null;

  if (runQwen && qwenPreliminaryRem !== null && qwenPreliminaryRem < qwenPlannedMax) {
    throw new Error(
      `Stopping before Task 3d: ${qwenModel} needs up to ${qwenPlannedMax} requests, remaining=${qwenPreliminaryRem}`,
    );
  }
  if (run120b && reliablePreliminaryRem !== null && reliablePreliminaryRem < reliableMatrixPlannedMax + 4) {
    throw new Error(
      `Stopping before Task 3d: ${reliableModel} needs at least ${reliableMatrixPlannedMax + 4} requests, remaining=${reliablePreliminaryRem}`,
    );
  }

  let tierProbeResult: {
    readonly probes: readonly ServiceTierProbeResult[];
    readonly latestHeaders: Record<string, string>;
  } = { probes: [], latestHeaders: {} };
  let allowedTiers: GroqServiceTier[] = [];
  let tiersToBenchmark: GroqServiceTier[] = [];

  if (run120b && reliableProbe) {
    console.log("\n=== Task 3d Part 3b: Probing Groq service_tier values on free tier ===");
    tierProbeResult = await probeGroqServiceTiers(cfg.groqApiKey, reliableProbe.probe);
    for (const tp of tierProbeResult.probes) {
      console.log(`  service_tier="${tp.tier}": ${tp.allowed ? "ALLOWED" : "REJECTED"} (${tp.detail})`);
    }
    allowedTiers = tierProbeResult.probes.filter((p) => p.allowed).map((p) => p.tier);
    const extraAllowedTiers = allowedTiers.filter((t) => t !== "on_demand");
    tiersToBenchmark = extraAllowedTiers.length > 0 ? allowedTiers : [];
  }

  const serviceTierPlannedReqs = tiersToBenchmark.length * N_TASK3D;
  const reliableTotalPlannedMax = reliableMatrixPlannedMax + serviceTierPlannedReqs;
  const grandTotalPlannedMax = qwenPlannedMax + reliableTotalPlannedMax;

  console.log("\n=== Task 3d Planned Request Count (printed before matrix/tier loops) ===");
  console.log(
    `  Matrix (voice-v2, tool_choice=auto, warm H2, N=${N_TASK3D}/cell, selected=${selectedIds.join(",")} x 5 prompts):`,
  );
  if (runQwen) {
    const labelParts = [runQwenNone ? "none" : null, runQwenLow ? "low" : null]
      .filter((v): v is string => v !== null)
      .join(" + ");
    console.log(
      `    - ${qwenModel} (${labelParts}): max ${qwenPlannedMax} reqs`,
    );
  }
  if (run120b) {
    console.log(
      `    - ${reliableModel} (low): max ${reliableMatrixPlannedMax} reqs (20+20+10+10+10)`,
    );
    if (tiersToBenchmark.length === 0) {
      console.log(
        `  Part 3b service_tier check on ${reliableModel}: free tier only permits default "on_demand" (auto/flex/performance rejected 400); skipping extra service_tier loop (0 reqs; default covered by Matrix Plain N=${N_TASK3D})`,
      );
    } else {
      console.log(
        `  Part 3b service_tier check on ${reliableModel}: ${tiersToBenchmark.length} allowed tiers (${tiersToBenchmark.join(", ")}) x N=${N_TASK3D} = ${serviceTierPlannedReqs} reqs`,
      );
    }
  }
  console.log(
    `  Total planned loop requests: ${grandTotalPlannedMax} max` +
      `${runQwen ? ` (${qwenModel}=${qwenPlannedMax})` : ""}` +
      `${run120b ? ` (${reliableModel}=${reliableTotalPlannedMax})` : ""}`,
  );

  const budgetCandidates: GroqCandidateSpec[] = [];
  const plannedMap = new Map<string, number>();
  if (runQwen) {
    const qwenProbeForBudget = qwenLowProbe?.probe ?? qwenNoneProbe?.probe;
    if (qwenProbeForBudget) {
      budgetCandidates.push({
        role: "noreason",
        model: qwenModel,
        probeWithBudget: {
          probe: qwenProbeForBudget,
          probeRequestsSpent:
            (qwenNoneProbe?.probeRequestsSpent ?? 0) + (qwenLowProbe?.probeRequestsSpent ?? 0),
          rateLimitHeaders: latestQwenHeaders,
        },
      });
      plannedMap.set("noreason", qwenPlannedMax);
    }
  }
  if (run120b && reliableProbe) {
    budgetCandidates.push({
      role: "reliable",
      model: reliableModel,
      probeWithBudget: {
        probe: reliableProbe.probe,
        probeRequestsSpent: reliableProbe.probeRequestsSpent + GROQ_SERVICE_TIERS.length,
        rateLimitHeaders:
          Object.keys(tierProbeResult.latestHeaders).length > 0
            ? tierProbeResult.latestHeaders
            : reliableProbe.rateLimitHeaders,
      },
    });
    plannedMap.set("reliable", reliableTotalPlannedMax);
  }
  const budget = checkGroqRequestBudget(
    groqBase.baseline.rateLimitHeaders,
    budgetCandidates,
    plannedMap,
    `  Task 3d max loop requests: total=${grandTotalPlannedMax}`,
  );

  const modelSpecs: Task3dModelSpec[] = [];
  if (qwenNoneProbe) {
    modelSpecs.push({
      id: "qwen_none",
      label: "qwen/qwen3.8-27b (reasoning=none)",
      model: qwenModel,
      probe: qwenNoneProbe.probe,
      pacingMs: 4000,
    });
  }
  if (qwenLowProbe) {
    modelSpecs.push({
      id: "qwen_low",
      label: "qwen/qwen3.8-27b (reasoning=low)",
      model: qwenModel,
      probe: qwenLowProbe.probe,
      pacingMs: 4000,
    });
  }
  if (reliableProbe) {
    modelSpecs.push({
      id: "gpt_oss_120b_low",
      label: "openai/gpt-oss-120b (reasoning=low)",
      model: reliableModel,
      probe: reliableProbe.probe,
      pacingMs: 3200,
    });
  }

  const promptSpecs: readonly Task3dPromptSpec[] = [
    {
      id: "c_time",
      label: "C-time",
      prompt: TIME_TOOL_PROMPT_V2,
      expectTool: "get_current_time",
      validate: validateCurrentTimeToolCalls,
    },
    {
      id: "c_order",
      label: "C-order",
      prompt: ORDER_TOOL_PROMPT,
      expectTool: "get_order_status",
      validate: validateOrderStatusToolCalls,
    },
    {
      id: "plain",
      label: "Plain",
      prompt: PLAIN_PROMPT,
      expectTool: null,
    },
    {
      id: "near_miss_1",
      label: "Near-miss 1",
      prompt: NEAR_MISS_TIME_PROMPT,
      expectTool: null,
    },
    {
      id: "near_miss_2",
      label: "Near-miss 2",
      prompt: NEAR_MISS_SHIPPING_PROMPT,
      expectTool: null,
    },
  ];

  const cellBuckets = new Map<string, Task3dCellSample[]>();
  for (const m of modelSpecs) {
    for (const p of promptSpecs) {
      cellBuckets.set(`${m.id}:${p.id}`, []);
    }
  }

  const warmH2Instr = createInstrumentedAgent(true);
  const pacer = new PerModelRatePacer();
  const serviceTierRuns = new Map<GroqServiceTier, PlainRunSample[]>();
  for (const tier of tiersToBenchmark) {
    serviceTierRuns.set(tier, []);
  }

  try {
    await listModels(GROQ_BASE_URL, cfg.groqApiKey, warmH2Instr.agent);

    for (let i = 0; i < N_TASK3D; i += 1) {
      const iterStart = performance.now();
      for (const p of promptSpecs) {
        for (const m of modelSpecs) {
          await pacer.waitForModel(m.model);
          const key = `${m.id}:${p.id}`;
          const reasoningEffort =
            m.probe.reasoningEffort === "not_applicable" ? undefined : m.probe.reasoningEffort;

          if (p.expectTool !== null && p.validate !== undefined) {
            const toolSample = await runToolTurn(
              cfg.groqApiKey,
              m.probe,
              warmH2Instr,
              p.prompt,
              p.validate,
              `3d:${key}[${i}]`,
              "auto",
              { systemPrompt: SYSTEM_PROMPT_V2, tools: VOICE_TOOLS_V2 },
            );
            const claimed = detectClaimedCheckWithoutToolCall(
              toolSample.req1Content,
              toolSample.calledAnyTool ? 1 : 0,
            );
            const wrongOrUnwanted = toolSample.calledAnyTool && !toolSample.calledExpectedTool;
            cellBuckets.get(key)?.push({
              correct: toolSample.passed,
              calledAnyTool: toolSample.calledAnyTool,
              wrongOrUnwantedToolCall: wrongOrUnwanted,
              claimedToCheckWithoutToolCall: claimed,
              emittedPreToolFiller: toolSample.emittedContentBeforeToolCall,
              followupSucceeded: toolSample.passed ? toolSample.followupSucceeded : null,
              failureReason: toolSample.reason,
              req1Content: toolSample.req1Content,
              req1FinishReason: toolSample.req1FinishReason,
              req1FirstAnyTokenMs: toolSample.req1FirstAnyTokenMs,
              req1TtftMs: toolSample.req1TtftMs,
              tToolCallMs: toolSample.tToolCallMs,
              followupTtftMs: toolSample.followupTtftMs,
              e2eMs: toolSample.e2eMs,
              req1ServerQueueMs: toolSample.req1ServerQueueMs,
              req2ServerQueueMs: toolSample.req2ServerQueueMs,
              groqRegion: toolSample.groqRegion,
              cfRayLocation: toolSample.cfRayLocation,
            });
            pacer.recordRequests(m.model, toolSample.connectionReq2 ? 2 : 1, m.pacingMs);
          } else {
            const res = await runStreamingChat({
              baseUrl: GROQ_BASE_URL,
              apiKey: cfg.groqApiKey,
              model: m.model,
              systemPrompt: SYSTEM_PROMPT_V2,
              prompt: p.prompt,
              tools: VOICE_TOOLS_V2,
              toolChoice: "auto",
              reasoningEffort,
              reasoningFormat: m.probe.reasoningFormat,
              instr: warmH2Instr,
            });
            assertWarmConnection(`3d:${key}[${i}]`, res.connection);
            const calledAnyTool = res.parsed.toolCalls.length > 0;
            const claimed = detectClaimedCheckWithoutToolCall(
              res.parsed.content,
              res.parsed.toolCalls.length,
            );
            const failureReason = calledAnyTool
              ? `unwanted_tool:${res.parsed.toolCalls.map((t) => t.name).join(",")}`
              : res.parsed.content.trim().length === 0
                ? "empty_reply"
                : null;
            cellBuckets.get(key)?.push({
              correct: !calledAnyTool && res.parsed.content.trim().length > 0,
              calledAnyTool,
              wrongOrUnwantedToolCall: calledAnyTool,
              claimedToCheckWithoutToolCall: claimed,
              emittedPreToolFiller: res.parsed.emittedContentBeforeToolCall,
              followupSucceeded: null,
              failureReason,
              req1Content: res.parsed.content,
              req1FinishReason: res.parsed.finishReason,
              req1FirstAnyTokenMs: res.firstAnyTokenMs,
              req1TtftMs: res.ttftMs,
              tToolCallMs: null,
              followupTtftMs: null,
              e2eMs: null,
              req1ServerQueueMs: res.parsed.usage.queueTimeMs,
              req2ServerQueueMs: null,
              groqRegion: res.groqRegion,
              cfRayLocation: res.cfRayLocation,
            });
            pacer.recordRequests(m.model, 1, m.pacingMs);
          }
        }
      }
      const elapsedSec = ((performance.now() - iterStart) / 1000).toFixed(1);
      console.log(`[Task3d:Matrix] completed iteration ${i + 1}/${N_TASK3D} in ${elapsedSec} s`);
    }

    if (run120b && tiersToBenchmark.length > 0 && reliableProbe) {
      const reliableEffort =
        reliableProbe.probe.reasoningEffort === "not_applicable"
          ? undefined
          : reliableProbe.probe.reasoningEffort;
      for (let i = 0; i < N_TASK3D; i += 1) {
        for (const tier of tiersToBenchmark) {
          await pacer.waitForModel(reliableModel);
          const res = await runStreamingChat({
            baseUrl: GROQ_BASE_URL,
            apiKey: cfg.groqApiKey,
            model: reliableModel,
            systemPrompt: SYSTEM_PROMPT_V2,
            prompt: PLAIN_PROMPT,
            tools: VOICE_TOOLS_V2,
            toolChoice: "auto",
            reasoningEffort: reliableEffort,
            reasoningFormat: reliableProbe.probe.reasoningFormat,
            serviceTier: tier,
            instr: warmH2Instr,
          });
          assertWarmConnection(`3d:service_tier=${tier}[${i}]`, res.connection);
          serviceTierRuns.get(tier)?.push(toPlainRunSample(res));
          pacer.recordRequests(reliableModel, 1, 2500);
        }
        console.log(`[Task3d:ServiceTier] completed iteration ${i + 1}/${N_TASK3D}`);
      }
    }
  } finally {
    await warmH2Instr.close();
  }

  console.log(
    `\n=== Task 3d Matrix Results (prompt=${PROMPT_VERSION_V2}, toolSchema=${TOOL_SCHEMA_VERSION_V2}, tool_choice=auto, warm H2, N=${N_TASK3D}, models=${selectedIds.join(",")}) ===`,
  );
  const cellSummaries: Array<ReturnType<typeof summarizeTask3dCell>> = [];
  for (const m of modelSpecs) {
    console.log(`\n--- ${m.label} ---`);
    for (const p of promptSpecs) {
      const summary = summarizeTask3dCell(m, p, cellBuckets.get(`${m.id}:${p.id}`) ?? []);
      cellSummaries.push(summary);
      printTask3dCellSummary(summary);
    }
  }

  // Part 3a: queue_time min/median/p90/max for openai/gpt-oss-120b runs.
  let queueTime120b: {
    readonly matrixPlain: DistributionStats;
    readonly matrixAllReq1: DistributionStats;
    readonly matrixAllRequests: DistributionStats;
  } | null = null;
  let serviceTierSummaries: Array<{
    readonly tier: GroqServiceTier;
    readonly summary: ReturnType<typeof summarizePlainRuns>;
  }> = [];

  if (run120b) {
    const reliablePlainQueueTimes = (cellBuckets.get("gpt_oss_120b_low:plain") ?? [])
      .map((r) => r.req1ServerQueueMs)
      .filter((v): v is number => v !== null);
    const reliableAllReq1QueueTimes = promptSpecs
      .flatMap((p) => cellBuckets.get(`gpt_oss_120b_low:${p.id}`) ?? [])
      .map((r) => r.req1ServerQueueMs)
      .filter((v): v is number => v !== null);
    const reliableAllReqQueueTimes = promptSpecs
      .flatMap((p) => cellBuckets.get(`gpt_oss_120b_low:${p.id}`) ?? [])
      .flatMap((r) => [r.req1ServerQueueMs, r.req2ServerQueueMs])
      .filter((v): v is number => v !== null);

    const queueStatsPlain = summarize(reliablePlainQueueTimes);
    const queueStatsAllReq1 = summarize(reliableAllReq1QueueTimes);
    const queueStatsAllReqs = summarize(reliableAllReqQueueTimes);
    queueTime120b = {
      matrixPlain: queueStatsPlain,
      matrixAllReq1: queueStatsAllReq1,
      matrixAllRequests: queueStatsAllReqs,
    };

    console.log(`\n=== Task 3d Part 3a: ${reliableModel} queue_time distribution ===`);
    for (const [label, q] of [
      ["Matrix Plain (n=10)", queueStatsPlain],
      ["Matrix All req1 (5 prompts x 10)", queueStatsAllReq1],
      ["Matrix All requests (req1 + req2)", queueStatsAllReqs],
    ] as const) {
      console.log(
        `  ${label} (count=${q.count}): min=${formatMs(q.min)} | median=${formatMs(q.median)} | p90=${formatMs(q.p90)} | max=${formatMs(q.max)}`,
      );
    }

    console.log(`\n=== Task 3d Part 3b: ${reliableModel} service_tier Plain Warm H2 (N=${N_TASK3D}/tier) ===`);
    if (tiersToBenchmark.length === 0) {
      console.log(
        "  Skipped extra service_tier loop: Groq free tier only accepts default service_tier=\"on_demand\" (auto, flex, performance returned HTTP 400).",
      );
    }
    serviceTierSummaries = tiersToBenchmark.map((tier) => {
      const s = summarizePlainRuns(serviceTierRuns.get(tier) ?? []);
      console.log(
        `  service_tier="${tier}" (n=${s.n}): ` +
          `queue_time min=${formatMs(s.serverTimings.queueTimeMs.min)} med=${formatMs(s.serverTimings.queueTimeMs.median)} p90=${formatMs(s.serverTimings.queueTimeMs.p90)} max=${formatMs(s.serverTimings.queueTimeMs.max)} | ` +
          `TTFT(content) med=${formatMs(s.ttftMs.median)} p90=${formatMs(s.ttftMs.p90)} | ` +
          `FirstToken(any) med=${formatMs(s.firstAnyTokenMs.median)} p90=${formatMs(s.firstAnyTokenMs.p90)}`,
      );
      return {
        tier,
        summary: s,
      };
    });
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    selectedModels: selectedIds,
    promptVersion: PROMPT_VERSION_V2,
    toolSchemaVersion: TOOL_SCHEMA_VERSION_V2,
    comparisonBaseline: {
      promptVersion: PROMPT_VERSION,
      toolSchemaVersion: TOOL_SCHEMA_VERSION_V1,
    },
    systemPrompt: SYSTEM_PROMPT_V2,
    tools: VOICE_TOOLS_V2,
    nTask3d: N_TASK3D,
    plannedRequestCounts: {
      qwenPlannedMax,
      reliableMatrixPlannedMax,
      serviceTierPlannedReqs,
      reliableTotalPlannedMax,
      grandTotalPlannedMax,
    },
    tokenBudget,
    budget,
    baselines: {
      groqControlPlane: groqBase.baseline,
    },
    matrixCells: cellSummaries,
    queueTime120b,
    serviceTierCheck: run120b
      ? {
          probes: tierProbeResult.probes,
          allowedTiers,
          results: serviceTierSummaries,
        }
      : null,
  };
  const outPath =
    selectedIds.length === TASK3D_MODEL_IDS.length
      ? TASK3D_RESULTS_PATH
      : path.join(OUT_DIR, `task3d-${selectedIds.join("-")}-results.json`);
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`\nSaved Task 3d results to ${outPath}`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--list-models")) {
    await printAvailableModels();
    return;
  }
  if (process.argv.includes("--task3c")) {
    await runTask3cDiagnosis();
    return;
  }
  if (process.argv.includes("--task3d")) {
    await runTask3dExperiment();
    return;
  }

  loadEnvFromRoot();
  const cfg: SpikeEnvConfig = loadSpikeConfig(process.env);

  checkGroqTokenBudget([
    { model: cfg.groqModelFast, plannedRequests: N_RUNS * GROQ_REQUESTS_PER_ITERATION + 2 },
    { model: cfg.groqModelReliable, plannedRequests: N_RUNS * GROQ_REQUESTS_PER_ITERATION + 2 },
    ...(cfg.groqModelNoReason
      ? [{ model: cfg.groqModelNoReason, plannedRequests: N_RUNS * GROQ_REQUESTS_PER_ITERATION + 2 }]
      : []),
  ]);

  const groqBase = await measureBaseline("Groq", GROQ_BASE_URL, cfg.groqApiKey);
  console.log(`Groq live models (${groqBase.modelIds.length}): ${groqBase.modelIds.join(", ")}`);

  const requestedGroqModels = [
    cfg.groqModelFast,
    cfg.groqModelReliable,
    ...(cfg.groqModelNoReason ? [cfg.groqModelNoReason] : []),
  ];
  assertModelsPresent("Groq", requestedGroqModels, groqBase.modelIds);

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

  const groqCandidates: GroqCandidateSpec[] = [
    { role: "fast", model: cfg.groqModelFast, probeWithBudget: fastProbe },
    { role: "reliable", model: cfg.groqModelReliable, probeWithBudget: reliableProbe },
  ];

  if (cfg.groqModelNoReason) {
    const noReasonProbe = await probeReasoningSettings(
      GROQ_BASE_URL,
      cfg.groqApiKey,
      cfg.groqModelNoReason,
      cfg.groqNoReasonReasoningEffort ?? "none",
      true,
    );
    groqCandidates.push({
      role: "noreason",
      model: cfg.groqModelNoReason,
      probeWithBudget: noReasonProbe,
    });
  }

  const budget = checkGroqRequestBudget(groqBase.baseline.rateLimitHeaders, groqCandidates);

  const groqReports = await runInterleavedGroqSuite(
    cfg.groqApiKey,
    groqCandidates,
  );

  const fastReport = groqReports.get("fast");
  const reliableReport = groqReports.get("reliable");
  const noReasonReport = groqReports.get("noreason") ?? null;

  if (fastReport) printModelReport("FAST", fastReport);
  if (reliableReport) printModelReport("RELIABLE", reliableReport);
  if (noReasonReport) printModelReport("NOREASON", noReasonReport);

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
    console.log(`\n[Budget] Gemini ${cfg.geminiModel}: plannedLoop=${N_RUNS} (Scenario B warm)`);
    geminiReport = await benchmarkGeminiScenarioB(
      cfg.geminiApiKey,
      gemProbe.probe,
    );
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
    toolSchemaVersion: TOOL_SCHEMA_VERSION_V1,
    systemPrompt: SYSTEM_PROMPT,
    sampleSizeN: N_RUNS,
    interleavedRoundRobin: true,
    budget,
    baselines: {
      groq: groqBase.baseline,
      gemini: geminiBaseline,
    },
    availableModels: {
      groq: groqBase.modelIds,
      gemini: geminiModels,
    },
    groq: {
      fast: fastReport ?? null,
      reliable: reliableReport ?? null,
      noreason: noReasonReport,
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
