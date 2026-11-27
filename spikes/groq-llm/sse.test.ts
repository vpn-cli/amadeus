import { describe, expect, it } from "vitest";
import { SseParser } from "./sse.js";

describe("SseParser", () => {
  it("reassembles events across arbitrary byte and UTF-8 boundaries", () => {
    const parser = new SseParser();
    const payload = 'event: message\nid: 1\ndata: {"text":"café 🚀"}\n\n';
    const bytes = new TextEncoder().encode(payload);

    const out = [];
    // Feed 3 bytes at a time to split multi-byte UTF-8 characters.
    for (let i = 0; i < bytes.length; i += 3) {
      out.push(...parser.push(bytes.subarray(i, i + 3)));
    }
    out.push(...parser.flush());

    expect(out).toEqual([
      {
        event: "message",
        id: "1",
        data: '{"text":"café 🚀"}',
      },
    ]);
  });

  it("handles CRLF, comments, multi-line data, and [DONE]", () => {
    const parser = new SseParser();
    const events = parser.push(
      ": keepalive\r\ndata: line1\r\ndata: line2\r\n\r\ndata: [DONE]\r\n\r\n",
    );

    expect(events).toEqual([
      { data: "line1\nline2" },
      { data: "[DONE]" },
    ]);
  });

  it("flushes trailing event missing final blank line", () => {
    const parser = new SseParser();
    expect(parser.push('data: {"ok":true}\n')).toEqual([]);
    expect(parser.flush()).toEqual([{ data: '{"ok":true}' }]);
  });
});
