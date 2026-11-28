import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import WebSocket, { type RawData } from "ws";
import {
  computePlaybackTimeline,
  type AudioChunkTiming,
  type PlaybackTimelineResult,
} from "./timeline.js";
import {
  TtsTurnStateMachine,
  parseDeepgramTtsMessage,
  serializeClientCommand,
  type ClassifiedServerNotice,
  type DeepgramTtsMetadataMessage,
} from "./tts-parser.js";

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

export interface WsConnectFailure {
  readonly host: string;
  readonly phase: "dns" | "tcp" | "tls" | "http_upgrade" | "error";
  readonly statusCode: number | null;
  readonly errorCode: string | null;
  readonly message: string;
  readonly elapsedMs: number;
  readonly headers: Readonly<Record<string, string>>;
}

export class DeepgramTtsWsError extends Error {
  readonly failure: WsConnectFailure;

  constructor(failure: WsConnectFailure) {
    super(
      `${failure.host} [${failure.phase}${failure.statusCode !== null ? ` HTTP ${failure.statusCode}` : ""}${failure.errorCode ? ` ${failure.errorCode}` : ""}]: ${failure.message}`,
    );
    this.name = "DeepgramTtsWsError";
    this.failure = failure;
  }
}

export interface DeepgramTtsCloseSummary {
  readonly metadata: DeepgramTtsMetadataMessage | null;
  readonly closeCode: number | null;
  readonly closeReason: string;
  readonly elapsedMs: number;
  readonly notices: readonly ClassifiedServerNotice[];
}

export interface TtsTurnResult {
  readonly speakToFirstAudioMs: number | null;
  readonly flushToFirstAudioMs: number | null;
  readonly audioStartedBeforeFlush: boolean;
  readonly flushedMs: number | null;
  readonly timedOut: boolean;
  readonly pcmBytes: Buffer;
  readonly chunks: readonly AudioChunkTiming[];
  readonly timelineJ0: PlaybackTimelineResult;
  readonly timelineJ100: PlaybackTimelineResult;
  readonly notices: readonly ClassifiedServerNotice[];
  readonly closeCode: number | null;
  readonly closeReason: string | null;
}

export interface TtsTwoSentenceResult {
  readonly flush1ToFirstAudioMs: number | null;
  readonly flush2ToS2StartGapActualMs: number;
  readonly flushedCount: number;
  readonly totalFlushedMs: number | null;
  readonly timedOut: boolean;
  readonly pcmBytes: Buffer;
  readonly chunks: readonly AudioChunkTiming[];
  readonly timelineJ0: PlaybackTimelineResult;
  readonly timelineJ100: PlaybackTimelineResult;
  readonly notices: readonly ClassifiedServerNotice[];
  readonly closeCode: number | null;
  readonly closeReason: string | null;
}

export interface TtsBargeInClearResult {
  readonly turn1FirstAudioMs: number | null;
  readonly flushedBeforeClear: boolean;
  readonly clearToClearedMs: number | null;
  readonly postClearBytesBeforeCleared: number;
  readonly postClearBytesAfterCleared: number;
  readonly totalPostClearBytes: number;
  readonly clearedTimedOut: boolean;
  readonly socketSurvived: boolean;
  readonly turn2FirstAudioMs: number | null;
  readonly turn2FlushedMs: number | null;
  readonly turn2AudioBytes: number;
  readonly notices: readonly ClassifiedServerNotice[];
  readonly closeCode: number | null;
  readonly closeReason: string | null;
}

/**
 * Rolling-window rate limiter to ensure we stay safely below Deepgram's
 * 20 Flushes / 60 s WebSocket limit without ever deliberately exceeding it.
 */
export class FlushRateLimiter {
  private readonly timestamps: number[] = [];
  private readonly maxFlushes: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: {
    readonly maxFlushes?: number;
    readonly windowMs?: number;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {}) {
    this.maxFlushes = options.maxFlushes ?? 18;
    this.windowMs = options.windowMs ?? 62_000;
    this.now = options.now ?? (() => performance.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private prune(currentMs: number): void {
    while (this.timestamps.length > 0 && currentMs - this.timestamps[0]! >= this.windowMs) {
      this.timestamps.shift();
    }
  }

  async waitAndReserve(count = 1): Promise<number> {
    if (count <= 0) return 0;
    let totalWaited = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const current = this.now();
      this.prune(current);
      if (this.timestamps.length + count <= this.maxFlushes) {
        for (let i = 0; i < count; i += 1) {
          this.timestamps.push(current);
        }
        return totalWaited;
      }
      const neededToExpire = this.timestamps.length + count - this.maxFlushes;
      const targetExpireAt = (this.timestamps[neededToExpire - 1] ?? current) + this.windowMs + 25;
      const waitMs = Math.max(10, targetExpireAt - current);
      totalWaited += waitMs;
      await this.sleep(waitMs);
    }
  }
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

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function createTimedHttpsAgent() {
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

function createTimedHttpAgent() {
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

export class DeepgramTtsWsSession {
  readonly url: string;
  readonly host: string;
  readonly connectTimings: WsConnectionTimings;
  readonly openedAtMs: number;
  readonly flushLimiter = new FlushRateLimiter();

  private readonly ws: WebSocket;
  private readonly agent: http.Agent | https.Agent;
  private metadata: DeepgramTtsMetadataMessage | null = null;
  private readonly sessionNotices: ClassifiedServerNotice[] = [];
  private closed = false;
  private desynced = false;
  private closeCode: number | null = null;
  private closeReason = "";
  private closeResolve!: (summary: DeepgramTtsCloseSummary) => void;
  private readonly closePromise: Promise<DeepgramTtsCloseSummary>;
  private activeMessageHandler: ((data: RawData, isBinary: boolean, nowMs: number) => void) | null =
    null;
  private activeCloseHandler: ((code: number, reason: string) => void) | null = null;
  private activeErrorHandler: ((err: Error) => void) | null = null;

  private constructor(
    url: string,
    ws: WebSocket,
    agent: http.Agent | https.Agent,
    connectTimings: WsConnectionTimings,
    openedAtMs: number,
  ) {
    this.url = url;
    this.host = new URL(url).hostname;
    this.ws = ws;
    this.agent = agent;
    this.connectTimings = connectTimings;
    this.openedAtMs = openedAtMs;

    this.closePromise = new Promise<DeepgramTtsCloseSummary>((resolve) => {
      this.closeResolve = resolve;
    });

    ws.on("message", (data, isBinary) => {
      const nowMs = performance.now();
      if (!isBinary) {
        const text = rawDataToBuffer(data).toString("utf8");
        try {
          const parsed = parseDeepgramTtsMessage(text);
          if (parsed.kind === "metadata") {
            this.metadata = parsed.msg;
          } else if (parsed.kind === "warning" || parsed.kind === "error") {
            this.sessionNotices.push(parsed);
          }
        } catch {
          // handled downstream if needed
        }
      }
      this.activeMessageHandler?.(data, isBinary, nowMs);
    });

    ws.on("close", (code, reasonBuf) => {
      this.closed = true;
      this.closeCode = Number.isFinite(code) ? code : null;
      this.closeReason = reasonBuf.toString("utf8");
      this.agent.destroy();
      this.activeCloseHandler?.(code, this.closeReason);
      this.closeResolve({
        metadata: this.metadata,
        closeCode: this.closeCode,
        closeReason: this.closeReason,
        elapsedMs: Math.max(0, performance.now() - this.openedAtMs),
        notices: [...this.sessionNotices],
      });
    });

    ws.on("error", (err) => {
      this.activeErrorHandler?.(err);
    });
  }

  static async connect(
    url: string,
    apiKey: string,
    options: { readonly handshakeTimeoutMs?: number } = {},
  ): Promise<DeepgramTtsWsSession> {
    const parsedUrl = new URL(url);
    const isTls = parsedUrl.protocol === "wss:";
    const timed = isTls ? createTimedHttpsAgent() : createTimedHttpAgent();
    const tOpenStart = performance.now();
    const timeoutMs = options.handshakeTimeoutMs ?? 10_000;

    return await new Promise<DeepgramTtsWsSession>((resolve, reject) => {
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
        reject(new DeepgramTtsWsError(failure));
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
        resolve(new DeepgramTtsWsSession(url, ws, timed.agent, timings, tOpenDone));
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

  get isOpen(): boolean {
    return !this.closed && !this.desynced && this.ws.readyState === WebSocket.OPEN;
  }

  getMetadata(): DeepgramTtsMetadataMessage | null {
    return this.metadata;
  }

  getNotices(): readonly ClassifiedServerNotice[] {
    return [...this.sessionNotices];
  }

  /**
   * Sends Speak(text) + Flush, collects raw binary audio until Flushed, and
   * computes playback timelines for J = 0 ms and J = 100 ms.
   */
  async synthesizeTurn(options: {
    readonly text: string;
    readonly turnTimeoutMs?: number;
  }): Promise<TtsTurnResult> {
    if (!this.isOpen) {
      throw new Error("Deepgram TTS WebSocket is not open");
    }

    await this.flushLimiter.waitAndReserve(1);
    if (!this.isOpen) {
      throw new Error("Deepgram TTS WebSocket closed while waiting for flush budget");
    }

    const timeoutMs = options.turnTimeoutMs ?? 30_000;
    const chunks: AudioChunkTiming[] = [];
    const buffers: Buffer[] = [];
    const notices: ClassifiedServerNotice[] = [];
    let firstAudioAtMs: number | null = null;
    let flushedAtMs: number | null = null;
    let timedOut = false;

    let tSpeakSent = 0;
    let tFlushSent = 0;

    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.activeMessageHandler = null;
        this.activeCloseHandler = null;
        this.activeErrorHandler = null;
        resolve();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        this.desynced = true;
        finish();
      }, timeoutMs);

      this.activeMessageHandler = (data, isBinary, nowMs) => {
        if (isBinary) {
          const buf = rawDataToBuffer(data);
          if (buf.byteLength === 0) return;
          if (firstAudioAtMs === null) {
            firstAudioAtMs = nowMs;
          }
          chunks.push({ arrivedAtMs: nowMs, bytes: buf.byteLength });
          buffers.push(buf);
          return;
        }
        try {
          const parsed = parseDeepgramTtsMessage(rawDataToBuffer(data).toString("utf8"));
          if (parsed.kind === "warning") {
            notices.push(parsed);
          } else if (parsed.kind === "error") {
            notices.push(parsed);
            finish();
          } else if (parsed.kind === "flushed") {
            flushedAtMs = nowMs;
            finish();
          }
        } catch {
          // ignore malformed non-JSON frame
        }
      };

      this.activeCloseHandler = () => finish();
      this.activeErrorHandler = () => finish();

      tSpeakSent = performance.now();
      this.ws.send(serializeClientCommand({ type: "Speak", text: options.text }));
      tFlushSent = performance.now();
      this.ws.send(serializeClientCommand({ type: "Flush" }));
    });

    const pcmBytes = Buffer.concat(buffers);
    return {
      speakToFirstAudioMs:
        firstAudioAtMs !== null ? firstAudioAtMs - tSpeakSent : null,
      flushToFirstAudioMs:
        firstAudioAtMs !== null ? firstAudioAtMs - tFlushSent : null,
      audioStartedBeforeFlush: firstAudioAtMs !== null && firstAudioAtMs < tFlushSent,
      flushedMs: flushedAtMs !== null ? flushedAtMs - tFlushSent : null,
      timedOut,
      pcmBytes,
      chunks,
      timelineJ0: computePlaybackTimeline(chunks, 0),
      timelineJ100: computePlaybackTimeline(chunks, 100),
      notices,
      closeCode: this.closeCode,
      closeReason: this.closed ? this.closeReason : null,
    };
  }

  /**
   * Streams sentence 1 (Speak + Flush), waits gapMs (50 ms or 300 ms), then
   * sends sentence 2 (Speak + Flush) and awaits 2 Flushed acknowledgments.
   */
  async streamTwoSentences(options: {
    readonly sentence1: string;
    readonly sentence2: string;
    readonly gapMs: number;
    readonly turnTimeoutMs?: number;
  }): Promise<TtsTwoSentenceResult> {
    if (!this.isOpen) {
      throw new Error("Deepgram TTS WebSocket is not open");
    }

    await this.flushLimiter.waitAndReserve(2);
    if (!this.isOpen) {
      throw new Error("Deepgram TTS WebSocket closed while waiting for flush budget");
    }

    const timeoutMs = options.turnTimeoutMs ?? 20_000;
    const chunks: AudioChunkTiming[] = [];
    const buffers: Buffer[] = [];
    const notices: ClassifiedServerNotice[] = [];
    let firstAudioAtMs: number | null = null;
    let flushedCount = 0;
    let lastFlushedAtMs: number | null = null;
    let timedOut = false;

    let tFlush1Sent = 0;
    let tSpeak2Sent = 0;

    await new Promise<void>((resolve) => {
      let finished = false;
      let gapTimer: NodeJS.Timeout | undefined;

      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (gapTimer !== undefined) clearTimeout(gapTimer);
        this.activeMessageHandler = null;
        this.activeCloseHandler = null;
        this.activeErrorHandler = null;
        resolve();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        this.desynced = true;
        finish();
      }, timeoutMs);

      this.activeMessageHandler = (data, isBinary, nowMs) => {
        if (isBinary) {
          const buf = rawDataToBuffer(data);
          if (buf.byteLength === 0) return;
          if (firstAudioAtMs === null) {
            firstAudioAtMs = nowMs;
          }
          chunks.push({ arrivedAtMs: nowMs, bytes: buf.byteLength });
          buffers.push(buf);
          return;
        }
        try {
          const parsed = parseDeepgramTtsMessage(rawDataToBuffer(data).toString("utf8"));
          if (parsed.kind === "warning") {
            notices.push(parsed);
          } else if (parsed.kind === "error") {
            notices.push(parsed);
            finish();
          } else if (parsed.kind === "flushed") {
            flushedCount += 1;
            lastFlushedAtMs = nowMs;
            if (flushedCount >= 2) {
              finish();
            }
          }
        } catch {
          // ignore
        }
      };

      this.activeCloseHandler = () => finish();
      this.activeErrorHandler = () => finish();

      this.ws.send(serializeClientCommand({ type: "Speak", text: options.sentence1 }));
      tFlush1Sent = performance.now();
      this.ws.send(serializeClientCommand({ type: "Flush" }));

      gapTimer = setTimeout(() => {
        if (finished || !this.isOpen) return;
        tSpeak2Sent = performance.now();
        this.ws.send(serializeClientCommand({ type: "Speak", text: options.sentence2 }));
        this.ws.send(serializeClientCommand({ type: "Flush" }));
      }, options.gapMs);
    });

    const pcmBytes = Buffer.concat(buffers);
    return {
      flush1ToFirstAudioMs:
        firstAudioAtMs !== null ? firstAudioAtMs - tFlush1Sent : null,
      flush2ToS2StartGapActualMs:
        tSpeak2Sent > 0 ? tSpeak2Sent - tFlush1Sent : options.gapMs,
      flushedCount,
      totalFlushedMs:
        lastFlushedAtMs !== null ? lastFlushedAtMs - tFlush1Sent : null,
      timedOut,
      pcmBytes,
      chunks,
      timelineJ0: computePlaybackTimeline(chunks, 0),
      timelineJ100: computePlaybackTimeline(chunks, 100),
      notices,
      closeCode: this.closeCode,
      closeReason: this.closed ? this.closeReason : null,
    };
  }

  /**
   * Tests mid-audio Clear: sends Speak(sentence1)+Flush, sends Clear after
   * clearAfterFirstAudioMs (or sooner if needed), counts post-Clear stale bytes,
   * awaits Cleared, drains postClearDrainMs, then immediately runs Speak(nextSentence)+Flush
   * on the same socket to verify survival and measure next-turn tts_first_audio.
   */
  async runBargeInClear(options: {
    readonly sentence1: string;
    readonly nextSentence: string;
    readonly clearAfterFirstAudioMs?: number;
    readonly postClearDrainMs?: number;
    readonly turnTimeoutMs?: number;
  }): Promise<TtsBargeInClearResult> {
    if (!this.isOpen) {
      throw new Error("Deepgram TTS WebSocket is not open");
    }

    await this.flushLimiter.waitAndReserve(2);
    if (!this.isOpen) {
      throw new Error("Deepgram TTS WebSocket closed while waiting for flush budget");
    }

    const clearDelayMs = options.clearAfterFirstAudioMs ?? 40;
    const drainMs = options.postClearDrainMs ?? 150;
    const timeoutMs = options.turnTimeoutMs ?? 30_000;

    const sm = new TtsTurnStateMachine();
    const notices: ClassifiedServerNotice[] = [];
    let tFlush1Sent = 0;
    let tFirstAudio1: number | null = null;
    let flushedBeforeClear = false;
    let clearSent = false;
    let clearedTimedOut = false;
    let postClearBytesAfterCleared = 0;

    await new Promise<void>((resolve) => {
      let finished = false;
      let clearTimer: NodeJS.Timeout | undefined;
      let drainTimer: NodeJS.Timeout | undefined;

      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeoutTimer);
        if (clearTimer !== undefined) clearTimeout(clearTimer);
        if (drainTimer !== undefined) clearTimeout(drainTimer);
        this.activeMessageHandler = null;
        this.activeCloseHandler = null;
        this.activeErrorHandler = null;
        resolve();
      };

      const sendClearNow = () => {
        if (finished || clearSent || !this.isOpen) return;
        clearSent = true;
        sm.markClearSent(performance.now());
        this.ws.send(serializeClientCommand({ type: "Clear" }));
      };

      const timeoutTimer = setTimeout(() => {
        clearedTimedOut = true;
        finish();
      }, timeoutMs);

      this.activeMessageHandler = (data, isBinary, nowMs) => {
        if (isBinary) {
          const buf = rawDataToBuffer(data);
          if (buf.byteLength === 0) return;
          if (!clearSent && tFirstAudio1 === null) {
            tFirstAudio1 = nowMs;
            clearTimer = setTimeout(sendClearNow, clearDelayMs);
          }
          const outcome = sm.onAudioChunk(buf.byteLength);
          if (!outcome.accepted && !outcome.discardedAfterClear && sm.getState() === "idle") {
            postClearBytesAfterCleared += buf.byteLength;
          }
          return;
        }
        try {
          const parsed = parseDeepgramTtsMessage(rawDataToBuffer(data).toString("utf8"));
          if (parsed.kind === "warning") {
            notices.push(parsed);
            sm.onWarning(parsed);
          } else if (parsed.kind === "error") {
            notices.push(parsed);
            sm.onError(parsed);
            finish();
          } else if (parsed.kind === "flushed") {
            if (!clearSent) {
              flushedBeforeClear = true;
              sendClearNow();
            }
          } else if (parsed.kind === "cleared") {
            sm.onCleared(parsed.sequenceId, nowMs);
            drainTimer = setTimeout(finish, drainMs);
          }
        } catch {
          // ignore
        }
      };

      this.activeCloseHandler = () => {
        sm.onClose();
        finish();
      };
      this.activeErrorHandler = () => finish();

      sm.startTurn();
      this.ws.send(serializeClientCommand({ type: "Speak", text: options.sentence1 }));
      tFlush1Sent = performance.now();
      sm.markFlushSent();
      this.ws.send(serializeClientCommand({ type: "Flush" }));
    });

    const snap = sm.snapshot();
    const socketSurvivedBeforeTurn2 = this.isOpen && sm.getState() === "idle";

    let turn2FirstAudioMs: number | null = null;
    let turn2FlushedMs: number | null = null;
    let turn2AudioBytes = 0;

    if (socketSurvivedBeforeTurn2) {
      // Turn 2 immediately on same socket (reservation for 2 Flushes was taken above)
      let tFlush2Sent = 0;
      let tFirstAudio2: number | null = null;
      let tFlushed2: number | null = null;

      await new Promise<void>((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          this.activeMessageHandler = null;
          this.activeCloseHandler = null;
          this.activeErrorHandler = null;
          resolve();
        };

        const timer = setTimeout(finish, timeoutMs);

        this.activeMessageHandler = (data, isBinary, nowMs) => {
          if (isBinary) {
            const buf = rawDataToBuffer(data);
            if (buf.byteLength === 0) return;
            if (tFirstAudio2 === null) tFirstAudio2 = nowMs;
            turn2AudioBytes += buf.byteLength;
            return;
          }
          try {
            const parsed = parseDeepgramTtsMessage(rawDataToBuffer(data).toString("utf8"));
            if (parsed.kind === "warning") {
              notices.push(parsed);
            } else if (parsed.kind === "error") {
              notices.push(parsed);
              finish();
            } else if (parsed.kind === "flushed") {
              tFlushed2 = nowMs;
              finish();
            }
          } catch {
            // ignore
          }
        };

        this.activeCloseHandler = () => finish();
        this.activeErrorHandler = () => finish();

        this.ws.send(serializeClientCommand({ type: "Speak", text: options.nextSentence }));
        tFlush2Sent = performance.now();
        this.ws.send(serializeClientCommand({ type: "Flush" }));
      });

      if (tFirstAudio2 !== null) {
        turn2FirstAudioMs = tFirstAudio2 - tFlush2Sent;
      }
      if (tFlushed2 !== null) {
        turn2FlushedMs = tFlushed2 - tFlush2Sent;
      }
    }

    return {
      turn1FirstAudioMs: tFirstAudio1 !== null ? tFirstAudio1 - tFlush1Sent : null,
      flushedBeforeClear,
      clearToClearedMs: snap.clearToClearedMs,
      postClearBytesBeforeCleared: snap.postClearDiscardedBytes,
      postClearBytesAfterCleared,
      totalPostClearBytes: snap.postClearDiscardedBytes + postClearBytesAfterCleared,
      clearedTimedOut,
      socketSurvived: socketSurvivedBeforeTurn2 && this.isOpen && turn2AudioBytes > 0,
      turn2FirstAudioMs,
      turn2FlushedMs,
      turn2AudioBytes,
      notices,
      closeCode: this.closeCode,
      closeReason: this.closed ? this.closeReason : null,
    };
  }

  /**
   * Sends a WebSocket protocol ping frame and measures pong RTT.
   */
  async probePing(timeoutMs = 3000): Promise<{ readonly ok: boolean; readonly rttMs: number | null }> {
    if (!this.isOpen) return { ok: false, rttMs: null };
    const tStart = performance.now();
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean, rttMs: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ws.off("pong", onPong);
        this.ws.off("close", onClose);
        resolve({ ok, rttMs });
      };
      const onPong = () => finish(true, performance.now() - tStart);
      const onClose = () => finish(false, null);
      const timer = setTimeout(() => finish(false, null), timeoutMs);
      this.ws.once("pong", onPong);
      this.ws.once("close", onClose);
      this.ws.ping();
    });
  }

  /**
   * Sends an arbitrary JSON message (e.g. {"type":"KeepAlive"}) and observes
   * notices / close behavior for observeMs.
   */
  async probeJsonControl(
    payload: Record<string, unknown>,
    observeMs = 3000,
  ): Promise<{
    readonly notices: readonly ClassifiedServerNotice[];
    readonly closedByServer: boolean;
    readonly closeCode: number | null;
    readonly closeReason: string | null;
    readonly rawTextMessages: readonly string[];
  }> {
    if (!this.isOpen) {
      return {
        notices: [],
        closedByServer: true,
        closeCode: this.closeCode,
        closeReason: this.closeReason,
        rawTextMessages: [],
      };
    }

    const notices: ClassifiedServerNotice[] = [];
    const rawTextMessages: string[] = [];

    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.activeMessageHandler = null;
        this.activeCloseHandler = null;
        resolve();
      };
      const timer = setTimeout(finish, observeMs);

      this.activeMessageHandler = (data, isBinary) => {
        if (isBinary) return;
        const txt = rawDataToBuffer(data).toString("utf8");
        rawTextMessages.push(txt);
        try {
          const parsed = parseDeepgramTtsMessage(txt);
          if (parsed.kind === "warning" || parsed.kind === "error") {
            notices.push(parsed);
          }
        } catch {
          // ignore
        }
      };

      this.activeCloseHandler = () => finish();
      this.ws.send(JSON.stringify(payload));
    });

    return {
      notices,
      closedByServer: this.closed,
      closeCode: this.closeCode,
      closeReason: this.closed ? this.closeReason : null,
      rawTextMessages,
    };
  }

  /**
   * Holds socket idle without sending text and waits up to maxWaitMs for server close.
   * Optionally sends WebSocket protocol ping frames (not KeepAlive JSON) every pingIntervalMs.
   */
  async waitForIdleClose(
    maxWaitMs = 70_000,
    options: {
      readonly pingIntervalMs?: number;
      readonly onPing?: (rttMs: number | null, elapsedMs: number) => void;
    } = {},
  ): Promise<{
    readonly closedByServer: boolean;
    readonly idleElapsedMs: number;
    readonly closeCode: number | null;
    readonly closeReason: string | null;
    readonly notices: readonly ClassifiedServerNotice[];
  }> {
    if (this.closed) {
      return {
        closedByServer: true,
        idleElapsedMs: 0,
        closeCode: this.closeCode,
        closeReason: this.closeReason,
        notices: [...this.sessionNotices],
      };
    }
    const tStart = performance.now();
    const noticesStartIdx = this.sessionNotices.length;

    let maxTimer: NodeJS.Timeout | undefined;
    let pingTimer: NodeJS.Timeout | undefined;
    let pingInFlight = false;

    if (options.pingIntervalMs !== undefined && options.pingIntervalMs > 0) {
      pingTimer = setInterval(() => {
        if (this.closed || this.ws.readyState !== WebSocket.OPEN || pingInFlight) return;
        pingInFlight = true;
        void this.probePing(4000).then((res) => {
          pingInFlight = false;
          options.onPing?.(res.ok ? res.rttMs : null, performance.now() - tStart);
        });
      }, options.pingIntervalMs);
    }

    try {
      const summary = await Promise.race([
        this.closePromise,
        new Promise<null>((resolve) => {
          maxTimer = setTimeout(() => resolve(null), maxWaitMs);
        }),
      ]);

      if (summary === null) {
        return {
          closedByServer: false,
          idleElapsedMs: performance.now() - tStart,
          closeCode: null,
          closeReason: null,
          notices: this.sessionNotices.slice(noticesStartIdx),
        };
      }

      return {
        closedByServer: true,
        idleElapsedMs: performance.now() - tStart,
        closeCode: summary.closeCode,
        closeReason: summary.closeReason,
        notices: this.sessionNotices.slice(noticesStartIdx),
      };
    } finally {
      if (maxTimer !== undefined) clearTimeout(maxTimer);
      if (pingTimer !== undefined) clearInterval(pingTimer);
    }
  }

  async closeGracefully(timeoutMs = 2500): Promise<DeepgramTtsCloseSummary> {
    if (this.closed) {
      this.agent.destroy();
      return await this.closePromise;
    }
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(serializeClientCommand({ type: "Close" }));
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.closePromise,
        new Promise<DeepgramTtsCloseSummary>((resolve) => {
          timer = setTimeout(() => {
            if (!this.closed) {
              this.ws.terminate();
            }
            this.agent.destroy();
            resolve({
              metadata: this.metadata,
              closeCode: this.closeCode,
              closeReason: "close_timeout",
              elapsedMs: Math.max(0, performance.now() - this.openedAtMs),
              notices: [...this.sessionNotices],
            });
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.agent.destroy();
    }
  }
}
