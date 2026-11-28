import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { DeepgramTtsWsError, DeepgramTtsWsSession, FlushRateLimiter } from "./ws-client.js";

async function withMockWsServer(
  onConnection: (ws: WebSocket) => void,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const addr = wss.address() as AddressInfo;
  wss.on("connection", onConnection);
  try {
    await fn(addr.port);
  } finally {
    for (const client of wss.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}

describe("ws-client", () => {
  it("measures connect timings, synthesizes a turn, computes J=0/100 timelines, and closes gracefully", async () => {
    await withMockWsServer(
      (ws) => {
        ws.send(
          JSON.stringify({
            type: "Metadata",
            request_id: "req-1",
            model_name: "aura-2-thalia-en",
            model_version: "1",
            model_uuid: "uuid-1",
          }),
        );
        ws.on("message", (data, isBinary) => {
          if (isBinary) return;
          const msg = JSON.parse(data.toString()) as { type: string };
          if (msg.type === "Flush") {
            ws.send(Buffer.alloc(9600)); // 200 ms
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(Buffer.alloc(9600)); // +200 ms
                ws.send(JSON.stringify({ type: "Flushed", sequence_id: 0 }));
              }
            }, 25);
          } else if (msg.type === "Close") {
            ws.close(1000, "Normal Closure");
          }
        });
      },
      async (port) => {
        const session = await DeepgramTtsWsSession.connect(
          `ws://127.0.0.1:${port}/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=24000`,
          "test_key",
        );
        expect(session.connectTimings.newSocket).toBe(true);
        expect(session.connectTimings.statusCode).toBe(101);

        const res = await session.synthesizeTurn({ text: "Your order 1042 has shipped." });
        expect(res.timedOut).toBe(false);
        expect(res.pcmBytes.byteLength).toBe(19200);
        expect(res.flushToFirstAudioMs).not.toBeNull();
        expect(res.flushedMs).not.toBeNull();
        expect(res.timelineJ0.underrunCount).toBe(0);
        expect(res.timelineJ100.underrunCount).toBe(0);
        expect(res.timelineJ0.firstChunkMs).toBe(200);

        const closed = await session.closeGracefully();
        expect(closed.closeCode).toBe(1000);
        expect(closed.metadata?.model_name).toBe("aura-2-thalia-en");
      },
    );
  });

  it("handles two-sentence streaming and barge-in Clear with post-Clear audio discard", async () => {
    await withMockWsServer(
      (ws) => {
        let seq = 0;
        let lastText = "";
        ws.on("message", (data, isBinary) => {
          if (isBinary) return;
          const msg = JSON.parse(data.toString()) as { type: string; text?: string };
          if (msg.type === "Speak" && typeof msg.text === "string") {
            lastText = msg.text;
          } else if (msg.type === "Flush") {
            if (lastText.startsWith("Long")) {
              ws.send(Buffer.alloc(4800)); // 100 ms
              setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: "Flushed", sequence_id: seq++ }));
                }
              }, 200);
            } else {
              ws.send(Buffer.alloc(4800));
              ws.send(JSON.stringify({ type: "Flushed", sequence_id: seq++ }));
            }
          } else if (msg.type === "Clear") {
            // Emit stale audio chunk after Clear before Cleared arrives
            ws.send(Buffer.alloc(2400));
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "Cleared", sequence_id: seq++ }));
              }
            }, 20);
          } else if (msg.type === "Close") {
            ws.close(1000, "Done");
          }
        });
      },
      async (port) => {
        const session = await DeepgramTtsWsSession.connect(
          `ws://127.0.0.1:${port}/v1/speak`,
          "test_key",
        );

        const two = await session.streamTwoSentences({
          sentence1: "First sentence.",
          sentence2: "Second sentence.",
          gapMs: 120,
        });
        expect(two.flushedCount).toBe(2);
        expect(two.pcmBytes.byteLength).toBe(9600);
        expect(two.timelineJ0.underrunCount).toBe(1);
        expect(two.timelineJ100.underrunCount).toBe(0);

        const barge = await session.runBargeInClear({
          sentence1: "Long first sentence.",
          nextSentence: "Short reply.",
          clearAfterFirstAudioMs: 15,
          postClearDrainMs: 40,
        });
        expect(barge.flushedBeforeClear).toBe(false);
        expect(barge.postClearBytesBeforeCleared).toBe(2400);
        expect(barge.clearToClearedMs).not.toBeNull();
        expect(barge.socketSurvived).toBe(true);
        expect(barge.turn2AudioBytes).toBe(4800);

        await session.closeGracefully();
      },
    );
  });

  it("surfaces HTTP upgrade rejection errors cleanly", async () => {
    const wss = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      verifyClient: (_info, cb) => cb(false, 404, "Not Found"),
    });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const addr = wss.address() as AddressInfo;

    try {
      await expect(
        DeepgramTtsWsSession.connect(`ws://127.0.0.1:${addr.port}/v1/speak`, "test_key"),
      ).rejects.toBeInstanceOf(DeepgramTtsWsError);
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it("enforces rolling-window FlushRateLimiter without exceeding cap", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const limiter = new FlushRateLimiter({
      maxFlushes: 3,
      windowMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });

    expect(await limiter.waitAndReserve(2)).toBe(0);
    clock += 100;
    expect(await limiter.waitAndReserve(1)).toBe(0);
    // 4th flush must wait until oldest timestamp (0) expires at 1000 + 25
    const waited = await limiter.waitAndReserve(1);
    expect(waited).toBeGreaterThan(0);
    expect(sleeps.length).toBe(1);
  });
});
