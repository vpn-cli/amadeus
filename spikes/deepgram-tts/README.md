# Phase 0 Spike — Deepgram Aura-2 Streaming TTS (`/v1/speak`)

Standalone Node spike validating Deepgram Aura-2 (`aura-2-thalia-en`) streaming WebSocket TTS (`/v1/speak`, `linear16` `24000 Hz` mono) vs REST `POST /v1/speak` (`container=none`), comparing `api.in.deepgram.com` (India) and `api.deepgram.com` (Global/US), warm vs fresh sockets, `Speak`+`Flush` latency, continuous playback timeline & underruns (`J = 0 ms` vs `J = 100 ms`), barge-in `Clear`/`Cleared` & same-socket survival, idle timeout/`KeepAlive` behavior, and raw PCM format checks.

## Modules

- `config.ts` — Endpoint definitions (`api.in.deepgram.com`, `api.deepgram.com`), `/v1/speak` WS and REST (`container=none`) URL builders (`aura-2-thalia-en`, `linear16`, `24000 Hz`), env loader, and pre-run character budget guard (`DEEPGRAM_TTS_MAX_CHARS`, default `25000`).
- `tts-parser.ts` — Zod schemas & parser for client (`Speak`, `Flush`, `Clear`, `Close`) and server (`Metadata`, `Flushed`, `Cleared`, `Warning`, `Error`) messages, explicit `Warning`/`Error` classifier (`flush_rate_limit`, `char_throughput`, `text_length`, `no_active_speech`, `unsupported_message`, etc.), and `TtsTurnStateMachine` (`idle` -> `streaming` -> `flushing` -> `discarding` post-`Clear` audio until `Cleared` -> `idle`).
- `timeline.ts` — Pure 24 kHz mono PCM16LE (`48 B/ms`) playback timeline & underrun calculator (`computePlaybackTimeline` starting at `t_first_audio + J` for `J = 0 ms` and `J = 100 ms`, `firstChunkMs`, `streamRtf`) and `checkRawPcm24kFormat` (no `RIFF`/`WAVE` header, even byte length, plausible duration).
- `wav.ts` — 24 kHz mono PCM16LE RIFF/WAVE encoder (`encodePcm16Wav`, `writePcm16Wav`, `parseWavHeader`).
- `ws-client.ts` — Instrumented `ws` client measuring DNS/TCP/TLS/HTTP-101 upgrade timings, rolling-window `FlushRateLimiter` (`18 Flushes / 62 s`), `synthesizeTurn`, `streamTwoSentences` (`50 ms` / `300 ms` gaps), `runBargeInClear`, `probePing`, `probeJsonControl`, and `waitForIdleClose`.
- `rest-client.ts` — Warm `undici` `Agent` `POST /v1/speak` client tracking `newSocket`, headers RTT, streaming TTFB, total body time, and playback timeline.
- `stats.ts` — Distribution summary helpers (`min`, `median`, `p90`, `max`).
- `live.ts` — Preflight char budget guard, WS+REST capability probe, `N = 10` round-robin interleaved benchmark (`2a`–`2f`), WAV exports in `out/`, and JSON report (`out/results.json`).

## Run

Copy `.env.example` to `.env` at the repo root and set `DEEPGRAM_API_KEY`:

```powershell
pnpm --dir spikes/deepgram-tts install
pnpm --dir spikes/deepgram-tts typecheck
pnpm --dir spikes/deepgram-tts exec vitest run --reporter=verbose   # 25 unit tests across 6 files (zero API keys)
pnpm --dir spikes/deepgram-tts live                                  # N=10 interleaved WS & REST -> out/results.json + out/*.wav
```

## Live Benchmark Results (2026-11-28, Node `v24.15.0`, India, `aura-2-thalia-en`)

- **Preflight char budget:** `16,434` planned chars (`probe=12`, `2a=5840`, `2b=4640`, `2c=2920`, `2e_warmup=56`, `2e=2920`, `manual_wav=46`) vs `DEEPGRAM_TTS_MAX_CHARS = 25000` (`$0.4930` est @ `$0.030 / 1k` vs `$200` free credit).
- **Host capability:** Both `api.in.deepgram.com` and `api.deepgram.com` serve Aura-2 (`aura-2-thalia-en`) over WS and REST `/v1/speak` (`HTTP 101` / `HTTP 200`).
- **Sentences:** `short` = `"Your order 1042 has shipped."` (`28 chars`); `long` = `"Your package for order 1042 is packed at our warehouse and scheduled to arrive tomorrow afternoon before five o'clock."` (`119 chars`); `stream_s2` = `"Let me know if you would like the tracking link or want to update your delivery address."` (`88 chars`); `time` = `"It's 3:45 PM right now."` (`23 chars`).
- **Warnings / Errors observed:** `0` `Warning` or `Error` JSON messages across all `160` synthesized turns (`2a` + `2b` + `2e`) and `20` `Clear` turns (`2c`). During `2d`, sending `{"type":"KeepAlive"}` triggered immediate server close `1008 DATA-0000` on both hosts. In `2a`, `1/10` `api.deepgram.com | fresh | long` hit the `30 s` turn timeout (network/US stall).

### 2a. `tts_first_audio` & Playback Timeline (`N = 10` per cell, interleaved round-robin)

| Host | Socket (`n=10`) | Length | `Flush->1st` med / p90 | `Flushed` med / p90 | `1stChunk` med | `RTF` med | `J=0` Underruns (runs / total cnt / starved med / max) | `J=100` Underruns (runs / total cnt / starved med / max) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `api.in.deepgram.com` | `warm` (`0/10` new) | `short` | **`107.0 / 111.1 ms`** | `752.0 / 863.4 ms` | `40.0 ms` | `4.79x` | `0/10` (`0` / `0.0` / `0.0 ms`) | `0/10` (`0` / `0.0` / `0.0 ms`) |
| `api.in.deepgram.com` | `warm` (`0/10` new) | `long` | **`106.9 / 109.0 ms`** | `1546.3 / 1647.6 ms` | `40.0 ms` | `4.73x` | `0/10` (`0` / `0.0` / `0.0 ms`) | `0/10` (`0` / `0.0` / `0.0 ms`) |
| `api.in.deepgram.com` | `fresh` (`10/10` new) | `short` | `113.0 / 121.2 ms` | `753.0 / 798.1 ms` | `40.0 ms` | `4.82x` | `1/10` (`1` / `0.0` / `20.9 ms`) | `0/10` (`0` / `0.0` / `0.0 ms`) |
| `api.in.deepgram.com` | `fresh` (`10/10` new) | `long` | `106.3 / 119.2 ms` | `1500.7 / 1615.5 ms` | `40.0 ms` | `4.79x` | `0/10` (`0` / `0.0` / `0.0 ms`) | `0/10` (`0` / `0.0` / `0.0 ms`) |
| `api.deepgram.com` | `warm` (`0/10` new) | `short` | `352.6 / 363.4 ms` | `1684.9 / 1833.7 ms` | `40.0 ms` | `2.26x` | `5/10` (`5` / `43.7` / `87.6 ms`) | `0/10` (`0` / `0.0` / `0.0 ms`) |
| `api.deepgram.com` | `warm` (`0/10` new) | `long` | `348.2 / 358.8 ms` | `3355.8 / 3459.4 ms` | `40.0 ms` | `2.25x` | `5/10` (`5` / `43.7` / `87.8 ms`) | `0/10` (`0` / `0.0` / `0.0 ms`) |
| `api.deepgram.com` | `fresh` (`10/10` new) | `short` | `328.6 / 918.0 ms` | `1562.7 / 4000.3 ms` | `40.0 ms` | `2.84x` | `10/10` (`22` / `67.6` / `1811.0 ms`) | `4/10` (`15` / `0.0` / `1711.0 ms`) |
| `api.deepgram.com` | `fresh` (`10/10` new, `1/10` timeout) | `long` | `323.2 / 518.2 ms` | `2598.8 / 22452.8 ms` | `40.0 ms` | `2.64x` | `10/10` (`134` / `66.8` / `23828.7 ms`) | `4/10` (`128` / `0.0` / `23728.7 ms`) |

- `Speak->1st` matched `Flush->1st` within `~0.1–0.2 ms` (`0/80` turns emitted audio before `Flush`).

### 2b. Sentence Streaming (`Speak(s1)+Flush`, gap `50 ms` / `300 ms`, `Speak(s2)+Flush`, `N = 10` per cell)

| Host | Gap (`n=10`) | `Flush1->1st` med / p90 | `1stChunk` med | `RTF` med | `J=0` Underruns (runs / total cnt / starved med / max) | `J=100` Underruns (runs / total cnt / starved med / max) |
| --- | --- | --- | --- | --- | --- | --- |
| `api.in.deepgram.com` | `50 ms` | **`107.9 / 109.0 ms`** | `40.0 ms` | `4.62x` | **`0/10`** (`0` / `0.0` / `0.0 ms`) | **`0/10`** (`0` / `0.0` / `0.0 ms`) |
| `api.in.deepgram.com` | `300 ms` | **`110.1 / 113.2 ms`** | `40.0 ms` | `4.60x` | **`0/10`** (`0` / `0.0` / `0.0 ms`) | **`0/10`** (`0` / `0.0` / `0.0 ms`) |
| `api.deepgram.com` | `50 ms` | `349.0 / 450.4 ms` | `40.0 ms` | `2.22x` | `10/10` (`72` / `80.4` / `13935.0 ms`) | `2/10` (`64` / `0.0` / `13835.0 ms`) |
| `api.deepgram.com` | `300 ms` | `353.8 / 502.6 ms` | `40.0 ms` | `2.22x` | `10/10` (`96` / `89.5` / `13277.5 ms`) | `3/10` (`88` / `0.0` / `13177.5 ms`) |

### 2c. Barge-in `Clear` & Same-Socket Survival (`N = 10` per host, interleaved)

| Host (`n=10`) | Mid-stream `Clear` | `Clear->Cleared` med / p90 | Post-`Clear` stale bytes med / max (before `Cleared`) | Post-`Cleared` bytes | Socket Survival | Next-turn `Flush->1st` med / p90 |
| --- | --- | --- | --- | --- | --- | --- |
| `api.in.deepgram.com` | `10/10` | **`42.5 / 42.6 ms`** | `9,600 B` / `11,520 B` (`200–240 ms`) | `0 B` | **`100.0% (10/10)`** | **`101.3 / 102.7 ms`** |
| `api.deepgram.com` | `10/10` | `434.9 / 444.7 ms` | `42,240 B` / `42,240 B` (`880 ms`) | `0 B` | `100.0% (10/10)` | `284.4 / 289.2 ms` |

### 2d. Open Cost & Idle / KeepAlive Behavior (`N = 20` fresh opens, `N = 1` idle probe per host)

| Host | Fresh Open (`n=20`) Total med / p90 | DNS / TCP / TLS / Upgrade med | Warm New Sockets (`n=20`) | WS `ping` RTT (`n=1`) | `{"type":"KeepAlive"}` (`n=1`) | Pure Idle Hold (`n=1`) |
| --- | --- | --- | --- | --- | --- | --- |
| `api.in.deepgram.com` | **`184.5 / 295.2 ms`** | `1.5` / `50.5` / `52.8` / `75.8 ms` | `0/20` | `49.3 ms` | **Closed `1008 DATA-0000`** | **`>= 75.0 s` (still open)** |
| `api.deepgram.com` | `840.1 / 1607.1 ms` | `46.6` / `260.5` / `264.4` / `279.3 ms` | `0/20` | `283.1 ms` | **Closed `1008 DATA-0000`** | **`>= 75.0 s` (still open)** |

### 2e. REST `POST /v1/speak` Comparison (`undici` warm `Agent`, `N = 10` per cell)

| Host | Length (`n=10`) | `newSocket` | `TTFB` med / p90 | `Total` med / p90 |
| --- | --- | --- | --- | --- |
| `api.in.deepgram.com` | `short` | `4/10` | `176.7 / 278.9 ms` | `806.1 / 893.7 ms` |
| `api.in.deepgram.com` | `long` | `5/10` | `201.1 / 262.0 ms` | `1576.2 / 1691.5 ms` |
| `api.deepgram.com` | `short` | `0/10` | `340.9 / 358.7 ms` | `1737.4 / 2004.9 ms` |
| `api.deepgram.com` | `long` | `0/10` | `346.6 / 356.4 ms` | `3348.5 / 3454.3 ms` |

> **REST keep-alive note:** During interleaved `2e` runs, `api.in.deepgram.com` sat idle `~5.0 s` between cycles while `api.deepgram.com` finished (`1.7 s + 3.3 s`) and reopened `4/10` + `5/10` sockets, indicating an HTTP keep-alive idle timeout `< 5 s` on `api.in.deepgram.com` (whereas `api.deepgram.com` sat idle only `~2.4 s` and reopened `0/20`).

### 2f & 3. Raw PCM Format Check & Manual Listening WAVs

- All `160/160` synthesized WS & REST streams passed `checkRawPcm24kFormat` (`0` `RIFF` headers, `0` odd-byte buffers, `160/160` plausible duration).
- Saved WAVs in `spikes/deepgram-tts/out/` (gitignored): `order-1042-in-ws.wav` (`2920 ms`), `long-20w-in-ws.wav` (`6600 ms`), `order-1042-default-ws.wav` (`2840 ms`), `long-20w-default-ws.wav` (`6160 ms`), `order-1042-in-rest.wav` (`2880 ms`), `order-1042-default-rest.wav` (`2920 ms`), `time-345pm-in-ws.wav` (`2440 ms`), `time-345pm-default-ws.wav` (`2480 ms`).

## Phase 1 design constraints

1. **`Flush` rate limit (`20 Flushes / 60 s`) — documented behavior & scope:**
   - **Docs facts (`tts-ws-flush.md`, `streaming-text-to-speech.md`, `api-rate-limits.md`):** Deepgram caps `Flush` at **20 Flushes every 60 seconds** and documents it under the `/v1/speak` WebSocket stream limits alongside the `60-minute` WebSocket lifetime and `2,400 chars/min` WebSocket throughput limit (`1008 DATA-0001`), whereas project-wide limits in `api-rate-limits.md` are **concurrency** caps (`45` concurrent Aura-2 WS streams on Pay-as-You-Go, `15` REST). (The docs do not print the literal phrase "per WebSocket connection" vs "per API key", though it appears under WebSocket session limits.)
   - **Exceeding behavior:** Non-fatal server **`Warning`** JSON message (`{ type: "Warning", code, description }`) stating that additional `Flush` messages cannot be processed until the 60-second window passes; no `Error` event or WebSocket close code is documented for `Flush` throttling (unlike `1003`/`1008`/`1009`/`1011`), though docs warn that very frequent flushes degrade audio output quality.
   - **Related WS limits:** `2,000` chars max per `Speak` message (`413`), `2,400 chars/min` WebSocket character throughput (`1008 DATA-0001`), `60-minute` connection lifetime, and **`1008 DATA-0000`** immediate close if an unrecognized JSON type such as `{"type":"KeepAlive"}` is sent (verified on both hosts).

2. **Concrete recommendation for sentence-level streaming (supported by measured data):**
   - **Use one pre-warmed `wss://api.in.deepgram.com/v1/speak` WebSocket per call (`START_CALL`), and Flush ONLY the first sentence immediately + one final Flush at end-of-turn (batch/stream intermediate sentences with `Speak` without extra `Flush`es)** — do **not** open one socket per turn.
   - **Why the data supports this over one-socket-per-turn:**
     - Opening a fresh socket per turn adds **`184.5 ms` med / `295.2 ms` p90** on `api.in.deepgram.com` (`840.1 / 1607.1 ms` on `api.deepgram.com`), erasing WS's `~70–94 ms` latency lead over REST and eating `~185 ms` of our `<= 1,500 ms` turn budget.
     - Reusing one pre-warmed socket per call delivers **`107.0 ms` med (`111.1 ms` p90)** `tts_first_audio`, `0/20` reconnects, `>= 75 s` idle survival without keep-alive JSON frames (use WS protocol `ping` if needed, never `{"type":"KeepAlive"}`), and **`100%` (`10/10`) survival after `Clear`** (`42.5 ms` `Clear -> Cleared`, `101.3 ms` next-turn audio).
     - Flushing **only sentence 1 immediately** (for minimal `tts_first_audio`) and **once at LLM stream end** uses **1–2 Flushes per turn** (`10–20` turns/min on one socket), staying safely below `20 Flushes / 60 s` while keeping `J = 60–100 ms` client jitter buffering at `0/60` underruns.
