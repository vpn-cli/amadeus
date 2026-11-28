import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ZodError, z } from "zod";
import {
  sliceTurnAudio,
  type DeliveryMode,
  type SlicedTurnAudio,
  type VadSegmentSpec,
} from "./audio-slicer.js";
import {
  DEEPGRAM_DOC_ENDPOINTS,
  GROQ_WHISPER_ASD_LIMIT,
  GROQ_WHISPER_ASH_LIMIT,
  GROQ_WHISPER_RPD_LIMIT,
  buildDeepgramListenUrl,
  evaluateSttQuota,
  loadSttSpikeConfig,
  parseDotEnv,
  type DeepgramEndpointSpec,
  type SttSpikeEnvConfig,
} from "./config.js";
import {
  scoreTranscriptAccuracy,
  type DeepgramMetadataMessage,
  type SttAccuracyScore,
} from "./deepgram-parser.js";
import { formatMs, formatPct, summarize, type DistributionStats } from "./stats.js";
import {
  appendWhisperUsageEntry,
  readWhisperUsageLedger,
  summarizeWhisperUsage,
} from "./usage-ledger.js";
import { readPcm16Wav } from "./wav.js";
import {
  createInstrumentedWhisperAgent,
  transcribeWithGroqWhisper,
  type WhisperTranscriptionOutcome,
} from "./whisper.js";
import {
  DeepgramWsError,
  DeepgramWsSession,
  type WsConnectionTimings,
} from "./ws-client.js";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const OUT_DIR = path.join(__dirname, "out");
const RESULTS_PATH = path.join(OUT_DIR, "results.json");
const WHISPER_LEDGER_PATH = path.join(OUT_DIR, "whisper-usage-ledger.jsonl");

const SILERO_DIR = path.resolve(__dirname, "../silero-vad");
const SAMPLE_WAV_PATH = path.join(SILERO_DIR, "out", "sample-16k.wav");
const SAMPLE_LABELS_PATH = path.join(SILERO_DIR, "out", "sample-16k.labels.txt");

const N_ENDPOINT_PROBES = 3;
const DEFAULT_N_RUNS = 10;
const WHISPER_MIN_GAP_MS = 3200; // <= 18.75 RPM (Groq Whisper free tier: 20 RPM)

const SileroJsonSchema = z.object({
  sampleRate: z.literal(16000),
  durationMs: z.number().positive(),
  segments: z
    .array(
      z.object({
        index: z.number().int().positive(),
        startMs: z.number().nonnegative(),
        confirmedAtMs: z.number().nonnegative(),
        endMs: z.number().positive(),
        decidedAtMs: z.number().positive(),
        onsetConfirmMs: z.number().positive(),
        vadEndMs: z.number().nonnegative(),
      }),
    )
    .min(1),
});

interface GroundTruthLine {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
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

function parseLabelsFile(filePath: string): GroundTruthLine[] {
  const lines: GroundTruthLine[] = [];
  const raw = readFileSync(filePath, "utf8");
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const startSec = Number(parts[0]);
    const endSec = Number(parts[1]);
    const text = parts.slice(2).join("\t").trim();
    if (Number.isFinite(startSec) && Number.isFinite(endSec) && text.length > 0) {
      lines.push({
        startMs: startSec * 1000,
        endMs: endSec * 1000,
        text,
      });
    }
  }
  return lines;
}

async function detectVadSegmentsFromSilero(): Promise<readonly VadSegmentSpec[]> {
  if (!existsSync(SAMPLE_WAV_PATH)) {
    throw new Error(
      `Missing ${SAMPLE_WAV_PATH}. Generate it first via: pnpm --dir spikes/silero-vad test-wav`,
    );
  }
  const tsxCli = path.join(SILERO_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const { stdout } = await execFileAsync(process.execPath, [tsxCli, "run.ts", "--json"], {
    cwd: SILERO_DIR,
  });
  const parsed = SileroJsonSchema.parse(JSON.parse(stdout) as unknown);
  const labels = existsSync(SAMPLE_LABELS_PATH) ? parseLabelsFile(SAMPLE_LABELS_PATH) : [];

  return parsed.segments.map((seg, idx) => {
    const label = labels[idx];
    const expectedText = label?.text ?? "";
    const expectedOrderId = /\bone zero four two\b|\b1042\b/i.test(expectedText) ? "1042" : null;
    return {
      index: seg.index,
      startMs: seg.startMs,
      confirmedAtMs: seg.confirmedAtMs,
      endMs: seg.endMs,
      decidedAtMs: seg.decidedAtMs,
      expectedText,
      expectedOrderId,
    };
  });
}

interface EndpointProbeAttempt {
  readonly ok: boolean;
  readonly statusCode: number | null;
  readonly errorPhase: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly dnsMs: number | null;
  readonly tcpMs: number | null;
  readonly tlsMs: number | null;
  readonly upgradeMs: number | null;
  readonly totalOpenMs: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly metadata: DeepgramMetadataMessage | null;
}

interface EndpointProbeReport {
  readonly spec: DeepgramEndpointSpec;
  readonly okCount: number;
  readonly nProbes: number;
  readonly working: boolean;
  readonly dnsMs: DistributionStats;
  readonly tcpMs: DistributionStats;
  readonly tlsMs: DistributionStats;
  readonly upgradeMs: DistributionStats;
  readonly totalOpenMs: DistributionStats;
  readonly statuses: readonly string[];
  readonly errors: readonly string[];
  readonly headerSnapshot: Readonly<Record<string, string>>;
  readonly metadataSample: DeepgramMetadataMessage | null;
}

function extractInterestingHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const skip = new Set([
    "upgrade",
    "connection",
    "sec-websocket-accept",
    "set-cookie",
    "authorization",
  ]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (!skip.has(lk)) {
      out[lk] = v;
    }
  }
  return out;
}

async function probeDeepgramEndpoints(
  cfg: SttSpikeEnvConfig,
): Promise<{
  readonly reports: readonly EndpointProbeReport[];
  readonly defaultHost: string;
  readonly fastestWorkingHost: string;
}> {
  const reports: EndpointProbeReport[] = [];

  console.log(
    `\n=== Deepgram Regional Endpoint Probe (N=${N_ENDPOINT_PROBES} WS opens per host, 0 audio sent) ===`,
  );

  for (const spec of DEEPGRAM_DOC_ENDPOINTS) {
    const url = buildDeepgramListenUrl(spec.host, {
      model: cfg.deepgramModel,
      language: cfg.deepgramLanguage,
    });
    const attempts: EndpointProbeAttempt[] = [];

    for (let i = 0; i < N_ENDPOINT_PROBES; i += 1) {
      try {
        const session = await DeepgramWsSession.connect(url, cfg.deepgramApiKey, {
          handshakeTimeoutMs: 8000,
        });
        const t = session.connectTimings;
        const closeSummary = await session.closeStream(2000);
        attempts.push({
          ok: true,
          statusCode: t.statusCode,
          errorPhase: null,
          errorCode: null,
          errorMessage: null,
          dnsMs: t.dnsMs,
          tcpMs: t.tcpMs,
          tlsMs: t.tlsMs,
          upgradeMs: t.upgradeMs,
          totalOpenMs: t.totalOpenMs,
          headers: extractInterestingHeaders(t.headers),
          metadata: closeSummary.metadata,
        });
      } catch (err) {
        if (err instanceof DeepgramWsError) {
          attempts.push({
            ok: false,
            statusCode: err.failure.statusCode,
            errorPhase: err.failure.phase,
            errorCode: err.failure.errorCode,
            errorMessage: err.failure.message,
            dnsMs: null,
            tcpMs: null,
            tlsMs: null,
            upgradeMs: null,
            totalOpenMs: err.failure.elapsedMs,
            headers: extractInterestingHeaders(err.failure.headers),
            metadata: null,
          });
        } else {
          attempts.push({
            ok: false,
            statusCode: null,
            errorPhase: "error",
            errorCode: null,
            errorMessage: err instanceof Error ? err.message : String(err),
            dnsMs: null,
            tcpMs: null,
            tlsMs: null,
            upgradeMs: null,
            totalOpenMs: 0,
            headers: {},
            metadata: null,
          });
        }
      }
    }

    const okAttempts = attempts.filter((a) => a.ok);
    const statuses = [
      ...new Set(
        attempts.map((a) =>
          a.ok
            ? `HTTP ${a.statusCode ?? 101}`
            : `${a.errorPhase ?? "err"}${a.statusCode !== null ? `:HTTP_${a.statusCode}` : ""}${a.errorCode ? `:${a.errorCode}` : ""}`,
        ),
      ),
    ];
    const errors = [
      ...new Set(attempts.filter((a) => !a.ok && a.errorMessage).map((a) => a.errorMessage!)),
    ];
    const headerSnapshot = Object.assign({}, ...attempts.map((a) => a.headers));
    const metadataSample = attempts.find((a) => a.metadata !== null)?.metadata ?? null;

    const report: EndpointProbeReport = {
      spec,
      okCount: okAttempts.length,
      nProbes: N_ENDPOINT_PROBES,
      working: okAttempts.length === N_ENDPOINT_PROBES,
      dnsMs: summarize(okAttempts.map((a) => a.dnsMs!).filter((v) => v !== null)),
      tcpMs: summarize(okAttempts.map((a) => a.tcpMs!).filter((v) => v !== null)),
      tlsMs: summarize(okAttempts.map((a) => a.tlsMs!).filter((v) => v !== null)),
      upgradeMs: summarize(okAttempts.map((a) => a.upgradeMs!).filter((v) => v !== null)),
      totalOpenMs: summarize(okAttempts.map((a) => a.totalOpenMs)),
      statuses,
      errors,
      headerSnapshot,
      metadataSample,
    };
    reports.push(report);

    const statusTag = report.working
      ? `OK (${report.okCount}/${report.nProbes})`
      : `FAIL (${report.okCount}/${report.nProbes}, ${statuses.join(",")})`;
    console.log(
      `  [${spec.id.padEnd(7)}] ${spec.host.padEnd(20)} (${spec.regionLabel}) -> ${statusTag} | ` +
        `open(med/p90)=${formatMs(report.totalOpenMs.median)} / ${formatMs(report.totalOpenMs.p90)} | ` +
        `DNS=${formatMs(report.dnsMs.median)} TCP=${formatMs(report.tcpMs.median)} ` +
        `TLS=${formatMs(report.tlsMs.median)} Upgrade=${formatMs(report.upgradeMs.median)} | ` +
        `hdrs=${JSON.stringify(report.headerSnapshot)}`,
    );
    if (errors.length > 0) {
      console.log(`           error=${errors[0]}`);
    }
  }

  const workingReports = reports
    .filter((r) => r.working && r.totalOpenMs.median !== null)
    .sort((a, b) => (a.totalOpenMs.median ?? Infinity) - (b.totalOpenMs.median ?? Infinity));

  const defaultWorking = workingReports.find((r) => r.spec.host === "api.deepgram.com");
  if (!defaultWorking) {
    throw new Error("Default Deepgram host api.deepgram.com failed endpoint probes");
  }
  const fastestWorking = workingReports[0] ?? defaultWorking;
  console.log(
    `  -> Default host: api.deepgram.com (med=${formatMs(defaultWorking.totalOpenMs.median)}) | ` +
      `Fastest working host: ${fastestWorking.spec.host} (med=${formatMs(fastestWorking.totalOpenMs.median)})`,
  );

  return {
    reports,
    defaultHost: defaultWorking.spec.host,
    fastestWorkingHost: fastestWorking.spec.host,
  };
}

interface DeepgramTurnSample {
  readonly scenario: string;
  readonly host: string;
  readonly socketMode: "warm" | "fresh";
  readonly deliveryMode: DeliveryMode;
  readonly segmentIndex: number;
  readonly burstBytes: number;
  readonly burstDurationMs: number;
  readonly totalAudioMs: number;
  readonly newSocket: boolean;
  readonly connectTimings: WsConnectionTimings | null;
  readonly firstAnyResultMs: number | null;
  readonly firstNonEmptyInterimMs: number | null;
  readonly sttFinalMs: number | null;
  readonly timedOut: boolean;
  readonly fromFinalizeReceived: boolean;
  readonly fromFinalizeWasEmpty: boolean;
  readonly interimCount: number;
  readonly nonEmptyInterimCount: number;
  readonly finalChunkCount: number;
  readonly transcript: string;
  readonly accuracy: SttAccuracyScore;
  readonly headers: Readonly<Record<string, string>>;
  readonly metadata: DeepgramMetadataMessage | null;
}

interface WhisperTurnSample {
  readonly segmentIndex: number;
  readonly totalAudioMs: number;
  readonly sttFinalEquivMs: number;
  readonly transcript: string;
  readonly accuracy: SttAccuracyScore;
  readonly newSocket: boolean;
  readonly dnsMs: number;
  readonly tcpMs: number;
  readonly tlsMs: number;
  readonly protocol: string;
  readonly groqRegion: string | null;
  readonly cfRayLocation: string | null;
}

function summarizeDeepgramGroup(
  label: string,
  samples: readonly DeepgramTurnSample[],
) {
  const freshConns = samples
    .map((s) => s.connectTimings)
    .filter((c): c is WsConnectionTimings => c !== null && c.newSocket);
  const seg1 = samples.filter((s) => s.segmentIndex === 1);
  const orderMatchedCount = seg1.filter((s) => s.accuracy.orderIdMatched === true).length;
  const nonEmptyCount = samples.filter((s) => s.accuracy.nonEmpty).length;
  const exactMatchCount = samples.filter((s) => s.accuracy.exactNormalizedMatch).length;
  const fromFinalizeEmptyCount = samples.filter((s) => s.fromFinalizeWasEmpty).length;
  const headersMerged = Object.assign({}, ...samples.map((s) => s.headers));
  const sampleMetadata = samples.find((s) => s.metadata !== null)?.metadata ?? null;

  return {
    label,
    nTurns: samples.length,
    hosts: [...new Set(samples.map((s) => s.host))],
    socketModes: [...new Set(samples.map((s) => s.socketMode))],
    deliveryModes: [...new Set(samples.map((s) => s.deliveryMode))],
    burstBytes: samples[0]?.burstBytes ?? 0,
    burstDurationMs: samples[0]?.burstDurationMs ?? 0,
    newSocketCount: freshConns.length,
    newSocketRate: formatPct(freshConns.length, samples.length),
    connectOpenMs: summarize(freshConns.map((c) => c.totalOpenMs)),
    dnsMs: summarize(freshConns.map((c) => c.dnsMs)),
    tcpMs: summarize(freshConns.map((c) => c.tcpMs)),
    tlsMs: summarize(freshConns.map((c) => c.tlsMs)),
    upgradeMs: summarize(freshConns.map((c) => c.upgradeMs)),
    firstAnyResultMs: summarize(
      samples.map((s) => s.firstAnyResultMs).filter((v): v is number => v !== null),
    ),
    firstNonEmptyInterimMs: summarize(
      samples.map((s) => s.firstNonEmptyInterimMs).filter((v): v is number => v !== null),
    ),
    sttFinalMs: summarize(
      samples.map((s) => s.sttFinalMs).filter((v): v is number => v !== null),
    ),
    fromFinalizeEmptyCount,
    fromFinalizeEmptyRate: formatPct(fromFinalizeEmptyCount, samples.length),
    nonEmptyRate: formatPct(nonEmptyCount, samples.length),
    exactMatchRate: formatPct(exactMatchCount, samples.length),
    orderId1042Rate: formatPct(orderMatchedCount, seg1.length),
    werStats: summarize(samples.map((s) => s.accuracy.wer)),
    headers: headersMerged,
    metadataSample: sampleMetadata,
    sampleTranscripts: [1, 2].map((segIdx) => {
      const hit = samples.find((s) => s.segmentIndex === segIdx);
      return {
        segmentIndex: segIdx,
        transcript: hit?.transcript ?? "",
        wer: hit?.accuracy.wer ?? null,
      };
    }),
  };
}

function summarizeWhisperGroup(samples: readonly WhisperTurnSample[]) {
  const seg1 = samples.filter((s) => s.segmentIndex === 1);
  const orderMatchedCount = seg1.filter((s) => s.accuracy.orderIdMatched === true).length;
  const nonEmptyCount = samples.filter((s) => s.accuracy.nonEmpty).length;
  const exactMatchCount = samples.filter((s) => s.accuracy.exactNormalizedMatch).length;
  const newSocketCount = samples.filter((s) => s.newSocket).length;

  return {
    nTurns: samples.length,
    sttFinalEquivMs: summarize(samples.map((s) => s.sttFinalEquivMs)),
    newSocketRate: formatPct(newSocketCount, samples.length),
    protocols: [...new Set(samples.map((s) => s.protocol))],
    groqRegions: [...new Set(samples.map((s) => s.groqRegion).filter((v): v is string => v !== null))],
    cfRayLocations: [
      ...new Set(samples.map((s) => s.cfRayLocation).filter((v): v is string => v !== null)),
    ],
    nonEmptyRate: formatPct(nonEmptyCount, samples.length),
    exactMatchRate: formatPct(exactMatchCount, samples.length),
    orderId1042Rate: formatPct(orderMatchedCount, seg1.length),
    werStats: summarize(samples.map((s) => s.accuracy.wer)),
    sampleTranscripts: [1, 2].map((segIdx) => {
      const hit = samples.find((s) => s.segmentIndex === segIdx);
      return {
        segmentIndex: segIdx,
        transcript: hit?.transcript ?? "",
        wer: hit?.accuracy.wer ?? null,
      };
    }),
  };
}

function printDeepgramSummary(s: ReturnType<typeof summarizeDeepgramGroup>): void {
  console.log(
    `\n  [${s.label}] turns=${s.nTurns} host=${s.hosts.join(",")} socket=${s.socketModes.join(",")} ` +
      `mode=${s.deliveryModes.join(",")} burst=${s.burstBytes}B (${s.burstDurationMs}ms)`,
  );
  console.log(
    `    first_nonempty_interim: med=${formatMs(s.firstNonEmptyInterimMs.median)} p90=${formatMs(s.firstNonEmptyInterimMs.p90)} | ` +
      `stt_final (Finalize->from_finalize): med=${formatMs(s.sttFinalMs.median)} p90=${formatMs(s.sttFinalMs.p90)} ` +
      `(empty from_finalize: ${s.fromFinalizeEmptyRate})`,
  );
  console.log(
    `    Accuracy: nonEmpty=${s.nonEmptyRate} | exactNorm=${s.exactMatchRate} | order_1042=${s.orderId1042Rate} | ` +
      `WER med=${((s.werStats.median ?? 0) * 100).toFixed(1)}% p90=${((s.werStats.p90 ?? 0) * 100).toFixed(1)}%`,
  );
  if (s.newSocketCount > 0) {
    console.log(
      `    Conn (${s.newSocketRate}): open med=${formatMs(s.connectOpenMs.median)} p90=${formatMs(s.connectOpenMs.p90)} | ` +
        `DNS=${formatMs(s.dnsMs.median)} TCP=${formatMs(s.tcpMs.median)} TLS=${formatMs(s.tlsMs.median)} Upgrade=${formatMs(s.upgradeMs.median)}`,
    );
  } else {
    console.log(`    Conn: ${s.newSocketRate} new sockets (pre-warmed reuse)`);
  }
  console.log(`    Headers: ${JSON.stringify(s.headers)}`);
  if (s.metadataSample) {
    console.log(
      `    Metadata: request_id=${s.metadataSample.request_id ?? "n/a"} duration=${s.metadataSample.duration ?? "n/a"}s ` +
        `model_info=${JSON.stringify(s.metadataSample.model_info ?? {})}`,
    );
  }
  for (const t of s.sampleTranscripts) {
    console.log(`    Sample seg#${t.segmentIndex}: ${JSON.stringify(t.transcript)}`);
  }
}

async function runLiveDeepgramBench(): Promise<void> {
  loadEnvFromRoot();
  const cfg: SttSpikeEnvConfig = loadSttSpikeConfig(process.env);
  if (!cfg.groqApiKey) {
    throw new Error("GROQ_API_KEY is required in .env to run the interleaved Whisper comparison");
  }
  const argv = process.argv.slice(2);
  const nRuns = parseCliIntFlag(argv, "--n", DEFAULT_N_RUNS);

  const wav = await readPcm16Wav(SAMPLE_WAV_PATH);
  const segments = await detectVadSegmentsFromSilero();
  console.log(
    `Loaded ${SAMPLE_WAV_PATH} (${wav.durationMs.toFixed(1)} ms, ${wav.sampleRate} Hz, ${wav.sampleCount} samples)`,
  );
  for (const seg of segments) {
    console.log(
      `  VAD Seg #${seg.index}: start=${seg.startMs}ms confirm=${seg.confirmedAtMs}ms end=${seg.endMs}ms decided=${seg.decidedAtMs}ms | ` +
        `slice=[${Math.max(0, seg.startMs - 100)}..${seg.endMs + 576}]ms | text=${JSON.stringify(seg.expectedText)}`,
    );
  }

  const slicesBurst: SlicedTurnAudio[] = segments.map((s) =>
    sliceTurnAudio(wav.pcmBytes, s, "burst_at_confirm"),
  );
  const slicesRealtime: SlicedTurnAudio[] = segments.map((s) =>
    sliceTurnAudio(wav.pcmBytes, s, "realtime_paced"),
  );
  const twoTurnAudioSec =
    slicesBurst.reduce((acc, s) => acc + s.totalDurationMs, 0) / 1000;
  const seg1AudioSec = (slicesBurst[0]?.totalDurationMs ?? 0) / 1000;

  const probeResult = await probeDeepgramEndpoints(cfg);
  const hasDistinctFastest = probeResult.fastestWorkingHost !== probeResult.defaultHost;

  // Planned audio accounting BEFORE any audio is transmitted.
  // Per iteration:
  //   - dg_default_warm (2 turns burst): twoTurnAudioSec
  //   - dg_fastest_warm (2 turns burst, if distinct): twoTurnAudioSec
  //   - dg_default_fresh (1 turn burst seg#1): seg1AudioSec
  //   - dg_realtime_paced (2 turns on fastest host): twoTurnAudioSec
  //   - whisper (2 turns): twoTurnAudioSec
  const dgPerIterSec =
    twoTurnAudioSec +
    (hasDistinctFastest ? twoTurnAudioSec + seg1AudioSec : 0) +
    seg1AudioSec +
    twoTurnAudioSec;
  const plannedDeepgramAudioSeconds = nRuns * dgPerIterSec;
  const plannedWhisperAudioSeconds = nRuns * twoTurnAudioSec;
  const plannedWhisperRequests = nRuns * segments.length;

  const whisperLedgerEntries = readWhisperUsageLedger(WHISPER_LEDGER_PATH);
  const whisperUsed = summarizeWhisperUsage(whisperLedgerEntries);
  const quota = evaluateSttQuota({
    plannedDeepgramAudioSeconds,
    plannedWhisperAudioSeconds,
    plannedWhisperRequests,
    usedWhisperSecondsLast1h: whisperUsed.audioSecondsLast1h,
    usedWhisperSecondsLast24h: whisperUsed.audioSecondsLast24h,
    usedWhisperRequestsLast24h: whisperUsed.requestsLast24h,
    maxDeepgramAudioMinutes: cfg.maxDeepgramAudioMinutes,
    maxWhisperAudioSeconds: cfg.maxWhisperAudioSeconds,
  });

  console.log("\n=== Pre-Run STT Audio & Quota Check ===");
  console.log(
    `  Iterations: N=${nRuns} | 2-turn slice=${twoTurnAudioSec.toFixed(3)} s (${segments.length} segments) | ` +
      `hosts=[${probeResult.defaultHost}${hasDistinctFastest ? `, ${probeResult.fastestWorkingHost}` : ""}]`,
  );
  console.log(
    `  Deepgram estimated audio: ${plannedDeepgramAudioSeconds.toFixed(1)} s (${quota.plannedDeepgramMinutes.toFixed(2)} min) | ` +
      `ceiling=${cfg.maxDeepgramAudioMinutes.toFixed(2)} min`,
  );
  console.log(
    `  Groq Whisper (${cfg.whisperModel}) estimated audio: ${quota.plannedWhisperSeconds.toFixed(1)} s (${plannedWhisperRequests} reqs) | ` +
      `used_1h=${whisperUsed.audioSecondsLast1h.toFixed(1)}/${GROQ_WHISPER_ASH_LIMIT} s | ` +
      `used_24h=${whisperUsed.audioSecondsLast24h.toFixed(1)}/${GROQ_WHISPER_ASD_LIMIT} s | ` +
      `reqs_24h=${whisperUsed.requestsLast24h}/${GROQ_WHISPER_RPD_LIMIT}`,
  );
  console.log(
    `  Projected Whisper: 1h=${quota.projectedWhisperSeconds1h.toFixed(1)}/${GROQ_WHISPER_ASH_LIMIT} s | ` +
      `24h=${quota.projectedWhisperSeconds24h.toFixed(1)}/${GROQ_WHISPER_ASD_LIMIT} s | ` +
      `reqs=${quota.projectedWhisperRequests24h}/${GROQ_WHISPER_RPD_LIMIT} -> ${quota.ok ? "OK" : "STOP"}`,
  );
  if (!quota.ok) {
    throw new Error(`Stopping before live run: ${quota.reasons.join("; ")}`);
  }

  const dgDefaultWarm: DeepgramTurnSample[] = [];
  const dgFastestWarm: DeepgramTurnSample[] = [];
  const dgDefaultFresh: DeepgramTurnSample[] = [];
  const dgFastestFresh: DeepgramTurnSample[] = [];
  const dgRealtimePaced: DeepgramTurnSample[] = [];
  const whisperSamples: WhisperTurnSample[] = [];

  const whisperAgent = createInstrumentedWhisperAgent(true);
  let lastWhisperAt = 0;

  const runDeepgramSocketTurns = async (
    scenarioLabel: string,
    host: string,
    socketMode: "warm" | "fresh",
    deliveryMode: DeliveryMode,
    segmentIndices: readonly number[],
  ): Promise<DeepgramTurnSample[]> => {
    const url = buildDeepgramListenUrl(host, {
      model: cfg.deepgramModel,
      language: cfg.deepgramLanguage,
    });
    const session = await DeepgramWsSession.connect(url, cfg.deepgramApiKey);
    const out: DeepgramTurnSample[] = [];

    try {
      if (socketMode === "warm") {
        // Simulate pre-warmed socket opened at START_CALL before user speaks.
        await new Promise<void>((r) => setTimeout(r, 50));
      }

      for (let k = 0; k < segmentIndices.length; k += 1) {
        const idx = segmentIndices[k]!;
        const seg = segments[idx]!;
        const sliced =
          deliveryMode === "burst_at_confirm" ? slicesBurst[idx]! : slicesRealtime[idx]!;

        const turnRes = await session.runTurn({
          burstChunk: sliced.burstChunk,
          realtimeFrames: sliced.realtimeFrames,
          frameIntervalMs: 20,
        });

        const isFirstOnSocket = k === 0;
        const connTimings =
          socketMode === "fresh" && isFirstOnSocket ? session.connectTimings : null;

        out.push({
          scenario: scenarioLabel,
          host,
          socketMode,
          deliveryMode,
          segmentIndex: seg.index,
          burstBytes: sliced.burstBytes,
          burstDurationMs: sliced.burstDurationMs,
          totalAudioMs: sliced.totalDurationMs,
          newSocket: socketMode === "fresh" && isFirstOnSocket,
          connectTimings: connTimings,
          firstAnyResultMs: turnRes.summary.firstAnyResultMs,
          firstNonEmptyInterimMs: turnRes.summary.firstNonEmptyResultMs,
          sttFinalMs: turnRes.summary.sttFinalMs,
          timedOut: turnRes.timedOut,
          fromFinalizeReceived: turnRes.summary.fromFinalizeReceived,
          fromFinalizeWasEmpty: turnRes.summary.fromFinalizeWasEmpty,
          interimCount: turnRes.summary.interimCount,
          nonEmptyInterimCount: turnRes.summary.nonEmptyInterimCount,
          finalChunkCount: turnRes.summary.finalChunkCount,
          transcript: turnRes.summary.transcript,
          accuracy: scoreTranscriptAccuracy(
            seg.expectedText,
            turnRes.summary.transcript,
            seg.expectedOrderId,
          ),
          headers: extractInterestingHeaders(session.connectTimings.headers),
          metadata: session.getLatestMetadata(),
        });
      }
    } finally {
      const closed = await session.closeStream();
      if (closed.metadata) {
        for (let i = 0; i < out.length; i += 1) {
          out[i] = { ...out[i]!, metadata: closed.metadata };
        }
      }
    }
    return out;
  };

  const runWhisperTurn = async (segIdx: number): Promise<WhisperTurnSample> => {
    const waitMs = lastWhisperAt + WHISPER_MIN_GAP_MS - performance.now();
    if (waitMs > 0) {
      await new Promise<void>((r) => setTimeout(r, waitMs));
    }
    const seg = segments[segIdx]!;
    const sliced = slicesBurst[segIdx]!;
    const res: WhisperTranscriptionOutcome = await transcribeWithGroqWhisper({
      apiKey: cfg.groqApiKey!,
      pcmBytes: sliced.fullPcmBytes,
      model: cfg.whisperModel,
      language: cfg.deepgramLanguage,
      instr: whisperAgent,
    });
    lastWhisperAt = performance.now();
    appendWhisperUsageEntry(WHISPER_LEDGER_PATH, {
      ts: new Date().toISOString(),
      model: cfg.whisperModel,
      audio_seconds: Number((sliced.totalDurationMs / 1000).toFixed(3)),
    });
    return {
      segmentIndex: seg.index,
      totalAudioMs: sliced.totalDurationMs,
      sttFinalEquivMs: res.latencyMs,
      transcript: res.transcript,
      accuracy: scoreTranscriptAccuracy(seg.expectedText, res.transcript, seg.expectedOrderId),
      newSocket: res.connection.newSocket,
      dnsMs: res.connection.dnsMs,
      tcpMs: res.connection.tcpMs,
      tlsMs: res.connection.tlsMs,
      protocol: res.connection.protocol,
      groqRegion: res.groqRegion,
      cfRayLocation: res.cfRayLocation,
    };
  };

  try {
    // Pre-warm Whisper HTTP/2 socket outside measured loop (same as Groq LLM spike).
    const warmupWhisper = await transcribeWithGroqWhisper({
      apiKey: cfg.groqApiKey,
      pcmBytes: slicesBurst[1]!.fullPcmBytes,
      model: cfg.whisperModel,
      language: cfg.deepgramLanguage,
      instr: whisperAgent,
    });
    lastWhisperAt = performance.now();
    appendWhisperUsageEntry(WHISPER_LEDGER_PATH, {
      ts: new Date().toISOString(),
      model: cfg.whisperModel,
      audio_seconds: Number(((slicesBurst[1]?.totalDurationMs ?? 0) / 1000).toFixed(3)),
    });
    console.log(
      `\n[WhisperWarmup] proto=${warmupWhisper.connection.protocol} region=${warmupWhisper.groqRegion ?? "none"} ` +
        `edge=${warmupWhisper.cfRayLocation ?? "none"} DNS=${formatMs(warmupWhisper.connection.dnsMs)} ` +
        `TCP=${formatMs(warmupWhisper.connection.tcpMs)} TLS=${formatMs(warmupWhisper.connection.tlsMs)}`,
    );

    console.log(`\n=== Running N=${nRuns} Interleaved Deepgram + Whisper Iterations ===`);
    for (let iter = 0; iter < nRuns; iter += 1) {
      const iterStart = performance.now();

      // 1. Deepgram default host (warm multi-turn socket, burst_at_confirm)
      dgDefaultWarm.push(
        ...(await runDeepgramSocketTurns(
          "dg_default_warm_burst",
          probeResult.defaultHost,
          "warm",
          "burst_at_confirm",
          [0, 1],
        )),
      );

      // 2. Whisper turn 1 (interleaved)
      whisperSamples.push(await runWhisperTurn(0));

      // 3. Fastest host (warm multi-turn socket, burst_at_confirm) if distinct from default
      if (hasDistinctFastest) {
        dgFastestWarm.push(
          ...(await runDeepgramSocketTurns(
            "dg_fastest_warm_burst",
            probeResult.fastestWorkingHost,
            "warm",
            "burst_at_confirm",
            [0, 1],
          )),
        );
      }

      // 4. Deepgram fresh sockets (burst_at_confirm, seg 1) on default and fastest hosts
      dgDefaultFresh.push(
        ...(await runDeepgramSocketTurns(
          "dg_default_fresh_burst",
          probeResult.defaultHost,
          "fresh",
          "burst_at_confirm",
          [0],
        )),
      );
      if (hasDistinctFastest) {
        dgFastestFresh.push(
          ...(await runDeepgramSocketTurns(
            "dg_fastest_fresh_burst",
            probeResult.fastestWorkingHost,
            "fresh",
            "burst_at_confirm",
            [0],
          )),
        );
      }

      // 5. Whisper turn 2 (interleaved)
      whisperSamples.push(await runWhisperTurn(1));

      // 6. Deepgram realtime_paced variant from (start - 100 ms) on fastest working host
      dgRealtimePaced.push(
        ...(await runDeepgramSocketTurns(
          "dg_fastest_warm_realtime",
          probeResult.fastestWorkingHost,
          "warm",
          "realtime_paced",
          [0, 1],
        )),
      );

      const elapsedSec = ((performance.now() - iterStart) / 1000).toFixed(1);
      console.log(`  [Iter ${iter + 1}/${nRuns}] completed in ${elapsedSec} s`);
    }
  } finally {
    await whisperAgent.close();
  }

  const summaries = {
    defaultWarmBurst: summarizeDeepgramGroup(
      `Deepgram ${probeResult.defaultHost} (warm, burst_at_confirm)`,
      dgDefaultWarm,
    ),
    fastestWarmBurst: hasDistinctFastest
      ? summarizeDeepgramGroup(
          `Deepgram ${probeResult.fastestWorkingHost} (warm, burst_at_confirm)`,
          dgFastestWarm,
        )
      : null,
    defaultFreshBurst: summarizeDeepgramGroup(
      `Deepgram ${probeResult.defaultHost} (fresh, burst_at_confirm)`,
      dgDefaultFresh,
    ),
    fastestFreshBurst: hasDistinctFastest
      ? summarizeDeepgramGroup(
          `Deepgram ${probeResult.fastestWorkingHost} (fresh, burst_at_confirm)`,
          dgFastestFresh,
        )
      : null,
    realtimePaced: summarizeDeepgramGroup(
      `Deepgram ${probeResult.fastestWorkingHost} (warm, realtime_paced)`,
      dgRealtimePaced,
    ),
    whisper: summarizeWhisperGroup(whisperSamples),
  };

  console.log("\n=== Deepgram STT & Groq Whisper Summary ===");
  printDeepgramSummary(summaries.defaultWarmBurst);
  if (summaries.fastestWarmBurst) {
    printDeepgramSummary(summaries.fastestWarmBurst);
  }
  printDeepgramSummary(summaries.defaultFreshBurst);
  if (summaries.fastestFreshBurst) {
    printDeepgramSummary(summaries.fastestFreshBurst);
  }
  printDeepgramSummary(summaries.realtimePaced);

  console.log(
    `\n  [Groq Whisper (${cfg.whisperModel}, batch HTTP)] turns=${summaries.whisper.nTurns} ` +
      `proto=${summaries.whisper.protocols.join(",")} region=${summaries.whisper.groqRegions.join(",") || "none"} ` +
      `edge=${summaries.whisper.cfRayLocations.join(",") || "none"}`,
  );
  console.log(
    `    stt_final_equiv (req->transcript): med=${formatMs(summaries.whisper.sttFinalEquivMs.median)} p90=${formatMs(summaries.whisper.sttFinalEquivMs.p90)} | ` +
      `NewSocket=${summaries.whisper.newSocketRate}`,
  );
  console.log(
    `    Accuracy: nonEmpty=${summaries.whisper.nonEmptyRate} | exactNorm=${summaries.whisper.exactMatchRate} | ` +
      `order_1042=${summaries.whisper.orderId1042Rate} | WER med=${((summaries.whisper.werStats.median ?? 0) * 100).toFixed(1)}% ` +
      `p90=${((summaries.whisper.werStats.p90 ?? 0) * 100).toFixed(1)}%`,
  );
  for (const t of summaries.whisper.sampleTranscripts) {
    console.log(`    Sample seg#${t.segmentIndex}: ${JSON.stringify(t.transcript)}`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    RESULTS_PATH,
    `${JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        nodeVersion: process.version,
        deepgramModel: cfg.deepgramModel,
        whisperModel: cfg.whisperModel,
        nRuns,
        segments,
        quota,
        endpointProbes: probeResult,
        summaries,
        raw: {
          dgDefaultWarm,
          dgFastestWarm,
          dgDefaultFresh,
          dgFastestFresh,
          dgRealtimePaced,
          whisperSamples,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`\nSaved live STT benchmark results to ${RESULTS_PATH}`);
}

function formatCliError(err: unknown): string {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const key = first?.path[0];
    if (key === "DEEPGRAM_API_KEY") {
      return "DEEPGRAM_API_KEY is missing: copy .env.example to .env at the repo root and set it";
    }
    if (first) {
      return key !== undefined ? `${String(key)}: ${first.message}` : first.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

runLiveDeepgramBench().catch((err) => {
  console.error(formatCliError(err));
  process.exitCode = 1;
});
