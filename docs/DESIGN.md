# Voice Agent MVP — M1 Design & Contracts

> **Status:** M1 contracts review (no Phase 1 code written yet).  
> **Tag legend:** **`[DECIDED]`** = backed by Phase 0 measurements, [claude-handoff-02.md](../handoff/claude-handoff-02.md), spike READMEs, or explicit rulings. **`[PROPOSED]`** = M1 design proposal awaiting final sign-off.

---

## 1. Scope & Traceability

This design covers all requirements in `Technical Assignment.pdf` (§5–§9), incorporating the measured Phase 0 findings from `spikes/`.

### 1.1 Acceptance Criteria (§7 of Spec)

| # | Spec Acceptance Criterion | Satisfied By (Design Section) | Verification / Evidence |
| --- | --- | --- | --- |
| 1 | User completes a 5+ turn conversation and agent remembers earlier turns | §3 (Reducer), §8 (Persistence `turns`), §9 (`START_CALL` warm lifecycle) | Multi-turn E2E call; server passes `≤ 1,500` estimated history tokens (oldest dropped first; system prompt & tools always kept, with honest barge-in `spoken_text` from §7) to `LlmAdapter.stream()` |
| 2 | Median time from end of user speech to first agent audio ≤ 1.5 s (20 test turns) | §5 (Latency definitions), §9 (`api.in.deepgram.com` + Groq H2 + 2-Flush TTS) | Phase 0 measured India median sum ≈ 1,258 ms (`gpt-oss-120b`); Phase 2 `pnpm bench` (`20` fixture turns: 16 non-tool + 4 tool) emits `docs/latency-report.md` reporting non-tool, tool, and overall median/p90 |
| 3 | Live captions show partial and final transcripts | §2 (`transcript_partial`, `transcript_final`), §4 (`SttAdapter` `partials: true`) | Deepgram Nova-3 (`interim_results=true`, pre-roll burst at confirm: `403 ms` median first caption); UI renders `transcript_partial` → `transcript_final` |
| 4 | Barge-in works: agent audio stops within ~300 ms of user speaking | §2 (`interrupt`, `turn_id` header), §3 (`SPEAKING` client-authoritative barge-in), §5.3 (`onset_to_stop_ms`), §7 (Heard-text history), §9 (`Clear`) | Client `@ricky0123/vad-web` stops playback locally, drops stale `turn_id` frames, server sends `Clear` (`42.5 ms` med `Clear→Cleared`). Acceptance: Chrome fake-mic integration test median `onset_to_stop_ms ≤ 300 ms` over `n ≥ 10` (`detect_to_stop_ms` logged as diagnostic only) |
| 5 | Sample tool is invoked correctly when asked a relevant question | §4 (`Tool`, `LlmAdapter`), §5 (`ack_audio_ms`, `tool_ms`), §8 (`tool_calls`) | `get_current_time` (`tools-v3`, `{}`) and `get_order_status` (`{ order_id }`) measured 100% accuracy under `voice-v2` on `gpt-oss-120b` |
| 6 | All failure cases in §6 behave as described | §6 (Error Matrix & Timeouts), §9 (Pre-rendered fallback/goodbye clips) | Unit tests per error row + timeout test suite (zero API keys) |
| 7 | Each session's transcript and per-stage latencies are persisted and retrievable by `session_id` | §5 (`turn_metrics`), §8 (`sessions`, `turns`, `tool_calls`, `turn_metrics`, `errors`, `GET /sessions/:id`) | Drizzle/SQLite integration test asserts per-turn flushed rows, live `GET /sessions/:id` during an active call, nullable stage metrics, and turn `outcome` |
| 8 | Swapping one provider needs only config + a new adapter, no pipeline changes | §4 (Adapter interfaces + Groq Whisper & REST TTS swap proofs), §11 (ESLint boundary) | ESLint `no-restricted-imports` blocks vendor SDKs outside `adapters/<kind>/<vendor>.ts`; swap proofs in §4.5 |
| 9 | Unit tests for state transitions & adapters (mocked); 1 integration test with recorded audio & zero API keys | §3 (Pure reducer), §4 (Fakes for STT/LLM/TTS + real Silero ONNX), §6 (Test column) | Vitest table-driven reducer tests, mock WS/fetch adapter tests, keyless `pnpm test:int` with fixture WAV + real Silero v6.3 |
| 10 | `README.md` with setup, env vars, architecture diagram, and local run instructions | §11 (Monorepo layout) | Delivered in Phase 1/2 once monorepo + `pnpm dev` / `pnpm test` / `pnpm bench` are wired |

### 1.2 Error Rows (§6 of Spec)

| # | Spec Failure Row | Satisfied By | Verification / Evidence |
| --- | --- | --- | --- |
| 1 | Mic permission denied | §6 Row 1 (Client requests `getUserMedia` *before* `POST /sessions`) | Client unit/UI test: denied mic shows banner and never calls `POST /sessions` |
| 2 | STT / LLM / TTS timeout or error | §6 Rows 2, 7–13 (Timeouts, failover, pre-rendered fallback clip, logged error) | Mock WS/fetch failure + timeout unit tests assert fallback clip, error log, and return to `LISTENING` |
| 3 | WebSocket drops | §3 (`WS_CLOSE`), §6 Row 3 (Client `"Disconnected"`, server aborts turn & persists) | WS drop integration test asserts `end_reason = "ws_drop"`, `ended_at` set, transcript saved |
| 4 | Empty / noise-only utterance | §3 (`STT_FINAL_EMPTY`), §6 Row 4 (Dropped, back to `LISTENING`, no LLM call) | Reducer unit test + VAD `noise-only` test assert `0` LLM calls |
| 5 | Tool call fails | §4 (`Tool`), §6 Row 5 (3 s timeout / error `{ error }` returned to LLM) | Tool-executor unit test asserts `{ error }` passed to follow-up LLM turn and graceful spoken apology |
| 6 | Max duration / silence timeout | §3 (`TIMEOUT_SILENCE`, `TIMEOUT_MAX_CALL`), §6 Row 6 (Pre-rendered goodbye clip + `call_ended`) | Reducer timer tests assert goodbye clip, `call_ended`, DB persist, and `ENDED` |

### 1.3 Deliverables (§9 of Spec)

| # | Spec Deliverable | Satisfied By |
| --- | --- | --- |
| 1 | PR(s) with backend, frontend, tests, and `README.md` | §11 (`apps/server`, `apps/web`, `packages/protocol`, `packages/audio`), §3–§8 |
| 2 | 2–3 min demo recording of a multi-turn call including a barge-in and a tool call | Phase 2 deliverable exercising §3 (multi-turn + barge-in), §4 (tool call), §7 (heard-text history) |
| 3 | Latency report (median + p90 per stage) from 20 test turns | §5 (`turn_metrics` stage definitions), §8 (`GET /sessions/:id`), Phase 2 `scripts/bench.ts` → `docs/latency-report.md` (turn mix: 16 non-tool + 4 tool turns; reports non-tool and tool turns separately alongside the overall median and p90) |

---

## 2. Wire Protocol (`packages/protocol`, Zod, Versioned)

`[DECIDED]` Transport is Fastify + `@fastify/websocket` at `/ws/voice?session_id=<uuid>`. Messages are validated at runtime with Zod schemas exported from `packages/protocol` and shared by `apps/server` and `apps/web`.

### 2.1 Binary Audio Frames

- **Client → Server (`mic_audio`):** `[DECIDED]`
  - **Raw `PCM16LE`, mono, `16,000 Hz`, NO header, exactly `640` bytes per frame (`320` samples = `20 ms`).**
  - **Pre-session sequence rule (`[PROPOSED]`):** The client **must** send `session_start` before its first binary audio frame. Any binary frame received before `session_start` (in `IDLE`) causes the server to emit `error { code: "bad_sequence", stage: "protocol", message: "...", recoverable: false }`, persist the error, and close the WebSocket immediately (`1002` / `1008`). It must not be ignored, because doing so would desync the implicit `seq` counter.
  - **Implicit `seq`:** `0`-based frame counter incremented by `1` per `640 B` frame after `session_start`, counted identically on client and server (`audioTimeMs = seq * 20`).
  - **Frame size enforcement (`[PROPOSED]`):** Any binary frame after `session_start` whose `byteLength !== 640` causes the server to emit `error { code: "bad_frame_size", stage: "protocol", message: "...", recoverable: false }`, persist the error, and close the WebSocket immediately (`1002` / `1008`).
  - **Mic gap detection (`[PROPOSED]`):** If `receiveAt - prevMicReceiveAt > 500 ms` while `state === "LISTENING"`, server logs a `mic_stall` metric/warning event (no state change, no fallback clip).

- **Server → Client (`agent_audio`):** `[DECIDED]`
  - **`10`-byte little-endian header** followed by `PCM16LE`, mono, `24,000 Hz` payload starting at byte offset `10` (chosen over 9 bytes because offset `9` puts `Int16Array` at an odd `byteOffset` and throws). No 1-byte ack flag may be added to the binary header (it would break the 10 B aligned layout).
  - `seq` restarts at `0` for each `turn_id` (`1..N`). Every turn and every pre-rendered clip (`ack`, `fallback`, `goodbye`) is sent with a positive `turn_id` (`ack` uses the current `turn_id`; `fallback` and `goodbye` get a fresh `turn_id` from `nextTurnId`).
  - **Ack-to-reply boundary (`[PROPOSED]`):** When `"One moment"` plays during `THINKING` under the current `turn_id` (`seq = 0..K-1`), the server records `ack_bytes` and sends JSON `reply_audio_start { turn_id, seq }` (`seq = K`) immediately before the first real-reply `agent_audio` binary frame.
  - **End-of-audio marker (`[PROPOSED]`):** After the last `agent_audio` frame of a turn or clip, the server sends JSON `agent_audio_end { turn_id, total_bytes }`. The client sends `playback_done` only after playing `total_bytes` for that `turn_id`.
  - **Client frame acceptance rule (`[PROPOSED]`):** The client tracks `maxSeenTurnId` and `lastInterruptedTurnId`, accepts `agent_audio` frames only when `version === 1`, `kind === 1`, and `turn_id === maxSeenTurnId && turn_id > lastInterruptedTurnId`, and drops all else.

```text
Offset  Size  Type    Field     Value / Meaning
0       1     u8      kind      1 = agent_audio
1       1     u8      version   1 (protocol version)
2       4     u32 LE  turn_id   1..N per turn or clip (assigned via nextTurnId)
6       4     u32 LE  seq       0..K per turn_id
10      N     PCM16LE payload   24 kHz mono little-endian signed 16-bit PCM (N even)
```

- **Server Binary Parsing Rule (`[DECIDED]`):**
  - Never construct `new Int16Array(buf.buffer, buf.byteOffset, ...)` directly on a Node `Buffer` received from `ws`, because `ws` / Node slab allocation can produce an odd `buf.byteOffset`.
  - Always convert incoming `640 B` `mic_audio` frames using `buf.readInt16LE(i * 2)` or `new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getInt16(i * 2, true)` (or copy into a fresh aligned `ArrayBuffer` first).

```ts
// packages/protocol/src/binary.ts (sketch only — do not create .ts in M1 design)
export const PROTOCOL_VERSION = 1 as const;
export const MIC_FRAME_BYTES = 640; // 320 samples * 2 bytes (20 ms @ 16 kHz mono)
export const AGENT_AUDIO_HEADER_BYTES = 10;
export const AGENT_AUDIO_KIND = 1 as const;

export interface AgentAudioHeader {
  kind: typeof AGENT_AUDIO_KIND;
  version: number;
  turn_id: number;
  seq: number;
}

export function encodeAgentAudioFrame(header: AgentAudioHeader, pcm24k: Uint8Array): Uint8Array;
export function decodeAgentAudioFrame(frame: ArrayBuffer | Uint8Array): {
  header: AgentAudioHeader;
  pcm24k: Uint8Array;
};

// Server-side safe PCM16LE -> Float32 normalization (zero byteOffset assumptions)
export function pcm16LeBufferToFloat32(buf: Uint8Array): Float32Array {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const samples = new Float32Array(buf.byteLength / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }
  return samples;
}
```

### 2.2 JSON Control & Event Schemas (`packages/protocol`)

```ts
import { z } from "zod";

export const ProtocolVersionSchema = z.literal(1);

export const SessionStateSchema = z.enum([
  "IDLE",
  "LISTENING",
  "THINKING",
  "SPEAKING",
  "ENDED",
]);

export const PipelineStageSchema = z.enum([
  "protocol",
  "vad",
  "stt",
  "llm",
  "tool",
  "tts",
  "ws",
  "session",
]);

export const EndReasonSchema = z.enum([
  "user_end_call",
  "silence_timeout",
  "max_duration",
  "ws_drop",
  "protocol_error",
  "internal_error",
]);

// --- Client -> Server ---
export const SessionStartEventSchema = z.object({
  type: z.literal("session_start"),
  timezone: z.string().min(1).refine((tz) => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Invalid IANA timezone"),
  protocol_version: z.number().int().positive(),
});

export const InterruptEventSchema = z.object({
  type: z.literal("interrupt"),
  turn_id: z.number().int().positive(),
  played_ms: z.number().nonnegative(),
  detect_to_stop_ms: z.number().nonnegative(), // diagnostic only; acceptance uses onset_to_stop_ms
});

export const PlaybackDoneEventSchema = z.object({
  type: z.literal("playback_done"),
  turn_id: z.number().int().positive(),
  played_ms: z.number().nonnegative(),
});

export const EndCallEventSchema = z.object({
  type: z.literal("end_call"),
});

export const ClientJsonEventSchema = z.discriminatedUnion("type", [
  SessionStartEventSchema,
  InterruptEventSchema,
  PlaybackDoneEventSchema,
  EndCallEventSchema,
]);

// --- Server -> Client ---
export const SessionReadyEventSchema = z.object({
  type: z.literal("session_ready"),
  session_id: z.string().min(1),
  protocol_version: ProtocolVersionSchema,
  timezone: z.string().min(1),
});

export const StateEventSchema = z.object({
  type: z.literal("state"),
  state: SessionStateSchema,
});

export const TranscriptPartialEventSchema = z.object({
  type: z.literal("transcript_partial"),
  text: z.string(),
  turn_id: z.number().int().positive(),
});

export const TranscriptFinalEventSchema = z.object({
  type: z.literal("transcript_final"),
  text: z.string(),
  turn_id: z.number().int().positive(),
});

export const AgentTextEventSchema = z.object({
  type: z.literal("agent_text"),
  text: z.string(),
  turn_id: z.number().int().positive(),
  sentence_idx: z.number().int().nonnegative(),
});

export const ToolStatusEventSchema = z.object({
  type: z.literal("tool_status"),
  turn_id: z.number().int().positive(),
  name: z.string().min(1),
  phase: z.enum(["started", "succeeded", "failed"]),
});

export const ReplyAudioStartEventSchema = z.object({
  type: z.literal("reply_audio_start"),
  turn_id: z.number().int().positive(),
  seq: z.number().int().nonnegative(),
});

export const AgentAudioEndEventSchema = z.object({
  type: z.literal("agent_audio_end"),
  turn_id: z.number().int().positive(),
  total_bytes: z.number().int().nonnegative(),
});

export const TurnOutcomeSchema = z.enum(["ok", "interrupted", "fallback", "failed"]);

export const TurnMetricsEventSchema = z.object({
  type: z.literal("turn_metrics"),
  turn_id: z.number().int().positive(),
  t0_seq: z.number().int().nonnegative(),
  vad_end_ms: z.number().nonnegative().nullable(),
  stt_final_ms: z.number().nonnegative().nullable(),
  llm_first_token_ms: z.number().nonnegative().nullable(),
  first_sentence_ms: z.number().nonnegative().nullable(),
  tool_ms: z.number().nonnegative().nullable(),
  ack_audio_ms: z.number().nonnegative().nullable(),
  tts_first_audio_ms: z.number().nonnegative().nullable(),
  total_ms: z.number().nonnegative().nullable(),
  total_client_ms: z.number().nonnegative().nullable(),
  client_latency_source: z.enum(["outputLatency", "baseLatency", "none"]).nullable(),
  llm_provider: z.string().min(1).nullable(),
  outcome: TurnOutcomeSchema,
  interrupted: z.boolean(),
});

export const ErrorEventSchema = z.object({
  type: z.literal("error"),
  code: z.string().min(1),
  stage: PipelineStageSchema,
  message: z.string().min(1),
  recoverable: z.boolean(),
});

export const CallEndedEventSchema = z.object({
  type: z.literal("call_ended"),
  reason: EndReasonSchema,
});

export const ServerJsonEventSchema = z.discriminatedUnion("type", [
  SessionReadyEventSchema,
  StateEventSchema,
  TranscriptPartialEventSchema,
  TranscriptFinalEventSchema,
  AgentTextEventSchema,
  ToolStatusEventSchema,
  ReplyAudioStartEventSchema,
  AgentAudioEndEventSchema,
  TurnMetricsEventSchema,
  ErrorEventSchema,
  CallEndedEventSchema,
]);
```

- **Protocol version mismatch (`[DECIDED]`):** If `session_start.protocol_version !== 1`, server responds with `error { code: "protocol_mismatch", stage: "protocol", message: "Unsupported protocol_version", recoverable: false }` and closes the WS (`1002`).

### 2.3 Strict-Superset Mapping to Spec §4 Event Table

| Spec §4 Endpoint / Event | Spec Direction & Key Fields | `DESIGN.md` Equivalent | Superset Delta |
| --- | --- | --- | --- |
| `POST /sessions` | `client -> server` `{ } -> { session_id }` | `POST /sessions` `{ } -> { session_id }` | Identical |
| `WS /ws/voice` | `both` binary audio + JSON events | `WS /ws/voice?session_id=...` | Identical |
| `audio (binary)` | `client -> server` PCM 16 kHz mono frames | Raw `640 B` PCM16LE 16 kHz mono (implicit `seq`) | Pinned exact `640 B` (`20 ms`) frame contract |
| `transcript_partial` | `server -> client` `{ text }` | `{ type: "transcript_partial", text, turn_id }` | Added `type` + `turn_id` |
| `transcript_final` | `server -> client` `{ text, turn_id }` | `{ type: "transcript_final", text, turn_id }` | Added `type` |
| `agent_text` | `server -> client` `{ text, turn_id }` | `{ type: "agent_text", text, turn_id, sentence_idx }` | Added `type` + `sentence_idx` (`[PROPOSED]`) |
| `agent_audio` | `server -> client` binary audio chunk | 10-byte LE header + 24 kHz PCM16LE | Added `10 B` header (`kind, version, turn_id, seq`) |
| `state` | `server -> client` `{ state }` (`listening / thinking / speaking`) | `{ type: "state", state }` (`IDLE \| LISTENING \| THINKING \| SPEAKING \| ENDED`) | Added `type` + explicit `IDLE`/`ENDED` states |
| `interrupt` | `client -> server` `{ turn_id }` | `{ type: "interrupt", turn_id, played_ms, detect_to_stop_ms }` | Added `type`, `played_ms`, `detect_to_stop_ms` |
| `error` | `server -> client` `{ code, message }` | `{ type: "error", code, stage, message, recoverable }` | Added `type`, `stage`, `recoverable` |
| `call_ended` | `server -> client` `{ reason }` | `{ type: "call_ended", reason }` | Added `type` + typed `EndReason` enum |
| `GET /sessions/:id` | `client -> server` `-> { transcript, metrics }` | `GET /sessions/:id` `-> { session, turns, metrics, errors }` | Strict superset (see §8.2) |
| *(Extension)* `session_start` | — | `{ type: "session_start", timezone, protocol_version }` | `[DECIDED]` IANA timezone + version negotiation |
| *(Extension)* `session_ready` | — | `{ type: "session_ready", session_id, protocol_version, timezone }` | `[DECIDED]` Warm-provider & version handshake ack |
| *(Extension)* `playback_done` | — | `{ type: "playback_done", turn_id, played_ms }` | `[DECIDED]` Exact `SPEAKING -> LISTENING` boundary |
| *(Extension)* `end_call` | — | `{ type: "end_call" }` | `[DECIDED]` Clean client hang-up signal |
| *(Extension)* `tool_status` | — | `{ type: "tool_status", turn_id, name, phase }` | `[PROPOSED]` Live tool execution indicator |
| *(Extension)* `reply_audio_start` | — | `{ type: "reply_audio_start", turn_id, seq }` | `[PROPOSED]` Marks first real-reply frame after `"One moment"` ack clip (`t1_server` / `t1_client` anchor) |
| *(Extension)* `agent_audio_end` | — | `{ type: "agent_audio_end", turn_id, total_bytes }` | `[PROPOSED]` Sent after last `agent_audio` frame of a turn or clip; client gates `playback_done` on `total_bytes` |
| *(Extension)* `turn_metrics` | — | `{ type: "turn_metrics", ... }` | `[PROPOSED]` Live client latency panel + `t0_seq` + `outcome` |

---

## 3. Session Reducer (`apps/server/src/session/reducer.ts`)

`[DECIDED]` Pure function `(state: SessionContext, event: ReducerEvent) => { state: SessionContext; effects: readonly Effect[] }`.
- Every `ReducerEvent` carries `at: number` (monotonic `performance.now()` ms supplied by `session/runtime.ts`).
- The reducer **never** reads `Date.now()`, `performance.now()`, or an injectable `Clock`.
- All timers are represented as pure effects (`schedule_timeout` / `cancel_timeout`) executed by `session/runtime.ts`.
- One `AbortController` per active turn (`create_turn_abort` / `abort_turn` effects).
- Outbound clip/turn audio effects end with `send_agent_audio_end { turn_id, total_bytes }` after the last `agent_audio` frame.

### 3.1 Core Types

```ts
export type SessionState = "IDLE" | "LISTENING" | "THINKING" | "SPEAKING" | "ENDED";

export type TimeoutKey =
  | "stt_final"
  | "llm_first_token"
  | "llm_budget"
  | "tool"
  | "tts_first_audio"
  | "tts_stall"
  | "goodbye_close"
  | "silence"
  | "max_call";

export interface SessionContext {
  readonly state: SessionState;
  readonly sessionId: string;
  readonly timezone: string;
  readonly activeTurnId: number;
  readonly nextTurnId: number;
  readonly pendingUserText: string;      // accumulated across THINKING continuation or SPEAKING overlap
  readonly lastInterimText: string;
  readonly lastMicAt: number | null;
  readonly micSeq: number;
  readonly speechInProgress: boolean;    // server VAD confirmed speech currently active
  readonly sttTurnOpen: boolean;
  readonly lastVadEndAt: number | null;  // monotonic at of last VAD_END (for reply-tail echo check)
  readonly goodbyeTurnId: number | null; // non-null while draining goodbye clip before ENDED
  readonly goodbyeEndReason: EndReason | null;
}

export type ReducerEvent =
  | { type: "SESSION_START"; at: number; timezone: string; protocolVersion: number }
  | { type: "PREWARM_FAILED"; at: number; stage: Stage; code: string; message: string }
  | { type: "MIC_FRAME"; at: number; byteLength: number }
  | { type: "VAD_SPEECH_CONFIRM"; at: number }
  | { type: "VAD_END"; at: number; t0Seq: number; vadEndMs: number }
  | { type: "STT_PARTIAL"; at: number; turnId: number; text: string }
  | { type: "STT_FINAL"; at: number; turnId: number; text: string }
  | { type: "LLM_FIRST_TOKEN"; at: number; turnId: number }
  | { type: "LLM_TOOL_CALL"; at: number; turnId: number; callId: string; name: string }
  | { type: "TOOL_RESULT"; at: number; turnId: number; callId: string; ok: boolean }
  | { type: "TTS_FIRST_FLUSH"; at: number; turnId: number }
  | { type: "LLM_DONE"; at: number; turnId: number; speakableChars: number; hasToolCall: boolean }
  | { type: "FIRST_AUDIO"; at: number; turnId: number }
  | { type: "TTS_AUDIO_CHUNK"; at: number; turnId: number }
  | { type: "PLAYBACK_DONE"; at: number; turnId: number; playedMs: number }
  | { type: "INTERRUPT"; at: number; turnId: number; playedMs: number; detectToStopMs: number }
  | { type: "TIMEOUT"; at: number; key: TimeoutKey; turnId?: number }
  | { type: "STAGE_ERROR"; at: number; turnId?: number; stage: Stage; code: string; message: string; recoverable: boolean; preFirstToken?: boolean }
  | { type: "STT_DROP"; at: number; code: string; message: string }
  | { type: "TTS_DROP"; at: number; code: string; message: string }
  | { type: "TTS_FLUSH_WARNING"; at: number }
  | { type: "END_CALL"; at: number }
  | { type: "WS_CLOSE"; at: number };
```

### 3.2 Key Behavioral Rules

- **`[PROPOSED]` Speech confirmed during `THINKING`:** User is still talking (`VAD_SPEECH_CONFIRM` while `THINKING`). The reducer aborts the current turn's LLM/TTS (`abort_turn`), cancels turn timeouts (`llm_first_token`, `llm_budget`, `tool`, `tts_first_audio`), retains `activeTurnId` and `pendingUserText` (the prior turn's final transcript), sets `state = "LISTENING"`, and awaits the new `VAD_END` → `STT_FINAL`, appending `pendingUserText + " " + newText`. On that `STT_FINAL`, the server re-emits `transcript_final` with the **same** `turn_id` (the client replaces its caption) and updates the existing DB user turn row instead of inserting a new row.
- **`[PROPOSED]` Client-authoritative barge-in during `SPEAKING`:** `@ricky0123/vad-web` has sole barge-in authority and sends `interrupt`. While `SPEAKING`, the server continues feeding incoming `640 B` mic frames into Silero VAD + STT so any interrupting speech and its `500 ms` pre-roll are captured (`speechInProgress = true`), **but** `VAD_SPEECH_CONFIRM` in `SPEAKING` never aborts playback or leaves `SPEAKING` until `INTERRUPT` arrives (preventing speaker-echo false barge-in).
- **`[PROPOSED]` Reply-tail overlap:** On `PLAYBACK_DONE` while `speechInProgress` is true, carry the active capture into `LISTENING` (keep `sttTurnOpen = true` and `pendingUserText`). A held `STT_FINAL` captured during `SPEAKING` with no `INTERRUPT` is discarded as echo only if its VAD speech end (`lastVadEndAt`) is `≤` playback end (`at` of `PLAYBACK_DONE`); otherwise it becomes the user's next turn (`→ THINKING`).
- **`[PROPOSED]` Ack clip (`"One moment"`):** Uses the current `turn_id` (`seq = 0..K-1`), plays during `THINKING` on tool start, and does **not** emit `FIRST_AUDIO` or change state. Server records `ack_bytes` and sends JSON `reply_audio_start { turn_id, seq }` immediately before the first real-reply `agent_audio` frame.
- **`[PROPOSED]` Pre-rendered clip playback (`fallback` / `goodbye`):** Every pre-rendered clip is sent with a positive `turn_id` (`1..N`; sentinel zero turn IDs are forbidden). Fallback and goodbye clips allocate a fresh `turn_id` from `nextTurnId` followed by `agent_audio_end { turn_id, total_bytes }`. Fallback enters `SPEAKING` until `PLAYBACK_DONE` (then `LISTENING`). Goodbye emits `call_ended`, plays in `SPEAKING`, and closes the WS + transitions to `ENDED` only after `PLAYBACK_DONE` for the goodbye turn or `goodbye_close` (`clip_ms + 1000 ms`), whichever comes first. `WS_CLOSE` and fatal protocol errors close immediately.
- **`[DECIDED]` Noise-only / empty `STT_FINAL`:** If `(pendingUserText + " " + text).trim() === ""`, stay in `LISTENING` with zero LLM call and reset `pendingUserText`.

### 3.3 Full Transition Table (`State × Event`)

Every cell below either transitions (`→ STATE` + effects) or is explicitly `ignored (reason)`.

| Event | `IDLE` | `LISTENING` | `THINKING` | `SPEAKING` | `ENDED` |
| --- | --- | --- | --- | --- | --- |
| `SESSION_START` (`v=1`) | `→ LISTENING`: warm providers (retry once on failure), emit `session_ready` + `state(LISTENING)`, schedule `silence(120s)` & `max_call(600s)` | `ignored (session already started)` | `ignored (session already started)` | `ignored (session already started)` | `ignored (session ended)` |
| `SESSION_START` (`v≠1`) | `→ ENDED`: emit `error(protocol_mismatch, fatal)`, persist error, `close_ws(1002)` immediately | `ignored (session already started)` | `ignored (session already started)` | `ignored (session already started)` | `ignored (session ended)` |
| `PREWARM_FAILED` | `→ ENDED`: log & emit `error(internal_error, fatal)`, play no audio, emit `call_ended(internal_error)`, `close_ws(1011)` immediately | `ignored (already warmed)` | `ignored (already warmed)` | `ignored (already warmed)` | `ignored (session ended)` |
| `MIC_FRAME` (`len≠640`) | `→ ENDED`: emit `error(bad_sequence, fatal)`, persist error, `close_ws(1002)` immediately | `→ ENDED`: abort turn, emit `error(bad_frame_size, fatal)`, persist error, `close_ws(1002)` immediately | `→ ENDED`: abort turn, emit `error(bad_frame_size, fatal)`, persist error, `close_ws(1002)` immediately | `→ ENDED`: abort turn, emit `error(bad_frame_size, fatal)`, persist error, `close_ws(1002)` immediately | `ignored (session ended)` |
| `MIC_FRAME` (`len=640`, gap `>500ms`) | `→ ENDED`: emit `error(bad_sequence, fatal)`, persist error, `close_ws(1002)` immediately | `LISTENING`: log `mic_stall` metric, increment `micSeq`, feed VAD | `THINKING`: increment `micSeq`, feed VAD (no `mic_stall` outside `LISTENING`) | `SPEAKING`: increment `micSeq`, feed VAD (pre-roll capture only) | `ignored (session ended)` |
| `MIC_FRAME` (`len=640`, normal) | `→ ENDED`: emit `error(bad_sequence, fatal)`, persist error, `close_ws(1002)` immediately | `LISTENING`: increment `micSeq`, feed VAD (+ STT if `sttTurnOpen`; buffer up to `500ms` during STT reconnect, else drop & log `stt_gap`), reset `silence(120s)` only if `speechInProgress` | `THINKING`: increment `micSeq`, feed VAD (+ STT if `sttTurnOpen`) | `SPEAKING`: increment `micSeq`, feed VAD (+ STT if `sttTurnOpen` for barge-in pre-roll) | `ignored (session ended)` |
| `VAD_SPEECH_CONFIRM` | `ignored (no active session)` | `LISTENING`: `speechInProgress=true`, `sttTurnOpen=true`, cancel `silence`, assign/keep turn, burst STT pre-roll `(start-100ms..confirm)` | **`→ LISTENING` `[PROPOSED]`**: `abort_turn`, cancel `llm_first_token`/`llm_budget`/`tool`/`tts_first_audio`, retain `activeTurnId` & `pendingUserText`, `speechInProgress=true`, `sttTurnOpen=true`, burst STT pre-roll, emit `state(LISTENING)` | **`SPEAKING` `[PROPOSED]`**: `speechInProgress=true`, `sttTurnOpen=true`, burst STT pre-roll (do **not** abort turn; wait for client `INTERRUPT`) | `ignored (session ended)` |
| `VAD_END` | `ignored (no active session)` | `LISTENING`: `speechInProgress=false`, record `lastVadEndAt=at`, call `stt.finalize(turnId)`, record `t0_seq`/`vad_end_ms`, schedule `stt_final(1000ms)` | `ignored (not in speech capture; speech confirm moves to LISTENING first)` | `SPEAKING`: `speechInProgress=false`, record `lastVadEndAt=at`, call `stt.finalize` if `sttTurnOpen` (captured speech/echo during playback) | `ignored (session ended)` |
| `STT_PARTIAL` | `ignored (no active session)` | `LISTENING`: update `lastInterimText`, emit `transcript_partial` | `ignored (STT finalized for turn)` | `SPEAKING`: buffer `lastInterimText` internally (emit `transcript_partial` only after `INTERRUPT` or overlap promotes turn) | `ignored (session ended)` |
| `STT_FINAL` (combined empty) | `ignored (no active session)` | `LISTENING`: cancel `stt_final`, clear `pendingUserText`/`lastInterimText`, `sttTurnOpen=false`, schedule `silence(120s)` (no LLM call) | `ignored (stale STT_FINAL)` | `SPEAKING`: clear `sttTurnOpen`, drop empty echo/noise | `ignored (session ended)` |
| `STT_FINAL` (combined non-empty) | `ignored (no active session)` | `→ THINKING`: cancel `stt_final`, `sttTurnOpen=false`, merge `pendingUserText + text`, keep `activeTurnId` if THINKING continuation else `nextTurnId++`, emit `transcript_final(turn_id)`, insert or update DB user turn row, `create_turn_abort`, start LLM, schedule `llm_first_token(2000ms)` & `llm_budget(3500ms)`, emit `state(THINKING)` | `ignored (already THINKING; speech confirm moves to LISTENING first)` | `SPEAKING`: hold as `pendingUserText` until `INTERRUPT` or `PLAYBACK_DONE` (reply-tail overlap rule) | `ignored (session ended)` |
| `LLM_FIRST_TOKEN` | `ignored (no active turn)` | `ignored (no active turn)` | `THINKING`: cancel `llm_first_token` & `llm_budget`, stream content tokens into sentence chunker | `ignored (already past first token)` | `ignored (session ended)` |
| `LLM_TOOL_CALL` | `ignored (no active turn)` | `ignored (no active turn)` | `THINKING`: cancel `llm_first_token` & `llm_budget`, emit `tool_status(started)`, send `"One moment"` ack clip (`current turn_id`, record `ack_bytes`, no `FIRST_AUDIO` or state change), schedule `tool(3000ms)` | `ignored (not in THINKING)` | `ignored (session ended)` |
| `TOOL_RESULT` | `ignored (no active turn)` | `ignored (no active turn)` | `THINKING`: cancel `tool`, emit `tool_status(succeeded/failed)`, enqueue `tool_calls` row, start follow-up LLM request, schedule `llm_first_token(2000ms)` | `ignored (not in THINKING)` | `ignored (session ended)` |
| `TTS_FIRST_FLUSH` | `ignored (no active turn)` | `ignored (no active turn)` | `THINKING`: schedule `tts_first_audio(1500ms)` | `ignored (already receiving TTS audio)` | `ignored (session ended)` |
| `LLM_DONE` (`speakableChars > 0`) | `ignored (no active turn)` | `ignored (no active turn)` | `THINKING`: flush chunker tail to TTS (`end()`), schedule `tts_first_audio(1500ms)` if not yet flushed | `SPEAKING`: flush chunker tail to TTS (`end()`), emit `agent_audio_end { turn_id, total_bytes }` when TTS finishes | `ignored (session ended)` |
| `LLM_DONE` (`speakableChars = 0`, no tool call) | `ignored (no active turn)` | `ignored (no active turn)` | `→ SPEAKING`: `abort_turn`, cancel `llm_first_token`/`llm_budget`/`tts_first_audio`, log `llm_empty`, `turn_id=nextTurnId++`, play fallback clip + `agent_audio_end`, flush turn metrics (`outcome="fallback"`), emit `state(SPEAKING)` | `ignored (already speaking)` | `ignored (session ended)` |
| `FIRST_AUDIO` | `ignored (no active session)` | `ignored (stale turn audio)` | `→ SPEAKING`: cancel `tts_first_audio`, emit `reply_audio_start { turn_id, seq }` before first real-reply frame, schedule `tts_stall(2000ms)`, emit `state(SPEAKING)` | `ignored (already SPEAKING)` | `ignored (session ended)` |
| `TTS_AUDIO_CHUNK` | `ignored (no active session)` | `ignored (stale turn audio)` | `ignored (FIRST_AUDIO transitions first)` | `SPEAKING`: reset `tts_stall(2000ms)` | `ignored (session ended)` |
| `PLAYBACK_DONE` | `ignored (no active session)` | `ignored (duplicate or post-barge-in)` | `ignored (not playing)` | If `goodbyeTurnId === turnId`: `→ ENDED` (cancel `goodbye_close`, persist end, close providers & `close_ws(1000)`). Else: cancel `tts_stall`, commit agent turn + `turn_metrics`, flush DB turn, emit `turn_metrics`; if `speechInProgress`: `→ LISTENING` (keep `sttTurnOpen` & `pendingUserText`, emit `state(LISTENING)`); else if `pendingUserText` non-empty & `lastVadEndAt > at`: start next turn `→ THINKING` (`nextTurnId++`, emit `transcript_final`, start LLM, schedule `llm_first_token(2000ms)` & `llm_budget(3500ms)`); else discard echo `pendingUserText`, schedule `silence(120s)`, `→ LISTENING`, emit `state(LISTENING)` | `ignored (session ended)` |
| `INTERRUPT` | `ignored (no active session)` | `ignored (already LISTENING)` | `→ LISTENING`: `abort_turn`, cancel turn timers, emit `state(LISTENING)`, schedule `silence(120s)` | **`→ LISTENING` `[DECIDED]`**: if `goodbyeTurnId !== null`, ignore; else `abort_turn` (TTS `Clear`), cancel `tts_stall`, compute `reply_played_ms = max(0, played_ms - ack_ms)` & heard prefix, commit agent turn (`interrupted=true`, `outcome="interrupted"`), flush DB turn, emit `turn_metrics`, if `pendingUserText` captured start `→ THINKING` else `→ LISTENING` (`state(LISTENING)` + `silence(120s)`) | `ignored (session ended)` |
| `TIMEOUT(stt_final)` | `ignored` | `LISTENING` / `→ THINKING` / `→ SPEAKING`: `[PROPOSED]` if `lastInterimText` non-empty, promote as `STT_FINAL` → `THINKING`; else `turn_id=nextTurnId++`, play fallback clip + `agent_audio_end`, log `stt_timeout`, flush turn metrics (`outcome="fallback"`), `→ SPEAKING` | `ignored (stale timer)` | `ignored (stale timer)` | `ignored` |
| `TIMEOUT(llm_first_token)` | `ignored` | `ignored (stale timer)` | `THINKING` / `→ SPEAKING`: `[PROPOSED]` fail over `120b → 20b → gemini` (reschedule `2000ms` within `3500ms` `llm_budget`); if chain exhausted, `abort_turn`, `turn_id=nextTurnId++`, play fallback clip + `agent_audio_end`, log `llm_timeout`, flush turn metrics (`outcome="fallback"`), `→ SPEAKING` | `ignored (stale timer)` | `ignored` |
| `TIMEOUT(llm_budget)` | `ignored` | `ignored (stale timer)` | `→ SPEAKING`: `abort_turn`, cancel `llm_first_token`/`tool`, `turn_id=nextTurnId++`, play fallback clip + `agent_audio_end`, log `llm_timeout`, flush turn metrics (`outcome="fallback"`), emit `state(SPEAKING)` | `ignored (stale timer)` | `ignored` |
| `TIMEOUT(tool)` | `ignored` | `ignored` | `THINKING`: emit `tool_status(failed)`, return `{ error: "tool_timeout" }` to LLM for graceful reply, log `tool_timeout`, schedule `llm_first_token(2000ms)` for follow-up | `ignored` | `ignored` |
| `TIMEOUT(tts_first_audio)` | `ignored` | `ignored` | `→ SPEAKING`: `abort_turn`, `turn_id=nextTurnId++`, play pre-rendered fallback clip + `agent_audio_end`, log `tts_timeout`, flush turn metrics (`outcome="fallback"`), emit `state(SPEAKING)` | `ignored` | `ignored` |
| `TIMEOUT(tts_stall)` | `ignored` | `ignored` | `ignored` | `→ SPEAKING`: `abort_turn`, `turn_id=nextTurnId++`, play pre-rendered fallback clip + `agent_audio_end`, log `tts_stall`, flush turn metrics (`outcome="fallback"`), emit `state(SPEAKING)` | `ignored` |
| `TIMEOUT(goodbye_close)` | `ignored` | `ignored` | `ignored` | `→ ENDED` (if `goodbyeTurnId !== null`): persist session end, close providers & `close_ws(1000)` | `ignored` |
| `TIMEOUT(silence)` | `ignored` | `→ SPEAKING`: `goodbyeTurnId=nextTurnId++`, emit `call_ended(silence_timeout)`, stream goodbye clip + `agent_audio_end`, schedule `goodbye_close(clip_ms + 1000ms)` | `ignored (timer cancelled on THINKING)` | `ignored (timer cancelled on SPEAKING)` | `ignored` |
| `TIMEOUT(max_call)` | `ignored` | `→ SPEAKING`: abort active work, `goodbyeTurnId=nextTurnId++`, emit `call_ended(max_duration)`, stream goodbye clip + `agent_audio_end`, schedule `goodbye_close(clip_ms + 1000ms)` | `→ SPEAKING`: `abort_turn`, `goodbyeTurnId=nextTurnId++`, emit `call_ended(max_duration)`, stream goodbye clip + `agent_audio_end`, schedule `goodbye_close(clip_ms + 1000ms)` | `→ SPEAKING`: `abort_turn`, `goodbyeTurnId=nextTurnId++`, emit `call_ended(max_duration)`, stream goodbye clip + `agent_audio_end`, schedule `goodbye_close(clip_ms + 1000ms)` | `ignored` |
| `STAGE_ERROR` (`recoverable`) | `IDLE`: log only, no state change | `LISTENING` / `→ SPEAKING`: abort active STT turn, log & emit `error`, `turn_id=nextTurnId++`, play fallback clip + `agent_audio_end`, flush turn metrics (`outcome="failed"`), `→ SPEAKING` | `THINKING` / `→ SPEAKING`: if pre-first-token LLM error/`429` within `llm_budget`, fail over; if `tool_use_failed`, retry once on same model; else `abort_turn`, log & emit `error`, `turn_id=nextTurnId++`, play fallback clip + `agent_audio_end`, flush turn metrics (`outcome="failed"`), `→ SPEAKING` | `SPEAKING`: `abort_turn`, log & emit `error`, `turn_id=nextTurnId++`, play fallback clip + `agent_audio_end`, flush turn metrics (`outcome="failed"`) | `ignored` |
| `STT_DROP` | `ignored` | `LISTENING` / `→ SPEAKING`: log `stt_drop`, emit `error(recoverable=true)`, reconnect STT WS in background (buffer mic frames up to `500ms` in pre-roll ring; if turn active, fallback clip + `agent_audio_end` → `SPEAKING`) | `THINKING`: log `stt_drop`, reconnect STT WS in background (LLM continues) | `SPEAKING`: log `stt_drop`, reconnect STT WS in background (buffer mic frames up to `500ms`) | `ignored` |
| `TTS_DROP` | `ignored` | `LISTENING`: log `tts_drop`, reconnect TTS WS in background | `→ SPEAKING`: `abort_turn`, `turn_id=nextTurnId++`, play fallback clip + `agent_audio_end`, log `tts_drop`, flush turn metrics (`outcome="failed"`), reconnect TTS WS, `state(SPEAKING)` | `→ SPEAKING`: `abort_turn`, `turn_id=nextTurnId++`, play fallback clip + `agent_audio_end`, log `tts_drop`, flush turn metrics (`outcome="failed"`), reconnect TTS WS, `state(SPEAKING)` | `ignored` |
| `TTS_FLUSH_WARNING` | `ignored` | `LISTENING`: log `tts_flush_limited`, no state change | `THINKING`: log `tts_flush_limited`, no state change | `SPEAKING`: log `tts_flush_limited`, no state change | `ignored` |
| `END_CALL` | `→ ENDED`: emit `call_ended(user_end_call)`, persist, close immediately | `→ ENDED`: emit `call_ended(user_end_call)`, persist, close immediately | `→ ENDED`: `abort_turn`, emit `call_ended(user_end_call)`, persist, close immediately | `→ ENDED`: `abort_turn`, emit `call_ended(user_end_call)`, persist, close immediately | `ignored` |
| `WS_CLOSE` | `→ ENDED`: persist `ws_drop`, close immediately | `→ ENDED`: persist `ws_drop`, close immediately | `→ ENDED`: `abort_turn`, persist `ws_drop`, close immediately | `→ ENDED`: `abort_turn`, persist `ws_drop`, close immediately | `ignored` |

---

## 4. Adapter Interfaces (`apps/server/src/adapters/types.ts`)

`[DECIDED]` Vendor SDKs, endpoints, and API keys live **only** under `apps/server/src/adapters/<kind>/<vendor>.ts`. `pipeline/`, `session/`, and `vad/` import only `adapters/types.ts`.

### 4.1 Typed Errors & Capabilities

```ts
export type AdapterStage = "vad" | "stt" | "llm" | "tts" | "tool";

export class AdapterError extends Error {
  readonly stage: AdapterStage;
  readonly code: string;
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(params: {
    stage: AdapterStage;
    code: string;
    message: string;
    retryable: boolean;
    statusCode?: number;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.stage = params.stage;
    this.code = params.code;
    this.retryable = params.retryable;
    this.statusCode = params.statusCode;
  }
}
```

### 4.2 Core Interfaces (Call-Scoped Sessions Containing Turns)

```ts
import type { z } from "zod";

// --- VAD ---
export interface VadSession {
  probability(window512: Float32Array): Promise<number>; // [-1, 1], 16 kHz
  reset(): void;
  close(): Promise<void>;
}

export interface VadAdapter {
  readonly name: string;
  open(): Promise<VadSession>;
}

// --- STT ---
export type SttEvent =
  | { type: "partial"; turnId: number; text: string }
  | { type: "final"; turnId: number; text: string }
  | { type: "error"; error: AdapterError };

export interface SttCapabilities {
  readonly streaming: boolean;
  readonly partials: boolean;
}

export interface SttSessionConfig {
  readonly sampleRate: 16000;
  readonly channels: 1;
  readonly encoding: "linear16";
}

export interface SttSession {
  push(pcm16Frame640B: Uint8Array): void;
  finalize(turnId: number): Promise<void>;
  readonly events: AsyncIterable<SttEvent>;
  keepAlive?(): void;
  close(): Promise<void>;
}

export interface SttAdapter {
  readonly name: string;
  readonly capabilities: SttCapabilities;
  open(cfg: SttSessionConfig): Promise<SttSession>;
}

// --- LLM ---
export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: readonly { id: string; name: string; argumentsJson: string }[];
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parametersJsonSchema: Record<string, unknown>;
}

export type LlmStreamEvent =
  | { type: "token"; text: string } // speakable content delta only (reasoning filtered)
  | { type: "tool_call"; id: string; name: string; argumentsJson: string }
  | {
      type: "done";
      finishReason: "stop" | "tool_calls" | "length" | "abort";
      usage?: { promptTokens: number; completionTokens: number; queueTimeMs?: number };
    };

export interface LlmAdapter {
  readonly name: string;
  readonly model: string;
  stream(
    messages: readonly LlmMessage[],
    tools: readonly ToolDefinition[],
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamEvent>;
}

// --- TTS (call-scoped session -> turn-scoped synthesis) ---
export interface TtsCapabilities {
  readonly streamingInput: boolean;
  readonly supportsClear: boolean;
}

export interface TtsSessionConfig {
  readonly sampleRate: 24000;
  readonly channels: 1;
  readonly encoding: "linear16";
}

export interface TtsAudioChunk {
  readonly type: "audio" | "flushed";
  readonly pcm24k?: Uint8Array;
  readonly flushedChars?: number; // present on "flushed" to mark Flush boundary
}

export interface TtsTurn {
  push(text: string): void;
  end(): void;
  readonly audio: AsyncIterable<TtsAudioChunk>;
}

export interface TtsSession {
  startTurn(turnId: number, signal: AbortSignal): TtsTurn; // signal abort sends Clear on WS
  ping?(): void;
  close(): Promise<void>;
}

export interface TtsAdapter {
  readonly name: string;
  readonly capabilities: TtsCapabilities;
  open(cfg: TtsSessionConfig): Promise<TtsSession>;
}

// --- Tool ---
export interface ToolContext {
  readonly sessionId: string;
  readonly timezone: string;
  readonly signal: AbortSignal;
}

export interface Tool<TArgs> {
  readonly name: string;
  readonly description: string;
  readonly argsSchema: z.ZodType<TArgs>;
  run(args: TArgs, ctx: ToolContext): Promise<unknown>;
}
```

### 4.3 Fake Adapters for Keyless CI (`[DECIDED]`)

- **No `FakeVad`:** Silero VAD v6.3 (`onnxruntime-node`, SHA-256 pinned `f6f4407b...`) requires zero API keys and runs directly in CI integration tests (`pnpm test:int`). Pure segmenter unit tests feed synthetic probability arrays into `vad/segmenter.ts`.
- **`FakeStt`:** `capabilities = { streaming: true, partials: true }`; reads expected transcript sidecars or scripted chunks, emits timed `partial` events, and emits `final` on `finalize(turnId)`.
- **`FakeLlm`:** Scripted `AsyncIterable<LlmStreamEvent>` supporting multi-token streaming, scripted `tool_call` turns, simulated `tool_use_failed` / `429` errors, and instant `AbortSignal` cancellation.
- **`FakeTts`:** `capabilities = { streamingInput: true, supportsClear: true }`; returns deterministic `24 kHz` PCM16LE silence/tone chunks with `flushed` markers, handles `AbortSignal` (`Clear`), and supports simulated `tts_stall` / `Warning` injection.

### 4.4 Provider Swap Proof (`[DECIDED]`)

1. **Batch STT swap (`GroqWhisperSttAdapter`):**
   - `capabilities = { streaming: false, partials: false }`.
   - `open(cfg)` initializes a session state holding an `undici` HTTP/2 `Agent` (no persistent WS).
   - `push(frame640B)` appends frames to an in-memory PCM buffer for the active turn; emits no `partial` events (UI gracefully skips live partials when `!stt.capabilities.partials`).
   - `finalize(turnId)` wraps the buffered PCM in a 44-byte WAV header, `POST`s multipart audio to `/openai/v1/audio/transcriptions`, and pushes `{ type: "final", turnId, text }` onto `events`.
   - `close()` destroys the `Agent`. **Zero pipeline changes** in `session/` or `pipeline/`.
2. **REST TTS swap (`DeepgramRestTtsAdapter`):**
   - `capabilities = { streamingInput: false, supportsClear: false }`.
   - `open(cfg)` creates a warm `undici` `Agent` pool.
   - `startTurn(turnId, signal)` returns a `TtsTurn` that issues **one `POST` per sentence** (`/v1/speak?container=none&encoding=linear16&sample_rate=24000`, passing `signal` to `fetch`), issued in order, streaming audio chunks through as each response body arrives.
   - The next sentence's `POST` starts as soon as the previous sentence's TTFB (response headers / first byte) arrives, pipelining sentence latency without racing playback order.
   - On barge-in `signal.abort()`, any in-flight `POST` / response body stream is cancelled immediately (`session` remains usable for the next turn). **Zero pipeline changes** in `pipeline/` or `session/`.

---

## 5. Latency Definitions

### 5.1 Boundaries (`t0` & `t1`)

- **`t0` Quantization (`[PROPOSED]`):** Silero runs on `32 ms` (`512`-sample) windows while the client sends `20 ms` (`320`-sample) frames (`seq`). The last voiced `32 ms` Silero window (end sample `endSample`) maps to the mic frame containing its end: `t0_seq = Math.floor((endSample - 1) / 320)`. Quantization error between true speech-end sample and `t0_seq` is **≤ 32 ms**. `turn_metrics` reports `t0_seq`.
- **`t0` on Server Clock (`[DECIDED]`):** `t0_server = serverRecvMs.get(t0_seq)` (recorded with `performance.now()` when frame `t0_seq` arrives on the WS).
- **`t0` on Client Clock (`[PROPOSED]`):** Client maintains a ring/map `sentAtMs.set(seq, performance.now())` when sending each `640 B` mic frame; `t0_client = sentAtMs.get(t0_seq)`.
- **`t1` on Server Clock (`[DECIDED]`):** `t1_server = performance.now()` immediately before `ws.send()` of the **first real-reply** `agent_audio` binary frame (identified by `reply_audio_start { turn_id, seq }`, after any `"One moment"` ack clip) for that `turn_id`.
- **`t1` on Client Clock (`[PROPOSED]`):** `t1_client = performance.now() + audioCtxLatencyMs` when the first real-reply `agent_audio` sample (the frame matching `reply_audio_start.seq`) is scheduled onto the AudioWorklet playback ring buffer (`total_client_ms = t1_client - t0_client`). `audioCtxLatencyMs` adds `AudioContext.outputLatency` (or `AudioContext.baseLatency` if `outputLatency` is unavailable), and `turn_metrics.client_latency_source` records which property was used (`"outputLatency" | "baseLatency" | "none"`).
- **Same-clock subtraction (`[DECIDED]`):** Server subtracts `t1_server - t0_server`; client subtracts `t1_client - t0_client`. No client/server clock synchronization is required.

### 5.2 Per-Turn Stage Metrics (`turn_metrics`)

| Field | Formula (Named Boundaries) | Phase 0 India Baseline |
| --- | --- | --- |
| `vad_end_ms` | `t_vad_end - t0_server` (nullable on failed/aborted turns) | `576 ms` (`18 × 32 ms` windows) |
| `stt_final_ms` | `t_stt_final - t_vad_end` (nullable) | `80 ms` med / `119 ms` p90 (`api.in.deepgram.com`) |
| `llm_first_token_ms` | `t_llm_first_content_or_tool - t_stt_final` (nullable) | `447 ms` med (`gpt-oss-120b` H2; `req1` to first content or tool delta) |
| `first_sentence_ms` | `t_first_sentence_to_tts - t_llm_first_content` (nullable) | `18–48 ms` (`gpt-oss`), `~75 ms` (`qwen`) |
| `tool_ms` | `t_followup_llm_ready - t_tool_call_complete` (includes local `t_exec` + round-2 LLM TTFT; `null` on non-tool turns) | `~450 ms` (`gpt-oss`, `< 1 ms` local exec + ~406–454 ms follow-up) |
| `ack_audio_ms` | `[PROPOSED]` `t_ack_clip_sent - t0_server` when `"One moment"` pre-rendered clip plays on tool start (`null` if no tool) | `~t_tool_call + <1 ms` (local RAM clip) |
| `tts_first_audio_ms` | `t1_server - t_first_flush_sent` (first **real reply** `agent_audio` per `reply_audio_start`, excluding `"One moment"` ack clip; nullable) | `107.0 ms` med / `111.1 ms` p90 (`api.in.deepgram.com` warm WS) |
| `total_ms` | `t1_server - t0_server` (excluding `"One moment"` ack clip; nullable) | `≈ 1,258 ms` med (`gpt-oss-120b`); `≈ 1,600 ms` tool turns |
| `total_client_ms` | `t1_client - t0_client` (client same-clock subtraction via `t0_seq` + `outputLatency`/`baseLatency`; nullable) | Measured on client in Phase 1/2 |

### 5.3 Barge-In Metric (`onset_to_stop_ms`) (`[PROPOSED]`)

- **`onset_to_stop_ms`:** Time from the user's speech onset to the agent audio stopping.
- **Measurement harness:** Measured in a Chrome fake-mic integration test reusing the Phase 0 `spikes/browser-capture` harness: a recorded agent reply plays while a speech fixture with a labelled speech onset is injected.
- **Diagnostic vs acceptance:** `detect_to_stop_ms` (reported in `interrupt`) is kept as a diagnostic metric only. **Acceptance:** median `onset_to_stop_ms ≤ 300 ms` over `n ≥ 10` runs.

---

## 6. Error Matrix & Timeouts

### 6.1 Timeouts (`[PROPOSED]`, ~10× Measured p90)

| Timeout Key | Value | Basis / Replacement |
| --- | --- | --- |
| `stt_final` | `1000 ms` after `Finalize` | ~8.4× measured p90 (`119 ms` on `api.in`); **replaces** the `300 ms` settle timer in `ARCHITECTURE.md` §6 |
| `llm_first_token` | `2000 ms` | ~4× measured p90 (`~507 ms` on `gpt-oss-120b` H2; ~2.5× Gemini `~887 ms`) |
| `llm_budget` | `3500 ms` from `THINKING` entry | Total pre-first-token failover chain budget across `120b → 20b → gemini`; when exceeded, play fallback clip |
| `tool` | `3000 ms` | Bounded external/mock tool budget |
| `tts_first_audio` | `1500 ms` after first `Flush` | >10× measured p90 (`111.1 ms` on `api.in`) |
| `tts_stall` | `2000 ms` mid-utterance with no audio chunk | Catches `13–23 s` / `30 s` stalls seen on US host |
| `goodbye_close` | `clip_ms + 1000 ms` | Drains goodbye clip if client `playback_done` does not arrive before closing WS |
| `silence` | `120_000 ms` (`120 s`) | Spec §3 / §6 (`2 min` silence) |
| `max_call` | `600_000 ms` (`600 s`, env-configurable) | Default 10-minute session cap |

### 6.2 Failure Matrix

| Failure | Detection (Timeout / Signal) | Behavior | Error Code Logged | Test |
| --- | --- | --- | --- | --- |
| **1. Mic permission denied** *(Spec §6)* | Browser `getUserMedia` rejects (`NotAllowedError` / `NotFoundError`) before `POST /sessions` | Show clear permission banner in UI; create **no** server session | *(client-side UI state; 0 server rows)* | Client component test with mocked `navigator.mediaDevices` |
| **2. STT error / `1000 ms` Finalize timeout** *(Spec §6)* | Deepgram `Error` frame OR `TIMEOUT(stt_final)` `1000 ms` after `Finalize` | On `1000 ms` timeout: if `lastInterimText` non-empty, promote it as `transcript_final` and proceed; else play pre-rendered fallback clip (`"Sorry, I didn't catch that, could you repeat?"`), log error, return to `LISTENING` | `stt_timeout` / `stt_error` | Unit test: reducer `TIMEOUT(stt_final)` with & without interim; mock STT error test |
| **3. WebSocket drop** *(Spec §6)* | Server `ws` `close` / missed heartbeat; client `ws.onclose` | Client shows `"Disconnected"`; server emits `WS_CLOSE`, aborts active turn, sets `end_reason = "ws_drop"`, persists transcript/metrics | `ws_drop` | Integration test: drop WS mid-turn, assert DB `ended_at` + partial history saved |
| **4. Empty / noise-only utterance** *(Spec §6)* | Silero `< 250 ms` min speech OR `STT_FINAL` trims to `""` | Drop silently; return to `LISTENING`; zero LLM calls | *(none — normal drop)* | Reducer unit test + VAD `noise-only` test asserting `0` LLM invocations |
| **5. Tool call fails / `3000 ms` timeout** *(Spec §6)* | `Tool.run()` throws / rejects OR `TIMEOUT(tool)` `3000 ms` | Emit `tool_status(failed)`; return `{ error: message }` as `role: "tool"` message to LLM so it apologizes gracefully | `tool_failed` / `tool_timeout` | Tool-executor unit test (`3 s` fake timer + thrown error) |
| **6. Max duration (`600 s`) / silence (`120 s`)** *(Spec §6)* | `TIMEOUT(silence)` `120_000 ms` OR `TIMEOUT(max_call)` `600_000 ms` | Abort active turn if any, stream pre-rendered goodbye clip (fresh `nextTurnId`) + `agent_audio_end`, emit `call_ended`, close WS after `playback_done` or `clip_ms + 1000 ms` (`TIMEOUT(goodbye_close)`), persist DB, enter `ENDED` | *(none — normal `end_reason`)* | Reducer unit test with synthetic `at` timestamps & `schedule_timeout` assertions |
| **7. `tool_use_failed`** | Groq SSE `event: error` (`400`, `code: "tool_use_failed"`) | Retry **once** on the **same** LLM model (`[DECIDED]`/`[PROPOSED]`); if retry fails, play fallback clip, log error, return to `LISTENING` after `playback_done` | `llm_tool_use_failed` | Mock Groq SSE `tool_use_failed` unit test verifying 1 retry then fallback |
| **8. Pre-first-token LLM error / `2000 ms` timeout / `3500 ms` budget / daily `429`** | `TIMEOUT(llm_first_token)` `2000 ms`, `TIMEOUT(llm_budget)` `3500 ms`, HTTP `429` (daily TPD/RPD or RPM), or `5xx` before first content/tool delta | **No same-model retry.** Fail over immediately: `openai/gpt-oss-120b → openai/gpt-oss-20b → models/gemini-3.5-flash-lite` within total `3500 ms` pre-first-token budget from `THINKING` entry. If chain exhausted or `3500 ms` exceeded, play fallback clip | `llm_rate_limit` / `llm_timeout` / `llm_error` | Mock `fetch` returning `429` + `2000 ms` / `3500 ms` timeout tests verifying failover order and budget cutoff |
| **9. Post-first-token LLM error** | Stream error / premature EOF after content tokens already sent to TTS | Abort turn (`Clear` TTS), play fallback clip, log error, return to `LISTENING` after `playback_done` (no failover mid-sentence) | `llm_stream_aborted` | Mock LLM stream failing mid-sentence; verify `Clear` + fallback clip |
| **10. STT socket drop mid-turn** | Deepgram WS unexpected `close` / `error` | Log error (`recoverable: true`), reconnect STT WS in background; buffer mic frames up to `500 ms` in pre-roll ring (beyond that, drop & log `stt_gap`); if speech turn active, play fallback clip | `stt_drop` / `stt_gap` | Mock WS closing mid-stream; assert reconnect, `500 ms` buffering, `stt_gap`, + fallback clip |
| **11. TTS socket drop** | Deepgram `/v1/speak` WS unexpected `close` (e.g., `1008`) | Abort turn, play pre-rendered fallback clip (zero TTS dependency), log error, reconnect TTS WS in background, return to `LISTENING` after `playback_done` | `tts_drop` | Mock TTS WS closing mid-turn; assert fallback clip played + socket reopened |
| **12. `tts_stall` / `1500 ms` TTS first audio** | `TIMEOUT(tts_first_audio)` `1500 ms` OR `TIMEOUT(tts_stall)` `2000 ms` with no chunk mid-utterance | Abort stalled turn (`Clear`/close-reopen if desynced), play pre-rendered fallback clip, log error, return to `LISTENING` after `playback_done` | `tts_timeout` / `tts_stall` | Mock TTS server delaying `> 2000 ms` mid-stream; assert fallback clip + `tts_stall` |
| **13. TTS `Flush`-limit `Warning`** | Deepgram `/v1/speak` JSON `Warning` mentioning `Flush` rate limit | `[PROPOSED]` Handled inside the Deepgram TTS adapter (disables early sentence-1 `Flush` for `60 s` inside the adapter and emits a log-only event); reducer logs `tts_flush_limited` with no state change | `tts_flush_limited` | Mock TTS WS emitting `Warning` JSON; adapter test verifies single end-of-turn `Flush` for `60 s` + reducer logs only |
| **14. Mic frame gap** | `MIC_FRAME` arrival gap `> 500 ms` while `LISTENING` | `[PROPOSED]` Log `mic_stall` metric/event only; no state change, no fallback clip | `mic_stall` | Reducer/runtime unit test with `at` gap `> 500 ms` |
| **15. Bad frame size / `bad_sequence` / protocol mismatch** | Client binary frame before `session_start` (`bad_sequence`), binary frame `!== 640 B`, OR `session_start.protocol_version !== 1` | Emit `error(recoverable: false)`, persist error, close WS immediately (`1002`) | `bad_sequence` / `bad_frame_size` / `protocol_mismatch` | Protocol/WS integration test sending audio before `session_start`, `639 B` frame, and `protocol_version: 2` |
| **16. Provider pre-warm failure at `session_start`** | STT / TTS / VAD / LLM pre-warm throws or times out during `session_start` | `[PROPOSED]` Retry pre-warm **once**; if it still fails, emit `error`, play **no** audio, send `call_ended(internal_error)`, close WS. UI displays `"Couldn't connect"` | `internal_error` | Integration test failing pre-warm twice; assert retry, `0` audio frames, `call_ended(internal_error)`, UI `"Couldn't connect"` |
| **17. Empty LLM completion (`llm_empty`)** | `LLM_DONE` with `speakableChars = 0` and no tool call | `[PROPOSED]` Abort turn, log `llm_empty`, play fallback clip (fresh `nextTurnId`), return to `LISTENING` after `playback_done` | `llm_empty` | Reducer + mock LLM unit test returning empty stream with `finish_reason="stop"` |
| **18. Mic frames during STT reconnect** | `MIC_FRAME` arrives while STT WS is reconnecting | `[PROPOSED]` Buffer up to `500 ms` in the pre-roll ring; beyond `500 ms`, drop frames and log `stt_gap` | `stt_gap` | Unit test feeding `> 500 ms` of mic frames during simulated STT reconnect; assert `500 ms` buffered + `stt_gap` logged |

---

## 7. Barge-In History & Spoken-Form Normalization

1. **Spoken-form normalizer (`[DECIDED]`):**
   - Captions (`agent_text`) and DB `turns.text` preserve the natural display text (e.g., `"Your order 1042 has shipped."`).
   - Before sending text to `TtsSession`, a deterministic spoken-form normalizer rewrites known IDs (tool-returned IDs such as `order_id` and `'order' / '#' + digits`) into space-separated digits: `"1042"` → `"1 0 4 2"`, chosen by listening test in `e277aca` over `"one zero four two"` and `"ten forty-two"`.
   - Maintain a per-sentence reversible span map `captionSegment <-> spokenSegment` so any heard spoken prefix maps back cleanly to display caption text.

2. **Heard-text truncation on barge-in (`[PROPOSED]`):**
   - Client sends `interrupt { turn_id, played_ms, detect_to_stop_ms }` where `played_ms` is the exact sample-counted audio duration rendered by the playback AudioWorklet (`playedSamples / 24`) for that `turn_id` (including any `"One moment"` ack clip).
   - **Ack-duration subtraction:** When an `"One moment"` ack clip (`ack_bytes`) played on that `turn_id`, subtract its duration (`ack_ms = ack_bytes / 48`) to obtain `reply_played_ms = Math.max(0, played_ms - ack_ms)`. All heard-prefix boundaries below are evaluated against `reply_played_ms`.
   - **Sentence 1:** Because Sentence 1 receives its own immediate `Flush` (§9), Deepgram emits an exact `Flushed` boundary, giving Sentence 1's exact audio duration `dur_1_ms = bytes_1 / 48` (`24 kHz × 2 B = 48 B/ms`).
   - **Sentences 2..N (batched under final `Flush`):** Deepgram does not emit per-`Speak` byte counts when sentences `2..N` share one final `Flush`. Attribute the batched segment's audio duration `dur_tail_ms = bytes_tail / 48` across sentences `2..N` **proportionally by spoken-text character count** (note: attribution error is bounded by the length of that batched segment).
   - **Heard prefix rule:**
     - Any sentence `i` with `estimatedEndMs[i] <= reply_played_ms` is kept in full.
     - For the partially played sentence `k` (`estimatedStartMs[k] < reply_played_ms < estimatedEndMs[k]`), keep the leading word prefix of its spoken text matching `(reply_played_ms - estimatedStartMs[k]) / dur_k_ms`, map back through the span map to caption text, and append `...`.
     - Sentences `> k` are discarded.
   - **Persistence:** Store `turns.text = heardCaptionText`, `turns.spoken_text = heardSpokenText`, `turns.played_ms = reply_played_ms`, and `turns.interrupted = true`. Only `heardCaptionText` enters future LLM conversation history.

3. **LLM conversation history budget (`[PROPOSED]`):**
   - Cap conversation history by estimated prompt tokens: keep **`≤ 1,500` history tokens**, dropping the oldest turn pairs first; the system prompt and tool definitions are **always** kept.

---

## 8. Persistence (SQLite + Drizzle) & `GET /sessions/:id`

### 8.1 Drizzle Schema (`apps/server/src/db/schema.ts`)

Covers all fields in `Technical Assignment.pdf` §3 (*"Data saved per session"*) plus Phase 0 latency/barge-in fields:

```ts
// Drizzle/SQLite tables (sketch)
// sessions:
//   id TEXT PK, started_at INTEGER NOT NULL, ended_at INTEGER,
//   end_reason TEXT, timezone TEXT NOT NULL,
//   config_json TEXT NOT NULL (providers, prompt_version, tool_schema_version, vad/timeouts)
//
// turns:
//   id INTEGER PK AUTOINCREMENT,
//   session_id TEXT NOT NULL FK -> sessions.id,
//   turn_id INTEGER NOT NULL,
//   role TEXT NOT NULL ("user" | "agent"),
//   text TEXT NOT NULL,
//   spoken_text TEXT,
//   played_ms REAL,
//   interrupted INTEGER NOT NULL DEFAULT 0 (boolean),
//   created_at INTEGER NOT NULL
//
// tool_calls:
//   id INTEGER PK AUTOINCREMENT,
//   session_id TEXT NOT NULL FK -> sessions.id,
//   turn_id INTEGER NOT NULL,
//   name TEXT NOT NULL,
//   args_json TEXT NOT NULL,
//   result_json TEXT,
//   ok INTEGER NOT NULL (boolean),
//   duration_ms REAL NOT NULL,
//   created_at INTEGER NOT NULL
//
// turn_metrics:
//   id INTEGER PK AUTOINCREMENT,
//   session_id TEXT NOT NULL FK -> sessions.id,
//   turn_id INTEGER NOT NULL,
//   t0_seq INTEGER NOT NULL,
//   vad_end_ms REAL,
//   stt_final_ms REAL,
//   llm_first_token_ms REAL,
//   first_sentence_ms REAL,
//   tool_ms REAL,
//   ack_audio_ms REAL,
//   tts_first_audio_ms REAL,
//   total_ms REAL,
//   total_client_ms REAL,
//   client_latency_source TEXT,
//   llm_provider TEXT,
//   outcome TEXT NOT NULL -- "ok" | "interrupted" | "fallback" | "failed"
//
// errors:
//   id INTEGER PK AUTOINCREMENT,
//   session_id TEXT NOT NULL FK -> sessions.id,
//   turn_id INTEGER,
//   stage TEXT NOT NULL,
//   code TEXT NOT NULL,
//   message TEXT NOT NULL,
//   recoverable INTEGER NOT NULL,
//   at INTEGER NOT NULL
```

- **Timestamp clock rule (`[DECIDED]`):** Use **wall-clock epoch ms** (`Date.now()`) for `started_at`, `ended_at`, `created_at` (and `errors.at`), and **monotonic ms** (`performance.now()`) **only** for latency/duration deltas (`vad_end_ms`, `stt_final_ms`, ..., `duration_ms`).
- **Write & flush rule (`[PROPOSED]`):** Enqueue DB writes per event off the audio/streaming hot path via a per-session write queue and **flush per turn** (on `PLAYBACK_DONE`, `INTERRUPT`, or turn failure) as well as on `call_ended` / `WS_CLOSE`, so `GET /sessions/:id` returns up-to-date turns, tool calls, metrics, and errors during a live call.
- **THINKING continuation update (`[PROPOSED]`):** When a `THINKING` interruption merges additional speech under the same `turn_id`, update the existing user row in `turns` (`text`, `created_at`) rather than inserting a duplicate user turn row.

### 8.2 `GET /sessions/:id` Response Shape (`[PROPOSED]`)

Works both during an active live call and after call end. Strict superset of spec §4 (`-> { transcript, metrics }`):

```ts
export interface GetSessionResponse {
  session: {
    id: string;
    started_at: number;
    ended_at: number | null;
    end_reason: string | null;
    timezone: string;
    config: Record<string, unknown>;
  };
  transcript: Array<{
    turn_id: number;
    role: "user" | "agent";
    text: string;
    spoken_text: string | null;
    played_ms: number | null;
    interrupted: boolean;
    tool_calls: Array<{
      name: string;
      args: unknown;
      result: unknown;
      ok: boolean;
      duration_ms: number;
    }>;
    created_at: number;
  }>;
  metrics: Array<{
    turn_id: number;
    t0_seq: number;
    vad_end_ms: number | null;
    stt_final_ms: number | null;
    llm_first_token_ms: number | null;
    first_sentence_ms: number | null;
    tool_ms: number | null;
    ack_audio_ms: number | null;
    tts_first_audio_ms: number | null;
    total_ms: number | null;
    total_client_ms: number | null;
    client_latency_source: "outputLatency" | "baseLatency" | "none" | null;
    llm_provider: string | null;
    outcome: "ok" | "interrupted" | "fallback" | "failed";
  }>;
  errors: Array<{
    turn_id: number | null;
    stage: string;
    code: string;
    message: string;
    recoverable: boolean;
    at: number;
  }>;
}
```

---

## 9. Provider Connection Lifecycle (`[DECIDED]`)

On `session_start`, `session/runtime.ts` pre-warms all providers in parallel (retrying once on failure before emitting `error` + `call_ended(internal_error)` with zero audio played) before emitting `session_ready`:

1. **STT (`wss://api.in.deepgram.com/v1/listen`):**
   - Query: `model=nova-3&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&smart_format=true&endpointing=false`.
   - Keepalive: send Deepgram JSON `{"type":"KeepAlive"}` every `~5 s` between speech turns to prevent 10 s idle timeout; send `{"type":"Finalize"}` on `VAD_END`; send `{"type":"CloseStream"}` on session end.
2. **TTS (`wss://api.in.deepgram.com/v1/speak`):**
   - Query: `model=aura-2-thalia-en&encoding=linear16&sample_rate=24000`.
   - **One pre-warmed socket per call:** kept alive between turns with **WebSocket protocol `ping` frames every ~20 s** (verified `300.00 s` idle survival). **NEVER send `{"type":"KeepAlive"}` on `/v1/speak`** — Deepgram closes `/v1/speak` immediately with `1008 DATA-0000`.
   - **Flush policy:** Flush **Sentence 1 immediately** (for `~107 ms` `tts_first_audio`) + **one final `Flush`** at end of LLM turn (intermediate sentences `2..N` stream via `Speak` without extra `Flush`es). If a `Flush`-limit `Warning` occurs, the Deepgram TTS adapter internally disables early sentence-1 `Flush` for `60 s` and emits a log-only event (§6.2 Row 13).
   - **Barge-in:** Send `{"type":"Clear"}`, discard incoming audio until `Cleared` (`~42.5 ms`), keep socket open (`100%` survival in Phase 0).
3. **LLM (`api.groq.com` + Gemini failover):**
   - Shared `undici` `Agent({ allowH2: true })` (HTTP/2 multiplexing; do **not** cap `connections: 1` in production) pre-warmed at server/session start so `AbortSignal` (`RST_STREAM`) incurs zero TCP+TLS reconnect penalty.
   - Prompt `voice-v2`, tools `tools-v3` (`get_current_time {}`, `get_order_status { order_id }`), history capped at `≤ 1,500` estimated prompt tokens (oldest dropped first; system prompt + tools always kept).
4. **Pre-rendered local audio clips (`apps/server/src/assets/clips/`):**
   - `24 kHz` mono `PCM16LE` clips loaded into memory at server boot (`fallback.pcm`, `goodbye.pcm`, `one-moment.pcm`) so error fallbacks, goodbyes, and tool acknowledgments require zero network/TTS calls.

---

## 10. Risks & Open Items

1. **Deepgram `20 Flushes / 60 s` scope unknown:** Deepgram docs state `20 Flushes / 60 s` without specifying whether the quota is per WebSocket connection or per API key/project. At 2 Flushes/turn, one socket supports 10 turns/min (`20` turns/min if degraded to 1 Flush/turn). **Action:** Run a lightweight scope probe before Phase 1 streaming TTS; adapter guard in §6.2 Row 13 handles `Warning` safely either way.
2. **Primary LLM pending `qwen/qwen3.8-27b` `tools-v3` run:** `openai/gpt-oss-120b` (`~447 ms` H2 TTFT, 100% `tools-v3`) is the current baseline; `qwen/qwen3.8-27b` (`~195 ms` TTFT) is pending its `tools-v3` verification run.
3. **Spoken-form coverage beyond order IDs:** `"1042"` → `"1 0 4 2"` is `[DECIDED]` for numeric/order IDs (`e277aca`); additional formats (e.g. alphanumeric tracking codes, dates, prices) will be verified during M3/M4 listening checks.
4. **Server VAD worker thread at concurrency:** Silero v6.3 ONNX inference takes `p50 0.29 ms` / `p95 0.50 ms` per `32 ms` window on the Node event loop; move ONNX inference to a worker thread pool around `~100` concurrent sessions.
5. **Groq free-tier TPM & RPM limits:** Groq free tier allows **`8,000` tokens/min** and **`30` requests/min** per model, and tool turns cost **2 requests** (`req1` tool call + `req2` follow-up). History capping (`≤ 1,500` tokens) plus multi-model failover (`120b → 20b → gemini`) mitigates bursts, but rapid multi-turn calls can hit `429`.
6. **`@ricky0123/vad-web` onset latency (unmeasured):** Client-side barge-in onset latency has not yet been measured end-to-end in Chrome; will be measured and gated by the Phase 1/2 Chrome fake-mic integration test (`median onset_to_stop_ms ≤ 300 ms` over `n ≥ 10`, §5.3).

---

## 11. Monorepo Layout for Phase 1 (`[DECIDED]`)

Preserve existing repository conventions (`pnpm-workspace.yaml` at repo root with `apps/*` and `packages/*`), adding `packages/protocol` without introducing `packages/core` or `apps/client`:

```text
amadeus/
├─ pnpm-workspace.yaml            # apps/*, packages/*
├─ apps/
│  ├─ server/src/
│  │  ├─ main.ts                  # Fastify boot, POST /sessions, GET /sessions/:id, WS /ws/voice
│  │  ├─ config.ts                # Zod-validated env
│  │  ├─ session/                 # reducer.ts (pure), runtime.ts, manager.ts
│  │  ├─ pipeline/                # turn-controller.ts, chunker.ts (pure), spoken-form.ts, history.ts, prompt.ts
│  │  ├─ vad/                     # silero.ts (ONNX), segmenter.ts (pure)
│  │  ├─ adapters/                # types.ts (human-owned), factory.ts, stt/, llm/, tts/, fakes/
│  │  ├─ tools/                   # registry.ts, order-status.ts, current-time.ts
│  │  ├─ metrics/                 # turn-timer.ts
│  │  ├─ db/                      # schema.ts, repo.ts
│  │  └─ assets/clips/            # fallback.pcm, goodbye.pcm, one-moment.pcm (24 kHz)
│  └─ web/src/
│     ├─ audio/                   # capture.worklet.ts, playback.worklet.ts
│     ├─ call/                    # useVoiceCall.ts (seq -> performance.now() map, vad-web barge-in)
│     └─ components/              # CallControls, StatusPill, Captions, LatencyPanel
└─ packages/
   ├─ protocol/                   # Zod WS schemas + 10 B agent_audio frame codec (used by server & web)
   └─ audio/                      # Kaiser FIR + Catmull-Rom resampler, PCM16<->Float32, WAV read/write
```

- **ESLint boundary:** `no-restricted-imports` forbids `session/`, `pipeline/`, and `vad/` from importing vendor SDKs or `adapters/<kind>/<vendor>.ts`; only `adapters/types.ts` may be imported across the boundary, and only `adapters/factory.ts` reads `*_PROVIDER` config.
