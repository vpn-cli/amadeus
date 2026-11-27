---
name: check
description: Run typecheck, lint, unit tests, and integration tests, then summarize results.
---

# `/check` Verification Workflow

Run all workspace quality gates in order and report exact pass/fail results:

1. `pnpm typecheck`
2. `pnpm lint` (including the ESLint adapter import-boundary rule)
3. `pnpm test` (Vitest unit suite, keyless)
4. `pnpm test:int` (recorded-audio integration suite, keyless)

If any check fails, stop and fix the root cause before re-running. Summarize each command's outcome concisely with exact counts.
