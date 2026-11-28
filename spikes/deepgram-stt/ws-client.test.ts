import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { DeepgramWsError, DeepgramWsSession } from "./ws-client.js";

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (srv) =>
        new Promise<void>((resolve) => {
          srv.close(() => resolve());
        }),
    ),
  );
});

async function startMockDeepgramServer(): Promise<{
  readonly port: number;
  readonly receivedFrames: number[];
}> {
  const receivedFrames: number[] = [];
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(wss);

  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const addr = wss.address();
  if (typeof addr !== "object" || addr === null) {
    throw new Error("Unexpected mock ws address");
  }

  wss.on("connection", (ws, req) => {
    if (req.url?.includes("reject401")) {
      ws.close(1008, "unauthorized");
      return;
    }

    let turnCounter = 0;
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        receivedFrames.push(buf.byteLength);
        if (receivedFrames.length === 1) {
          ws.send(
            JSON.stringify({
              type: "Results",
              is_final: false,
              channel: { alternatives: [{ transcript: "hello" }] },
            }),
          );
        }
        return;
      }

      const msg = JSON.parse(data.toString()) as { type?: string };
      if (msg.type === "Finalize") {
        turnCounter += 1;
        if (turnCounter === 1) {
          ws.send(
            JSON.stringify({
              type: "Results",
              is_final: true,
              from_finalize: true,
              channel: { alternatives: [{ transcript: "Hello world." }] },
            }),
          );
        } else {
          ws.send(
            JSON.stringify({
              type: "Results",
              is_final: true,
              channel: { alternatives: [{ transcript: "Second turn." }] },
            }),
          );
          ws.send(
            JSON.stringify({
              type: "Results",
              is_final: true,
              from_finalize: true,
              channel: { alternatives: [{ transcript: "" }] },
            }),
          );
        }
      } else if (msg.type === "CloseStream") {
        ws.send(
          JSON.stringify({
            type: "Metadata",
            request_id: "mock-req-123",
            duration: 1.5,
            channels: 1,
          }),
        );
        ws.close(1000, "done");
      }
    });
  });

  return { port: addr.port, receivedFrames };
}

describe("ws-client", () => {
  it("streams burst + 20 ms frames across warm multi-turn socket, captures timings, and closes cleanly with CloseStream", async () => {
    const mock = await startMockDeepgramServer();
    const session = await DeepgramWsSession.connect(
      `ws://127.0.0.1:${mock.port}/v1/listen?model=nova-3`,
      "dg_mock_key",
    );

    expect(session.connectTimings.newSocket).toBe(true);
    expect(session.connectTimings.statusCode).toBe(101);
    expect(session.connectTimings.totalOpenMs).toBeGreaterThanOrEqual(0);

    const t1 = await session.runTurn({
      burstChunk: new Uint8Array(11392),
      realtimeFrames: [new Uint8Array(640), new Uint8Array(640)],
      frameIntervalMs: 5,
    });
    expect(t1.timedOut).toBe(false);
    expect(t1.summary.transcript).toBe("Hello world.");
    expect(t1.summary.fromFinalizeReceived).toBe(true);
    expect(t1.summary.fromFinalizeWasEmpty).toBe(false);
    expect(t1.summary.firstNonEmptyResultMs).not.toBeNull();
    expect(t1.summary.sttFinalMs).not.toBeNull();

    // Second turn on the same warm socket, with empty from_finalize response
    const t2 = await session.runTurn({
      burstChunk: null,
      realtimeFrames: [new Uint8Array(640)],
      frameIntervalMs: 5,
    });
    expect(t2.timedOut).toBe(false);
    expect(t2.summary.transcript).toBe("Second turn.");
    expect(t2.summary.fromFinalizeReceived).toBe(true);
    expect(t2.summary.fromFinalizeWasEmpty).toBe(true);

    const closed = await session.closeStream();
    expect(closed.metadata?.request_id).toBe("mock-req-123");
    expect(closed.closeCode).toBe(1000);
    expect(mock.receivedFrames).toEqual([11392, 640, 640, 640]);
  });

  it("reports HTTP 4xx upgrade rejection via DeepgramWsError", async () => {
    const wss = new WebSocketServer({ noServer: true });
    const http = await import("node:http");
    const server = http.createServer();
    server.on("upgrade", (_req, socket) => {
      socket.write("HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nRegion disabled");
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("Expected address");

    try {
      await expect(
        DeepgramWsSession.connect(`ws://127.0.0.1:${addr.port}/v1/listen`, "dg_mock"),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(DeepgramWsError);
        const dgErr = err as DeepgramWsError;
        expect(dgErr.failure.phase).toBe("http_upgrade");
        expect(dgErr.failure.statusCode).toBe(403);
        return true;
      });
    } finally {
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
