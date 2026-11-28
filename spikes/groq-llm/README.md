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
- **Groq No-Reasoning Candidate (`GROQ_MODEL_NOREASON`):** `qwen/qwen3.8-27b` — **Preview** `27b` model (`131k` ctx) supporting Local/Remote & Parallel Tool Use and `reasoning_effort` options `none` (default), `default` (returns 0 reasoning tokens on Groq), `low`, `medium`, `high` (`minimal` returns HTTP 400). Benchmarked primarily with `reasoning_effort: "none"`, plus a Task 3c tool-calling diagnosis across `"none"`, `tool_choice: "required"`, and `reasoning_effort: "low"`.
- **Gemini Failover (`gemini`):** `models/gemini-3.5-flash-lite` — Current low-latency Gemini Flash-Lite model for pre-first-token failover on the free tier (`models/gemini-2.5-flash-lite` returned `404` deprecated for new users and directed callers to `models/gemini-3.5-flash-lite`).

## Run

Copy `.env.example` to `.env` at the repo root and set `GROQ_API_KEY` (plus `GEMINI_API_KEY` for failover):

```powershell
pnpm --dir spikes/groq-llm install
pnpm --dir spikes/groq-llm typecheck
pnpm --dir spikes/groq-llm test              # 24 pure unit tests (no API keys required)
pnpm --dir spikes/groq-llm models            # list active Groq and Gemini models
pnpm --dir spikes/groq-llm live              # run N=20 interleaved live suite -> out/results.json
pnpm --dir spikes/groq-llm exec tsx live.ts --task3c  # N=10 server-timing split + qwen tool diagnosis -> out/task3c-results.json
```

## Live Benchmark Results (2026-11-28, Node `v24.15.0`, India)

All Groq scenarios ran in **round-robin interleaved order** (`N = 20` iterations; each iteration executed all 3 Groq models across Scenarios `A`, `B`, `B-h2`, `C-time`, `C-order`, `D-h1`, `D-h2` once) so time-of-day variance hit every model and scenario equally. Before the loop, `live.ts` verified daily request budget per model (`220` loop requests each vs `x-ratelimit-remaining-requests` from `POST /chat/completions`, because Groq's `GET /models` returns no `x-ratelimit-*` headers: `828/1000`, `857/1000`, `986/1000` remaining).

### Control-Plane RTT vs Inference Server-Side Timing Split (`n = 10` fresh Warm H2)

> **Why `warm TTFT − /models RTT` was replaced:** Groq `GET /models` (`med = 299.8 ms`, `p90 = 309.3 ms` in Task 3c; `310.9 / 318.0 ms` in Task 3b) is a **control-plane RTT (not the inference path)**. Live chat completions return header `x-groq-region: bom` (Mumbai, edge `cf-ray: ...-MAA`) and stream server-side timings in both `usage` and `x_groq.usage` (`queue_time`, `prompt_time`, `completion_time`, `total_time` in seconds). Gemini responses return `server-timing: gfet4t7; dur=...` HTTP headers (`486–989 ms`) and no `queue_time`/`prompt_time` fields in stream `usage`, so no pre-first-token server/network split is derived for Gemini.

| Host / Model | Region / Edge | Control-plane `/models` RTT (`n=10`, not inference) | `FirstToken(any)` med / p90 (`n=10` H2) | `TTFT(content)` med / p90 (`n=10` H2) | Server `queue` / `prompt` med | Server pre-token (`queue+prompt`) med | Server pre-content est (`+reasoning`) med | Network ≈ `FirstToken − (queue+prompt)` med / p90 | Network ≈ `TTFT − preContentEst` med / p90 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Groq `openai/gpt-oss-20b` (`reasoning=low`) | `bom` / `-MAA` | `299.8 / 309.3 ms` | `427.5 / 472.3 ms` | `453.2 / 499.9 ms` | `326.8 / 12.8 ms` | `339.1 ms` | `360.5 ms` | `87.8 / 91.5 ms` | `93.1 / 96.8 ms` |
| Groq `openai/gpt-oss-120b` (`reasoning=low`) | `bom` / `-MAA` | `299.8 / 309.3 ms` | `420.9 / 479.2 ms` | `446.9 / 506.8 ms` | `317.9 / 11.2 ms` | `329.4 ms` | `345.1 ms` | `91.6 / 94.2 ms` | `102.9 / 105.2 ms` |
| Groq `qwen/qwen3.8-27b` (`reasoning=none`) | `bom` / `-MAA` | `299.8 / 309.3 ms` | `195.2 / 360.6 ms` | `195.2 / 360.6 ms` | `60.3 / 42.4 ms` | `104.3 ms` | `104.3 ms` | `90.0 / 91.9 ms` | `90.0 / 91.9 ms` |
| Gemini `models/gemini-3.5-flash-lite` (`thinking=minimal`, H1) | `none` | `113.5 / 196.2 ms` | `615.5 / 763.8 ms` | `615.5 / 763.8 ms` | — (unavailable in `usage`) | — | — | — | — |

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

### `qwen/qwen3.8-27b` Tool-Call Diagnosis (`n = 10` per variant, warm H2)

Groq docs classify `qwen/qwen3.8-27b` as a **Preview** model with Local/Remote and Parallel Tool Use support; `reasoning_effort` accepts `none` (default), `default` (returns 0 reasoning tokens on Groq), `low`, `medium`, `high` (`minimal` returns HTTP 400 `"invalid Qwen3.8 reasoning_effort"`), and `reasoning_format: "raw"` is rejected (`400`) when tools are enabled. Inspecting the request body confirmed `tools` was sent (`tool_choice` defaulted to `"auto"` in 3b and was explicitly set to `"auto"` / `"required"` in 3c). When refusing to call tools in variant (i), `qwen` did **not** invent a time or order status—it asked for a timezone/location on `C-time` and narrated `"I'm checking the status of order 1042 for you right now."` (`finish_reason: "stop"`) on `C-order`.

| Variant | Scenario (`n`) | Correctness | Pre-Tool Filler | `req1` FirstToken / TTFT med | `t_toolcall` med / p90 | `followup_ttft` med / p90 | `e2e` med / p90 | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| (i) `reasoning=none`, `tool_choice=auto` | `C-time` (`n=10`) | `0.0% (0/10)` | `0.0% (0/10)` | `192.0 / 192.0 ms` | `n/a` | `n/a` | `n/a` | Plain text asking for timezone (`no_tool_call`) |
| (i) `reasoning=none`, `tool_choice=auto` | `C-order` (`n=10`) | `0.0% (0/10)` | `0.0% (0/10)` | `185.4 / 185.4 ms` | `n/a` | `n/a` | `n/a` | Plain text narrating check (`no_tool_call`) |
| (ii) `reasoning=none`, `tool_choice=required` | `C-time` (`n=10`) | `100.0% (10/10)` | `0.0% (0/10)` | `250.7 ms` / `n/a` | `252.2 / 273.6 ms` | `185.6 / 225.2 ms` | `446.0 / 538.0 ms` | `req2` used `tool_choice="auto"` |
| (ii) `reasoning=none`, `tool_choice=required` | `C-order` (`n=10`) | `100.0% (10/10)` | `0.0% (0/10)` | `339.3 ms` / `n/a` | `343.5 / 398.5 ms` | `195.4 / 200.4 ms` | `536.7 / 596.1 ms` | `req2` used `tool_choice="auto"` |
| (iii) `reasoning=low` (lowest active), `tool_choice=auto` | `C-time` (`n=10`) | `0.0% (0/10)` | `0.0% (0/10)` | `197.6 / 197.6 ms` | `n/a` | `n/a` | `n/a` | Still plain text asking for timezone (`0` reasoning tok) |
| (iii) `reasoning=low` (lowest active), `tool_choice=auto` | `C-order` (`n=10`) | `100.0% (10/10)` | `100.0% (10/10)` | `200.8 / 200.8 ms` | `381.3 / 437.5 ms` | `194.6 / 212.9 ms` | `582.4 / 650.2 ms` | Emitted `"Let me check that for you right away.\n\n"` before tool call |

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

1. **Inference runs in `bom` (~88–92 ms network RTT); `gpt-oss` TTFT is queue-bound on free tier:** Groq `/models` (`299.8–310.9 ms`) hits a control-plane origin, whereas chat completions run in `x-groq-region: bom` with `~87.8–91.6 ms` network RTT (`FirstToken − (queue_time + prompt_time)`). On the free tier, `openai/gpt-oss-20b` (`326.8 ms`) and `openai/gpt-oss-120b` (`317.9 ms`) spend most of their `~447–453 ms` H2 TTFT in server `queue_time` (`qwen/qwen3.8-27b` had `60.3 ms` queue time and `195.2 ms` H2 TTFT).
2. **HTTP/2 (`allowH2: true`) eliminates barge-in reconnect penalties:** Aborting an active HTTP/1.1 SSE stream forced a full TCP+TLS reconnect on `100%` (`60/60`) of follow-up turns (`~88–96 ms` DNS+TCP+TLS handshake; `+89.5` to `+134.8 ms` median TTFT penalty vs Warm H1). HTTP/2 cancelled via `RST_STREAM` with `0%` (`0/60`) reconnects, `0` post-abort deltas, and `-26.0` to `+2.2 ms` median delta vs Warm H2. Note that `connections: 1` in this spike is a **benchmark setting only** (to prevent `undici.Agent` from opening an extra socket during `0 ms` back-to-back stream teardown); **production uses an HTTP/2 agent for multiplexing** (`allowH2: true` without `connections: 1`).
3. **`gpt-oss-120b` primary, `gpt-oss-20b` same-provider fallback:** With `N = 20` interleaved runs, latency between `120b` and `20b` is effectively tied (Warm H2 TTFT `450.6` vs `464.8 ms`; Warm H1 `486.3` vs `435.5 ms`), and both achieved `100%` (`20/20` on both `time` and `order`) tool accuracy with `0/40` pre-tool filler. `openai/gpt-oss-120b` is chosen as primary (larger model at tied latency), with `openai/gpt-oss-20b` as same-provider fallback.
4. **Tool turns add a second round trip (`~826–913 ms` E2E median on `gpt-oss`):** Across both `gpt-oss` models, request 1 tool-call assembly (`~469–523 ms`) + local execution (`<1 ms`) + request 2 follow-up TTFT (`~406–454 ms`) puts first real spoken content at `826.4–913.1 ms` median (`p90 965–1076 ms`) with `0%` pre-tool filler text.
5. **`qwen/qwen3.8-27b` is unsuitable for tool-enabled voice turns:** It is a **Preview** model that failed `0/10` (`C-time`) and `0/10` (`C-order`) under `"auto"`/`"none"` (and `0/40` in Task 3b). Switching to `reasoning_effort="low"` (the lowest active non-`none` setting) still failed `0/10` on `C-time` and emitted `100%` (`10/10`) pre-tool filler (`"Let me check that for you right away.\n\n"`) on `C-order`. `tool_choice="required"` forced `100%` (`10/10`) tool calls (`446.0 / 536.7 ms` e2e), but cannot be enabled globally when conversational turns should not call tools.
6. **Gemini failover:** `models/gemini-3.5-flash-lite` (`thinking=minimal`, `0` reasoning tokens) streamed cleanly at `836.0 ms` median TTFT (`n=20`, Task 3b) / `615.5 ms` (`n=10`, Task 3c) with `0.5–0.6 ms` first-sentence delta, confirming its role as a reliable pre-first-token failover.
