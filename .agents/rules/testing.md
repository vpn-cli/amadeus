---
trigger: model_decision
description: "Apply when writing, modifying, or reviewing unit tests, integration tests, adapter mocks, or benchmark scripts."
---

# Testing & Verification Rules

- **Zero API keys in tests:** No unit or integration test may make real network calls or require `.env` provider keys.
- **Unit tests (Vitest):**
  - `session/reducer.ts`: table-driven tests covering every state transition row in `docs/DESIGN.md` §3.3.
  - `pipeline/chunker.ts`: write tests first covering decimals (`3.5`), abbreviations (`Dr.`, `e.g.`, `etc.`, `no.`), first-clause flush (`, ; :` at ≥ 40 chars), markdown stripping, and end-of-stream flush.
  - `vad/segmenter.ts`: test against synthetic probability sequences (no ONNX runtime required).
  - Barge-in truncation: verify `played_ms` → `spoken_text` mapping.
  - Tool executor: verify 3 s timeout and error propagation as `{ error }`.
  - Protocol: verify Zod event round trips and binary frame codec encode/decode.
  - Adapters: test against a local mock `ws` server or mocked `fetch`, including abort/cancel behavior.
- **Integration test (CI, keyless):** Replay fixture 16 kHz WAVs through the **real** Silero ONNX VAD + fake adapters (`FakeStt` with sidecar transcript, scripted `FakeLlm` with tool call, timed `FakeTts`), asserting event order, state sequence, DB rows, and a barge-in scenario.
- **Benchmarks (`scripts/bench.ts`):** Stream 20 fixture WAVs at real-time pace with real keys and output `docs/latency-report.md` (median & p90 per stage + end-to-end).
