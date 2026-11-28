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
  ORDER_TOOL_PROMPT,
  OrderStatusArgsSchema,
  PLAIN_PROMPT,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  TIME_TOOL_PROMPT,
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
  validateCurrentTimeToolCalls,
  validateOrderStatusToolCalls,
  type AssembledToolCall,
  type ParsedStreamResult,
  type ToolValidationResult,
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

interface PlainRunSample {
  readonly ttftMs: number | null;
  readonly firstSentenceAbsMs: number | null;
  readonly firstSentenceRelMs: number | null;
  readonly totalMs: number;
  readonly reasoningTokens: number;
  readonly wronglyCalledTool: boolean;
  readonly connection: RequestConnectionMetrics;
  readonly protocol: HttpProtocol;
  readonly cfRayLocation: string | null;
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
  readonly prompt?: string;
  readonly messages?: readonly ChatMessage[];
  readonly tools: typeof VOICE_TOOLS | undefined;
  readonly reasoningEffort?: ReasoningEffort | undefined;
  readonly reasoningFormat?: "parsed" | "default" | undefined;
  readonly instr: InstrumentedAgent;
  readonly maxTokens?: number;
  readonly abortOnFirstContent?: boolean;
}

interface ChatStreamOutcome {
  readonly parsed: ParsedStreamResult;
  readonly startTimestampMs: number;
  readonly firstContentTimestampMs: number | null;
  readonly ttftMs: number | null;
  readonly toolCallAssembledMs: number | null;
  readonly firstSentenceAbsMs: number | null;
  readonly firstSentenceRelMs: number | null;
  readonly totalMs: number;
  readonly deltasAfterAbort: number;
  readonly aborted: boolean;
  readonly connection: RequestConnectionMetrics;
  readonly cfRayLocation: string | null;
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

async function runStreamingChat(opts: ChatRequestOptions): Promise<ChatStreamOutcome> {
  const controller = new AbortController();
  const messages: readonly ChatMessage[] =
    opts.messages ?? [
      { role: "system", content: SYSTEM_PROMPT },
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
  }
  if (opts.reasoningEffort !== undefined) {
    bodyObj.reasoning_effort = opts.reasoningEffort;
  }
  if (opts.reasoningFormat === "parsed") {
    bodyObj.reasoning_format = "parsed";
  }

  let res: Response | null = null;
  let tStart = 0;
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
    if (attempt === MAX_RATE_LIMIT_RETRIES) {
      throw new Error(
        `POST ${opts.baseUrl}/chat/completions (${opts.model}) failed ${res.status}: ${errText}`,
      );
    }
    const waitMs = computeRateLimitWaitMs(res, errText);
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
  const rateLimitHeaders = extractRateLimitHeaders(res.headers);

  const sse = new SseParser();
  const acc = new GroqStreamAccumulator();
  const splitter = new SentenceSplitter();

  let firstContentTimestampMs: number | null = null;
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

  return {
    parsed,
    startTimestampMs: tStart,
    firstContentTimestampMs,
    ttftMs,
    toolCallAssembledMs,
    firstSentenceAbsMs,
    firstSentenceRelMs,
    totalMs,
    deltasAfterAbort,
    aborted: abortedAtMs !== null,
    connection,
    cfRayLocation,
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
    const requestedTz = parsed.success ? (parsed.data.timezone ?? "UTC") : "UTC";
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
): Promise<ModelProbeResult> {
  const instr = createInstrumentedAgent(false);
  try {
    if (overrideEffort !== undefined) {
      let reasoningFormat: "parsed" | "default" = "default";
      if (allowReasoningFormat && overrideEffort !== "none") {
        try {
          await runStreamingChat({
            baseUrl,
            apiKey,
            model,
            prompt: "Say ok.",
            tools: undefined,
            reasoningEffort: overrideEffort,
            reasoningFormat: "parsed",
            instr,
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
            instr,
            maxTokens: 16,
          });
        }
      } else {
        await runStreamingChat({
          baseUrl,
          apiKey,
          model,
          prompt: "Say ok.",
          tools: undefined,
          reasoningEffort: overrideEffort,
          instr,
          maxTokens: 16,
        });
      }
      return {
        model,
        isReasoningModel: overrideEffort !== "none",
        reasoningEffort: overrideEffort,
        reasoningFormat,
      };
    }

    const defaultProbe = await runStreamingChat({
      baseUrl,
      apiKey,
      model,
      prompt: "Reply with the word ok.",
      tools: undefined,
      instr,
      maxTokens: 24,
    });
    const hasReasoning =
      defaultProbe.parsed.reasoningDeltaCount > 0 ||
      (defaultProbe.parsed.usage.reasoningTokens ?? 0) > 0 ||
      defaultProbe.parsed.content.includes("<think>");

    if (!hasReasoning) {
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
              instr,
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
      if (allowReasoningFormat && effort !== "none") {
        try {
          await runStreamingChat({
            baseUrl,
            apiKey,
            model,
            prompt: "Reply with ok.",
            tools: undefined,
            reasoningEffort: effort,
            reasoningFormat: "parsed",
            instr,
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
          instr,
          maxTokens: 16,
        });
        return {
          model,
          isReasoningModel: effort !== "none",
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
  const absFirst = runs.map((r) => r.firstSentenceAbsMs).filter((v): v is number => v !== null);
  const relFirst = runs.map((r) => r.firstSentenceRelMs).filter((v): v is number => v !== null);
  const totals = runs.map((r) => r.totalMs);
  const reasoning = runs.map((r) => r.reasoningTokens);
  const wrongToolCalls = runs.filter((r) => r.wronglyCalledTool).length;
  const protocols = [...new Set(runs.map((r) => r.protocol))];
  const edgeLocations = [
    ...new Set(runs.map((r) => r.cfRayLocation).filter((v): v is string => v !== null)),
  ];
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
    connection: summarizeConnectionMetrics(runs.map((r) => r.connection)),
    protocols,
    edgeLocations,
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
    rateLimitHeaders: rateLimits,
    failureReasons: runs.filter((r) => !r.passed).map((r) => r.reason),
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
): Promise<ToolRunSample> {
  const reasoningEffort =
    probe.reasoningEffort === "not_applicable" ? undefined : probe.reasoningEffort;

  const req1 = await runStreamingChat({
    baseUrl: GROQ_BASE_URL,
    apiKey,
    model: probe.model,
    prompt,
    tools: VOICE_TOOLS,
    reasoningEffort,
    reasoningFormat: probe.reasoningFormat,
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
  let reasoningTokensReq2 = 0;
  let totalMs = req1.totalMs;
  let cfRayLocation = req1.cfRayLocation;
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
      { role: "system", content: SYSTEM_PROMPT },
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
      tools: VOICE_TOOLS,
      reasoningEffort,
      reasoningFormat: probe.reasoningFormat,
      instr: warmInstr,
    });
    assertWarmConnection(`${label}:req2`, req2.connection);

    req2Connection = req2.connection;
    followupTtftMs = req2.ttftMs;
    followupFirstSentenceAbsMs = req2.firstSentenceAbsMs;
    followupSucceeded = req2.ttftMs !== null && req2.parsed.toolCalls.length === 0;
    e2eMs =
      req2.firstContentTimestampMs !== null
        ? req2.firstContentTimestampMs - req1.startTimestampMs
        : null;
    reasoningTokensReq2 = req2.parsed.usage.reasoningTokens ?? 0;
    totalMs = req1.totalMs + execAccum + req2.totalMs;
    if (req2.cfRayLocation) cfRayLocation = req2.cfRayLocation;
    rateLimitHeaders = { ...rateLimitHeaders, ...req2.rateLimitHeaders };
  }

  return {
    ...validation,
    emittedContentBeforeToolCall: req1.parsed.emittedContentBeforeToolCall,
    preToolContentTtftMs: req1.parsed.emittedContentBeforeToolCall ? req1.ttftMs : null,
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
    rateLimitHeaders,
  };
}

async function runCancellationSuite(
  baseUrl: string,
  apiKey: string,
  probe: ModelProbeResult,
  allowH2: boolean,
  warmBaselineLabel: string,
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
        instr,
        abortOnFirstContent: true,
      });
      assertWarmConnection(`${probe.model}:D-${allowH2 ? "h2" : "h1"}[${i}]:aborted`, abortedRun.connection);
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
        instr,
      });

      cycles.push({
        abortedTtftMs: abortedRun.ttftMs ?? abortedRun.totalMs,
        deltasAfterAbort: abortedRun.deltasAfterAbort,
        postAbortTtftMs: followUp.ttftMs,
        newAgentConnections: instr.getConnectCount() - agentConnBefore,
        newSocketConnects: instr.getSocketCount() - sockConnBefore,
        abortedConnection: abortedRun.connection,
        followUpConnection: followUp.connection,
        protocol: followUp.connection.protocol,
        cfRayLocation: followUp.cfRayLocation,
      });
    }

    return summarizeCancelRuns(cycles, warmBaselineLabel, normalWarmTtftMedian);
  } finally {
    await instr.close();
  }
}

async function benchmarkGroqModel(
  apiKey: string,
  probe: ModelProbeResult,
  originRttMedianMs: number | null,
) {
  const reasoningEffort =
    probe.reasoningEffort === "not_applicable" ? undefined : probe.reasoningEffort;

  const warmH1Instr = createInstrumentedAgent(false);
  const warmH2Instr = createInstrumentedAgent(true);
  const coldRuns: PlainRunSample[] = [];
  const warmH1Runs: PlainRunSample[] = [];
  const warmH2Runs: PlainRunSample[] = [];
  const toolTimeRuns: ToolRunSample[] = [];
  const toolOrderRuns: ToolRunSample[] = [];

  try {
    await listModels(GROQ_BASE_URL, apiKey, warmH1Instr.agent);
    await listModels(GROQ_BASE_URL, apiKey, warmH2Instr.agent);

    for (let i = 0; i < N_PLAIN; i += 1) {
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
        coldRuns.push({
          ttftMs: coldRes.ttftMs,
          firstSentenceAbsMs: coldRes.firstSentenceAbsMs,
          firstSentenceRelMs: coldRes.firstSentenceRelMs,
          totalMs: coldRes.totalMs,
          reasoningTokens: coldRes.parsed.usage.reasoningTokens ?? 0,
          wronglyCalledTool: coldRes.parsed.toolCalls.length > 0,
          connection: coldRes.connection,
          protocol: coldRes.connection.protocol,
          cfRayLocation: coldRes.cfRayLocation,
          rateLimitHeaders: coldRes.rateLimitHeaders,
        });
      } finally {
        await coldInstr.close();
      }
      await sleep(GROQ_PACING_MS);

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
      warmH1Runs.push({
        ttftMs: warmH1Res.ttftMs,
        firstSentenceAbsMs: warmH1Res.firstSentenceAbsMs,
        firstSentenceRelMs: warmH1Res.firstSentenceRelMs,
        totalMs: warmH1Res.totalMs,
        reasoningTokens: warmH1Res.parsed.usage.reasoningTokens ?? 0,
        wronglyCalledTool: warmH1Res.parsed.toolCalls.length > 0,
        connection: warmH1Res.connection,
        protocol: warmH1Res.connection.protocol,
        cfRayLocation: warmH1Res.cfRayLocation,
        rateLimitHeaders: warmH1Res.rateLimitHeaders,
      });
      await sleep(GROQ_PACING_MS);

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
      warmH2Runs.push({
        ttftMs: warmH2Res.ttftMs,
        firstSentenceAbsMs: warmH2Res.firstSentenceAbsMs,
        firstSentenceRelMs: warmH2Res.firstSentenceRelMs,
        totalMs: warmH2Res.totalMs,
        reasoningTokens: warmH2Res.parsed.usage.reasoningTokens ?? 0,
        wronglyCalledTool: warmH2Res.parsed.toolCalls.length > 0,
        connection: warmH2Res.connection,
        protocol: warmH2Res.connection.protocol,
        cfRayLocation: warmH2Res.cfRayLocation,
        rateLimitHeaders: warmH2Res.rateLimitHeaders,
      });
      await sleep(GROQ_PACING_MS);
    }

    for (let i = 0; i < N_TOOL; i += 1) {
      toolTimeRuns.push(
        await runToolTurn(
          apiKey,
          probe,
          warmH1Instr,
          TIME_TOOL_PROMPT,
          validateCurrentTimeToolCalls,
          `${probe.model}:C-time[${i}]`,
        ),
      );
      await sleep(GROQ_PACING_MS * 2);

      toolOrderRuns.push(
        await runToolTurn(
          apiKey,
          probe,
          warmH1Instr,
          ORDER_TOOL_PROMPT,
          validateOrderStatusToolCalls,
          `${probe.model}:C-order[${i}]`,
        ),
      );
      await sleep(GROQ_PACING_MS * 2);
    }
  } finally {
    await warmH1Instr.close();
    await warmH2Instr.close();
  }

  const coldSummary = summarizePlainRuns(coldRuns);
  const warmSummary = summarizePlainRuns(warmH1Runs);
  const warmH2Summary = summarizePlainRuns(warmH2Runs);
  const toolTimeSummary = summarizeToolRuns(
    "time",
    TIME_TOOL_PROMPT,
    "get_current_time",
    toolTimeRuns,
  );
  const toolOrderSummary = summarizeToolRuns(
    "order",
    ORDER_TOOL_PROMPT,
    "get_order_status",
    toolOrderRuns,
  );
  const cancelH1 = await runCancellationSuite(
    GROQ_BASE_URL,
    apiKey,
    probe,
    false,
    "B: Warm H1",
    warmSummary.ttftMs.median,
  );
  const cancelH2 = await runCancellationSuite(
    GROQ_BASE_URL,
    apiKey,
    probe,
    true,
    "B-h2: Warm H2",
    warmH2Summary.ttftMs.median,
  );

  const estimatedModelTimeMs = {
    h1Ms:
      warmSummary.ttftMs.median !== null && originRttMedianMs !== null
        ? warmSummary.ttftMs.median - originRttMedianMs
        : null,
    h2Ms:
      warmH2Summary.ttftMs.median !== null && originRttMedianMs !== null
        ? warmH2Summary.ttftMs.median - originRttMedianMs
        : null,
    originRttMedianMs,
  };

  return {
    settings: probe,
    estimatedModelTimeMs,
    scenarioA_cold: coldSummary,
    scenarioB_warm: warmSummary,
    scenarioB_warmH2: warmH2Summary,
    scenarioC_tool_time: toolTimeSummary,
    scenarioC_tool_order: toolOrderSummary,
    scenarioD_cancelH1: cancelH1,
    scenarioD_cancelH2: cancelH2,
  };
}

async function benchmarkGeminiScenarioB(
  apiKey: string,
  probe: ModelProbeResult,
  originRttMedianMs: number | null,
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
        instr,
      });
      assertWarmConnection(`${probe.model}:B-h1[${i}]`, res.connection);
      runs.push({
        ttftMs: res.ttftMs,
        firstSentenceAbsMs: res.firstSentenceAbsMs,
        firstSentenceRelMs: res.firstSentenceRelMs,
        totalMs: res.totalMs,
        reasoningTokens: res.parsed.usage.reasoningTokens ?? 0,
        wronglyCalledTool: res.parsed.toolCalls.length > 0,
        connection: res.connection,
        protocol: res.connection.protocol,
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

  const warmSummary = summarizePlainRuns(runs);
  return {
    settings: probe,
    estimatedModelTimeMs: {
      h1Ms:
        warmSummary.ttftMs.median !== null && originRttMedianMs !== null
          ? warmSummary.ttftMs.median - originRttMedianMs
          : null,
      originRttMedianMs,
    },
    scenarioB_warm: warmSummary,
  };
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
  console.log(`    Conn: ${formatConnectionLine(s.connection)}`);
  if (Object.keys(s.rateLimitHeaders).length > 0) {
    console.log(`    x-ratelimit: ${JSON.stringify(s.rateLimitHeaders)}`);
  }
}

function printToolSummary(label: string, c: ReturnType<typeof summarizeToolRuns>): void {
  console.log(
    `  ${label} (n=${c.n}, proto=${c.protocols.join(",") || "unknown"}, edge=${c.edgeLocations.join(",") || "none"}):`,
  );
  console.log(
    `    Correct(${c.expectedTool}): ${c.toolCorrectnessRate} | ` +
      `FollowupOK: ${c.followupSuccessRate} | ` +
      `PreToolFiller: ${c.fillerRate}`,
  );
  console.log(
    `    t_toolcall: med=${formatMs(c.tToolCallMs.median)} p90=${formatMs(c.tToolCallMs.p90)} | ` +
      `t_exec: med=${formatMs(c.tExecMs.median)} p90=${formatMs(c.tExecMs.p90)} | ` +
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

function printModelReport(role: string, report: Awaited<ReturnType<typeof benchmarkGroqModel>>): void {
  console.log(
    `\n=== Groq [${role}] model=${report.settings.model} reasoning=${report.settings.reasoningEffort} format=${report.settings.reasoningFormat} ===`,
  );
  console.log(
    `  Derived: model time ≈ warm TTFT - origin RTT -> ` +
      `h1=${formatMs(report.estimatedModelTimeMs.h1Ms)} (${formatMs(report.scenarioB_warm.ttftMs.median)} - ${formatMs(report.estimatedModelTimeMs.originRttMedianMs)}), ` +
      `h2=${formatMs(report.estimatedModelTimeMs.h2Ms)} (${formatMs(report.scenarioB_warmH2.ttftMs.median)} - ${formatMs(report.estimatedModelTimeMs.originRttMedianMs)})`,
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

  const groqOriginRttMedian = groqBase.baseline.originRttMs.median;
  const fastReport = await benchmarkGroqModel(cfg.groqApiKey, fastProbe, groqOriginRttMedian);
  const reliableReport = await benchmarkGroqModel(
    cfg.groqApiKey,
    reliableProbe,
    groqOriginRttMedian,
  );

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
    geminiReport = await benchmarkGeminiScenarioB(
      cfg.geminiApiKey,
      gemProbe,
      gemBase.baseline.originRttMs.median,
    );
    console.log(
      `\n=== Gemini [FAILOVER] model=${geminiReport.settings.model} thinking=${geminiReport.settings.reasoningEffort} ===`,
    );
    console.log(
      `  Derived: model time ≈ warm TTFT - origin RTT -> ${formatMs(geminiReport.estimatedModelTimeMs.h1Ms)} (${formatMs(geminiReport.scenarioB_warm.ttftMs.median)} - ${formatMs(geminiReport.estimatedModelTimeMs.originRttMedianMs)})`,
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
