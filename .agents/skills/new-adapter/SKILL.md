---
name: new-adapter
description: Add a new STT, LLM, or TTS provider adapter behind the contract in apps/server/src/adapters/types.ts.
---

# `/new-adapter` Workflow

Follow these steps whenever adding or swapping a provider adapter:

1. **Read contracts:** Inspect `apps/server/src/adapters/types.ts` and the relevant section of `docs/ARCHITECTURE.md`. Do not modify pipeline code.
2. **Implement adapter:** Create `apps/server/src/adapters/<kind>/<vendor>.ts` implementing the interface (`SttAdapter`, `LlmAdapter`, or `TtsAdapter`).
   - Observe the turn's `AbortSignal` on every socket, stream, or `fetch` call.
   - Keep all vendor SDK imports, headers, and URLs strictly inside this file.
3. **Write keyless tests:** Add unit tests alongside or under the adapter test directory using a local mock `ws` server or mocked `fetch` (covering normal flow, streaming/chunking, error/timeout, and abort cancellation).
4. **Register in factory & config:**
   - Wire the provider enum/case in `apps/server/src/adapters/factory.ts`.
   - Add any new env variables to the Zod schema in `apps/server/src/config.ts`, `.env.example`, and the `README.md` env table.
5. **Verify:** Run `/check` (`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:int`).
