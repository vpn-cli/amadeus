import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createWarmRestAgent, synthesizeRest } from "./rest-client.js";

describe("rest-client", () => {
  it("measures TTFB, total ms, and warm socket reuse against a local HTTP server", async () => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/v1/speak") && req.method === "POST") {
        res.writeHead(200, {
          "Content-Type": "audio/pcm",
          "dg-request-id": "rest-req-1",
        });
        res.write(Buffer.alloc(4800));
        setTimeout(() => {
          res.end(Buffer.alloc(4800));
        }, 20);
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as AddressInfo;
    const warm = createWarmRestAgent();

    try {
      const url = `http://127.0.0.1:${addr.port}/v1/speak?model=aura-2-thalia-en&encoding=linear16&container=none&sample_rate=24000`;
      const first = await synthesizeRest({
        url,
        apiKey: "test_key",
        text: "Your order 1042 has shipped.",
        dispatcher: warm.agent,
        consumeNewSocketFlag: warm.consumeNewSocketFlag,
      });
      expect(first.ok).toBe(true);
      expect(first.newSocket).toBe(true);
      expect(first.pcmBytes.byteLength).toBe(9600);
      expect(first.ttfbMs).not.toBeNull();
      expect(first.totalMs).toBeGreaterThanOrEqual(first.ttfbMs ?? 0);
      expect(first.headers["dg-request-id"]).toBe("rest-req-1");

      const second = await synthesizeRest({
        url,
        apiKey: "test_key",
        text: "Second call.",
        dispatcher: warm.agent,
        consumeNewSocketFlag: warm.consumeNewSocketFlag,
      });
      expect(second.ok).toBe(true);
      expect(second.newSocket).toBe(false);
    } finally {
      await warm.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("handles 4xx/5xx error responses cleanly", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ err_code: "BAD_REQUEST", err_msg: "Invalid model" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as AddressInfo;

    try {
      const res = await synthesizeRest({
        url: `http://127.0.0.1:${addr.port}/v1/speak`,
        apiKey: "test_key",
        text: "Test.",
      });
      expect(res.ok).toBe(false);
      expect(res.statusCode).toBe(400);
      expect(res.errorMessage).toContain("BAD_REQUEST");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
