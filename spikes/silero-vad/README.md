# Phase 0 Spike — Silero VAD v5 ONNX in Node

Standalone spike validating `silero_vad.onnx` (v5) on Windows + Node 24 via `onnxruntime-node`.

## What it tests
1. Re-chunking incoming 20 ms (`320`-sample) 16 kHz PCM16 frames into 32 ms (`512`-sample) Silero windows.
2. Prepending the mandatory `64`-sample rolling context tail (`[1, 576]` input) and carrying LSTM `state` (`[2, 1, 128]`) + `sr` (`16000`).
3. Hysteresis speech segmentation (`0.5` onset / `0.35` offset, `250 ms` min speech, `550 ms` silence hang) and per-window inference latency.

## Run
```powershell
cd spikes/silero-vad
pnpm install
pnpm model      # downloads silero_vad.onnx into out/ and prints ONNX input/output metadata
pnpm test-wav   # generates out/sample-16k.wav using Windows TTS + ffmpeg (2 utterances + silence)
pnpm start      # runs Silero VAD across out/sample-16k.wav (or pass a custom 16kHz WAV path)
```

## Verified Gotchas (Node v24.15.0 + Windows)
- **pnpm v12 native builds:** `package.json`'s `pnpm.onlyBuiltDependencies` is ignored by pnpm v12; use `allowBuilds` in `pnpm-workspace.yaml` (`esbuild: true`, `onnxruntime-node: true`).
- **Silero v5 ONNX contract (verified from `silero_vad.onnx` metadata):**
  - Inputs: `input` (`float32`, `[1, 576]` = 64 context + 512 samples), `state` (`float32`, `[2, 1, 128]`), `sr` (`int64`, scalar `[]`).
  - Outputs: `output` (`float32`, `[1, 1]`), `stateN` (`float32`, `[2, 1, 128]`).
- **Performance:** `onnxruntime-node@1.31.1` runs natively on Node 24 (`avg = 0.258 ms`, `p50 = 0.233 ms`, `p95 = 0.345 ms` per 32 ms window across 334 windows).
- **Comma pauses:** Short natural pauses after `"Hello,"` / `"Thanks,"` drop probability to `~0.002–0.01` for ~250–300 ms; the 550 ms silence hang prevents false turn splits.
- **PowerShell + `ffmpeg`:** Under `$ErrorActionPreference = "Stop"`, `ffmpeg` stderr output triggers `NativeCommandError`; wrap `ffmpeg` calls with `Continue` and check `$LASTEXITCODE`.

