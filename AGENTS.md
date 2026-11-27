# Voice Agent MVP — agent guide

Real-time voice agent: browser mic → Silero VAD → streaming STT → LLM (+tools) → sentence-level TTS → speaker.
Full design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Read the section for your task before writing code.

## Commands

`pnpm dev` · `pnpm test` · `pnpm test:int` · `pnpm typecheck` · `pnpm lint` · `pnpm bench`

## Non-negotiables

1. Human-owned contracts: `packages/protocol/**` and `apps/server/src/adapters/types.ts`. Propose changes in your plan; never edit silently.
2. Vendor SDKs/URLs only in `apps/server/src/adapters/<kind>/<vendor>.ts`. `pipeline/`, `session/`, `vad/` import interfaces only.
3. `session/reducer.ts`, `vad/segmenter.ts`, `pipeline/chunker.ts` are pure: no I/O, timers, or `Date.now()`.
4. Every async operation in a turn accepts the turn's `AbortSignal` and stops promptly on abort.
5. Server→client audio frames are encoded with the `packages/protocol` frame codec (`turn_id` header).
6. Any new pipeline stage records a mark in `metrics/turn-timer.ts`.
7. Audio: client→server PCM16LE mono 16 kHz 20 ms frames; server→client PCM16LE mono 24 kHz. Never guess formats.
8. No test may require an API key. Adapters are tested against a local mock ws server or mocked fetch.

## Workflow

Start with a plan listing files to touch and tests to add; wait for approval. One module per task. Run `/check` before finishing. Make small, focused Conventional Commits after each verified step.

## UI work
Read DESIGN.md before any change under apps/web. One design skill per pass. Run /unslop as an audit before merging UI changes. Never hardcode colors or spacing; use the tokens in apps/web/src/styles/tokens.css.
