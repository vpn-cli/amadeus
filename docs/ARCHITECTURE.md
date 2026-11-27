# Voice Agent MVP — Architecture & Roadmap

Real-time voice agent: browser mic → Silero VAD → streaming STT → LLM (+tools) → sentence-level TTS → speaker.

This document synthesizes [Technical Assignment.pdf](../Technical%20Assignment.pdf) with our self-paced, zero-cost-tier architecture and phased roadmap.

---

## 1. Goals & Acceptance Criteria

Must pass all 10 acceptance criteria from §7 of the spec:

1. User completes a 5+ turn conversation and the agent remembers earlier turns.
2. Median time from end of user speech to first agent audio ≤ 1.5 s (measured over 20 test turns).
3. Live captions show partial (`transcript_partial`) and final (`transcript_final`) transcripts.
4. Barge-in works: agent audio stops within ~300 ms of user speaking.
5. Sample tool (`get_order_status` / `get_current_time`) is invoked correctly when asked a relevant question.
6. All failure cases in §8 behave as described.
7. Each session's transcript and per-stage latencies are persisted and retrievable by `session_id` (`GET /sessions/:id`).
8. Swapping one provider (e.g., TTS or STT) needs only config + a new adapter, with zero pipeline changes.
9. Unit tests for state transitions and adapters (mocked); one integration test running a recorded audio file through the full pipeline with zero API keys.
10. `README.md` with setup, env vars, architecture diagram, and local run instructions.

### Latency & Quality Targets

| Metric | Spec | Target |
| :--- | :--- | :--- |
| Median end-of-speech → first audio (20 turns) | ≤ 1.5 s | ≤ 1.2 s |
| p90 end-of-speech → first audio | — | ≤ 1.6 s |
| Barge-in: user speaks → agent audio stops | ~300 ms | ≤ 250 ms |
| CI | — | Unit + integration tests, zero API keys |

---

## 2. Tech Stack & Zero-Cost Guardrails

| Layer | Pick | Why |
| :--- | :--- | :--- |
| Language | TypeScript (strict), Node 22+ (tested on Node 24), pnpm workspaces | Shared protocol schemas between client, server, and bench |
| Server | Fastify + `@fastify/websocket` (`ws`), `pino` logs | Typed routes and structured logs with `session_id` / `turn_id` |
| Client | Vite + React + Tailwind, AudioWorklets | Lightweight SPA; sample-accurate capture and playback |
| Server VAD | Silero VAD v6.3 (same ONNX I/O as v5: [1,576] input with 64-sample context, [2,1,128] state, int64 sr) ONNX via `onnxruntime-node` (~120-line wrapper) | Spec requires server-side VAD; `vad-node` is deprecated |
| Client VAD | `@ricky0123/vad-web` | Local barge-in detection avoids network RTT before stopping playback |
| STT (streaming) | Deepgram Nova-3 live WebSocket | Interim results for live captions + `Finalize` for fast final transcript |
| STT (batch) | Groq `whisper-large-v3-turbo` | Used for initial non-streaming milestone and provider-swap proof |
| LLM | Groq (OpenAI-compatible API) + Gemini failover | Fast first content token; one `OpenAICompatibleLlm` covers both |
| TTS | Deepgram Aura-2 over `/v1/speak` WebSocket (REST in M2) | Same vendor/credit pool as STT; supports streaming input (`/v2/speak` rejects Aura models) |
| DB | SQLite (`better-sqlite3`) + Drizzle locally | Zero-setup local persistence (use Supabase Postgres if deployed to ephemeral Render) |
| Validation | Zod for WS events and env config | Shared runtime + static validation |
| Tests / CI | Vitest, GitHub Actions | Fast unit + keyless recorded-audio integration tests |

**Zero-cost rule:** Never attach a payment card to any provider account.
- **Deepgram:** \$200 signup credit, no credit card, non-expiring.
- **Groq & Gemini:** Free tiers with rate limits (develop primarily against fake adapters and replay fixtures to stay well under daily limits).
- **Hosting (optional):** Render free tier (no card; sleeps after 15 min idle, ephemeral disk).

---

## 3. System Architecture & Core Principles

```mermaid
flowchart LR
  subgraph Client["Browser (Chrome target)"]
    Mic["Mic -> Capture Worklet\n48k -> 16k PCM16LE, 20ms"]
    ClientVad["@ricky0123/vad-web\nbarge-in only"]
    Play["Playback Worklet\n24 kHz ring buffer"]
    UI["Call UI\ncaptions · status · latency panel"]
  end

  subgraph Server["Node + Fastify + ws"]
    WS["WS Gateway\nZod-validated events"]
    Reducer["Session Reducer (pure)\nstate · timeouts"]
    Silero["Silero VAD v6.3 (same ONNX I/O as v5: [1,576] input with 64-sample context, [2,1,128] state, int64 sr)\nonnxruntime-node"]
    STT["STT Adapter\nDeepgram Nova-3 / Batch"]
    Turn["Turn Controller\nAbortController per turn"]
    LLM["LLM Adapter\nGroq -> Gemini failover"]
    Tools["Tool Executor\n3s timeout"]
    Chunker["Sentence Chunker (pure)"]
    TTS["TTS Adapter\nDeepgram Aura-2 WS"]
    Metrics["Turn Timer + pino\nSQLite · Drizzle"]
  end

  Mic -->|"binary 16kHz PCM"| WS
  Mic --> ClientVad
  ClientVad -->|"interrupt (played_ms)"| WS
  WS --> Silero --> STT --> Turn
  WS <--> Reducer
  Turn --> LLM
  LLM <--> Tools
  LLM -->|"tokens"| Chunker --> TTS -->|"agent_audio (9B hdr + 24kHz PCM)"| WS
  WS -->|"binary frames"| Play
  WS -->|"events & timings"| UI
  Turn --> Metrics
```

### Core Principles
1. **Functional core, imperative shell:** `session/reducer.ts` is pure: `(state, event) => { state, effects }`. `session/runtime.ts` executes side effects.
2. **Pipeline sees interfaces only:** Vendor SDKs and URLs live strictly in `apps/server/src/adapters/<kind>/<vendor>.ts`. `adapters/factory.ts` is the only module reading `*_PROVIDER` config. Enforced by ESLint `no-restricted-imports`.
3. **One `AbortController` per turn:** LLM fetch, tool calls, and TTS streaming all observe the same `AbortSignal`. Cancelling a turn is a single `abort()`.
4. **Turn-tagged outbound audio:** Every server→client `agent_audio` binary frame carries its `turn_id` and `seq`. Client drops frames from cancelled/stale turns immediately.
5. **Pre-warm at session start:** Open STT/TTS sockets and keep-alive connections on `START_CALL` so turns avoid cold TLS handshakes.

---

## 4. Repo Layout

```text
amadeus/
├─ AGENTS.md
├─ .agents/
│  ├─ rules/                  # architecture.md, audio.md, testing.md
│  └─ skills/                 # /check, /new-adapter
├─ spikes/                    # Phase 0 standalone learning spikes
├─ apps/
│  ├─ server/src/
│  │  ├─ main.ts              # Fastify boot, REST routes, WS gateway
│  │  ├─ config.ts            # Zod-validated env
│  │  ├─ session/             # reducer.ts (pure), runtime.ts, manager.ts
│  │  ├─ pipeline/            # turn-controller.ts, chunker.ts (pure), history.ts, prompt.ts
│  │  ├─ vad/                 # silero.ts (ONNX), segmenter.ts (pure)
│  │  ├─ adapters/            # types.ts, factory.ts, stt/, llm/, tts/
│  │  ├─ tools/               # registry.ts, order-status.ts, current-time.ts
│  │  ├─ metrics/             # turn-timer.ts
│  │  ├─ db/                  # schema.ts, repo.ts
│  │  └─ assets/clips/        # pre-rendered fallback & goodbye WAVs
│  └─ web/src/
│     ├─ audio/               # capture.worklet.ts, playback.worklet.ts
│     ├─ call/                # useVoiceCall.ts
│     └─ components/          # CallControls, StatusPill, Captions, LatencyPanel
├─ packages/
│  ├─ protocol/               # Zod events + binary frame codec (client, server, bench)
│  └─ audio/                  # PCM16<->Float32, resampler, WAV read/write
├─ fixtures/audio/            # 20 recorded 16kHz WAVs + expected transcripts
├─ scripts/                   # bench.ts, ping-providers.ts, gen-clips.ts
└─ docs/                      # ARCHITECTURE.md, DESIGN_NOTE.md, latency-report.md
```

---

## 5. Contracts

`packages/protocol/**` and `apps/server/src/adapters/types.ts` are human-owned contracts.

### 5.1 Audio Formats
- **Client → Server:** `PCM16LE`, mono, `16 kHz`, `20 ms` frames (`320` samples = `640` bytes), raw binary WS messages. Capture uses native `AudioContext` rate with low-pass downsample (`48k -> 16k`) in `packages/audio`. Mic constraints: `echoCancellation`, `noiseSuppression`, `autoGainControl` = `true`.
- **Server VAD (Silero VAD v6.3 — same ONNX I/O as v5: [1,576] input with 64-sample context, [2,1,128] state, int64 sr):** Re-chunked into `512`-sample windows (`32 ms` at 16 kHz). Each ONNX inference call prepends `64` context samples from the end of the previous frame (shape `[1, 576]`), alongside `state` (`[2, 1, 128]`, float32) and `sr` (`16000`, int64).
- **Server → Client:** `PCM16LE`, mono, `24 kHz`, prefixed by a `9-byte` header: `u8 kind=1 · u32 turn_id · u32 seq` (big/little endian pinned in `packages/protocol`). Playback uses a dedicated `AudioContext({ sampleRate: 24000 })`.

### 5.2 WebSocket Events (`packages/protocol`)
- **Server → Client:** `state`, `transcript_partial`, `transcript_final`, `agent_text`, `error`, `call_ended`, plus documented extensions `tool_status` and `turn_metrics`.
- **Client → Server:** `interrupt` (with `turn_id`, `played_ms`, optional `detect_to_stop_ms`), plus documented extensions `end_call` and `playback_done`.

### 5.3 Adapter Interfaces (`adapters/types.ts`)
- `SttAdapter` / `SttStream`: `write(pcm)`, `onPartial(cb)`, `finalize()`, `close()`. Batch adapters buffer in `write()` and transcribe in `finalize()`.
- `LlmAdapter`: `stream({ messages, tools, signal }) -> AsyncIterable<LlmChunk>`.
- `TtsAdapter` / `TtsTurn`: `startTurn(signal) -> { push(sentence), end(), audio: AsyncIterable<Uint8Array> }`.
- `Tool<A>`: `{ name, description, args: z.ZodType<A>, run(args, ctx) }`.
- `VadModel`: `{ probability(window512: Float32Array): Promise<number> }`.

### 5.4 Database (SQLite + Drizzle)
- `sessions`: `id`, `started_at`, `ended_at`, `end_reason`, `config_json`, `prompt_version`
- `turns`: `session_id`, `turn_id`, `role`, `text`, `spoken_text`, `interrupted`, `created_at`
- `tool_calls`: `session_id`, `turn_id`, `name`, `args_json`, `result_json`, `ok`, `duration_ms`
- `turn_metrics`: `session_id`, `turn_id`, `vad_end_ms`, `stt_final_ms`, `llm_first_token_ms`, `first_sentence_ms`, `tts_first_audio_ms`, `total_ms`, `llm_provider`
- `errors`: `session_id`, `turn_id?`, `stage`, `code`, `message`, `at`

---

## 6. Turn Lifecycle & Barge-In

- **State Machine (`session/reducer.ts`):**
  - `IDLE` + `START_CALL` → `LISTENING`
  - `LISTENING` + `VAD_START` → `LISTENING` (flush 300 ms pre-roll, stream frames to STT)
  - `LISTENING` + `VAD_END` → `LISTENING` (`stt.finalize()`, mark `t_vad_end`)
  - `LISTENING` + `STT_FINAL` (empty/noise) → `LISTENING` (drop)
  - `LISTENING` + `STT_FINAL` (text) → `THINKING` (append user turn, start LLM)
  - `THINKING` + `VAD_START` → `LISTENING` (abort turn, merge next final with prior user text)
  - `THINKING` + `FIRST_AUDIO` → `SPEAKING`
  - `SPEAKING` + `PLAYBACK_DONE` → `LISTENING` (commit agent turn)
  - `SPEAKING` + `INTERRUPT` → `LISTENING` (abort turn, commit `spoken_text` via `played_ms`, `interrupted = true`)
  - `any` + `STAGE_ERROR` → `LISTENING` (play cached fallback clip, log error)
  - `any` + `END_CALL` / `SILENCE_2MIN` / `MAX_DURATION` / `WS_CLOSE` → `ENDED`
- **VAD Settings:** `0.5` onset / `0.35` offset hysteresis, `250 ms` min speech, `550 ms` end-of-utterance silence (configurable `500–700 ms`), `300 ms` pre-roll, `30 s` max utterance. Send Deepgram `KeepAlive` outside speech.
- **STT:** Deepgram Nova-3 with `interim_results=true`, `Finalize` on VAD end (plus `300 ms` settle timeout). Do not rely on Deepgram endpointing (`10 ms` default); treat `is_final` messages as fragments accumulated until VAD end.
- **LLM & Tools:** System prompt + last 20 messages + transcript, `max_tokens ~ 150`. Max 2 tool rounds/turn with `3 s` tool timeout (`get_order_status`, `get_current_time`). Failover to Gemini only before first content token.
- **Sentence Chunker (pure):** Split on `. ? !` + whitespace/EOS once ≥ 12 chars; ignore decimals & abbreviations (`Dr.`, `e.g.`, `etc.`, `no.`); first-clause flush on `, ; :` once ≥ 40 chars; strip markdown.
- **Barge-In:** Client `vad-web` ducks volume to 20% on suspicion, confirms after ~150 ms, clears playback worklet, and sends `interrupt` with `played_ms` and `detect_to_stop_ms`. Server maps `played_ms` to per-sentence durations to store honest `spoken_text`.

---

## 7. Latency Budget (`performance.now()`)

| Stage | Measurement | Budget |
| :--- | :--- | :--- |
| `vad_end_ms` | Last voiced frame arrival → VAD end decision | 550 ms |
| `stt_final_ms` | VAD end → final transcript | ≤ 200 ms |
| `llm_first_token_ms` | Final transcript → first content token | ≤ 350 ms |
| `first_sentence_ms` | First content token → first chunk sent to TTS | ≤ 80 ms |
| `tts_first_audio_ms` | First chunk sent to TTS → first `agent_audio` sent | ≤ 250 ms |
| `total_ms` | Last voiced frame → first `agent_audio` sent | ≤ 1,430 ms |

---

## 8. Error Handling Matrix

- **Mic denied:** Request mic permission *before* `POST /sessions` so no orphaned session is created; show banner.
- **STT error / 1.5 s Finalize timeout:** Play pre-rendered fallback clip (*"Sorry, I didn't catch that, could you repeat?"*); reconnect in background; log error.
- **LLM error / 429 / 3 s timeout:** Failover to Gemini if pre-first-token; otherwise fallback clip.
- **TTS error / 2 s timeout:** Play pre-rendered fallback clip (zero TTS dependency); reconnect.
- **WS drop / 2 missed pings (10 s):** Client shows `"Disconnected"`; server aborts turn, marks `ws_drop`, persists DB.
- **Noise-only (< 250 ms or empty transcript):** Ignore; no LLM call.
- **Tool fails / 3 s timeout:** Return `{ error }` to LLM so it apologizes gracefully.
- **Silence (2 min) / Max duration:** Play goodbye clip, emit `call_ended`, close sockets.

---

## 9. Testing Strategy

- **Unit (`pnpm test`):** Pure reducer table tests, chunker, pure segmenter (synthetic probability arrays), `played_ms` truncation, tool timeouts/errors, Zod protocol round trips, adapters vs local mock WS/fetch. Zero API keys.
- **Integration (`pnpm test:int`):** Stream fixture WAVs through real Silero VAD + fake adapters (`FakeStt`, scripted `FakeLlm` with tool calls, `FakeTts` timed silence), asserting event order, state transitions, DB rows, and barge-in. Zero API keys.
- **Bench (`pnpm bench`):** Real keys, 20 fixture WAVs (`ffmpeg -i in.m4a -ac 1 -ar 16000 -sample_fmt s16 out.wav`), writes `docs/latency-report.md` with median and p90 per stage + end-to-end.

---

## 10. Phased Roadmap (Self-Paced)

- **Phase 0 — Spikes (`spikes/`):** Standalone throwaway scripts to isolate each API/runtime before integrating:
  1. Silero VAD v6.3 (same ONNX I/O as v5: [1,576] input with 64-sample context, [2,1,128] state, int64 sr) ONNX in Node (`onnxruntime-node` + `512 + 64` context + `state`).
  2. Browser mic capture worklet → WAV download.
  3. Deepgram Nova-3 live WS transcription of a WAV.
  4. Groq streaming tokens + 1 tool call.
  5. Deepgram Aura-2 `/v1/speak` WS → WAV file.
- **Phase 1 — Spec MVP (M1–M4):**
  - M1: pnpm monorepo, TS strict, ESLint import boundary, Vitest, CI, `packages/protocol`, `config.ts`, `POST /sessions` + WS echo, `ping-providers.ts`.
  - M2: Capture/playback worklets, `packages/audio`, Silero + pure segmenter, pure reducer + manager, batch path (Whisper + Groq + Deepgram REST), turn timer, SQLite, `GET /sessions/:id`.
  - M3: Deepgram live STT + captions, LLM streaming + pure chunker + Aura-2 WS TTS, turn-tagged frames, multi-turn history.
  - M4: Barge-in + `played_ms`, streamed tool-call loop, error matrix + pre-rendered clips, Gemini failover, keyless CI integration test.
- **Phase 2 — Resume-Ready:** Live latency waterfall panel, 20-turn bench report (`docs/latency-report.md`), `README.md`, `DESIGN_NOTE.md`, 2:30 demo video (plus optional Render + Supabase deploy).
- **Phase 3 — Depth (pick 1–2):** Deepgram Flux vs Silero+Nova-3 comparison; concurrency load test; fully local mode (`whisper.cpp` + Ollama + Piper); adaptive endpointing.
