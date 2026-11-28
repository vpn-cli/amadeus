import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import WebSocket, { type RawData } from "ws";
import {
  DeepgramTurnAccumulator,
  parseDeepgramMessage,
  type DeepgramMetadataMessage,
  type DeepgramTurnSummary,
} from "./deepgram-parser.js";

export interface WsConnectionTimings {
  readonly newSocket: boolean;
  readonly dnsMs: number;
  readonly tcpMs: number;
  readonly tlsMs: number;
  readonly upgradeMs: number;
  readonly totalOpenMs: number;
  readonly reusedTlsSession: boolean;
  readonly statusCode: number | null;
  readonly headers: Readonly<Record<string, string>>;
}

export interface DeepgramCloseSummary {
  readonly metadata: DeepgramMetadataMessage | null;
  readonly closeCode: number | null;
  readonly closeReason: string;
}

export interface WsConnectFailure {
  readonly host: string;
  readonly phase: "dns" | "tcp" | "tls" | "http_upgrade" | "error";
  readonly statusCode: number | null;
  readonly errorCode: string | null;
  readonly message: string;
  readonly elapsedMs: number;
  readonly headers: Readonly<Record<string, string>>;
}

function normalizeHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") {
      out[k.toLowerCase()] = v;
    } else if (Array.isArray(v)) {
      out[k.toLowerCase()] = v.join(", ");
    }
  }
  return out;
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function createTimedHttpsAgent(): {
  readonly agent: https.Agent;
  readonly readTimings: () => {
    dnsMs: number;
    tcpMs: number;
    tlsMs: number;
    tTlsDone: number | null;
    reusedTlsSession: boolean;
  };
} {
  let tStart = 0;
  let tLookup: number | null = null;
  let tTcp: number | null = null;
  let tTls: number | null = null;
  let reusedTlsSession = false;

  class TimedHttpsAgent extends https.Agent {
    override createConnection(
      options: https.RequestOptions,
      callback?: ((err: Error | null, stream: Duplex) => void) | undefined,
    ): Duplex | null | undefined {
      tStart = performance.now();
      const sock = super.createConnection(options, callback);
      if (sock) {
        sock.once("lookup", () => {
          tLookup = performance.now();
        });
        sock.once("connect", () => {
          tTcp = performance.now();
        });
        sock.once("secureConnect", () => {
          tTls = performance.now();
          const tlsSock = sock as Partial<TLSSocket>;
          reusedTlsSession =
            typeof tlsSock.isSessionReused === "function" ? tlsSock.isSessionReused() : false;
        });
      }
      return sock;
    }
  }

  const agent = new TimedHttpsAgent({ keepAlive: false, maxCachedSessions: 0 });
  return {
    agent,
    readTimings: () => {
      const dnsMs = tLookup !== null ? Math.max(0, tLookup - tStart) : 0;
      const tcpMs = tTcp !== null ? Math.max(0, tTcp - (tLookup ?? tStart)) : 0;
      const tlsMs = tTls !== null ? Math.max(0, tTls - (tTcp ?? tLookup ?? tStart)) : 0;
      return { dnsMs, tcpMs, tlsMs, tTlsDone: tTls, reusedTlsSession };
    },
  };
}

function createTimedHttpAgent(): {
  readonly agent: http.Agent;
  readonly readTimings: () => {
    dnsMs: number;
    tcpMs: number;
    tlsMs: number;
    tTlsDone: number | null;
    reusedTlsSession: boolean;
  };
} {
  let tStart = 0;
  let tLookup: number | null = null;
  let tTcp: number | null = null;

  class TimedHttpAgent extends http.Agent {
    override createConnection(
      options: http.ClientRequestArgs,
      callback?: ((err: Error | null, stream: Duplex) => void) | undefined,
    ): Duplex | null | undefined {
      tStart = performance.now();
      const sock = super.createConnection(options, callback);
      if (sock) {
        sock.once("lookup", () => {
          tLookup = performance.now();
        });
        sock.once("connect", () => {
          tTcp = performance.now();
        });
      }
      return sock;
    }
  }

  const agent = new TimedHttpAgent({ keepAlive: false });
  return {
    agent,
    readTimings: () => {
      const dnsMs = tLookup !== null ? Math.max(0, tLookup - tStart) : 0;
      const tcpMs = tTcp !== null ? Math.max(0, tTcp - (tLookup ?? tStart)) : 0;
      return { dnsMs, tcpMs, tlsMs: 0, tTlsDone: tTcp, reusedTlsSession: false };
    },
  };
}

export class DeepgramWsError extends Error {
  readonly failure: WsConnectFailure;

  constructor(failure: WsConnectFailure) {
    super(
      `${failure.host} [${failure.phase}${failure.statusCode !== null ? ` HTTP ${failure.statusCode}` : ""}${failure.errorCode ? ` ${failure.errorCode}` : ""}]: ${failure.message}`,
    );
    this.name = "DeepgramWsError";
    this.failure = failure;
  }
}

export class DeepgramWsSession {
  readonly url: string;
  readonly host: string;
  readonly connectTimings: WsConnectionTimings;

  private readonly ws: WebSocket;
  private activeAccumulator: DeepgramTurnAccumulator | null = null;
  private finalizeWaiter: {
    resolve: () => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;
  private metadata: DeepgramMetadataMessage | null = null;
  private closed = false;
  private closePromise: Promise<DeepgramCloseSummary>;
  private resolveClose!: (summary: DeepgramCloseSummary) => void;
  private lastError: Error | null = null;

  private constructor(url: string, ws: WebSocket, connectTimings: WsConnectionTimings) {
    this.url = url;
    this.host = new URL(url).hostname;
    this.ws = ws;
    this.connectTimings = connectTimings;

    this.closePromise = new Promise<DeepgramCloseSummary>((resolve) => {
      this.resolveClose = resolve;
    });

    ws.on("message", (data) => {
      const now = performance.now();
      const text = rawDataToString(data);
      let parsed: ReturnType<typeof parseDeepgramMessage>;
      try {
        parsed = parseDeepgramMessage(text);
      } catch {
        return;
      }

      if (parsed.kind === "metadata") {
        this.metadata = parsed.msg;
        return;
      }

      if (parsed.kind === "error") {
        const err = new Error(
          `Deepgram WS error${parsed.code ? ` [${parsed.code}]` : ""}: ${parsed.message}`,
        );
        this.lastError = err;
        if (this.finalizeWaiter !== null) {
          clearTimeout(this.finalizeWaiter.timer);
          const waiter = this.finalizeWaiter;
          this.finalizeWaiter = null;
          waiter.reject(err);
        }
        return;
      }

      if (parsed.kind === "results" && this.activeAccumulator !== null) {
        const step = this.activeAccumulator.pushResults(parsed.msg, now);
        if (step.fromFinalize && this.finalizeWaiter !== null) {
          clearTimeout(this.finalizeWaiter.timer);
          const waiter = this.finalizeWaiter;
          this.finalizeWaiter = null;
          waiter.resolve();
        }
      }
    });

    ws.on("close", (code, reasonBuf) => {
      this.closed = true;
      if (this.finalizeWaiter !== null) {
        clearTimeout(this.finalizeWaiter.timer);
        const waiter = this.finalizeWaiter;
        this.finalizeWaiter = null;
        waiter.reject(
          this.lastError ??
            new Error(`WebSocket closed before from_finalize (code=${code})`),
        );
      }
      this.resolveClose({
        metadata: this.metadata,
        closeCode: Number.isFinite(code) ? code : null,
        closeReason: reasonBuf.toString("utf8"),
      });
    });

    ws.on("error", (err) => {
      this.lastError = err;
      if (this.finalizeWaiter !== null) {
        clearTimeout(this.finalizeWaiter.timer);
        const waiter = this.finalizeWaiter;
        this.finalizeWaiter = null;
        waiter.reject(err);
      }
    });
  }

  static async connect(
    url: string,
    apiKey: string,
    options: { readonly handshakeTimeoutMs?: number } = {},
  ): Promise<DeepgramWsSession> {
    const parsedUrl = new URL(url);
    const isTls = parsedUrl.protocol === "wss:";
    const timed = isTls ? createTimedHttpsAgent() : createTimedHttpAgent();
    const tOpenStart = performance.now();
    const timeoutMs = options.handshakeTimeoutMs ?? 10_000;

    return await new Promise<DeepgramWsSession>((resolve, reject) => {
      let upgradeHeaders: Record<string, string> = {};
      let statusCode: number | null = null;
      let tUpgrade: number | null = null;
      let settled = false;

      const ws = new WebSocket(url, {
        agent: timed.agent,
        headers: {
          Authorization: `Token ${apiKey}`,
        },
        handshakeTimeout: timeoutMs,
      });

      const finishError = (failure: WsConnectFailure): void => {
        if (settled) return;
        settled = true;
        timed.agent.destroy();
        reject(new DeepgramWsError(failure));
      };

      ws.once("upgrade", (res) => {
        tUpgrade = performance.now();
        statusCode = res.statusCode ?? 101;
        upgradeHeaders = normalizeHeaders(res.headers);
      });

      ws.once("unexpected-response", (_req, res) => {
        const elapsedMs = performance.now() - tOpenStart;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8").trim();
          const code = res.statusCode ?? null;
          ws.terminate();
          finishError({
            host: parsedUrl.hostname,
            phase: "http_upgrade",
            statusCode: code,
            errorCode: code !== null ? `HTTP_${code}` : null,
            message: body.length > 0 ? body.slice(0, 300) : `HTTP ${code ?? "unknown"}`,
            elapsedMs,
            headers: normalizeHeaders(res.headers),
          });
        });
      });

      ws.once("open", () => {
        if (settled) return;
        settled = true;
        const tOpenDone = performance.now();
        const sockTimings = timed.readTimings();
        const upgradeBase = sockTimings.tTlsDone ?? tOpenStart;
        const upgradeMs = Math.max(0, (tUpgrade ?? tOpenDone) - upgradeBase);
        const totalOpenMs = Math.max(0, tOpenDone - tOpenStart);

        const timings: WsConnectionTimings = {
          newSocket: true,
          dnsMs: sockTimings.dnsMs,
          tcpMs: sockTimings.tcpMs,
          tlsMs: sockTimings.tlsMs,
          upgradeMs,
          totalOpenMs,
          reusedTlsSession: sockTimings.reusedTlsSession,
          statusCode: statusCode ?? 101,
          headers: upgradeHeaders,
        };
        resolve(new DeepgramWsSession(url, ws, timings));
      });

      ws.once("error", (err: NodeJS.ErrnoException) => {
        const elapsedMs = performance.now() - tOpenStart;
        const code = typeof err.code === "string" ? err.code : null;
        let phase: WsConnectFailure["phase"] = "error";
        if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA") {
          phase = "dns";
        } else if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "EHOSTUNREACH") {
          phase = "tcp";
        } else if (code?.startsWith("ERR_TLS") || code === "EPROTO") {
          phase = "tls";
        }
        finishError({
          host: parsedUrl.hostname,
          phase,
          statusCode,
          errorCode: code,
          message: err.message,
          elapsedMs,
          headers: upgradeHeaders,
        });
      });
    });
  }

  getLatestMetadata(): DeepgramMetadataMessage | null {
    return this.metadata;
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Streams one turn (optional confirm burst + 20 ms paced frames), sends Finalize
   * immediately after the last frame, and resolves when from_finalize arrives.
   */
  async runTurn(options: {
    readonly burstChunk: Uint8Array | null;
    readonly realtimeFrames: readonly Uint8Array[];
    readonly frameIntervalMs?: number;
    readonly finalizeTimeoutMs?: number;
  }): Promise<{
    readonly summary: DeepgramTurnSummary;
    readonly timedOut: boolean;
    readonly sendDurationMs: number;
  }> {
    if (!this.isOpen) {
      throw new Error("Deepgram WebSocket is not open");
    }

    const frameIntervalMs = options.frameIntervalMs ?? 20;
    const finalizeTimeoutMs = options.finalizeTimeoutMs ?? 4000;
    const acc = new DeepgramTurnAccumulator();
    this.activeAccumulator = acc;

    const tStart = performance.now();
    acc.markStreamStart(tStart);

    if (options.burstChunk !== null && options.burstChunk.byteLength > 0) {
      this.ws.send(options.burstChunk);
    }

    for (let i = 0; i < options.realtimeFrames.length; i += 1) {
      const targetAt = tStart + (i + 1) * frameIntervalMs;
      const waitMs = targetAt - performance.now();
      if (waitMs > 1) {
        await new Promise<void>((r) => setTimeout(r, waitMs));
      }
      if (!this.isOpen) {
        throw this.lastError ?? new Error("WebSocket closed while streaming audio");
      }
      const frame = options.realtimeFrames[i];
      if (frame !== undefined && frame.byteLength > 0) {
        this.ws.send(frame);
      }
    }

    const tFinalizeSent = performance.now();
    acc.markFinalizeSent(tFinalizeSent);
    this.ws.send(JSON.stringify({ type: "Finalize" }));

    let timedOut = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.finalizeWaiter !== null) {
            this.finalizeWaiter = null;
            timedOut = true;
            resolve();
          }
        }, finalizeTimeoutMs);
        this.finalizeWaiter = { resolve, reject, timer };
      });
    } finally {
      this.activeAccumulator = null;
    }

    return {
      summary: acc.summary(),
      timedOut,
      sendDurationMs: tFinalizeSent - tStart,
    };
  }

  /**
   * Sends CloseStream so Deepgram flushes Metadata and closes gracefully.
   */
  async closeStream(timeoutMs = 2500): Promise<DeepgramCloseSummary> {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "CloseStream" }));
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.closePromise,
        new Promise<DeepgramCloseSummary>((resolve) => {
          timer = setTimeout(() => {
            if (!this.closed) {
              this.ws.terminate();
            }
            resolve({
              metadata: this.metadata,
              closeCode: null,
              closeReason: "close_timeout",
            });
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
