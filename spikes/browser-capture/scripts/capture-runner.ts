import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { parseWav, type ParsedWav } from "../src/wav.js";

export const DEFAULT_PREVIEW_PORT = 4173;
export const TARGET_SAMPLE_RATE = 16000;
export const FRAME_SAMPLES_20MS = 320;

export interface ReportedTrackSettings {
  echoCancellation: string;
  noiseSuppression: string;
  autoGainControl: string;
  channelCount: string;
  sampleRate: string;
}

export type CaptureStopCondition =
  | { kind: "duration"; durationMs: number }
  | { kind: "minFrames"; minFrames: number; timeoutMs: number };

export interface CaptureSessionOptions {
  browser: Browser;
  url: string;
  outputWavPath: string;
  stopCondition: CaptureStopCondition;
  label?: string;
}

export interface CaptureSessionResult {
  parsed: ParsedWav;
  pcm16: Int16Array;
  recordedWallMs: number;
  receivedFrames: number;
  seqGaps: number;
  ctxSampleRate: string;
  workletChannels: string;
  clockDriftText: string;
  trackSettings: ReportedTrackSettings;
}

export interface PreviewBrowserOptions {
  spikeRoot: string;
  fakeMicWavPath: string;
  previewPort?: number;
}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return;
      }
    } catch {
      // Server not listening yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for preview server at ${url}`);
}

export function startPreviewServer(
  spikeRoot: string,
  port = DEFAULT_PREVIEW_PORT,
): ChildProcess {
  const viteBin = path.join(spikeRoot, "node_modules", "vite", "bin", "vite.js");
  return spawn(
    process.execPath,
    [viteBin, "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: spikeRoot,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

export async function withFakeMicBrowserPreview<T>(
  options: PreviewBrowserOptions,
  fn: (ctx: { browser: Browser; previewUrl: string }) => Promise<T>,
): Promise<T> {
  const port = options.previewPort ?? DEFAULT_PREVIEW_PORT;
  const previewUrl = `http://127.0.0.1:${port}/`;
  const previewProc = startPreviewServer(options.spikeRoot, port);
  let previewStderr = "";
  previewProc.stderr?.on("data", (chunk: Buffer) => {
    previewStderr += chunk.toString();
  });

  try {
    await waitForServer(previewUrl, 15000);

    const browser = await chromium.launch({
      headless: true,
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-audio-capture=${options.fakeMicWavPath}`,
      ],
    });

    try {
      return await fn({ browser, previewUrl });
    } finally {
      await browser.close();
    }
  } finally {
    previewProc.kill("SIGTERM");
    if (previewStderr.trim().length > 0) {
      console.error(previewStderr.trim());
    }
  }
}

export async function runCaptureSession(
  options: CaptureSessionOptions,
): Promise<CaptureSessionResult> {
  const prefix = options.label ? `[${options.label}] ` : "";
  const context = await options.browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const browserErrors: string[] = [];

  page.on("pageerror", (err) => {
    browserErrors.push(`pageerror: ${err.message}`);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      browserErrors.push(`console.error: ${msg.text()}`);
    }
  });

  try {
    await page.goto(options.url, { waitUntil: "networkidle" });

    await page.click("#start-btn");
    await page.waitForSelector('#status-text[data-state="recording"]', {
      timeout: 10000,
    });

    let startedPerfMs: number;
    if (options.stopCondition.kind === "duration") {
      await page.waitForFunction(
        () => Number(document.getElementById("received-frames")?.textContent ?? "0") >= 1,
        null,
        { timeout: 10000 },
      );
      startedPerfMs = performance.now();
      await page.waitForTimeout(options.stopCondition.durationMs);
    } else {
      startedPerfMs = performance.now();
      await page.waitForFunction(
        (targetFrames: number) =>
          Number(document.getElementById("received-frames")?.textContent ?? "0") >= targetFrames,
        options.stopCondition.minFrames,
        { timeout: options.stopCondition.timeoutMs },
      );
    }

    await page.click("#stop-btn");
    const stoppedPerfMs = performance.now();
    await page.waitForSelector('#status-text[data-state="stopped"]', {
      timeout: 10000,
    });

    const recordedWallMs = stoppedPerfMs - startedPerfMs;
    const ctxSampleRate = (await page.textContent("#ctx-sample-rate"))?.trim() ?? "";
    const workletChannels = (await page.textContent("#input-channels"))?.trim() ?? "";
    const receivedFramesText =
      (await page.textContent("#received-frames"))?.trim() ?? "0";
    const droppedFramesText =
      (await page.textContent("#dropped-frames"))?.trim() ?? "-1";
    const clockDriftText = (await page.textContent("#clock-drift"))?.trim() ?? "";

    const trackSettings: ReportedTrackSettings = {
      echoCancellation:
        (await page.textContent("#setting-echo-cancellation"))?.trim() ?? "",
      noiseSuppression:
        (await page.textContent("#setting-noise-suppression"))?.trim() ?? "",
      autoGainControl:
        (await page.textContent("#setting-auto-gain-control"))?.trim() ?? "",
      channelCount:
        (await page.textContent("#setting-channel-count"))?.trim() ?? "",
      sampleRate: (await page.textContent("#setting-sample-rate"))?.trim() ?? "",
    };

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#download-wav-btn"),
    ]);
    await download.saveAs(options.outputWavPath);

    const wavBytes = new Uint8Array(await readFile(options.outputWavPath));
    const parsed = parseWav(wavBytes);
    const seqGaps = Number(droppedFramesText);
    const receivedFrames = Number(receivedFramesText);

    assert(
      browserErrors.length === 0,
      `${prefix}Browser errors observed:\n${browserErrors.join("\n")}`,
    );
    assert(
      parsed.sampleRate === TARGET_SAMPLE_RATE,
      `${prefix}Expected ${TARGET_SAMPLE_RATE} Hz, got ${parsed.sampleRate}`,
    );
    assert(parsed.channels === 1, `${prefix}Expected 1 channel, got ${parsed.channels}`);
    assert(
      parsed.bitsPerSample === 16,
      `${prefix}Expected 16-bit, got ${parsed.bitsPerSample}`,
    );
    assert(
      parsed.sampleCount % FRAME_SAMPLES_20MS === 0,
      `${prefix}Expected whole ${FRAME_SAMPLES_20MS}-sample frames, got ${parsed.sampleCount}`,
    );
    assert(seqGaps === 0, `${prefix}Expected 0 seq gaps, got ${seqGaps}`);
    assert(
      parsed.samples instanceof Int16Array,
      `${prefix}Expected Int16Array samples in parsed WAV`,
    );

    return {
      parsed,
      pcm16: parsed.samples,
      recordedWallMs,
      receivedFrames,
      seqGaps,
      ctxSampleRate,
      workletChannels,
      clockDriftText,
      trackSettings,
    };
  } finally {
    await context.close();
  }
}
