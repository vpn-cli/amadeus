# Phase 0 Spike — Silero VAD v6.3 ONNX in Node

Standalone spike validating `silero_vad.onnx` (**v6.3**, same ONNX I/O as v5) on Windows + Node 24 via `onnxruntime-node`, paired with a pure sample-accurate hysteresis segmenter and ground-truth label comparator.

## Pinned Model
- **Tag:** `v6.3` (`snakers4/silero-vad`)
- **SHA-256:** `f6f4407b41e05e277e7f5cfd9b9ae957b1dfe763c6076a934734c0b448e09b31`
- **Silero v6 / v6.3 threshold defaults check:**
  - `utils_vad.py` (`get_speech_timestamps` and `VADIterator`) keeps the same code defaults as v5: `threshold = 0.5`, `neg_threshold = max(threshold - 0.15, 0.01) = 0.35` (v6.3 PR #805 explicitly floors `VADIterator`'s `neg_threshold` at `0.01`), `min_speech_duration_ms = 250`, and `min_silence_duration_ms = 100` (our conversational turn endpointing uses `550 ms`).
  - **Release-note caveat (v6.3):** *"At the same threshold v6.3 is slightly stricter than v6.2. If you tuned the threshold for v6.2, re-check it."* v6.3 also detects short internal pauses (`96–256 ms`) more sharply and drops end-of-speech median delay toward zero. We keep our defaults (`0.5` onset / `0.35` offset) unchanged and flag this behavior for real-speech validation.

## What it tests
1. Re-chunking incoming 20 ms (`320`-sample) 16 kHz PCM16 frames into 32 ms (`512`-sample) Silero windows.
2. Prepending the mandatory `64`-sample rolling context tail (`[1, 576]` input) and carrying LSTM `state` (`[2, 1, 128]`) + `sr` (`16000`).
3. Pure `VadSegmenter` (`segmenter.ts`) with integer sample tracking, `300 ms` pre-roll, `0.5` onset / `0.35` offset hysteresis, `250 ms` min speech with `96 ms` (`3` windows) pending dip tolerance, `550 ms` silence hang, `30000 ms` max utterance (`max_duration`), and explicit event `reason` fields.
4. Ground-truth label generation (`gen-test-wav.ps1` trimming TTS near-silence below `-50 dBFS` before concatenation) and comparison (`labels.ts`) reporting matches, splits, false positives, and missed labels.

## Run
```powershell
cd spikes/silero-vad
pnpm install
pnpm typecheck
pnpm test       # pure unit tests for segmenter.ts and labels.ts (Vitest, no ONNX/API keys)
pnpm model      # downloads pinned v6.3 silero_vad.onnx into out/, verifies SHA-256, prints metadata
pnpm test-wav   # generates out/sample-16k.wav + trimmed out/sample-16k.labels.txt
pnpm start      # runs Silero VAD across out/sample-16k.wav (auto-loads out/sample-16k.labels.txt)
pnpm vad:all    # runs Silero VAD across fixtures/audio/*.wav and prints summary + per-segment error tables
```

## Verified Gotchas (Node v24.15.0 + Windows)
- **pnpm v12 native builds:** `package.json`'s `pnpm.onlyBuiltDependencies` is ignored by pnpm v12; use `allowBuilds` in `pnpm-workspace.yaml` (`esbuild: true`, `onnxruntime-node: true`).
- **Silero v6.3 ONNX contract (same ONNX I/O as v5, verified from `silero_vad.onnx` metadata):**
  - Inputs: `input` (`float32`, `[1, 576]` = 64 context + 512 samples), `state` (`float32`, `[2, 1, 128]`), `sr` (`int64`, scalar `[]`).
  - Outputs: `output` (`float32`, `[1, 1]`), `stateN` (`float32`, `[2, 1, 128]`).
- **TTS silence padding:** `System.Speech` pads synthesized clips with ~117–176 ms leading and ~750 ms trailing near-silence; `gen-test-wav.ps1` trims samples with `|x| < -50 dBFS` (`104` int16) before concatenation so `out/sample-16k.labels.txt` reflects actual speech boundaries.
- **PowerShell + `ffmpeg`:** Under `$ErrorActionPreference = "Stop"`, `ffmpeg` stderr output triggers `NativeCommandError`; wrap `ffmpeg` calls with `Continue` and check `$LASTEXITCODE`.
