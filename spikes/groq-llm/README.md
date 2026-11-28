# Phase 0 Spike — Groq Streaming LLM, Tool Calling & Gemini Failover

Standalone Node spike validating streaming SSE parsing, split-frame UTF-8/tool-call JSON assembly, sentence-boundary chunking (`SentenceSplitter`), `AbortController` barge-in cancellation, HTTP/1.1 vs HTTP/2 keep-alive behavior after abort, and live latency/reliability from India against Groq and Gemini (OpenAI-compatible endpoint).

## Modules

- `sse.ts` — Streaming byte-to-SSE parser handling `Uint8Array` chunk boundaries, multi-byte UTF-8 (`TextDecoder` `{ stream: true }`), `\r\n` / `\n`, multi-line `data:`, and `[DONE]`.
- `stream-parser.ts` — `GroqStreamAccumulator` tracking content vs `reasoning` deltas (for TTFT excluding reasoning tokens), interleaved multi-chunk tool-call argument assembly, and strict Zod validation (`get_order_status` / `get_current_time`).
- `sentence-splitter.ts` — Pure streaming sentence chunker splitting on `.`, `!`, `?` while guarding abbreviations (`Dr.`, `U.S.`, `e.g.`), decimals (`3.14`), ellipsis (`...`), and URLs/emails.
- `config.ts` — Prompts (`PROMPT_VERSION = "voice-v1"`), tool schemas, `models.json` loader with env overrides, and `.env` parser.
- `stats.ts` — Percentile (`median`, `p90`, `min`, `max`) summary helpers.
- `models.json` — Selected model IDs (overridable via `.env`).
- `live.ts` — Live benchmark harness (`--list-models` and full Scenarios A–D + Gemini Scenario B), rate-limit pacing (`2.1 s` Groq / `4.1 s` Gemini), and HTTP `429` retry/backoff.

## Selected Models (`models.json`)

- **Groq Fast (`groqFast`):** `openai/gpt-oss-20b` — Smallest active general-purpose chat/tool-calling LLM on Groq (`20b`, 131k ctx) for lowest latency.
- **Groq Reliable (`groqReliable`):** `openai/gpt-oss-120b` — Largest active general-purpose Groq LLM (`120b`, 131k ctx) for highest tool-calling accuracy and reasoning reliability.
- **Gemini Failover (`gemini`):** `models/gemini-3.5-flash-lite` — Current low-latency Gemini Flash-Lite model for pre-first-token failover on the free tier (`models/gemini-2.5-flash-lite` returned `404` deprecated for new users and directed callers to `models/gemini-3.5-flash-lite`).

## Run

Copy `.env.example` to `.env` at the repo root and set `GROQ_API_KEY` (plus `GEMINI_API_KEY` for failover):

```powershell
pnpm --dir spikes/groq-llm install
pnpm --dir spikes/groq-llm typecheck
pnpm --dir spikes/groq-llm test     # 22 pure unit tests (no API keys required)
pnpm --dir spikes/groq-llm models   # list active Groq and Gemini models
pnpm --dir spikes/groq-llm live     # run full live latency/tool/abort suite -> out/results.json
```

## Live Benchmark Results (2026-11-28, Node `v24.15.0`, India)

### Network Baselines
- **Groq (`api.groq.com`, Cloudflare edge `-MAA`, `h1`):** TCP edge RTT `med = 48.7 ms`, `p90 = 50.9 ms` | warm `GET /models` origin RTT `med = 301.3 ms`, `p90 = 315.7 ms`.
- **Gemini (`generativelanguage.googleapis.com`, `h1`):** TCP edge RTT `med = 34.5 ms`, `p90 = 44.3 ms` | warm `GET /models` origin RTT `med = 128.2 ms`, `p90 = 135.1 ms`.

### Scenarios A–D (Groq) & Scenario B (Gemini Failover)

| Target | Settings | Scenario | TTFT med / p90 | FirstSent(abs) med / p90 | FirstSent(rel) med / p90 | Total med / p90 | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `openai/gpt-oss-20b` (FAST) | `reasoning=low`, `format=parsed` | A: Cold (`n=10`, `h1`) | `508.7 / 585.5 ms` | `528.5 / 604.4 ms` | `17.0 / 21.1 ms` | `548.0 / 623.0 ms` | `22` reasoning tok, `0/10` wrong tools |
| `openai/gpt-oss-20b` (FAST) | `reasoning=low`, `format=parsed` | B: Warm (`n=10`, `h1`) | `486.7 / 499.3 ms` | `512.8 / 522.4 ms` | `22.7 / 29.5 ms` | `526.0 / 538.9 ms` | `22` reasoning tok, `0/10` wrong tools |
| `openai/gpt-oss-20b` (FAST) | `reasoning=low`, `format=parsed` | C: Tool (`n=20`, `h1`) | — | — | — | `485.6 / 505.0 ms` | `20/20` (`100%`) `order_id=1042`, `0/20` filler |
| `openai/gpt-oss-20b` (FAST) | `reasoning=low`, `format=parsed` | D: Cancel H1 (`n=5`, `h1`) | `489.8 / 582.8 ms` | — | — | — | `delta +3.1 ms`, `5/5 (100%)` reconnects, `0` post-abort deltas |
| `openai/gpt-oss-20b` (FAST) | `reasoning=low`, `format=parsed` | D: Cancel H2 (`n=5`, `h2`) | `497.0 / 524.8 ms` | — | — | — | `delta +10.3 ms`, `0/5 (0%)` reconnects, `0` post-abort deltas |
| `openai/gpt-oss-120b` (RELIABLE) | `reasoning=low`, `format=parsed` | A: Cold (`n=10`, `h1`) | `540.8 / 615.7 ms` | `586.6 / 659.3 ms` | `45.1 / 48.2 ms` | `622.3 / 694.9 ms` | `8` reasoning tok, `0/10` wrong tools |
| `openai/gpt-oss-120b` (RELIABLE) | `reasoning=low`, `format=parsed` | B: Warm (`n=10`, `h1`) | `397.9 / 504.5 ms` | `429.4 / 550.3 ms` | `43.1 / 53.7 ms` | `443.1 / 586.6 ms` | `9` reasoning tok, `0/10` wrong tools |
| `openai/gpt-oss-120b` (RELIABLE) | `reasoning=low`, `format=parsed` | C: Tool (`n=20`, `h1`) | — | — | — | `487.4 / 539.4 ms` | `20/20` (`100%`) `order_id=1042`, `0/20` filler |
| `openai/gpt-oss-120b` (RELIABLE) | `reasoning=low`, `format=parsed` | D: Cancel H1 (`n=5`, `h1`) | `386.6 / 546.0 ms` | — | — | — | `delta -11.3 ms`, `5/5 (100%)` reconnects, `0` post-abort deltas |
| `openai/gpt-oss-120b` (RELIABLE) | `reasoning=low`, `format=parsed` | D: Cancel H2 (`n=5`, `h2`) | `498.4 / 520.6 ms` | — | — | — | `delta +100.5 ms`, `0/5 (0%)` reconnects, `0` post-abort deltas |
| `models/gemini-3.5-flash-lite` (FAILOVER) | `thinking=minimal` | B: Warm (`n=10`, `h1`) | `844.4 / 988.5 ms` | `845.6 / 989.1 ms` | `0.5 / 2.1 ms` | `867.3 / 1011.9 ms` | `0` reasoning tok, `0/10` wrong tools |

## Key Findings for the Voice Pipeline

1. **India → US origin RTT dominates the `350 ms` LLM budget:** Groq edge RTT (`-MAA`) is only `48.7 ms`, but `GET /models` origin RTT is `301.3 ms` (`p90 = 315.7 ms`). Warm TTFT lands at `397.9–486.7 ms` median (`~50–135 ms` over the `350 ms` US-colocated budget), confirming the RTT risk noted in `docs/ARCHITECTURE.md`.
2. **Use HTTP/2 (`allowH2: true`) for barge-in safety:** Aborting an active SSE stream on HTTP/1.1 forces connection teardown (`100%` reconnect rate on the next turn), whereas HTTP/2 cancels the stream via `RST_STREAM` with `0%` socket reconnects and `0` post-abort deltas leaked.
3. **Reasoning token overhead matters:** Both `openai/gpt-oss-20b` and `openai/gpt-oss-120b` require `reasoning_effort: "low"` (rejecting `"none"`/`"minimal"`). `gpt-oss-120b` spent fewer reasoning tokens (`8–9` vs `22`), giving it the fastest warm TTFT (`397.9 ms` median), while `gpt-oss-20b` produced slightly faster first-sentence completion after TTFT (`22.7 ms` vs `43.1 ms` rel) and tighter p90 (`499.3 ms`).
4. **Tool calling is clean:** Both Groq models achieved `100%` (`20/20`) valid `get_order_status` calls for spoken `"one zero four two"` → `"1042"` with `0%` pre-tool filler text.
5. **Groq free-tier rate limits:** Observed `30 RPM` (`1,000 RPD`, `8,000 TPM`) per model via `x-ratelimit-*` headers; unpaced bursts hit `429` at request 31, avoided by `2.1 s` pacing and `429` backoff.
6. **Gemini failover:** `models/gemini-3.5-flash-lite` (`thinking=minimal`, `0` reasoning tokens) streams cleanly through the OpenAI-compatible endpoint (`844.4 ms` warm TTFT median), making it a solid pre-first-token failover target.
