import net from "node:net";
import { performance } from "node:perf_hooks";
import type { TLSSocket } from "node:tls";
import { Agent, buildConnector, fetch as undiciFetch, type Dispatcher, type Response } from "undici";
import { DEFAULT_WHISPER_MODEL } from "./config.js";
import { encodePcm16Wav } from "./wav.js";

export const GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

export interface HttpSocketConnectEvent {
  readonly dnsMs: number;
  readonly tcpMs: number;
  readonly tlsMs: number;
  readonly totalConnectMs: number;
  readonly protocol: "h1" | "h2" | "unknown";
}

export interface WhisperRequestConnectionMetrics {
  readonly newSocket: boolean;
  readonly socketsOpened: number;
  readonly dnsMs: number;
  readonly tcpMs: number;
  readonly tlsMs: number;
  readonly protocol: "h1" | "h2" | "unknown";
}

export interface InstrumentedWhisperAgent {
  readonly dispatcher: Agent;
  readonly getConnectEventsCount: () => number;
  readonly getConnectEventsSince: (idx: number) => readonly HttpSocketConnectEvent[];
  readonly getLastProtocol: () => "h1" | "h2" | "unknown";
  readonly close: () => Promise<void>;
}

export interface WhisperTranscriptionOutcome {
  readonly transcript: string;
  readonly latencyMs: number;
  readonly reportedDurationSec: number | null;
  readonly connection: WhisperRequestConnectionMetrics;
  readonly groqRegion: string | null;
  readonly cfRayLocation: string | null;
  readonly rateLimitHeaders: Readonly<Record<string, string>>;
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit & { dispatcher?: Dispatcher },
) => Promise<Response>;

export function createInstrumentedWhisperAgent(allowH2 = true): InstrumentedWhisperAgent {
  let lastProtocol: "h1" | "h2" | "unknown" = "unknown";
  const connectEvents: HttpSocketConnectEvent[] = [];
  const baseConnector = buildConnector({ allowH2, keepAlive: true });

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
      const tlsSock = socket as Partial<TLSSocket>;
      let protocol: "h1" | "h2" | "unknown";
      if (tlsSock.alpnProtocol === "h2") protocol = "h2";
      else if (tlsSock.alpnProtocol === "http/1.1" || tlsSock.alpnProtocol === false) protocol = "h1";
      else protocol = allowH2 ? "unknown" : "h1";
      lastProtocol = protocol;

      connectEvents.push({
        dnsMs: tLookup !== null ? Math.max(0, tLookup - t0) : 0,
        tcpMs: tTcp !== null ? Math.max(0, tTcp - (tLookup ?? t0)) : 0,
        tlsMs: isHttps ? Math.max(0, tDone - (tTcp ?? tLookup ?? t0)) : 0,
        totalConnectMs: Math.max(0, tDone - t0),
        protocol,
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

  return {
    dispatcher: agent,
    getConnectEventsCount: () => connectEvents.length,
    getConnectEventsSince: (idx) => connectEvents.slice(idx),
    getLastProtocol: () => lastProtocol,
    close: () => agent.close(),
  };
}

function parseWaitDurationMs(raw: string | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000);
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

function extractCfRayLocation(headers: Response["headers"]): string | null {
  const cfRay = headers.get("cf-ray");
  if (!cfRay) return null;
  const idx = cfRay.lastIndexOf("-");
  return idx >= 0 ? cfRay.slice(idx) : cfRay;
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

/**
 * Builds a RFC 7578 multipart/form-data payload explicitly so Content-Type and
 * Content-Length work identically across Node/undici HTTP/1.1 and HTTP/2.
 */
export function buildWhisperMultipartBody(options: {
  readonly wavBuffer: Uint8Array;
  readonly model: string;
  readonly language: string;
  readonly responseFormat?: string;
  readonly boundary?: string;
}): { readonly contentType: string; readonly body: Buffer } {
  const boundary =
    options.boundary ?? `----AmadeusWhisperBoundary${Math.random().toString(36).slice(2)}`;
  const fields: ReadonlyArray<readonly [string, string]> = [
    ["model", options.model],
    ["language", options.language],
    ["response_format", options.responseFormat ?? "verbose_json"],
  ];

  const parts: Buffer[] = [];
  for (const [name, value] of fields) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        "utf8",
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="turn.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
      "utf8",
    ),
  );
  parts.push(
    Buffer.from(
      options.wavBuffer.buffer,
      options.wavBuffer.byteOffset,
      options.wavBuffer.byteLength,
    ),
  );
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(parts),
  };
}

/**
 * Transcribes a PCM16LE 16 kHz slice via Groq's batch /audio/transcriptions REST endpoint.
 * Measures request start -> parsed transcript as the batch equivalent of stt_final.
 */
export async function transcribeWithGroqWhisper(options: {
  readonly apiKey: string;
  readonly pcmBytes: Uint8Array;
  readonly model?: string;
  readonly language?: string;
  readonly endpointUrl?: string;
  readonly instr?: InstrumentedWhisperAgent;
  readonly fetchFn?: FetchLike;
  readonly maxRateLimitRetries?: number;
}): Promise<WhisperTranscriptionOutcome> {
  const url = options.endpointUrl ?? GROQ_TRANSCRIPTIONS_URL;
  const model = options.model ?? DEFAULT_WHISPER_MODEL;
  const language = options.language ?? "en";
  const fetchImpl: FetchLike = options.fetchFn ?? (undiciFetch as unknown as FetchLike);
  const maxRetries = options.maxRateLimitRetries ?? 3;

  const wavBuffer = encodePcm16Wav(options.pcmBytes, 16000, 1);
  const multipart = buildWhisperMultipartBody({
    wavBuffer,
    model,
    language,
    responseFormat: "verbose_json",
  });

  let res: Response | null = null;
  let tStart = 0;
  let connectStartIdx = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    connectStartIdx = options.instr?.getConnectEventsCount() ?? 0;
    tStart = performance.now();
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": multipart.contentType,
      },
      body: new Uint8Array(multipart.body),
      ...(options.instr ? { dispatcher: options.instr.dispatcher } : {}),
    });

    if (res.status !== 429) {
      break;
    }

    const errText = await res.text();
    if (/\b(?:ASD|ASH|RPD)\b|per day|per hour/i.test(errText)) {
      throw new Error(`Groq Whisper quota exhausted (${res.status}): ${errText}`);
    }
    if (attempt === maxRetries) {
      throw new Error(`Groq Whisper 429 after ${maxRetries} retries: ${errText}`);
    }
    const retryAfterMs = parseWaitDurationMs(res.headers.get("retry-after")) ?? 3500;
    await new Promise<void>((r) => setTimeout(r, Math.min(Math.max(retryAfterMs + 250, 1000), 30_000)));
  }

  if (!res) {
    throw new Error("Groq Whisper fetch returned no response");
  }
  const bodyText = await res.text();
  const latencyMs = performance.now() - tStart;

  if (!res.ok) {
    throw new Error(`Groq Whisper HTTP ${res.status}: ${bodyText}`);
  }

  const parsed = JSON.parse(bodyText) as { text?: string; duration?: number };
  const events = options.instr?.getConnectEventsSince(connectStartIdx) ?? [];
  const firstEvent = events[0];
  const connection: WhisperRequestConnectionMetrics = firstEvent
    ? {
        newSocket: true,
        socketsOpened: events.length,
        dnsMs: firstEvent.dnsMs,
        tcpMs: firstEvent.tcpMs,
        tlsMs: firstEvent.tlsMs,
        protocol: firstEvent.protocol,
      }
    : {
        newSocket: false,
        socketsOpened: 0,
        dnsMs: 0,
        tcpMs: 0,
        tlsMs: 0,
        protocol: options.instr?.getLastProtocol() ?? "unknown",
      };

  return {
    transcript: typeof parsed.text === "string" ? parsed.text.trim() : "",
    latencyMs,
    reportedDurationSec: typeof parsed.duration === "number" ? parsed.duration : null,
    connection,
    groqRegion: res.headers.get("x-groq-region")?.trim() || null,
    cfRayLocation: extractCfRayLocation(res.headers),
    rateLimitHeaders: extractRateLimitHeaders(res.headers),
  };
}
