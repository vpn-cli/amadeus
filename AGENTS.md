# Voice Agent MVP — agent guide

Real-time voice agent: browser mic → Silero VAD → streaming STT → LLM (+tools) → sentence-level TTS → speaker.
Full design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Read the section for your task before writing code.

## Commands

`pnpm dev` · `pnpm test` · `pnpm test:int` · `pnpm typecheck` · `pnpm lint` · `pnpm bench`

## Non-negotiables

1. Human-owned contracts: `packages/protocol/**` (shared by `apps/server` and `apps/web`) and `apps/server/src/adapters/types.ts` (call-scoped adapter sessions with turns). Propose changes in your plan; never edit silently.
2. Vendor SDKs/URLs only in `apps/server/src/adapters/<kind>/<vendor>.ts`. `pipeline/`, `session/`, `vad/` import interfaces only.
3. `session/reducer.ts`, `vad/segmenter.ts`, `pipeline/chunker.ts` are pure: no I/O, timers, or `Date.now()`.
4. Every async operation in a turn accepts the turn's `AbortSignal` and stops promptly on abort.
5. Server→client audio frames are encoded with the `packages/protocol` 10 B `agent_audio` header (`kind`, `version`, `turn_id`, `seq`), announced by `audio_start`.
6. Any new pipeline stage records a mark in `metrics/turn-timer.ts`.
7. Audio: client→server raw 640 B `PCM16LE` mono 16 kHz 20 ms frames after `session_ready`; server→client 10 B `agent_audio` header + `PCM16LE` mono 24 kHz; `KeepAlive` on STT only, never on `/v1/speak`. Never guess formats.
8. No test may require an API key. Adapters are tested against a local mock ws server or mocked fetch.

## Workflow

Start with a plan listing files to touch and tests to add; wait for approval. One module per task. Run `/check` before finishing. Make small, atomic Conventional Commits after each verified step (one logical change per commit; see [.agents/rules/git.md](.agents/rules/git.md)). Never push unless the user's prompt explicitly says to push.

## UI work
Read DESIGN.md before any change under apps/web. One design skill per pass. Run /unslop as an audit before merging UI changes. Never hardcode colors or spacing; use the tokens in apps/web/src/styles/tokens.css.

## Handoff
At the end of every task, append your final report to handoff/antigravity-log.md: date, task, commit hash, key verification output (test counts, tables, measured numbers), and open issues or skipped items. Never rewrite earlier entries.
