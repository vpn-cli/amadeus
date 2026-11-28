import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEEPGRAM_TTS_HOSTS,
  buildDeepgramSpeakRestUrl,
  buildDeepgramSpeakWsUrl,
  evaluateTtsCharBudget,
  loadTtsSpikeConfig,
  parseDotEnv,
  type DeepgramTtsHostSpec,
} from "./config.js";
import { createWarmRestAgent, synthesizeRest } from "./rest-client.js";
import { formatMs, formatNum, formatPct, summarize, type DistributionStats } from "./stats.js";
import {
  checkRawPcm24kFormat,
  type PlaybackTimelineResult,
  type RawPcmFormatCheck,
} from "./timeline.js";
import type { ClassifiedServerNotice } from "./tts-parser.js";
import { writePcm16Wav } from "./wav.js";
import {
  DeepgramTtsWsError,
  DeepgramTtsWsSession,
  type TtsBargeInClearResult,
  type TtsTurnResult,
  type TtsTwoSentenceResult,
  type WsConnectionTimings,
} from "./ws-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const OUT_DIR = path.join(__dirname, "out");
const RESULTS_PATH = path.join(OUT_DIR, "results.json");

const SHORT_TEXT = "Your order 1042 has shipped.";
const LONG_TEXT =
  "Your package for order 1042 is packed at our warehouse and scheduled to arrive tomorrow afternoon before five o'clock.";
const STREAM_S1 = SHORT_TEXT;
const STREAM_S2 =
  "Let me know if you would like the tracking link or want to update your delivery address.";
const TIME_TEXT = "It's 3:45 PM right now.";

const DEFAULT_N = 10;
const IDLE_WAIT_MAX_MS = 75_000;
const IDLE_PROBE_5MIN_MS = 300_000;
const IDLE_PROBE_PING_INTERVAL_MS = 20_000;

function hasCliFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

function loadEnvFromRoot(): void {
  const candidates = [path.join(REPO_ROOT, ".env"), path.join(__dirname, ".env")];
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    const parsed = parseDotEnv(readFileSync(envPath, "utf8"));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) {
        process.env[k] = v;
      }
    }
  }
}

function parseCliIntFlag(argv: readonly string[], flag: string, fallback: number): number {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg.startsWith(`${flag}=`)) {
      const val = Number(arg.slice(flag.length + 1));
      if (!Number.isInteger(val) || val <= 0) {
        throw new Error(`${flag} must be a positive integer`);
      }
      return val;
    }
    if (arg === flag) {
      const next = argv[i + 1];
      const val = Number(next);
      if (next === undefined || !Number.isInteger(val) || val <= 0) {
        throw new Error(`${flag} requires a positive integer`);
      }
      return val;
    }
  }
  return fallback;
}

function nonNull(values: readonly (number | null)[]): number[] {
  return values.filter((v): v is number => v !== null && Number.isFinite(v));
}

function summarizeTimeline(timelines: readonly PlaybackTimelineResult[]) {
  const firstChunkMs = summarize(timelines.map((t) => t.firstChunkMs));
  const streamRtf = summarize(nonNull(timelines.map((t) => t.streamRtf)));
  const underrunRuns = timelines.filter((t) => t.underrunCount > 0).length;
  const underrunCounts = summarize(timelines.map((t) => t.underrunCount));
  const starvedMs = summarize(timelines.map((t) => t.totalStarvedMs));
  const totalStarvedAll = timelines.reduce((acc, t) => acc + t.totalStarvedMs, 0);
  return {
    n: timelines.length,
    firstChunkMs,
    streamRtf,
    underrunRuns,
    underrunCounts,
    starvedMs,
    totalStarvedAll,
  };
}

interface HostCapability {
  readonly spec: DeepgramTtsHostSpec;
  readonly wsSupported: boolean;
  readonly wsProbeError: string | null;
  readonly wsOpenTimings: WsConnectionTimings | null;
  readonly restSupported: boolean;
  readonly restProbeError: string | null;
  readonly sampleHeaders: Readonly<Record<string, string>>;
}

interface Turn2aRecord {
  readonly iteration: number;
  readonly hostId: DeepgramTtsHostSpec["id"];
  readonly socketMode: "warm" | "fresh";
  readonly lengthKind: "short" | "long";
  readonly openTimings: WsConnectionTimings | null;
  readonly result: TtsTurnResult;
  readonly formatCheck: RawPcmFormatCheck;
}

interface Stream2bRecord {
  readonly iteration: number;
  readonly hostId: DeepgramTtsHostSpec["id"];
  readonly gapMs: 50 | 300;
  readonly result: TtsTwoSentenceResult;
  readonly formatCheck: RawPcmFormatCheck;
}

interface Clear2cRecord {
  readonly iteration: number;
  readonly hostId: DeepgramTtsHostSpec["id"];
  readonly result: TtsBargeInClearResult;
}

interface Rest2eRecord {
  readonly iteration: number;
  readonly hostId: DeepgramTtsHostSpec["id"];
  readonly lengthKind: "short" | "long";
  readonly newSocket: boolean;
  readonly statusCode: number;
  readonly ok: boolean;
  readonly headersMs: number;
  readonly ttfbMs: number | null;
  readonly totalMs: number;
  readonly firstChunkMs: number;
  readonly streamRtf: number | null;
  readonly underrunsJ0: number;
  readonly starvedMsJ0: number;
  readonly underrunsJ100: number;
  readonly starvedMsJ100: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly formatCheck: RawPcmFormatCheck;
  readonly errorMessage: string | null;
}

interface IdleProbeRecord {
  readonly hostId: DeepgramTtsHostSpec["id"];
  readonly pingOk: boolean;
  readonly pingRttMs: number | null;
  readonly keepAliveReaction: {
    readonly notices: readonly ClassifiedServerNotice[];
    readonly closedByServer: boolean;
    readonly closeCode: number | null;
    readonly closeReason: string | null;
    readonly rawTextMessages: readonly string[];
  };
  readonly pureIdleHold: {
    readonly closedByServer: boolean;
    readonly idleElapsedMs: number;
    readonly closeCode: number | null;
    readonly closeReason: string | null;
    readonly notices: readonly ClassifiedServerNotice[];
  };
}

function printStatsLine(label: string, s: DistributionStats): void {
  console.log(
    `  ${label}: n=${s.count} | min=${formatMs(s.min)} | med=${formatMs(s.median)} | p90=${formatMs(s.p90)} | max=${formatMs(s.max)}`,
  );
}

async function probeHosts(
  apiKey: string,
  model: string,
  hosts: readonly DeepgramTtsHostSpec[] = DEEPGRAM_TTS_HOSTS,
): Promise<HostCapability[]> {
  const results: HostCapability[] = [];
  for (const spec of hosts) {
    const wsUrl = buildDeepgramSpeakWsUrl(spec.host, { model });
    let wsSupported = false;
    let wsProbeError: string | null = null;
    let wsOpenTimings: WsConnectionTimings | null = null;
    let sampleHeaders: Record<string, string> = {};

    try {
      const sess = await DeepgramTtsWsSession.connect(wsUrl, apiKey);
      wsOpenTimings = sess.connectTimings;
      sampleHeaders = { ...sess.connectTimings.headers };
      // Send a tiny Speak+Flush check ("Hi.")? No, 0 chars until we confirm or just check WS upgrade + Metadata!
      // Wait: some hosts might accept HTTP 101 or reject on Speak; test 1 short phrase "Hi." (3 chars, budgeted)
      const probeTurn = await sess.synthesizeTurn({ text: "Hi.", turnTimeoutMs: 8000 });
      if (probeTurn.pcmBytes.byteLength > 0 && probeTurn.notices.every((n) => n.kind !== "error")) {
        wsSupported = true;
      } else {
        const err = probeTurn.notices.find((n) => n.kind === "error");
        wsProbeError = err
          ? `WS Error [${err.code}]: ${err.description}`
          : `WS produced 0 audio bytes (close=${probeTurn.closeCode ?? "none"} ${probeTurn.closeReason ?? ""})`;
      }
      await sess.closeGracefully();
    } catch (err) {
      if (err instanceof DeepgramTtsWsError) {
        wsProbeError = `${err.failure.phase} HTTP=${err.failure.statusCode ?? "n/a"} ${err.failure.errorCode ?? ""} ${err.failure.message}`;
        sampleHeaders = { ...err.failure.headers };
      } else {
        wsProbeError = err instanceof Error ? err.message : String(err);
      }
    }

    const restUrl = buildDeepgramSpeakRestUrl(spec.host, { model });
    let restSupported = false;
    let restProbeError: string | null = null;
    const warm = createWarmRestAgent();
    try {
      const restRes = await synthesizeRest({
        url: restUrl,
        apiKey,
        text: "Hi.",
        dispatcher: warm.agent,
        consumeNewSocketFlag: warm.consumeNewSocketFlag,
        timeoutMs: 8000,
      });
      if (restRes.ok && restRes.pcmBytes.byteLength > 0) {
        restSupported = true;
      } else {
        restProbeError = `REST HTTP ${restRes.statusCode}: ${restRes.errorMessage ?? "empty body"}`;
      }
    } catch (err) {
      restProbeError = err instanceof Error ? err.message : String(err);
    } finally {
      await warm.close();
    }

    results.push({
      spec,
      wsSupported,
      wsProbeError,
      wsOpenTimings,
      restSupported,
      restProbeError,
      sampleHeaders,
    });
  }
  return results;
}

async function runIdleLifetimeProbe(apiKey: string, model: string, maxWaitMs: number): Promise<void> {
  const hostSpec = DEEPGRAM_TTS_HOSTS.find((h) => h.id === "in");
  if (!hostSpec) {
    throw new Error("India host spec (id='in') not found");
  }
  const wsUrl = buildDeepgramSpeakWsUrl(hostSpec.host, { model });
  console.log("=== Deepgram Aura-2 TTS — Idle Lifetime Probe (0 chars) ===");
  console.log(
    `Host: ${hostSpec.host} | Model: ${model} | MaxWait: ${(maxWaitMs / 1000).toFixed(0)} s | WS ping every ${(IDLE_PROBE_PING_INTERVAL_MS / 1000).toFixed(0)} s (no KeepAlive, no Speak)`,
  );

  const sess = await DeepgramTtsWsSession.connect(wsUrl, apiKey);
  try {
    console.log(
      `  Connected in ${sess.connectTimings.totalOpenMs.toFixed(1)} ms (HTTP ${sess.connectTimings.statusCode})`,
    );
    const res = await sess.waitForIdleClose(maxWaitMs, {
      pingIntervalMs: IDLE_PROBE_PING_INTERVAL_MS,
      onPing: (rttMs, elapsedMs) => {
        console.log(
          `  [${(elapsedMs / 1000).toFixed(1)}s] WS ping -> ${rttMs !== null ? `pong ${rttMs.toFixed(1)} ms` : "no pong"}`,
        );
      },
    });
    if (res.closedByServer) {
      console.log(
        `RESULT: Server closed idle /speak socket at ${(res.idleElapsedMs / 1000).toFixed(2)} s | closeCode=${res.closeCode ?? "none"} | closeReason="${res.closeReason ?? ""}" | notices=${res.notices.length}`,
      );
    } else {
      console.log(
        `RESULT: Socket stayed OPEN for full ${(res.idleElapsedMs / 1000).toFixed(2)} s (${(maxWaitMs / 1000).toFixed(0)} s cap) | notices=${res.notices.length}`,
      );
    }
    for (const n of res.notices) {
      console.log(`  Notice: ${n.kind.toUpperCase()} [${n.code}] ${n.description}`);
    }
  } finally {
    await sess.closeGracefully();
  }
  console.log(`Active resources after idle probe: ${JSON.stringify(process.getActiveResourcesInfo())}`);
}

async function main(): Promise<void> {
  loadEnvFromRoot();
  const cfg = loadTtsSpikeConfig(process.env);
  const argv = process.argv.slice(2);
  const isIdleProbe = hasCliFlag(argv, "--idle-probe");
  const isSmoke = hasCliFlag(argv, "--smoke");

  if (isIdleProbe) {
    const maxWaitMs = parseCliIntFlag(argv, "--idle-ms", IDLE_PROBE_5MIN_MS);
    await runIdleLifetimeProbe(cfg.deepgramApiKey, cfg.ttsModel, maxWaitMs);
    return;
  }

  const N = parseCliIntFlag(argv, "--n", isSmoke ? 1 : DEFAULT_N);
  const idleWaitMs = parseCliIntFlag(argv, "--idle-ms", isSmoke ? 2000 : IDLE_WAIT_MAX_MS);
  const targetHosts = isSmoke
    ? DEEPGRAM_TTS_HOSTS.filter((h) => h.id === "in")
    : DEEPGRAM_TTS_HOSTS;

  const hostsCount = targetHosts.length;
  const probeChars = hostsCount * 6; // "Hi." (3) WS + "Hi." (3) REST per host
  const chars2a = hostsCount * 2 * (SHORT_TEXT.length + LONG_TEXT.length) * N;
  const chars2b = hostsCount * 2 * (STREAM_S1.length + STREAM_S2.length) * N;
  const chars2c = hostsCount * (LONG_TEXT.length + SHORT_TEXT.length) * N;
  const chars2eWarmup = hostsCount * SHORT_TEXT.length;
  const chars2e = hostsCount * (SHORT_TEXT.length + LONG_TEXT.length) * N;
  const charsManual = isSmoke ? 0 : hostsCount * TIME_TEXT.length;
  const plannedChars =
    probeChars + chars2a + chars2b + chars2c + chars2eWarmup + chars2e + charsManual;

  const budget = evaluateTtsCharBudget(plannedChars, cfg.maxChars);
  console.log(`=== Deepgram Aura-2 TTS Spike${isSmoke ? " (SMOKE)" : ""} — Character & Cost Budget ===`);
  console.log(`Model: ${cfg.ttsModel} | Hosts: ${targetHosts.map((h) => h.host).join(", ")} | N=${N}`);
  console.log(
    `Planned chars breakdown: probe=${probeChars}, 2a=${chars2a}, 2b=${chars2b}, 2c=${chars2c}, 2e_warmup=${chars2eWarmup}, 2e=${chars2e}, manual_wav=${charsManual}`,
  );
  console.log(
    `Total planned: ${budget.plannedChars} chars (limit=${budget.maxChars}, est=$${budget.estimatedUsd.toFixed(4)} @ $0.030/1k vs $200 credit)`,
  );
  if (!budget.ok) {
    console.error(`ABORT: ${budget.reason}`);
    process.exitCode = 1;
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });

  console.log("\n=== Host Capability Probe (WS + REST /v1/speak) ===");
  const capabilities = await probeHosts(cfg.deepgramApiKey, cfg.ttsModel, targetHosts);
  for (const cap of capabilities) {
    console.log(
      `  ${cap.spec.host} (${cap.spec.regionLabel}): WS=${cap.wsSupported ? "OK" : `UNSUPPORTED (${cap.wsProbeError})`} | REST=${cap.restSupported ? "OK" : `UNSUPPORTED (${cap.restProbeError})`}`,
    );
    if (cap.wsOpenTimings) {
      console.log(
        `    WS open probe: total=${cap.wsOpenTimings.totalOpenMs.toFixed(1)} ms (DNS ${cap.wsOpenTimings.dnsMs.toFixed(1)} / TCP ${cap.wsOpenTimings.tcpMs.toFixed(1)} / TLS ${cap.wsOpenTimings.tlsMs.toFixed(1)} / Upgrade ${cap.wsOpenTimings.upgradeMs.toFixed(1)} ms)`,
      );
    }
  }

  const wsHosts = capabilities.filter((c) => c.wsSupported).map((c) => c.spec);
  const restHosts = capabilities.filter((c) => c.restSupported).map((c) => c.spec);

  const allNotices: Array<{
    readonly phase: string;
    readonly host: string;
    readonly notice: ClassifiedServerNotice;
  }> = [];

  // 2a: tts_first_audio (warm & fresh × serving hosts × short & long, interleaved)
  console.log("\n=== 2a. tts_first_audio (WS Warm vs Fresh × Short vs Long, interleaved) ===");
  const warm2aSockets = new Map<string, DeepgramTtsWsSession>();
  const records2a: Turn2aRecord[] = [];
  const savedWavs: Array<{ readonly file: string; readonly host: string; readonly text: string; readonly durationMs: number }> = [];
  const savedShortWsHosts = new Set<string>();
  const savedLongWsHosts = new Set<string>();

  try {
    for (const h of wsHosts) {
      warm2aSockets.set(
        h.id,
        await DeepgramTtsWsSession.connect(
          buildDeepgramSpeakWsUrl(h.host, { model: cfg.ttsModel }),
          cfg.deepgramApiKey,
        ),
      );
    }

    for (let i = 0; i < N; i += 1) {
      const lengthOrder: readonly ("short" | "long")[] = i % 2 === 0 ? ["short", "long"] : ["long", "short"];
      const slots: Array<{ readonly host: DeepgramTtsHostSpec; readonly mode: "warm" | "fresh" }> = [];
      for (const h of wsHosts) slots.push({ host: h, mode: "warm" });
      for (const h of wsHosts) slots.push({ host: h, mode: "fresh" });

      for (const slot of slots) {
        for (const lengthKind of lengthOrder) {
          const text = lengthKind === "short" ? SHORT_TEXT : LONG_TEXT;
          let session: DeepgramTtsWsSession;
          let openTimings: WsConnectionTimings | null = null;
          if (slot.mode === "warm") {
            let existing = warm2aSockets.get(slot.host.id);
            if (!existing || !existing.isOpen) {
              if (existing) {
                await existing.closeGracefully();
                warm2aSockets.delete(slot.host.id);
              }
              existing = await DeepgramTtsWsSession.connect(
                buildDeepgramSpeakWsUrl(slot.host.host, { model: cfg.ttsModel }),
                cfg.deepgramApiKey,
              );
              warm2aSockets.set(slot.host.id, existing);
              openTimings = existing.connectTimings;
            } else {
              openTimings = { ...existing.connectTimings, newSocket: false };
            }
            session = existing;
          } else {
            session = await DeepgramTtsWsSession.connect(
              buildDeepgramSpeakWsUrl(slot.host.host, { model: cfg.ttsModel }),
              cfg.deepgramApiKey,
            );
            openTimings = session.connectTimings;
          }

          try {
            const result = await session.synthesizeTurn({ text });
            for (const notice of result.notices) {
              allNotices.push({ phase: "2a", host: slot.host.host, notice });
            }
            if (slot.mode === "warm" && (result.timedOut || !session.isOpen)) {
              await session.closeGracefully();
              warm2aSockets.delete(slot.host.id);
            }
            const formatCheck = checkRawPcm24kFormat(result.pcmBytes, text);
            records2a.push({
              iteration: i + 1,
              hostId: slot.host.id,
              socketMode: slot.mode,
              lengthKind,
              openTimings,
              result,
              formatCheck,
            });

            if (!isSmoke && lengthKind === "short" && !savedShortWsHosts.has(slot.host.id) && result.pcmBytes.byteLength > 0) {
              savedShortWsHosts.add(slot.host.id);
              const wavPath = path.join(OUT_DIR, `order-1042-${slot.host.id}-ws.wav`);
              await writePcm16Wav(wavPath, result.pcmBytes);
              savedWavs.push({
                file: path.relative(REPO_ROOT, wavPath).replace(/\\/g, "/"),
                host: slot.host.host,
                text,
                durationMs: formatCheck.durationMs,
              });
            }
            if (!isSmoke && lengthKind === "long" && !savedLongWsHosts.has(slot.host.id) && result.pcmBytes.byteLength > 0) {
              savedLongWsHosts.add(slot.host.id);
              const wavPath = path.join(OUT_DIR, `long-20w-${slot.host.id}-ws.wav`);
              await writePcm16Wav(wavPath, result.pcmBytes);
              savedWavs.push({
                file: path.relative(REPO_ROOT, wavPath).replace(/\\/g, "/"),
                host: slot.host.host,
                text,
                durationMs: formatCheck.durationMs,
              });
            }
          } finally {
            if (slot.mode === "fresh") {
              await session.closeGracefully();
            }
          }
        }
      }
      console.log(`  2a iteration ${i + 1}/${N} done`);
    }
  } finally {
    for (const sess of warm2aSockets.values()) {
      await sess.closeGracefully();
    }
    warm2aSockets.clear();
  }

  // 2b: Sentence streaming (50 ms vs 300 ms gaps, interleaved across hosts & gaps)
  console.log("\n=== 2b. Sentence Streaming Timeline (gap 50 ms vs 300 ms, interleaved) ===");
  const warm2bSockets = new Map<string, DeepgramTtsWsSession>();
  const records2b: Stream2bRecord[] = [];
  try {
    for (const h of wsHosts) {
      for (const gapMs of [50, 300] as const) {
        warm2bSockets.set(
          `${h.id}:${gapMs}`,
          await DeepgramTtsWsSession.connect(
            buildDeepgramSpeakWsUrl(h.host, { model: cfg.ttsModel }),
            cfg.deepgramApiKey,
          ),
        );
      }
    }

    for (let i = 0; i < N; i += 1) {
      const gaps: readonly (50 | 300)[] = i % 2 === 0 ? [50, 300] : [300, 50];
      for (const gapMs of gaps) {
        for (const h of wsHosts) {
          const key = `${h.id}:${gapMs}`;
          let sess = warm2bSockets.get(key);
          if (!sess || !sess.isOpen) {
            if (sess) {
              await sess.closeGracefully();
              warm2bSockets.delete(key);
            }
            sess = await DeepgramTtsWsSession.connect(
              buildDeepgramSpeakWsUrl(h.host, { model: cfg.ttsModel }),
              cfg.deepgramApiKey,
            );
            warm2bSockets.set(key, sess);
          }
          const result = await sess.streamTwoSentences({
            sentence1: STREAM_S1,
            sentence2: STREAM_S2,
            gapMs,
          });
          for (const notice of result.notices) {
            allNotices.push({ phase: "2b", host: h.host, notice });
          }
          if (result.timedOut || !sess.isOpen) {
            await sess.closeGracefully();
            warm2bSockets.delete(key);
          }
          const formatCheck = checkRawPcm24kFormat(result.pcmBytes, `${STREAM_S1} ${STREAM_S2}`);
          records2b.push({
            iteration: i + 1,
            hostId: h.id,
            gapMs,
            result,
            formatCheck,
          });
        }
      }
      console.log(`  2b iteration ${i + 1}/${N} done`);
    }
  } finally {
    for (const sess of warm2bSockets.values()) {
      await sess.closeGracefully();
    }
    warm2bSockets.clear();
  }

  // 2c: Barge-in Clear + immediate next turn on same socket
  console.log("\n=== 2c. Barge-in Clear + Same-Socket Survival (interleaved) ===");
  const warm2cSockets = new Map<string, DeepgramTtsWsSession>();
  const records2c: Clear2cRecord[] = [];
  try {
    for (const h of wsHosts) {
      warm2cSockets.set(
        h.id,
        await DeepgramTtsWsSession.connect(
          buildDeepgramSpeakWsUrl(h.host, { model: cfg.ttsModel }),
          cfg.deepgramApiKey,
        ),
      );
    }

    for (let i = 0; i < N; i += 1) {
      for (const h of wsHosts) {
        let sess = warm2cSockets.get(h.id);
        if (!sess || !sess.isOpen) {
          if (sess) {
            await sess.closeGracefully();
            warm2cSockets.delete(h.id);
          }
          sess = await DeepgramTtsWsSession.connect(
            buildDeepgramSpeakWsUrl(h.host, { model: cfg.ttsModel }),
            cfg.deepgramApiKey,
          );
          warm2cSockets.set(h.id, sess);
        }
        const result = await sess.runBargeInClear({
          sentence1: LONG_TEXT,
          nextSentence: SHORT_TEXT,
          clearAfterFirstAudioMs: 40,
          postClearDrainMs: 150,
        });
        for (const notice of result.notices) {
          allNotices.push({ phase: "2c", host: h.host, notice });
        }
        if (!result.socketSurvived || !sess.isOpen) {
          await sess.closeGracefully();
          warm2cSockets.delete(h.id);
        }
        records2c.push({
          iteration: i + 1,
          hostId: h.id,
          result,
        });
      }
      console.log(`  2c iteration ${i + 1}/${N} done`);
    }
  } finally {
    for (const sess of warm2cSockets.values()) {
      await sess.closeGracefully();
    }
    warm2cSockets.clear();
  }

  // 2e: REST comparison (warm undici Agent per serving host)
  console.log("\n=== 2e. REST POST /v1/speak Comparison (warm undici Agent, interleaved) ===");
  const restAgents = new Map<string, ReturnType<typeof createWarmRestAgent>>();
  const records2e: Rest2eRecord[] = [];
  const savedRestHosts = new Set<string>();
  try {
    for (const h of restHosts) {
      const warm = createWarmRestAgent();
      restAgents.set(h.id, warm);
      // Single warm-up request (included in budget) so all N*2 benchmark requests reuse socket
      await synthesizeRest({
        url: buildDeepgramSpeakRestUrl(h.host, { model: cfg.ttsModel }),
        apiKey: cfg.deepgramApiKey,
        text: SHORT_TEXT,
        dispatcher: warm.agent,
        consumeNewSocketFlag: warm.consumeNewSocketFlag,
      });
    }

    for (let i = 0; i < N; i += 1) {
      const lengthOrder: readonly ("short" | "long")[] = i % 2 === 0 ? ["short", "long"] : ["long", "short"];
      for (const h of restHosts) {
        const warm = restAgents.get(h.id)!;
        const url = buildDeepgramSpeakRestUrl(h.host, { model: cfg.ttsModel });
        for (const lengthKind of lengthOrder) {
          const text = lengthKind === "short" ? SHORT_TEXT : LONG_TEXT;
          const res = await synthesizeRest({
            url,
            apiKey: cfg.deepgramApiKey,
            text,
            dispatcher: warm.agent,
            consumeNewSocketFlag: warm.consumeNewSocketFlag,
          });
          const formatCheck = checkRawPcm24kFormat(res.pcmBytes, text);
          records2e.push({
            iteration: i + 1,
            hostId: h.id,
            lengthKind,
            newSocket: res.newSocket,
            statusCode: res.statusCode,
            ok: res.ok,
            headersMs: res.headersMs,
            ttfbMs: res.ttfbMs,
            totalMs: res.totalMs,
            firstChunkMs: res.timelineJ0.firstChunkMs,
            streamRtf: res.timelineJ0.streamRtf,
            underrunsJ0: res.timelineJ0.underrunCount,
            starvedMsJ0: res.timelineJ0.totalStarvedMs,
            underrunsJ100: res.timelineJ100.underrunCount,
            starvedMsJ100: res.timelineJ100.totalStarvedMs,
            headers: res.headers,
            formatCheck,
            errorMessage: res.errorMessage,
          });

          if (!isSmoke && lengthKind === "short" && !savedRestHosts.has(h.id) && res.pcmBytes.byteLength > 0) {
            savedRestHosts.add(h.id);
            const wavPath = path.join(OUT_DIR, `order-1042-${h.id}-rest.wav`);
            await writePcm16Wav(wavPath, res.pcmBytes);
            savedWavs.push({
              file: path.relative(REPO_ROOT, wavPath).replace(/\\/g, "/"),
              host: h.host,
              text,
              durationMs: formatCheck.durationMs,
            });
          }
        }
      }
      console.log(`  2e iteration ${i + 1}/${N} done`);
    }
  } finally {
    for (const warm of restAgents.values()) {
      await warm.close();
    }
    restAgents.clear();
  }

  // Manual listening time WAV
  if (!isSmoke) {
    for (const h of wsHosts) {
      const sess = await DeepgramTtsWsSession.connect(
        buildDeepgramSpeakWsUrl(h.host, { model: cfg.ttsModel }),
        cfg.deepgramApiKey,
      );
      try {
        const turn = await sess.synthesizeTurn({ text: TIME_TEXT });
        for (const notice of turn.notices) {
          allNotices.push({ phase: "manual_wav", host: h.host, notice });
        }
        const fmt = checkRawPcm24kFormat(turn.pcmBytes, TIME_TEXT);
        if (turn.pcmBytes.byteLength > 0) {
          const wavPath = path.join(OUT_DIR, `time-345pm-${h.id}-ws.wav`);
          await writePcm16Wav(wavPath, turn.pcmBytes);
          savedWavs.push({
            file: path.relative(REPO_ROOT, wavPath).replace(/\\/g, "/"),
            host: h.host,
            text: TIME_TEXT,
            durationMs: fmt.durationMs,
          });
        }
      } finally {
        await sess.closeGracefully();
      }
    }
  }

  // 2d: Idle timeout & KeepAlive behavior per serving host
  console.log("\n=== 2d. Idle Timeout & KeepAlive / WS Ping Probe ===");
  const idleProbes: IdleProbeRecord[] = [];
  for (const h of wsHosts) {
    const wsUrl = buildDeepgramSpeakWsUrl(h.host, { model: cfg.ttsModel });

    // Probe 1: WS ping/pong + {"type":"KeepAlive"}
    const sess1 = await DeepgramTtsWsSession.connect(wsUrl, cfg.deepgramApiKey);
    let ping: { readonly ok: boolean; readonly rttMs: number | null };
    let keepAliveReaction: IdleProbeRecord["keepAliveReaction"];
    try {
      ping = await sess1.probePing(4000);
      keepAliveReaction = await sess1.probeJsonControl({ type: "KeepAlive" }, 4000);
      for (const notice of keepAliveReaction.notices) {
        allNotices.push({ phase: "2d_keepalive", host: h.host, notice });
      }
    } finally {
      await sess1.closeGracefully();
    }

    // Probe 2: Pure idle hold (no Speak, no KeepAlive)
    const sess2 = await DeepgramTtsWsSession.connect(wsUrl, cfg.deepgramApiKey);
    let pureIdleHold: IdleProbeRecord["pureIdleHold"];
    try {
      pureIdleHold = await sess2.waitForIdleClose(idleWaitMs);
      for (const notice of pureIdleHold.notices) {
        allNotices.push({ phase: "2d_idle", host: h.host, notice });
      }
    } finally {
      await sess2.closeGracefully();
    }

    idleProbes.push({
      hostId: h.id,
      pingOk: ping.ok,
      pingRttMs: ping.rttMs,
      keepAliveReaction,
      pureIdleHold,
    });
    console.log(
      `  ${h.host}: ping=${ping.ok ? formatMs(ping.rttMs) : "FAIL"} | KeepAlive=${keepAliveReaction.closedByServer ? `CLOSED(${keepAliveReaction.closeCode} ${keepAliveReaction.closeReason})` : "OPEN"} notices=${keepAliveReaction.notices.length} | idle=${pureIdleHold.closedByServer ? `CLOSED@${(pureIdleHold.idleElapsedMs / 1000).toFixed(1)}s(${pureIdleHold.closeCode} ${pureIdleHold.closeReason})` : `STILL_OPEN>=${(pureIdleHold.idleElapsedMs / 1000).toFixed(1)}s`}`,
    );
  }

  // Print full human-readable summary tables
  console.log("\n=== SUMMARY: 2a tts_first_audio (WS /v1/speak) ===");
  for (const h of targetHosts) {
    const cap = capabilities.find((c) => c.spec.id === h.id)!;
    if (!cap.wsSupported) {
      console.log(`  ${h.host}: UNSUPPORTED (${cap.wsProbeError})`);
      continue;
    }
    for (const mode of ["warm", "fresh"] as const) {
      for (const lengthKind of ["short", "long"] as const) {
        const subset = records2a.filter(
          (r) => r.hostId === h.id && r.socketMode === mode && r.lengthKind === lengthKind,
        );
        const flushFirst = summarize(nonNull(subset.map((r) => r.result.flushToFirstAudioMs)));
        const speakFirst = summarize(nonNull(subset.map((r) => r.result.speakToFirstAudioMs)));
        const flushed = summarize(nonNull(subset.map((r) => r.result.flushedMs)));
        const beforeFlushCount = subset.filter((r) => r.result.audioStartedBeforeFlush).length;
        const timedOutCount = subset.filter((r) => r.result.timedOut).length;
        const newSockCount = subset.filter((r) => r.openTimings?.newSocket === true).length;
        const j0 = summarizeTimeline(subset.map((r) => r.result.timelineJ0));
        const j100 = summarizeTimeline(subset.map((r) => r.result.timelineJ100));
        console.log(
          `  ${h.host} | ${mode} | ${lengthKind} (n=${subset.length}): flush->1st=${formatMs(flushFirst.median)}/${formatMs(flushFirst.p90)} | speak->1st=${formatMs(speakFirst.median)}/${formatMs(speakFirst.p90)} | preFlush=${beforeFlushCount}/${subset.length} | timedOut=${timedOutCount}/${subset.length} | newSock=${newSockCount}/${subset.length} | flushed=${formatMs(flushed.median)}/${formatMs(flushed.p90)} | 1stChunk=${formatMs(j0.firstChunkMs.median)} | RTF=${formatNum(j0.streamRtf.median)}x | J0_underruns=${j0.underrunRuns}/${j0.n}(starved med=${formatMs(j0.starvedMs.median)} max=${formatMs(j0.starvedMs.max)}) | J100_underruns=${j100.underrunRuns}/${j100.n}(starved med=${formatMs(j100.starvedMs.median)} max=${formatMs(j100.starvedMs.max)})`,
        );
      }
    }
  }

  console.log("\n=== SUMMARY: 2b Sentence Streaming Timeline ===");
  for (const h of wsHosts) {
    for (const gapMs of [50, 300] as const) {
      const subset = records2b.filter((r) => r.hostId === h.id && r.gapMs === gapMs);
      const first = summarize(nonNull(subset.map((r) => r.result.flush1ToFirstAudioMs)));
      const j0 = summarizeTimeline(subset.map((r) => r.result.timelineJ0));
      const j100 = summarizeTimeline(subset.map((r) => r.result.timelineJ100));
      console.log(
        `  ${h.host} | gap=${gapMs}ms (n=${subset.length}): flush1->1st=${formatMs(first.median)}/${formatMs(first.p90)} | 1stChunk=${formatMs(j0.firstChunkMs.median)} | RTF=${formatNum(j0.streamRtf.median)}x | J0: runs=${j0.underrunRuns}/${j0.n} cntMed=${formatNum(j0.underrunCounts.median, 1)} starvedMed=${formatMs(j0.starvedMs.median)} starvedMax=${formatMs(j0.starvedMs.max)} | J100: runs=${j100.underrunRuns}/${j100.n} cntMed=${formatNum(j100.underrunCounts.median, 1)} starvedMed=${formatMs(j100.starvedMs.median)} starvedMax=${formatMs(j100.starvedMs.max)}`,
      );
    }
  }

  console.log("\n=== SUMMARY: 2c Barge-in Clear ===");
  for (const h of wsHosts) {
    const subset = records2c.filter((r) => r.hostId === h.id);
    const cleared = summarize(nonNull(subset.map((r) => r.result.clearToClearedMs)));
    const postBytes = summarize(subset.map((r) => r.result.totalPostClearBytes));
    const t2First = summarize(nonNull(subset.map((r) => r.result.turn2FirstAudioMs)));
    const survived = subset.filter((r) => r.result.socketSurvived).length;
    const midStreamCount = subset.filter((r) => !r.result.flushedBeforeClear).length;
    console.log(
      `  ${h.host} (n=${subset.length}): midStream=${midStreamCount}/${subset.length} | Clear->Cleared=${formatMs(cleared.median)}/${formatMs(cleared.p90)} | postClearBytes med=${formatNum(postBytes.median, 0)} max=${formatNum(postBytes.max, 0)} | survival=${formatPct(survived, subset.length)} | nextTurn 1st=${formatMs(t2First.median)}/${formatMs(t2First.p90)}`,
    );
  }

  console.log("\n=== SUMMARY: 2d Open Cost (from 2a fresh sockets) ===");
  for (const h of wsHosts) {
    const freshSubset = records2a.filter((r) => r.hostId === h.id && r.socketMode === "fresh");
    const opens = nonNull(freshSubset.map((r) => r.openTimings?.totalOpenMs ?? null));
    const dns = nonNull(freshSubset.map((r) => r.openTimings?.dnsMs ?? null));
    const tcp = nonNull(freshSubset.map((r) => r.openTimings?.tcpMs ?? null));
    const tls = nonNull(freshSubset.map((r) => r.openTimings?.tlsMs ?? null));
    const upg = nonNull(freshSubset.map((r) => r.openTimings?.upgradeMs ?? null));
    const warmSubset = records2a.filter((r) => r.hostId === h.id && r.socketMode === "warm");
    const warmNew = warmSubset.filter((r) => r.openTimings?.newSocket === true).length;
    console.log(
      `  ${h.host} fresh (n=${opens.length}): total=${formatMs(summarize(opens).median)}/${formatMs(summarize(opens).p90)} (DNS ${formatMs(summarize(dns).median)} / TCP ${formatMs(summarize(tcp).median)} / TLS ${formatMs(summarize(tls).median)} / Upgrade ${formatMs(summarize(upg).median)}) | warm newSockets=${warmNew}/${warmSubset.length}`,
    );
  }

  console.log("\n=== SUMMARY: 2e REST Comparison (warm undici Agent) ===");
  for (const h of restHosts) {
    for (const lengthKind of ["short", "long"] as const) {
      const subset = records2e.filter((r) => r.hostId === h.id && r.lengthKind === lengthKind);
      const ttfb = summarize(nonNull(subset.map((r) => r.ttfbMs)));
      const total = summarize(subset.map((r) => r.totalMs));
      const newSock = subset.filter((r) => r.newSocket).length;
      const okCount = subset.filter((r) => r.ok).length;
      console.log(
        `  ${h.host} | ${lengthKind} (n=${subset.length}): ok=${okCount}/${subset.length} | newSock=${newSock}/${subset.length} | TTFB=${formatMs(ttfb.median)}/${formatMs(ttfb.p90)} | total=${formatMs(total.median)}/${formatMs(total.p90)}`,
      );
    }
  }

  console.log("\n=== SUMMARY: 2f Format Check & Saved WAVs ===");
  const allFmts = [
    ...records2a.map((r) => r.formatCheck),
    ...records2b.map((r) => r.formatCheck),
    ...records2e.map((r) => r.formatCheck),
  ];
  const riffCount = allFmts.filter((f) => f.hasRiffHeader).length;
  const oddCount = allFmts.filter((f) => !f.evenByteLength).length;
  const okFmtCount = allFmts.filter((f) => f.ok).length;
  console.log(
    `  Raw PCM checks (n=${allFmts.length}): ok=${okFmtCount}/${allFmts.length}, riffHeaders=${riffCount}, oddByteLen=${oddCount}`,
  );
  for (const w of savedWavs) {
    console.log(`  WAV: ${w.file} (${w.durationMs.toFixed(0)} ms, "${w.text}")`);
  }

  console.log("\n=== SUMMARY: Classified Warnings & Errors ===");
  console.log(`  Total notices observed: ${allNotices.length}`);
  for (const item of allNotices) {
    console.log(
      `  [${item.phase}] ${item.host} | ${item.notice.kind.toUpperCase()} | category=${item.notice.category} | code=${item.notice.code} | ${item.notice.description}`,
    );
  }

  // Write results.json (convert Buffers to byte lengths so JSON stays compact)
  const serializable = {
    generatedAt: new Date().toISOString(),
    model: cfg.ttsModel,
    n: N,
    budget,
    capabilities,
    records2a: records2a.map((r) => ({
      iteration: r.iteration,
      hostId: r.hostId,
      socketMode: r.socketMode,
      lengthKind: r.lengthKind,
      openTimings: r.openTimings,
      flushToFirstAudioMs: r.result.flushToFirstAudioMs,
      speakToFirstAudioMs: r.result.speakToFirstAudioMs,
      audioStartedBeforeFlush: r.result.audioStartedBeforeFlush,
      flushedMs: r.result.flushedMs,
      timedOut: r.result.timedOut,
      pcmByteLength: r.result.pcmBytes.byteLength,
      timelineJ0: r.result.timelineJ0,
      timelineJ100: r.result.timelineJ100,
      notices: r.result.notices,
      formatCheck: r.formatCheck,
    })),
    records2b: records2b.map((r) => ({
      iteration: r.iteration,
      hostId: r.hostId,
      gapMs: r.gapMs,
      flush1ToFirstAudioMs: r.result.flush1ToFirstAudioMs,
      flush2ToS2StartGapActualMs: r.result.flush2ToS2StartGapActualMs,
      flushedCount: r.result.flushedCount,
      totalFlushedMs: r.result.totalFlushedMs,
      timedOut: r.result.timedOut,
      pcmByteLength: r.result.pcmBytes.byteLength,
      timelineJ0: r.result.timelineJ0,
      timelineJ100: r.result.timelineJ100,
      notices: r.result.notices,
      formatCheck: r.formatCheck,
    })),
    records2c,
    records2e,
    idleProbes,
    savedWavs,
    allNotices,
  };
  const outPath = isSmoke ? path.join(OUT_DIR, "smoke-results.json") : RESULTS_PATH;
  writeFileSync(outPath, JSON.stringify(serializable, null, 2), "utf8");
  console.log(`\nSaved ${path.relative(REPO_ROOT, outPath).replace(/\\/g, "/")}`);
  console.log(`Active resources at completion: ${JSON.stringify(process.getActiveResourcesInfo())}`);
  void printStatsLine;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
