DRAFT, not approved; revisit after Phase 0 provider spikes

#### Step 0 — Proposed Human-Owned Contracts (require approval before creation/editing)
- `packages/protocol/src/events.ts`, `frame.ts`, `index.ts`:
  - Zod schemas for client→server JSON (`interrupt { turn_id, played_ms, detect_to_stop_ms? }`, `end_call`, `playback_done`) and server→client JSON (`state`, `transcript_partial`, `transcript_final`, `agent_text`, `tool_status`, `turn_metrics`, `error`, `call_ended`).
  - Binary frame codec: 9-byte header (`u8 kind=1`, `u32be turn_id`, `u32be seq`) + `PCM16LE` 24 kHz mono payload.
- `apps/server/src/adapters/types.ts`:
  - `SttAdapter` / `SttStream`, `LlmAdapter` (`stream({ messages, tools, signal })`), `TtsAdapter` / `TtsTurn`, `Tool<A>`, and `VadModel` (`probability(window512: Float32Array): Promise<number>`).

#### M1 — Monorepo Scaffold, Shared Packages & Server Shell
- **Files to create:**
  - Root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.mjs` (enforcing `no-restricted-imports` adapter boundary), `.env.example`, `.github/workflows/ci.yml`.
  - `packages/protocol/**` (above) + `packages/audio/src/{pcm.ts, resampler.ts, wav.ts, index.ts}` (reusing the verified streaming low-pass resampler from `spikes/browser-capture`).
  - `apps/server/src/{config.ts, main.ts}` (Fastify + `@fastify/websocket` + `pino`, `POST /sessions`, WS echo/heartbeat, `GET /health`).
  - `scripts/ping-providers.ts` (sanity-check provider keys outside CI).
- **Tests to add:**
  - `packages/protocol/src/protocol.test.ts` (Zod event round trips, invalid payload rejection, 9-byte binary frame encode/decode).
  - `packages/audio/src/audio.test.ts` (PCM16↔Float32 conversion, 48 kHz→16 kHz resampler impulse/sine attenuation, WAV read/write).

#### M2 — VAD, Pure Session Core, Batch Adapters & Persistence
- **Files to create:**
  - `apps/server/src/vad/{silero.ts, segmenter.ts}` (porting verified Silero v6.3 ONNX wrapper + pure `VadSegmenter` from `spikes/silero-vad`).
  - `apps/server/src/session/{reducer.ts, runtime.ts, manager.ts}` (pure `(state, event) => { state, effects }` reducer, 500 ms STT pre-roll ring buffer forwarding from `start - 100 ms`, `AbortController` per turn, 2-min silence timer).
  - `apps/server/src/pipeline/{turn-controller.ts, history.ts, prompt.ts}` + `apps/server/src/metrics/turn-timer.ts` (`performance.now()` marks for `vad_end_ms`, `stt_final_ms`, `llm_first_token_ms`, `first_sentence_ms`, `tts_first_audio_ms`, `total_ms`).
  - `apps/server/src/db/{schema.ts, repo.ts}` (Drizzle + `better-sqlite3` off hot path: `sessions`, `turns`, `tool_calls`, `turn_metrics`, `errors`; `GET /sessions/:id`).
  - `apps/server/src/adapters/{factory.ts, stt/groq-whisper.ts, llm/openai-compatible.ts, tts/deepgram-rest.ts}` (plus `apps/server/src/adapters/fake/*.ts` for keyless tests).
  - `apps/web/src/audio/{capture.worklet.ts, playback.worklet.ts}` + `apps/web/src/call/useVoiceCall.ts` + `apps/web/src/components/{CallControls, StatusPill, Captions}.tsx` + `apps/web/src/styles/tokens.css` (consulting `DESIGN.md` before `apps/web` work and running `/unslop` before merge).
- **Tests to add:**
  - `apps/server/src/vad/segmenter.test.ts`
  - `apps/server/src/session/reducer.test.ts` (table-driven covering every §6 transition)
  - `apps/server/src/adapters/*.test.ts` (mocked `fetch` / `ws`, abort signal propagation)
  - `apps/server/src/db/repo.test.ts` (in-memory SQLite persistence + `GET /sessions/:id`)

#### M3 — Streaming STT, Sentence Chunker & Streaming TTS
- **Files to create:**
  - `apps/server/src/adapters/stt/deepgram-live.ts` (Nova-3 WS, `interim_results=true`, `KeepAlive` outside speech, `Finalize` on VAD end + 300 ms settle timeout).
  - `apps/server/src/pipeline/chunker.ts` (pure sentence chunker: `. ? !` at ≥ 12 chars, decimal/abbreviation guards `Dr.`, `e.g.`, `etc.`, `no.`, first-clause `, ; :` at ≥ 40 chars, markdown stripping).
  - `apps/server/src/adapters/tts/deepgram-ws.ts` (Aura-2 `/v1/speak` WS streaming 24 kHz PCM16LE, emitting 9-byte turn-tagged frames).
- **Tests to add:**
  - `apps/server/src/pipeline/chunker.test.ts` (decimals, abbreviations, first-clause flush, markdown strip, EOS flush)
  - `apps/server/src/adapters/stt/deepgram-live.test.ts` and `apps/server/src/adapters/tts/deepgram-ws.test.ts` (local mock `ws` server + abort/cancel behavior)

#### M4 — Barge-In, Tool Execution, Failover & Keyless E2E Integration
- **Files to create:**
  - `apps/server/src/tools/{registry.ts, order-status.ts, current-time.ts}` (3 s timeout, `{ error }` propagation, max 2 tool rounds/turn).
  - `apps/server/src/pipeline/spoken-text.ts` (`played_ms` → per-sentence `spoken_text` truncation on barge-in).
  - `apps/server/src/assets/clips/` + `scripts/gen-clips.ts` (pre-rendered fallback & goodbye WAVs for error matrix §8).
  - Client `@ricky0123/vad-web` barge-in integration in `apps/web` (volume ducking to 20%, ~150 ms confirm, playback worklet flush, `interrupt` event).
  - Gemini pre-first-token failover wiring in `apps/server/src/adapters/llm/`.
- **Tests to add:**
  - `apps/server/src/tools/registry.test.ts` (3 s timeout, error → `{ error }`)
  - `apps/server/src/pipeline/spoken-text.test.ts` (`played_ms` truncation)
  - `apps/server/tests/integration/pipeline.int.test.ts` (`pnpm test:int`, keyless: real Silero ONNX VAD + `fixtures/audio/*.wav` + `FakeStt` + scripted `FakeLlm` with tool call + timed `FakeTts`, asserting event order, state sequence, DB rows, and barge-in).

#### Phase 2 — Latency Panel, Benchmark & Docs
- **Files to create:**
  - `apps/web/src/components/LatencyPanel.tsx` (live per-turn stage waterfall).
  - `scripts/bench.ts` (`pnpm bench`, 20 fixture WAVs → `docs/latency-report.md` with median & p90 per stage + end-to-end).
  - Root `README.md` & `docs/DESIGN_NOTE.md`.
