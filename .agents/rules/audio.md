---
trigger: glob
globs: "apps/web/src/audio/**, apps/server/src/vad/**, packages/audio/**, spikes/**"
description: "Pinned audio sample rates, frame sizes, binary headers, and Silero VAD v6.3 ONNX tensor contract."
---

# Audio & VAD Contracts

- **Client → Server:** PCM16LE, mono, `16,000 Hz`, `20 ms` frames (`320` samples = `640` bytes), raw binary WS payload.
  - Capture in an `AudioWorklet` at the native `AudioContext` rate and downsample (e.g., `48 kHz → 16 kHz`) with a low-pass filter implemented as a pure function in `packages/audio`.
  - Mic constraints: `echoCancellation: true`, `noiseSuppression: true`, `autoGainControl: true`.
- **Server VAD (Silero VAD v6.3 — same ONNX I/O as v5: [1,576] input with 64-sample context, [2,1,128] state, int64 sr):**
  - Re-chunk incoming 16 kHz audio into `512`-sample windows (`32 ms`).
  - Pass `input` of shape `[1, 576]` (`64` context samples from the end of the previous frame + `512` new samples, normalized `Float32` in `[-1, 1]`), `state` of shape `[2, 1, 128]` (`float32`, initialized to zeros), and `sr` (`16000`, `int64` `[1]` or scalar per model metadata).
  - Carry over `stateN` → `state` and slice the last `64` samples of `input` as the next frame's context tail.
  - Default segmenter thresholds: `0.5` onset / `0.35` offset hysteresis, `250 ms` min speech (`96 ms` / 3-window pending dip tolerance), `550 ms` end-of-utterance silence (`576 ms` quantized at 32 ms windows), `30 s` max utterance. Segmenter emits unpadded `startMs` (first positive window); STT forwarding keeps a `500 ms` pre-roll ring buffer and forwards from `(start − 100 ms)` (measured `onsetConfirmMs` = 256 ms = 8 × 32 ms windows, so the buffer must exceed `onsetConfirmMs` + padding).
- **Server → Client:** PCM16LE, mono, `24,000 Hz`, prefixed by a 9-byte header (`u8 kind=1 · u32 turn_id · u32 seq`).
  - Playback uses a separate `AudioContext({ sampleRate: 24000 })` with an `AudioWorklet` ring buffer tracking played samples for `played_ms`.
