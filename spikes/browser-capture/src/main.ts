import "./style.css";
import type { WorkletOutboundMessage } from "./capture.worklet";
import captureWorkletUrl from "./capture.worklet.ts?worker&url";
import { formatReportedTrackSettings, isAudioProcessingEnabled } from "./processing";
import { encodeFloat32Wav, encodePcm16Wav } from "./wav";

interface ChecklistItem {
  filename: string;
  description: string;
  done: boolean;
}

const CHECKLIST_ITEMS: ChecklistItem[] = [
  { filename: "speech-normal.wav", description: "Normal speech", done: false },
  {
    filename: "noise-only.wav",
    description: "10 s typing/fan, no speech",
    done: false,
  },
  { filename: "cough.wav", description: "Cough / throat clear", done: false },
  {
    filename: "mid-pause.wav",
    description: '"I want to... check my order"',
    done: false,
  },
  {
    filename: "echo-speakers.wav",
    description: "Speaking while a video plays through speakers",
    done: false,
  },
];

const TARGET_SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const CLOCK_DRIFT_TOLERANCE_FRAMES = 2;
const AUDIO_PROCESSING_ENABLED = isAudioProcessingEnabled(window.location.search);

const startBtn = document.getElementById("start-btn") as HTMLButtonElement;
const stopBtn = document.getElementById("stop-btn") as HTMLButtonElement;
const downloadWavBtn = document.getElementById(
  "download-wav-btn",
) as HTMLButtonElement;
const downloadRawBtn = document.getElementById(
  "download-raw-btn",
) as HTMLButtonElement;
const statusText = document.getElementById("status-text") as HTMLSpanElement;
const rmsMeter = document.getElementById("rms-meter") as HTMLProgressElement;
const rmsDbEl = document.getElementById("rms-db") as HTMLSpanElement;
const ctxSampleRateEl = document.getElementById("ctx-sample-rate") as HTMLElement;
const inputChannelsEl = document.getElementById("input-channels") as HTMLElement;
const receivedFramesEl = document.getElementById("received-frames") as HTMLElement;
const recordedDurationEl = document.getElementById(
  "recorded-duration",
) as HTMLElement;
const droppedFramesEl = document.getElementById("dropped-frames") as HTMLElement;
const clockDriftEl = document.getElementById("clock-drift") as HTMLElement;
const processingRequestedEl = document.getElementById(
  "processing-requested",
) as HTMLElement;
const settingEchoCancellationEl = document.getElementById(
  "setting-echo-cancellation",
) as HTMLElement;
const settingNoiseSuppressionEl = document.getElementById(
  "setting-noise-suppression",
) as HTMLElement;
const settingAutoGainControlEl = document.getElementById(
  "setting-auto-gain-control",
) as HTMLElement;
const settingChannelCountEl = document.getElementById(
  "setting-channel-count",
) as HTMLElement;
const settingSampleRateEl = document.getElementById(
  "setting-sample-rate",
) as HTMLElement;
const trackSettingsEl = document.getElementById("track-settings") as HTMLElement;
const checklistEl = document.getElementById("checklist") as HTMLUListElement;
const errorBoxEl = document.getElementById("error-box") as HTMLPreElement;

let activeFilename = CHECKLIST_ITEMS[0]?.filename ?? "speech-normal.wav";

let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let workletNode: AudioWorkletNode | null = null;
let silentGainNode: GainNode | null = null;
let rafId: number | null = null;

let nativeSampleRate = 48000;
let pcm16Frames: Int16Array[] = [];
let rawNativeChunks: Float32Array[] = [];
let expectedSeq = 0;
let droppedFrames = 0;
let streamAnchorPerfMs: number | null = null;
let isRecording = false;

function renderChecklist(): void {
  checklistEl.innerHTML = "";
  for (const item of CHECKLIST_ITEMS) {
    const li = document.createElement("li");

    const statusBadge = document.createElement("input");
    statusBadge.type = "checkbox";
    statusBadge.checked = item.done;
    statusBadge.ariaLabel = `${item.filename} recorded`;
    statusBadge.addEventListener("change", () => {
      item.done = statusBadge.checked;
    });

    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "active-clip";
    radio.value = item.filename;
    radio.checked = activeFilename === item.filename;
    radio.addEventListener("change", () => {
      activeFilename = item.filename;
    });

    const code = document.createElement("code");
    code.textContent = item.filename;

    const desc = document.createElement("span");
    desc.textContent = `— ${item.description}`;

    label.append(radio, code, desc);
    li.append(statusBadge, label);
    checklistEl.appendChild(li);
  }
}

function setError(message: string | null): void {
  if (!message) {
    errorBoxEl.hidden = true;
    errorBoxEl.textContent = "";
    return;
  }
  errorBoxEl.hidden = false;
  errorBoxEl.textContent = message;
}

function setStatus(state: "idle" | "starting" | "recording" | "stopped"): void {
  statusText.dataset["state"] = state;
  const labels: Record<typeof state, string> = {
    idle: "Idle",
    starting: "Starting...",
    recording: "Recording",
    stopped: "Stopped",
  };
  statusText.textContent = labels[state];
}

function updateClockDriftDisplay(nowPerfMs = performance.now()): void {
  const received = pcm16Frames.length;
  receivedFramesEl.textContent = String(received);
  recordedDurationEl.textContent = `${received * FRAME_MS} ms`;
  droppedFramesEl.textContent = String(droppedFrames);

  if (streamAnchorPerfMs === null) {
    clockDriftEl.textContent = "waiting for first frame...";
    return;
  }

  const elapsedMs = Math.max(0, nowPerfMs - streamAnchorPerfMs);
  const expectedClockFrames = Math.floor(elapsedMs / FRAME_MS);
  const delta = received - expectedClockFrames;
  const withinTolerance = Math.abs(delta) <= CLOCK_DRIFT_TOLERANCE_FRAMES;
  const sign = delta > 0 ? `+${delta}` : String(delta);
  clockDriftEl.textContent = `expected ${expectedClockFrames} vs received ${received} (delta ${sign} frames, ${withinTolerance ? "OK within +-2" : "OUT OF TOLERANCE"})`;
}

function scheduleTelemetryRefresh(): void {
  if (!isRecording) {
    return;
  }
  updateClockDriftDisplay();
  rafId = requestAnimationFrame(scheduleTelemetryRefresh);
}

function resetCaptureBuffers(): void {
  pcm16Frames = [];
  rawNativeChunks = [];
  expectedSeq = 0;
  droppedFrames = 0;
  streamAnchorPerfMs = null;

  rmsMeter.value = 0;
  rmsDbEl.textContent = "-inf dBFS";
  inputChannelsEl.textContent = "—";
  receivedFramesEl.textContent = "0";
  recordedDurationEl.textContent = "0 ms";
  droppedFramesEl.textContent = "0";
  clockDriftEl.textContent = "—";
  settingEchoCancellationEl.textContent = "—";
  settingNoiseSuppressionEl.textContent = "—";
  settingAutoGainControlEl.textContent = "—";
  settingChannelCountEl.textContent = "—";
  settingSampleRateEl.textContent = "—";
  trackSettingsEl.textContent = "{}";
}

async function cleanupAudioGraph(): Promise<void> {
  isRecording = false;
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  if (workletNode) {
    try {
      workletNode.port.postMessage({ type: "stop" });
    } catch {
      // Ignore if port is already closed
    }
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }

  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }

  if (silentGainNode) {
    silentGainNode.disconnect();
    silentGainNode = null;
  }

  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      track.stop();
    }
    mediaStream = null;
  }

  if (audioContext) {
    try {
      await audioContext.close();
    } finally {
      audioContext = null;
    }
  }
}

function triggerWavDownload(bytes: Uint8Array, filename: string): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

startBtn.addEventListener("click", async () => {
  setError(null);
  startBtn.disabled = true;
  stopBtn.disabled = true;
  downloadWavBtn.disabled = true;
  downloadRawBtn.disabled = true;
  setStatus("starting");
  resetCaptureBuffers();

  // Create AudioContext synchronously inside click handler at native sampleRate.
  const ctx = new AudioContext();
  audioContext = ctx;
  nativeSampleRate = ctx.sampleRate;
  ctxSampleRateEl.textContent = `${ctx.sampleRate} Hz`;

  try {
    await ctx.resume();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: AUDIO_PROCESSING_ENABLED,
        noiseSuppression: AUDIO_PROCESSING_ENABLED,
        autoGainControl: AUDIO_PROCESSING_ENABLED,
        channelCount: 1,
      },
    });
    mediaStream = stream;

    const audioTrack = stream.getAudioTracks()[0];
    const trackSettings = audioTrack?.getSettings();
    console.log("track.getSettings()", trackSettings ?? {});
    const reported = formatReportedTrackSettings(trackSettings);
    settingEchoCancellationEl.textContent = reported.echoCancellation;
    settingNoiseSuppressionEl.textContent = reported.noiseSuppression;
    settingAutoGainControlEl.textContent = reported.autoGainControl;
    settingChannelCountEl.textContent = reported.channelCount;
    settingSampleRateEl.textContent = reported.sampleRate;
    trackSettingsEl.textContent = JSON.stringify(trackSettings ?? {}, null, 2);

    await ctx.audioWorklet.addModule(captureWorkletUrl);

    const source = ctx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(ctx, "capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        sampleRate: ctx.sampleRate,
      },
    });
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;

    sourceNode = source;
    workletNode = worklet;
    silentGainNode = silentGain;

    worklet.port.onmessage = (event: MessageEvent<WorkletOutboundMessage>) => {
      const msg = event.data;
      if (msg.type === "meta") {
        inputChannelsEl.textContent =
          msg.channelCount > 1
            ? `${msg.channelCount} (downmixed to mono)`
            : `${msg.channelCount}`;
        return;
      }

      if (msg.type === "raw") {
        rawNativeChunks.push(msg.samples);
        return;
      }

      if (msg.type === "frame") {
        if (streamAnchorPerfMs === null) {
          streamAnchorPerfMs = performance.now() - FRAME_MS;
        }
        if (msg.seq > expectedSeq) {
          droppedFrames += msg.seq - expectedSeq;
        }
        expectedSeq = msg.seq + 1;
        pcm16Frames.push(msg.pcm16);

        rmsMeter.value = Math.min(1, msg.rms * 4);
        const db = msg.rms > 1e-6 ? 20 * Math.log10(msg.rms) : -Infinity;
        rmsDbEl.textContent = Number.isFinite(db)
          ? `${db.toFixed(1)} dBFS`
          : "-inf dBFS";
      }
    };

    source.connect(worklet);
    worklet.connect(silentGain);
    silentGain.connect(ctx.destination);

    await ctx.resume();

    isRecording = true;
    setStatus("recording");
    stopBtn.disabled = false;
    scheduleTelemetryRefresh();
  } catch (err) {
    await cleanupAudioGraph();
    setStatus("idle");
    startBtn.disabled = false;
    setError(err instanceof Error ? err.message : String(err));
  }
});

stopBtn.addEventListener("click", async () => {
  stopBtn.disabled = true;
  const stopPerfMs = performance.now();
  await cleanupAudioGraph();
  updateClockDriftDisplay(stopPerfMs);
  setStatus("stopped");
  startBtn.disabled = false;
  downloadWavBtn.disabled = pcm16Frames.length === 0;
  downloadRawBtn.disabled = rawNativeChunks.length === 0;
});

downloadWavBtn.addEventListener("click", () => {
  if (pcm16Frames.length === 0) {
    return;
  }
  const wav = encodePcm16Wav(pcm16Frames, TARGET_SAMPLE_RATE, 1);
  triggerWavDownload(wav, activeFilename);

  const item = CHECKLIST_ITEMS.find((entry) => entry.filename === activeFilename);
  if (item) {
    item.done = true;
    renderChecklist();
  }
});

downloadRawBtn.addEventListener("click", () => {
  if (rawNativeChunks.length === 0) {
    return;
  }
  const baseName = activeFilename.replace(/\.wav$/i, "");
  const rawName = `${baseName}-raw-${nativeSampleRate}hz.wav`;
  const wav = encodeFloat32Wav(rawNativeChunks, nativeSampleRate, 1);
  triggerWavDownload(wav, rawName);
});

processingRequestedEl.textContent = AUDIO_PROCESSING_ENABLED ? "on" : "off";
renderChecklist();
