# Phase 0 Spike — Deepgram Nova-3 Streaming STT & Groq Whisper Comparison

Standalone Node spike validating Deepgram Nova-3 streaming WebSocket transcription (`/v1/listen`), regional endpoint probing from India, realistic VAD pre-roll burst delivery vs fully real-time pacing, `Finalize` -> `from_finalize` latency, `CloseStream` metadata, warm vs fresh WebSocket connections, and interleaved comparison against Groq `whisper-large-v3-turbo` batch REST transcription on real Silero VAD v6.3 segments from `spikes/silero-vad/out/sample-16k.wav`.

## Modules

- `config.ts` — Official Deepgram doc endpoint list (`api.deepgram.com`, `api.us.deepgram.com`, `api.eu.deepgram.com`, `api.au.deepgram.com`, `api.in.deepgram.com`), `/v1/listen` query builder (`nova-3`, `linear16`, `16000 Hz`, `channels=1`, `interim_results=true`, `smart_format=true`), env loader, and pre-run Deepgram audio-minutes + Groq Whisper audio-seconds/requests quota guard (`ASH=7200 s`, `ASD=28800 s`, `RPD=2000`).
- `wav.ts` — PCM16LE mono 16 kHz RIFF/WAVE reader (`readPcm16Wav`, `parsePcm16WavBuffer`) and encoder (`encodePcm16Wav`).
- `audio-slicer.ts` — Pure turn audio slicer extracting real file audio from `(start - 100 ms)` through `(end + 576 ms)` (zero synthetic silence) in `burst_at_confirm` (`356 ms` / `11,392 B` burst at `confirm` + `20 ms` / `640 B` frames) and `realtime_paced` (`20 ms` frames from `start - 100 ms`) modes.
- `deepgram-parser.ts` — Deepgram WS JSON message parser (`Results`, `Metadata`, `UtteranceEnd`, `Error`), `DeepgramTurnAccumulator` (concatenating all `is_final` chunks for the turn; measuring `stt_final` from `Finalize` sent to `from_finalize: true` even when `from_finalize` transcript is empty), and unified `scoreTranscriptAccuracy` (normalized WER + `"1042"` order-ID check).
- `ws-client.ts` — Instrumented `ws` client with custom `http.Agent` / `https.Agent` measuring DNS, TCP, TLS, and HTTP `101` upgrade timings, capturing upgrade response headers, sending `Finalize` and `CloseStream`, and surfacing DNS/TCP/TLS/`4xx` errors cleanly.
- `whisper.ts` — Groq `whisper-large-v3-turbo` multipart/form-data batch REST client using an instrumented `undici` HTTP/2 `Agent`, measuring `request start -> transcript` as the batch equivalent of `stt_final`.
- `usage-ledger.ts` — Append-only JSONL ledger (`out/whisper-usage-ledger.jsonl`) tracking 1 h / 24 h Groq Whisper audio-seconds.
- `stats.ts` — Percentile (`median`, `p90`, `min`, `max`) helpers.
- `live.ts` — Silero VAD v6.3 segment loader, regional endpoint probe (`N=3`), pre-run quota check, and `N=10` round-robin interleaved Deepgram + Whisper live benchmark (`out/results.json`).

## Run

Copy `.env.example` to `.env` at the repo root and set `DEEPGRAM_API_KEY` and `GROQ_API_KEY`:

```powershell
pnpm --dir spikes/deepgram-stt install
pnpm --dir spikes/deepgram-stt typecheck
pnpm --dir spikes/deepgram-stt test   # 16 unit tests across 6 files (mock WS + mocked fetch; zero API keys)
pnpm --dir spikes/deepgram-stt live   # endpoint probe + N=10 interleaved Deepgram & Whisper -> out/results.json
```

## Live Benchmark Results (2026-11-28, Node `v24.19.4`, India)

### Audio Input & Silero VAD v6.3 Segments (`spikes/silero-vad/out/sample-16k.wav`)

| Segment | Utterance (`sample-16k.labels.txt`) | VAD `start` / `confirm` / `end` / `decided` | Real Audio Slice (`start - 100 ms` .. `end + 576 ms`) | Confirm Burst (`start - 100 ms` .. `confirm`) |
| --- | --- | --- | --- | --- |
| Seg #1 | `"Hello, can you check the status of order one zero four two?"` | `1024 / 1280 / 4544 / 5120 ms` | `924..5120 ms` (`4.196 s`) | `11,392 B` (`356 ms`) |
| Seg #2 | `"Thanks, what time is it right now?"` | `5728 / 5984 / 7904 / 8480 ms` | `5628..8480 ms` (`2.852 s`) | `11,392 B` (`356 ms`) |

### Deepgram Regional Endpoint Probe (`N = 3` WS opens per doc host, `0` audio sent)

| Host | Region | Status | Total Open med / p90 | DNS med | TCP med | TLS med | Upgrade med | Notable Headers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `api.deepgram.com` | Global (default) | `OK (3/3)` `HTTP 101` | `772.0 / 868.6 ms` | `1.4 ms` | `252.9 ms` | `254.3 ms` | `262.6 ms` | `dg-project-id`, `dg-request-id` |
| `api.us.deepgram.com` | United States | `OK (3/3)` `HTTP 101` | `755.8 / 809.8 ms` | `1.2 ms` | `247.6 ms` | `249.7 ms` | `257.0 ms` | `dg-project-id`, `dg-request-id` |
| `api.eu.deepgram.com` | European Union | `OK (3/3)` `HTTP 101` | `553.3 / 917.9 ms` | `1.5 ms` | `175.5 ms` | `182.3 ms` | `189.3 ms` | `dg-project-id`, `dg-request-id`, `alt-svc: h3=":8443"` |
| `api.au.deepgram.com` | Australia | `OK (3/3)` `HTTP 101` | `1358.9 / 1875.0 ms` | `1.5 ms` | `779.5 ms` | `274.9 ms` | `299.6 ms` | `dg-project-id`, `dg-request-id`, `alt-svc: h3=":8443"` |
| `api.in.deepgram.com` | **India (fastest)** | `OK (3/3)` `HTTP 101` | **`165.3 / 304.7 ms`** | `11.3 ms` | **`40.6 ms`** | **`43.6 ms`** | **`74.4 ms`** | `dg-project-id`, `dg-request-id`, `alt-svc: h3=":8443"` |

> **Region/Datacenter observation:** Deepgram's default `api.deepgram.com` resolves to US-level latency from India (`~253 ms` TCP RTT), whereas Deepgram's official India regional host `api.in.deepgram.com` responds in `40.6 ms` TCP RTT (`~6x` lower). WS upgrade headers return `dg-project-id` and `dg-request-id` (plus `alt-svc: h3=":8443";ma=60;` on `eu`/`au`/`in`), and `CloseStream` `Metadata` returns `request_id`, `duration`, `channels`, and `model_info` (`general-nova-3`, `version: 2025-04-17.21547`, `arch: nova-3`) with no explicit datacenter code header.

### Streaming Deepgram Nova-3 vs Batch Groq Whisper (`N = 10` interleaved iterations)

Pre-run quota check: Deepgram `295.4 s` (`4.92 min` vs `15.00 min` cap), Groq Whisper `70.5 s` (`20 reqs` vs `7,200 s/h` ASH, `28,800 s/d` ASD, `2,000` RPD).

| Configuration (`turns`) | Host / Endpoint | Socket / Delivery | Burst Size | `first_nonempty_interim` med / p90 | `stt_final` (or batch equiv) med / p90 | `empty from_finalize` | New Socket Rate | Accuracy (`nonEmpty` / `exactNorm` / `"1042"` / `WER med`) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Deepgram Nova-3 (`n=20`) | `api.deepgram.com` | `warm`, `burst_at_confirm` | `11,392 B` (`356 ms`) | `610.2 / 641.4 ms` | `275.0 / 298.4 ms` | `100% (20/20)` | `0.0% (0/20)` | `100%` / `100%` / `100% (10/10)` / `0.0%` |
| Deepgram Nova-3 (`n=20`) | `api.in.deepgram.com` | `warm`, `burst_at_confirm` | `11,392 B` (`356 ms`) | **`403.2 / 475.6 ms`** | **`79.8 / 119.0 ms`** | `100% (20/20)` | `0.0% (0/20)` | `100%` / `100%` / `100% (10/10)` / `0.0%` |
| Deepgram Nova-3 (`n=10`) | `api.deepgram.com` | `fresh`, `burst_at_confirm` | `11,392 B` (`356 ms`) | `553.3 / 614.8 ms` | `284.5 / 337.3 ms` | `100% (10/10)` | `100% (10/10)` (`829.4 ms` open: DNS `51.0` / TCP `254.8` / TLS `255.6` / Upgrade `267.0 ms`) | `100%` / `100%` / `100% (10/10)` / `0.0%` |
| Deepgram Nova-3 (`n=10`) | `api.in.deepgram.com` | `fresh`, `burst_at_confirm` | `11,392 B` (`356 ms`) | **`353.8 / 389.5 ms`** | **`82.8 / 122.0 ms`** | `100% (10/10)` | `100% (10/10)` (`171.0 ms` open: DNS `1.4` / TCP `44.6` / TLS `47.5` / Upgrade `76.8 ms`) | `100%` / `100%` / `100% (10/10)` / `0.0%` |
| Deepgram Nova-3 (`n=20`) | `api.in.deepgram.com` | `warm`, `realtime_paced` | `0 B` (`0 ms`) | `776.8 / 808.5 ms` | `78.9 / 99.8 ms` | `100% (20/20)` | `0.0% (0/20)` | `100%` / `100%` / `100% (10/10)` / `0.0%` |
| Groq `whisper-large-v3-turbo` (`n=20`) | `api.groq.com` (`bom` / `-MAA`, H2) | `warm` batch REST | `n/a` | **n/a (batch only — no partial captions)** | `266.3 / 272.2 ms` | `n/a` | `0.0% (0/20)` | `100%` / `100%` / `100% (10/10)` / `0.0%` |

## Key Findings for the Voice Pipeline

1. **Use `api.in.deepgram.com` (India) when hosting in India — `stt_final` drops from `275.0 ms` to `79.8 ms`:** Under `docs/ARCHITECTURE.md` §7, the `stt_final` latency budget is `<= 200 ms`. Default `api.deepgram.com` (`275.0 / 298.4 ms`) exceeds that budget by `75+ ms` due to ~253 ms US TCP RTT, whereas `api.in.deepgram.com` delivers `79.8 ms` median (`119.0 ms` p90), leaving `~120 ms` of budget headroom. Make the Deepgram WebSocket host configurable (`DEEPGRAM_HOST`, defaulting or configured to `api.in.deepgram.com` for India deployments).
2. **Pre-warming the WebSocket at `START_CALL` saves `171 ms` (`in`) to `829 ms` (`default`) per first turn:** Fresh sockets spent `171.0 ms` med (`187.8 ms` p90) on `api.in.deepgram.com` and `829.4 ms` med (`926.3 ms` p90) on `api.deepgram.com` before the first frame could be sent; warm sockets reused across multi-turn utterances incurred `0.0%` reconnects and `0 ms` connect overhead. Always send `CloseStream` on call end.
3. **Pre-roll burst at confirm cuts first-interim latency by `~374 ms`:** Sending `(start - 100 ms)` through `confirm` (`11,392 B` = `356 ms`) as one burst at VAD confirm produced first non-empty interim captions in `403.2 ms` med (`475.6 ms` p90) on `api.in.deepgram.com`, vs `776.8 ms` med (`808.5 ms` p90) when pacing from `(start - 100 ms)` at 1x real time.
4. **Concatenate all `is_final` chunks and resolve on `from_finalize` (even when empty):** Because the `576 ms` VAD silence tail is real audio streamed before `Finalize`, Deepgram already emitted the speech in earlier `is_final: true` chunks and returned an empty `from_finalize: true` response on `100%` (`80/80`) of turns. Accumulating `is_final` fragments per turn and resolving when `from_finalize: true` arrives yields `0.0%` WER and `100%` `"1042"` accuracy.
5. **Groq `whisper-large-v3-turbo` is the swap/fallback adapter, NOT primary:** Whisper achieved `100%` accuracy (`0.0%` WER, `266.3 / 272.2 ms` batch turnaround on `bom` H2), but **cannot provide partial (`interim`) captions** over a streaming socket. Keep Deepgram Nova-3 as primary streaming STT and Groq Whisper as the M2 / batch fallback & adapter-swap proof.
