import { describe, expect, it } from "vitest";
import {
  DeepgramTurnAccumulator,
  parseDeepgramMessage,
  scoreTranscriptAccuracy,
} from "./deepgram-parser.js";

describe("deepgram-parser", () => {
  it("concatenates all is_final chunks and measures stt_final on empty from_finalize", () => {
    const acc = new DeepgramTurnAccumulator();
    acc.markStreamStart(1000);

    // Interim empty then interim non-empty
    const r1 = acc.pushResults(
      {
        type: "Results",
        is_final: false,
        channel: { alternatives: [{ transcript: "" }] },
      },
      1100,
    );
    expect(r1.isFirstNonEmptyResult).toBe(false);

    const r2 = acc.pushResults(
      {
        type: "Results",
        is_final: false,
        channel: { alternatives: [{ transcript: "hello can you" }] },
      },
      1250,
    );
    expect(r2.isFirstNonEmptyResult).toBe(true);
    expect(r2.isNonEmptyInterim).toBe(true);

    // First is_final during utterance
    acc.pushResults(
      {
        type: "Results",
        is_final: true,
        channel: { alternatives: [{ transcript: "Hello, can you check" }] },
      },
      2500,
    );

    // Second is_final before Finalize
    acc.pushResults(
      {
        type: "Results",
        is_final: true,
        channel: { alternatives: [{ transcript: "the status of order 1042?" }] },
      },
      4800,
    );

    acc.markFinalizeSent(5000);

    // Empty from_finalize response (common when VAD hang already flushed last speech)
    const r5 = acc.pushResults(
      {
        type: "Results",
        is_final: true,
        from_finalize: true,
        channel: { alternatives: [{ transcript: "" }] },
      },
      5142,
    );
    expect(r5.fromFinalize).toBe(true);

    const summary = acc.summary();
    expect(summary.transcript).toBe("Hello, can you check the status of order 1042?");
    expect(summary.finalChunks).toEqual([
      "Hello, can you check",
      "the status of order 1042?",
    ]);
    expect(summary.interimCount).toBe(2);
    expect(summary.nonEmptyInterimCount).toBe(1);
    expect(summary.fromFinalizeReceived).toBe(true);
    expect(summary.fromFinalizeWasEmpty).toBe(true);
    expect(summary.firstAnyResultMs).toBe(100);
    expect(summary.firstNonEmptyResultMs).toBe(250);
    expect(summary.sttFinalMs).toBe(142);
  });

  it("parses Results, Metadata, and Error messages", () => {
    const meta = parseDeepgramMessage(
      JSON.stringify({
        type: "Metadata",
        request_id: "req-1",
        duration: 4.2,
        channels: 1,
      }),
    );
    expect(meta.kind).toBe("metadata");

    const err = parseDeepgramMessage(
      JSON.stringify({
        type: "Error",
        err_code: "BAD_REQUEST",
        err_msg: "Invalid encoding",
      }),
    );
    expect(err).toEqual({
      kind: "error",
      code: "BAD_REQUEST",
      message: "Invalid encoding",
    });
  });

  it("scores WER and order ID 1042 identically across spoken digits and formatted numerals", () => {
    const expected = "Hello, can you check the status of order one zero four two?";

    const dgScore = scoreTranscriptAccuracy(
      expected,
      "Hello, can you check the status of order 1042?",
      "1042",
    );
    expect(dgScore.wer).toBe(0);
    expect(dgScore.exactNormalizedMatch).toBe(true);
    expect(dgScore.orderIdMatched).toBe(true);

    const whisperScore = scoreTranscriptAccuracy(
      expected,
      "Hello, can you check the status of order 1042?",
      "1042",
    );
    expect(whisperScore).toEqual(dgScore);

    const missScore = scoreTranscriptAccuracy(
      expected,
      "Hello, can you check the status of order 1043?",
      "1042",
    );
    expect(missScore.orderIdMatched).toBe(false);
    expect(missScore.wer).toBeGreaterThan(0);
  });
});
