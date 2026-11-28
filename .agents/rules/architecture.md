---
trigger: always_on
---

# Architecture Principles & Contracts

- **Functional core, imperative shell:** Keep `session/reducer.ts`, `vad/segmenter.ts`, and `pipeline/chunker.ts` completely pure (no I/O, timers, random values, or `Date.now()`). Side effects belong in `session/runtime.ts`.
- **Strict adapter boundary:** Vendor SDKs, endpoints, and API keys must live strictly under `apps/server/src/adapters/<kind>/<vendor>.ts`. Only `adapters/factory.ts` reads `*_PROVIDER` config. `pipeline/`, `session/`, and `vad/` may only import interfaces from `adapters/types.ts`.
- **Human-owned contracts:** Treat `packages/protocol/**` (shared by `apps/server` and `apps/web`) and `apps/server/src/adapters/types.ts` (call-scoped adapter sessions with turns) as frozen contracts unless a plan explicitly proposes a schema/interface change.
- **Cancellation & stale-audio safety:** Every async call inside a turn accepts the turn's `AbortSignal` and exits promptly on abort. Outbound `agent_audio` binary frames must use the `packages/protocol` 10 B `agent_audio` header (`u8 kind=1`, `u8 version=1`, `u32 turn_id`, `u32 seq`), announced by `audio_start`; clients send raw 640 B mic frames only after `session_ready`.
- **Pre-warming & metrics:** Open call-scoped provider sessions on `session_start` (`IDLE → LISTENING` on `PREWARM_DONE` + `session_ready`), send `KeepAlive` on STT only and never on `/v1/speak` (use WS `ping` every `~20 s`), and record every pipeline stage via `metrics/turn-timer.ts` with `performance.now()`.
- **DB off hot path:** Persist turn records, tool calls, metrics, and errors via Drizzle/SQLite off the audio/streaming hot path.
