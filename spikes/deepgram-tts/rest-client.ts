import { performance } from "node:perf_hooks";
import { Agent, fetch } from "undici";
import { computePlaybackTimeline, type AudioChunkTiming, type PlaybackTimelineResult } from "./timeline.js";

export interface RestSynthResult {
  readonly statusCode: number;
  readonly ok: boolean;
  readonly newSocket: boolean;
  readonly headersMs: number;
  readonly ttfbMs: number | null;
  readonly totalMs: number;
  readonly pcmBytes: Buffer;
  readonly chunks: readonly AudioChunkTiming[];
  readonly timelineJ0: PlaybackTimelineResult;
  readonly timelineJ100: PlaybackTimelineResult;
  readonly headers: Readonly<Record<string, string>>;
  readonly errorMessage: string | null;
}

export interface InstrumentedRestAgent {
  readonly agent: Agent;
  readonly consumeNewSocketFlag: () => boolean;
  readonly close: () => Promise<void>;
}

/**
 * Creates a single-connection HTTP/1.1+H2 undici Agent that tracks whether each
 * request opened a new TCP/TLS socket or reused the warmed connection.
 */
export function createWarmRestAgent(): InstrumentedRestAgent {
  let sawConnect = false;
  const agent = new Agent({
    connections: 1,
    pipelining: 1,
    allowH2: true,
    connect: (options, callback) => {
      sawConnect = true;
      // Delegate to default undici connector via Agent.ConnectOptions? Not needed:
      // we can hook via buildConnector from undici!
      return defaultConnector(options, callback);
    },
  });
  return {
    agent,
    consumeNewSocketFlag: () => {
      const val = sawConnect;
      sawConnect = false;
      return val;
    },
    close: async () => {
      await agent.close();
    },
  };
}

import { buildConnector } from "undici";
const defaultConnector = buildConnector({});

export async function synthesizeRest(options: {
  readonly url: string;
  readonly apiKey: string;
  readonly text: string;
  readonly dispatcher?: Agent;
  readonly consumeNewSocketFlag?: () => boolean;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<RestSynthResult> {
  const fetchImpl = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const tStart = performance.now();
  try {
    const init: Parameters<typeof fetch>[1] = {
      method: "POST",
      headers: {
        Authorization: `Token ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: options.text }),
      signal: controller.signal,
      ...(options.dispatcher !== undefined ? { dispatcher: options.dispatcher } : {}),
    };

    const res = await fetchImpl(options.url, init);
    const tHeaders = performance.now();
    const newSocket = options.consumeNewSocketFlag ? options.consumeNewSocketFlag() : false;

    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    if (!res.ok) {
      const errText = await res.text();
      const tEnd = performance.now();
      return {
        statusCode: res.status,
        ok: false,
        newSocket,
        headersMs: tHeaders - tStart,
        ttfbMs: null,
        totalMs: tEnd - tStart,
        pcmBytes: Buffer.alloc(0),
        chunks: [],
        timelineJ0: computePlaybackTimeline([], 0),
        timelineJ100: computePlaybackTimeline([], 100),
        headers,
        errorMessage: errText.slice(0, 300) || `HTTP ${res.status}`,
      };
    }

    const chunks: AudioChunkTiming[] = [];
    const buffers: Buffer[] = [];
    let tFirstByte: number | null = null;

    if (res.body) {
      const reader = res.body.getReader();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          const nowMs = performance.now();
          if (tFirstByte === null) {
            tFirstByte = nowMs;
          }
          const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          chunks.push({ arrivedAtMs: nowMs, bytes: buf.byteLength });
          buffers.push(buf);
        }
      }
    }

    const tEnd = performance.now();
    const pcmBytes = Buffer.concat(buffers);

    return {
      statusCode: res.status,
      ok: true,
      newSocket,
      headersMs: tHeaders - tStart,
      ttfbMs: tFirstByte !== null ? tFirstByte - tStart : null,
      totalMs: tEnd - tStart,
      pcmBytes,
      chunks,
      timelineJ0: computePlaybackTimeline(chunks, 0),
      timelineJ100: computePlaybackTimeline(chunks, 100),
      headers,
      errorMessage: null,
    };
  } finally {
    clearTimeout(timer);
  }
}
