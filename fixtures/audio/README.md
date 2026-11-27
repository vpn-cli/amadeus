# Audio Fixtures (`fixtures/audio/`)

Ground-truth recorded audio clips used to evaluate Silero VAD (`spikes/silero-vad`) and end-to-end replay tests.

## Format & Recording

- **Audio format:** `16,000 Hz`, mono, `PCM16LE` WAV (`.wav`).
- **How to record:** Use the `spikes/browser-capture` web app in Chrome, which captures microphone input at the native `AudioContext` rate and downsamples to 16 kHz mono PCM16LE.
- **Recommended clip set** (matches the `spikes/browser-capture` checklist):
  - `speech-normal.wav` — normal conversational speech
  - `noise-only.wav` — ~10 s of background noise (typing/fan), no speech
  - `cough.wav` — cough / throat clear, no speech
  - `mid-pause.wav` — single utterance with a mid-sentence pause (e.g. `"I want to... check my order"`)
  - `echo-speakers.wav` — speaking while a video plays through speakers

## Label Files (`<name>.labels.txt`)

- Every `<name>.wav` has a matching `<name>.labels.txt` exported from **Audacity** (`File → Export → Export Labels...`), with tab-separated lines:
  ```text
  <start_seconds>	<end_seconds>	<optional_transcript_or_note>
  ```
  (`#` comment lines and blank lines are ignored.)
- **Mark ONLY my speech.** Do not label background noise, keyboard typing, coughs/throat clears, speaker echo, or silence.
- **`noise-only.labels.txt` and `cough.labels.txt` are empty on purpose** (0 labels). On those clips, any detected VAD segment is counted as a false positive, and expected result is `0` segments / `0` false positives / `0` missed labels.

## Running VAD Across All Fixtures

From `spikes/silero-vad`:

```powershell
pnpm vad:all
```

This runs Silero VAD across every `fixtures/audio/*.wav` paired with its `<name>.labels.txt`, prints a combined summary table, and prints each file's per-segment error table.
