# Phase 0 Spike — Groq Streaming LLM, Tool Calling & Gemini Failover

Standalone Node spike validating streaming SSE parsing, split-frame UTF-8/tool-call JSON assembly, sentence-boundary chunking (`SentenceSplitter`), `AbortController` barge-in cancellation, HTTP/1.1 vs HTTP/2 keep-alive behavior after abort, direct `undici` socket/TLS handshake timings, multi-turn tool execution loops, and live latency/reliability from India against Groq and Gemini (OpenAI-compatible endpoint).

## Modules

- `sse.ts` — Streaming byte-to-SSE parser handling `Uint8Array` chunk boundaries, multi-byte UTF-8 (`TextDecoder` `{ stream: true }`), `\r\n` / `\n`, multi-line `data:`, and `[DONE]`.
- `stream-parser.ts` — `GroqStreamAccumulator` tracking content vs `reasoning` deltas (for TTFT excluding reasoning tokens), interleaved multi-chunk tool-call argument assembly, and strict Zod validation (`get_order_status` / `get_current_time`).
- `sentence-splitter.ts` — Pure streaming sentence chunker splitting on `.`, `!`, `?` while guarding abbreviations (`Dr.`, `U.S.`, `e.g.`), decimals (`3.14`), ellipsis (`...`), and URLs/emails.
- `config.ts` — Prompts (`PROMPT_VERSION = "voice-v1"`), tool schemas, `models.json` loader with env overrides, and `.env` parser.
- `stats.ts` — Percentile (`median`, `p90`, `min`, `max`) summary helpers.
- `models.json` — Selected model IDs (overridable via `.env`).
- `live.ts` — Interleaved round-robin benchmark harness (`N = 20` per scenario), direct connector socket/DNS/TCP/TLS timing hooks, pre-run per-model request budget check, per-model rate pacing (`2.4 s` Groq / `4.1 s` Gemini), and HTTP `429` retry/backoff.

## Selected Models (`models.json`)

- **Groq Fast (`groqFast`):** `openai/gpt-oss-20b` — Smallest active general-purpose chat/tool-calling LLM on Groq (`20b`, 131k ctx).
- **Groq Reliable (`groqReliable`):** `openai/gpt-oss-120b` — Largest active general-purpose Groq LLM (`120b`, 131k ctx).
- **Groq No-Reasoning Candidate (`GROQ_MODEL_NOREASON`):** `qwen/qwen3.8-27b` — Active `27b` model (`131k` ctx) supporting `reasoning_effort: "none"` and OpenAI tool definitions per Groq docs, benchmarked with `reasoning_effort: "none"` across all scenarios.
- **Gemini Failover (`gemini`):** `models/gemini-3.5-flash-lite` — Current low-latency Gemini Flash-Lite model for pre-first-token failover on the free tier (`models/gemini-2.5-flash-lite` returned `404` deprecated for new users and directed callers to `models/gemini-3.5-flash-lite`).

## Run

Copy `.env.example` to `.env` at the repo root and set `GROQ_API_KEY` (plus `GEMINI_API_KEY` for failover):

```powershell
pnpm --dir spikes/groq-llm install
pnpm --dir spikes/groq-llm typecheck
pnpm --dir spikes/groq-llm test     # 23 pure unit tests (no API keys required)
pnpm --dir spikes/groq-llm models   # list active Groq and Gemini models
pnpm --dir spikes/groq-llm live     # run N=20 interleaved live suite -> out/results.json
```

## Live Benchmark Results (2026-11-28, Node `v24.15.0`, India)

All Groq scenarios ran in **round-robin interleaved order** (`N = 20` iterations; each iteration executed all 3 Groq models across Scenarios `A`, `B`, `B-h2`, `C-time`, `C-order`, `D-h1`, `D-h2` once) so time-of-day variance hit every model and scenario equally. Before the loop, `live.ts` verified daily request budget per model (`220` loop requests each vs `x-ratelimit-remaining-requests` from `POST /chat/completions`, because Groq's `GET /models` returns no `x-ratelimit-*` headers: `828/1000`, `857/1000`, `986/1000` remaining).

### Network Baselines & Derived Model Time (`n = 10` baseline probes, `n = 20` warm TTFT)

| Host / Model | Edge | Edge RTT med / p90 (`n=10`) | Origin `/models` RTT med / p90 (`n=10`) | Warm H1 TTFT med (`n=20`) | Warm H2 TTFT med (`n=20`) | `model time ≈ warm TTFT − origin RTT` |
| --- | --- | --- | --- | --- | --- | --- |
| Groq `openai/gpt-oss-20b` (`reasoning=low`) | `-MAA` | `45.4 / 55.6 ms` | `310.9 / 318.0 ms` | `435.5 ms` | `464.8 ms` | `124.5 ms` (H1) / `153.8 ms` (H2) |
| Groq `openai/gpt-oss-120b` (`reasoning=low`) | `-MAA` | `45.4 / 55.6 ms` | `310.9 / 318.0 ms` | `486.3 ms` | `450.6 ms` | `175.4 ms` (H1) / `139.7 ms` (H2) |
| Groq `qwen/qwen3.8-27b` (`reasoning=none`) | `-MAA` | `45.4 / 55.6 ms` | `310.9 / 318.0 ms` | `169.9 ms` | `176.4 ms` | `-141.0 ms` (H1) / `-134.5 ms` (H2)* |
| Gemini `models/gemini-3.5-flash-lite` (`thinking=minimal`) | `none` | `30.2 / 37.2 ms` | `118.5 / 180.0 ms` | `836.0 ms` | — | `717.5 ms` (H1) |

*\*`qwen/qwen3.8-27b` warm TTFT (`169.9 ms`) is lower than Groq `GET /models` RTT (`310.9 ms`), yielding a negative difference: `/models` hits a ~311 ms control-plane origin while `qwen/qwen3.8-27b` inference appears routed to a closer POP/region (~80 ms server `queue_time + prompt_time` observed in a spot SSE trace).*

### Plain & Connection Timing Scenarios (`A`, `B`, `B-h2`; `n = 20` per row)

| Target | Settings | Scenario (`n`) | TTFT med / p90 | FirstSent(abs) med / p90 | FirstSent(rel) med / p90 | New Socket Rate | DNS / TCP / TLS med (new sockets) | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `openai/gpt-oss-20b` | `reasoning=low`, `parsed` | A: Cold H1 (`n=20`) | `575.8 / 662.9 ms` | `591.3 / 681.7 ms` | `19.2 / 22.0 ms` | `100.0% (20/20)` | `1.5 / 48.3 / 51.6 ms` | `22` reasoning tok, `0/20` wrong tools |
| `openai/gpt-oss-20b` | `reasoning=low`, `parsed` | B: Warm H1 (`n=20`) | `435.5 / 494.0 ms` | `454.5 / 513.1 ms` | `18.3 / 20.8 ms` | `0.0% (0/20)` | — (reused) | `22` reasoning tok, `0/20` wrong tools |
| `openai/gpt-oss-20b` | `reasoning=low`, `parsed` | B-h2: Warm H2 (`n=20`) | `464.8 / 492.3 ms` | `481.7 / 516.2 ms` | `21.5 / 26.1 ms` | `0.0% (0/20)` | — (reused) | `22` reasoning tok, `0/20` wrong tools |
| `openai/gpt-oss-120b` | `reasoning=low`, `parsed` | A: Cold H1 (`n=20`) | `584.2 / 620.4 ms` | `629.4 / 657.5 ms` | `45.9 / 50.0 ms` | `100.0% (20/20)` | `1.6 / 48.3 / 53.3 ms` | `8` reasoning tok, `0/20` wrong tools |
| `openai/gpt-oss-120b` | `reasoning=low`, `parsed` | B: Warm H1 (`n=20`) | `486.3 / 509.1 ms` | `525.7 / 548.0 ms` | `43.7 / 49.6 ms` | `0.0% (0/20)` | — (reused) | `8` reasoning tok, `0/20` wrong tools |
| `openai/gpt-oss-120b` | `reasoning=low`, `parsed` | B-h2: Warm H2 (`n=20`) | `450.6 / 495.1 ms` | `488.8 / 545.2 ms` | `48.2 / 50.5 ms` | `0.0% (0/20)` | — (reused) | `8` reasoning tok, `0/20` wrong tools |
| `qwen/qwen3.8-27b` | `reasoning=none` | A: Cold H1 (`n=20`) | `278.8 / 313.5 ms` | `366.0 / 470.1 ms` | `66.8 / 152.7 ms` | `100.0% (20/20)` | `5.3 / 48.4 / 52.2 ms` | `0` reasoning tok, `0/20` wrong tools |
| `qwen/qwen3.8-27b` | `reasoning=none` | B: Warm H1 (`n=20`) | `169.9 / 210.5 ms` | `244.4 / 334.3 ms` | `57.6 / 113.0 ms` | `0.0% (0/20)` | — (reused) | `0` reasoning tok, `0/20` wrong tools |
| `qwen/qwen3.8-27b` | `reasoning=none` | B-h2: Warm H2 (`n=20`) | `176.4 / 296.6 ms` | `263.9 / 368.2 ms` | `76.8 / 103.8 ms` | `0.0% (0/20)` | — (reused) | `0` reasoning tok, `0/20` wrong tools |
| `models/gemini-3.5-flash-lite` | `thinking=minimal` | B: Warm H1 (`n=20`) | `836.0 / 886.9 ms` | `836.9 / 888.4 ms` | `0.5 / 1.5 ms` | `0.0% (0/20)` | — (reused) | `0` reasoning tok, `0/20` wrong tools |

### Scenario C: Full Tool Execution Loop by Utterance (`n = 20` per row, warm H1)

| Target | Utterance (`n`) | Expected Tool | Correctness | Follow-up OK | Pre-Tool Filler | `t_toolcall` med / p90 | `t_exec` med / p90 | `followup_ttft` med / p90 | `e2e` med / p90 | New Sockets (req1 / req2) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `openai/gpt-oss-20b` | `"What time is it?"` (`n=20`) | `get_current_time` | `100.0% (20/20)` | `100.0% (20/20)` | `0.0% (0/20)` | `484.0 / 491.8 ms` | `0.4 / 0.5 ms` | `451.0 / 473.6 ms` | `840.1 / 965.4 ms` | `0/20` / `0/20` |
| `openai/gpt-oss-20b` | `"order one zero four two"` (`n=20`) | `get_order_status` (`"1042"`) | `100.0% (20/20)` | `100.0% (20/20)` | `0.0% (0/20)` | `468.7 / 501.9 ms` | `0.0 / 0.0 ms` | `454.3 / 575.3 ms` | `826.4 / 1075.8 ms` | `0/20` / `0/20` |
| `openai/gpt-oss-120b` | `"What time is it?"` (`n=20`) | `get_current_time` | `100.0% (20/20)` | `100.0% (20/20)` | `0.0% (0/20)` | `476.0 / 536.7 ms` | `0.3 / 0.5 ms` | `412.1 / 466.5 ms` | `862.2 / 992.0 ms` | `0/20` / `0/20` |
| `openai/gpt-oss-120b` | `"order one zero four two"` (`n=20`) | `get_order_status` (`"1042"`) | `100.0% (20/20)` | `100.0% (20/20)` | `0.0% (0/20)` | `523.2 / 564.9 ms` | `0.0 / 0.0 ms` | `405.5 / 465.4 ms` | `913.1 / 1003.7 ms` | `0/20` / `0/20` |
| `qwen/qwen3.8-27b` | `"What time is it?"` (`n=20`) | `get_current_time` | `0.0% (0/20)` | `0.0% (0/20)` | `0.0% (0/20)` | `n/a` | `n/a` | `n/a` | `n/a` | `0/20` / `0/0` |
| `qwen/qwen3.8-27b` | `"order one zero four two"` (`n=20`) | `get_order_status` (`"1042"`) | `0.0% (0/20)` | `0.0% (0/20)` | `0.0% (0/20)` | `n/a` | `n/a` | `n/a` | `n/a` | `0/20` / `0/0` |

### Scenario D: Post-Abort Cancellation (`n = 20` per row, H1 vs Warm H1 and H2 vs Warm H2)

| Target | Scenario (`n`) | Baseline Used (`n=20`) | Post-Abort TTFT med / p90 | Delta vs Warm med | Reconnect Rate | Follow-up DNS / TCP / TLS med | Max Deltas After Abort |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `openai/gpt-oss-20b` | D-h1: Cancel H1 (`n=20`) | B: Warm H1 (`435.5 ms`) | `570.2 / 610.2 ms` | `+134.8 ms` | `100.0% (20/20)` | `1.3 / 42.0 / 44.7 ms` | `0` |
| `openai/gpt-oss-20b` | D-h2: Cancel H2 (`n=20`) | B-h2: Warm H2 (`464.8 ms`) | `438.8 / 491.4 ms` | `-26.0 ms` | `0.0% (0/20)` | — (reused) | `0` |
| `openai/gpt-oss-120b` | D-h1: Cancel H1 (`n=20`) | B: Warm H1 (`486.3 ms`) | `575.8 / 609.6 ms` | `+89.5 ms` | `100.0% (20/20)` | `1.5 / 41.9 / 44.5 ms` | `0` |
| `openai/gpt-oss-120b` | D-h2: Cancel H2 (`n=20`) | B-h2: Warm H2 (`450.6 ms`) | `443.7 / 495.3 ms` | `-6.9 ms` | `0.0% (0/20)` | — (reused) | `0` |
| `qwen/qwen3.8-27b` | D-h1: Cancel H1 (`n=20`) | B: Warm H1 (`169.9 ms`) | `284.9 / 343.8 ms` | `+114.9 ms` | `100.0% (20/20)` | `1.5 / 45.5 / 48.9 ms` | `0` |
| `qwen/qwen3.8-27b` | D-h2: Cancel H2 (`n=20`) | B-h2: Warm H2 (`176.4 ms`) | `178.6 / 265.1 ms` | `+2.2 ms` | `0.0% (0/20)` | — (reused) | `0` |

## Key Findings for the Voice Pipeline

1. **India → US origin RTT dominates plain and tool TTFT:** Groq `/models` origin RTT from India is `310.9 ms` median (`p90 = 318.0 ms`) despite a `45.4 ms` `-MAA` edge RTT. Warm TTFT for both `gpt-oss` models lands at `435.5–486.3 ms` median (over the `350 ms` US-colocated budget), with estimated model time around `~125–175 ms`.
2. **HTTP/2 (`allowH2: true`, `connections: 1`) eliminates barge-in reconnect penalties:** Aborting an active HTTP/1.1 SSE stream forced a full TCP+TLS reconnect on `100%` (`60/60`) of follow-up turns (`~88–96 ms` DNS+TCP+TLS handshake; `+89.5` to `+134.8 ms` median TTFT penalty vs Warm H1). HTTP/2 cancelled via `RST_STREAM` with `0%` (`0/60`) reconnects, `0` post-abort deltas, and `-26.0` to `+2.2 ms` median delta vs Warm H2. Note also that `undici.Agent` defaults to `connections: null`, which can open an extra socket on `0 ms`-gap back-to-back requests while stream teardown finishes; setting `connections: 1` kept warm socket reuse at `0/20` new sockets across all warm and tool scenarios.
3. **`gpt-oss-20b` vs `gpt-oss-120b` trade-off is small:** With `N = 20` interleaved runs, `gpt-oss-20b` was faster on Warm H1 (`435.5` vs `486.3 ms`) and had faster `FirstSent(rel)` (`18.3–21.5 ms` vs `43.7–48.2 ms`), whereas Warm H2 TTFT was slightly lower on `120b` (`450.6` vs `464.8 ms`). Both achieved `100%` (`20/20` on both `time` and `order`) tool accuracy with `0/40` pre-tool filler.
4. **Tool turns add a second origin round trip (`~826–913 ms` E2E median):** Across both `gpt-oss` models, request 1 tool-call assembly (`~469–523 ms`) + local execution (`<1 ms`) + request 2 follow-up TTFT (`~406–454 ms`) puts first real spoken content at `826.4–913.1 ms` median (`p90 965–1076 ms`) with `0%` pre-tool filler text.
5. **`qwen/qwen3.8-27b` (`reasoning=none`) failed tool-calling under the voice prompt:** Although it had the lowest plain-text TTFT (`169.9 ms` H1, `176.4 ms` H2, `0` reasoning tokens), it returned `0.0% (0/20)` tool calls on both `"What time is it?"` and `"order one zero four two"`, replying in plain text (e.g., `"I'm checking the status of order 1042 for you right now."`) with `finish_reason: "stop"` instead of invoking tools. It cannot be used for tool-enabled voice turns under `voice-v1` without prompt/mode changes.
6. **Gemini failover:** `models/gemini-3.5-flash-lite` (`thinking=minimal`, `0` reasoning tokens, `n=20`) streamed cleanly at `836.0 ms` median TTFT (`p90 = 886.9 ms`, `0.5 ms` first-sentence delta), confirming its role as a reliable pre-first-token failover.
