import { describe, expect, it } from "vitest";
import {
  TtsTurnStateMachine,
  classifyServerNotice,
  parseDeepgramTtsMessage,
  serializeClientCommand,
} from "./tts-parser.js";

describe("tts-parser", () => {
  it("serializes Speak, Flush, Clear, and Close client commands", () => {
    expect(JSON.parse(serializeClientCommand({ type: "Speak", text: "Hello." }))).toEqual({
      type: "Speak",
      text: "Hello.",
    });
    expect(JSON.parse(serializeClientCommand({ type: "Flush" }))).toEqual({ type: "Flush" });
    expect(JSON.parse(serializeClientCommand({ type: "Clear" }))).toEqual({ type: "Clear" });
    expect(JSON.parse(serializeClientCommand({ type: "Close" }))).toEqual({ type: "Close" });
  });

  it("parses Metadata, Flushed, and Cleared server responses", () => {
    const meta = parseDeepgramTtsMessage(
      JSON.stringify({
        type: "Metadata",
        request_id: "req-1",
        model_name: "aura-2-thalia-en",
        model_version: "2025-01-01",
        model_uuid: "uuid-1",
      }),
    );
    expect(meta.kind).toBe("metadata");
    if (meta.kind === "metadata") {
      expect(meta.msg.model_name).toBe("aura-2-thalia-en");
    }

    expect(parseDeepgramTtsMessage(JSON.stringify({ type: "Flushed", sequence_id: 2 }))).toEqual({
      kind: "flushed",
      sequenceId: 2,
    });
    expect(parseDeepgramTtsMessage(JSON.stringify({ type: "Cleared", sequence_id: 3 }))).toEqual({
      kind: "cleared",
      sequenceId: 3,
    });
  });

  it("classifies Warning and Error notices explicitly", () => {
    const flushWarn = parseDeepgramTtsMessage(
      JSON.stringify({
        type: "Warning",
        code: "TOO_MANY_FLUSHES",
        description: "Cannot process any more flush messages until the 60-second window passes.",
      }),
    );
    expect(flushWarn.kind).toBe("warning");
    if (flushWarn.kind === "warning") {
      expect(flushWarn.category).toBe("flush_rate_limit");
    }

    const legacyWarn = parseDeepgramTtsMessage(
      JSON.stringify({
        type: "Warning",
        warn_code: "NO_ACTIVE_SPEECH",
        warn_msg: "No active speech to flush",
      }),
    );
    expect(legacyWarn.kind).toBe("warning");
    if (legacyWarn.kind === "warning") {
      expect(legacyWarn.code).toBe("NO_ACTIVE_SPEECH");
      expect(legacyWarn.category).toBe("no_active_speech");
    }

    const fatalErr = parseDeepgramTtsMessage(
      JSON.stringify({
        type: "Error",
        err_code: "INTERNAL_SERVER_ERROR",
        err_msg: "An internal server error occurred",
      }),
    );
    expect(fatalErr.kind).toBe("error");
    if (fatalErr.kind === "error") {
      expect(fatalErr.category).toBe("server_error");
    }

    expect(classifyServerNotice("DATA-0001", "Too many input characters")).toBe("char_throughput");
  });

  it("handles Clear -> discarding stale audio until Cleared -> idle ready for next turn", () => {
    const sm = new TtsTurnStateMachine();
    expect(sm.getState()).toBe("idle");

    sm.startTurn();
    expect(sm.getState()).toBe("streaming");
    expect(sm.onAudioChunk(960)).toEqual({ accepted: true, discardedAfterClear: false });

    sm.markFlushSent();
    expect(sm.getState()).toBe("flushing");

    sm.markClearSent(1000);
    expect(sm.getState()).toBe("discarding");
    expect(() => sm.startTurn()).toThrow();

    // Stale audio received after Clear and before Cleared must be discarded
    expect(sm.onAudioChunk(480)).toEqual({ accepted: false, discardedAfterClear: true });
    expect(sm.onAudioChunk(240)).toEqual({ accepted: false, discardedAfterClear: true });

    sm.onCleared(1, 1042.5);
    expect(sm.getState()).toBe("idle");

    const snap = sm.snapshot();
    expect(snap.activeTurnAudioBytes).toBe(960);
    expect(snap.postClearDiscardedBytes).toBe(720);
    expect(snap.postClearDiscardedChunks).toBe(2);
    expect(snap.clearToClearedMs).toBeCloseTo(42.5, 4);

    // Ready for the next turn on the same socket
    sm.startTurn();
    expect(sm.getState()).toBe("streaming");
    expect(sm.onAudioChunk(1920)).toEqual({ accepted: true, discardedAfterClear: false });
    sm.onFlushed(2);
    expect(sm.getState()).toBe("idle");
  });

  it("keeps state open on Warning and moves to error on Error", () => {
    const sm = new TtsTurnStateMachine();
    sm.startTurn();
    const warn = parseDeepgramTtsMessage(
      JSON.stringify({ type: "Warning", code: "TEXT_LENGTH_WARNING", description: "Long text" }),
    );
    if (warn.kind === "warning") sm.onWarning(warn);
    expect(sm.getState()).toBe("streaming");

    const err = parseDeepgramTtsMessage(
      JSON.stringify({ type: "Error", code: "INTERNAL_SERVER_ERROR", description: "Boom" }),
    );
    if (err.kind === "error") sm.onError(err);
    expect(sm.getState()).toBe("error");
    expect(() => sm.startTurn()).toThrow();
  });
});
