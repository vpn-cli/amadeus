# Phase 0 Spike — Browser Audio Capture Worklet

Standalone Vite + plain TypeScript + HTML spike validating real-time browser microphone capture at the native `AudioContext` rate, streaming low-pass anti-aliasing + fractional resampling to `16,000 Hz` mono `PCM16LE` (`20 ms` / `320`-sample frames), sequence-gap drop detection, wall-clock drift checks, and WAV export.

## Modules

- `src/resampler.ts` — Pure streaming resampler (63-tap Kaiser-windowed sinc low-pass FIR + Catmull-Rom cubic fractional interpolation) and `Float32 <-> Int16` conversion (reusable in `packages/audio`).
- `src/wav.ts` — Pure 44-byte RIFF/WAVE encoder/parser for `PCM16LE` (`audioFormat=1`) and `IEEE Float32` (`audioFormat=3`) (reusable in `packages/audio`).
- `src/capture.worklet.ts` — `AudioWorkletProcessor` that guards empty early quanta, downmixes multi-channel input to mono, resamples to `16 kHz`, stamps monotonic `seq` numbers on full `320`-sample frames (dropping trailing `< 320` partial frames on stop), and batches raw native-rate `Float32` samples for debug WAV export.
- `src/main.ts` — Plain HTML + TypeScript UI using `?worker&url` worklet bundling, live RMS meter, sequence-gap drop counter, wall-clock drift check (`±2` frame tolerance), and the 5-clip recording checklist.
- `scripts/smoke.ts` — Automated Playwright + Chromium fake-mic end-to-end smoke test against `vite preview`.

## Run

```powershell
cd spikes/browser-capture
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
```

For manual recording with a real microphone in Chrome:

```powershell
pnpm dev      # development server
# or test the production bundle:
pnpm build
pnpm preview  # open http://127.0.0.1:4173/ in Chrome
```

## Gotchas Found

1. **Vite AudioWorklet bundling (`?worker&url` + `worker.format: "es"`):** Importing a TypeScript worklet with plain `?url` works in `vite dev`, but `vite build` copies raw `.ts` without compiling or bundling `./resampler`. Using `?worker&url` with `worker: { format: "es" }` in `vite.config.ts` bundles `capture.worklet.ts` + `./resampler.ts` into a self-contained ES module in `dist/assets/` with zero `window`/`document`/`self` references, loading cleanly in `pnpm preview`.
2. **TypeScript `AudioWorkletGlobalScope` types:** Standard `lib.dom.d.ts` omits `AudioWorkletProcessor` and `registerProcessor`, requiring `src/worklet.d.ts` for strict `tsc --noEmit`. Reading `(globalThis as { sampleRate?: number }).sampleRate` (with `processorOptions.sampleRate` fallback) avoids leaking a global `sampleRate` symbol into main-thread typechecking.
3. **Zero-gain `destination` connection required in Chrome:** Connecting `MediaStreamAudioSourceNode -> AudioWorkletNode` without routing to `audioContext.destination` causes Chrome to stop calling `process()`. Routing through a `GainNode` with `gain.value = 0` keeps the audio render graph active with zero speaker feedback.
4. **Channel count vs `channelCount: 1`:** Even with `channelCount: 1` requested in `getUserMedia` (observed empirically in Chromium where even a mono 1-channel fake-capture WAV produced `inputs[0].length === 2`), audio drivers can deliver 2-channel `inputs[0]` or empty `inputs[0].length === 0` on early quanta, so `capture.worklet.ts` guards empty quanta and averages all channels to mono.
5. **WebRTC `noiseSuppression: true` attenuates steady sine tones:** During `--use-file-for-fake-audio-capture` smoke testing with a continuous `1 kHz` sine, Chromium's WebRTC noise suppressor adapts after ~1 s and attenuates the steady tone by ~18–20 dB (first second `0.44` → third second `0.05`). The `1 kHz` peak still dominates other bins by `> 100x`; non-stationary human speech is unaffected.
6. **Kaiser FIR vs low-order IIR for 16 kHz anti-aliasing:** At 16 kHz output (8 kHz Nyquist), a 4th-order Butterworth near `6.5–7 kHz` yields only ~12–16 dB attenuation at `10 kHz`. A 63-tap Kaiser-windowed sinc FIR (`beta = 6.5`) keeps `1 kHz` flat while attenuating `10 kHz` well beyond `20 dB`, and carrying both the FIR delay line and 3-sample Catmull-Rom lookback history across 128-sample blocks matches single-buffer output without boundary clicks.
7. **pnpm v12 native `esbuild` build:** `pnpm-workspace.yaml` requires `allowBuilds: { esbuild: true }` so Vite/Vitest `esbuild` postinstall runs under pnpm v12.
