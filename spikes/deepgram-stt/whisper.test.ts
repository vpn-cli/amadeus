import { describe, expect, it } from "vitest";
import { Response } from "undici";
import { transcribeWithGroqWhisper, type FetchLike } from "./whisper.js";

describe("whisper", () => {
  it("uploads WAV multipart form and returns transcript + headers", async () => {
    let seenUrl = "";
    let seenModel = "";
    let seenFileBytes = 0;

    const mockFetch: FetchLike = async (input, init) => {
      seenUrl = String(input);
      const form = init?.body as FormData;
      seenModel = String(form.get("model"));
      const file = form.get("file") as Blob;
      seenFileBytes = file.size;

      return new Response(
        JSON.stringify({
          text: "Hello, can you check the status of order 1042?",
          duration: 4.2,
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-groq-region": "bom",
            "cf-ray": "abc123-MAA",
            "x-ratelimit-remaining-requests": "1999",
          },
        },
      );
    };

    const pcm = new Uint8Array(640);
    const out = await transcribeWithGroqWhisper({
      apiKey: "gsk_test",
      pcmBytes: pcm,
      fetchFn: mockFetch,
    });

    expect(seenUrl).toContain("/audio/transcriptions");
    expect(seenModel).toBe("whisper-large-v3-turbo");
    expect(seenFileBytes).toBe(44 + 640);
    expect(out.transcript).toBe("Hello, can you check the status of order 1042?");
    expect(out.reportedDurationSec).toBe(4.2);
    expect(out.groqRegion).toBe("bom");
    expect(out.cfRayLocation).toBe("-MAA");
    expect(out.rateLimitHeaders["x-ratelimit-remaining-requests"]).toBe("1999");
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("aborts immediately on daily/hourly ASH/ASD quota 429", async () => {
    const mockFetch: FetchLike = async () =>
      new Response(
        JSON.stringify({
          error: { message: "Rate limit reached on audio seconds per hour (ASH)" },
        }),
        { status: 429 },
      );

    await expect(
      transcribeWithGroqWhisper({
        apiKey: "gsk_test",
        pcmBytes: new Uint8Array(640),
        fetchFn: mockFetch,
      }),
    ).rejects.toThrow(/quota exhausted/i);
  });
});
