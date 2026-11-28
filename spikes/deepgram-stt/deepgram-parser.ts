export interface DeepgramWord {
  readonly word: string;
  readonly start: number;
  readonly end: number;
  readonly confidence: number;
  readonly punctuated_word?: string;
}

export interface DeepgramResultsMessage {
  readonly type: "Results";
  readonly channel_index?: readonly number[];
  readonly duration?: number;
  readonly start?: number;
  readonly is_final?: boolean;
  readonly speech_final?: boolean;
  readonly from_finalize?: boolean;
  readonly channel?: {
    readonly alternatives?: ReadonlyArray<{
      readonly transcript?: string;
      readonly confidence?: number;
      readonly words?: readonly DeepgramWord[];
    }>;
  };
}

export interface DeepgramMetadataMessage {
  readonly type: "Metadata";
  readonly request_id?: string;
  readonly sha256?: string;
  readonly created?: string;
  readonly duration?: number;
  readonly channels?: number;
  readonly model_info?: Readonly<Record<string, unknown>>;
}

export interface DeepgramErrorMessage {
  readonly type: "Error" | "error";
  readonly err_code?: string;
  readonly err_msg?: string;
  readonly description?: string;
  readonly message?: string;
}

export type DeepgramParsedMessage =
  | { readonly kind: "results"; readonly msg: DeepgramResultsMessage }
  | { readonly kind: "metadata"; readonly msg: DeepgramMetadataMessage }
  | { readonly kind: "utterance_end"; readonly lastWordEnd?: number }
  | { readonly kind: "speech_started"; readonly timestamp?: number }
  | { readonly kind: "error"; readonly code: string | null; readonly message: string }
  | { readonly kind: "unknown"; readonly type: string };

/**
 * Parses a raw Deepgram WebSocket text message into a typed event.
 */
export function parseDeepgramMessage(rawText: string): DeepgramParsedMessage {
  const parsed = JSON.parse(rawText) as Record<string, unknown>;
  const msgType = typeof parsed.type === "string" ? parsed.type : "unknown";

  if (msgType === "Results") {
    return { kind: "results", msg: parsed as unknown as DeepgramResultsMessage };
  }
  if (msgType === "Metadata") {
    return { kind: "metadata", msg: parsed as unknown as DeepgramMetadataMessage };
  }
  if (msgType === "UtteranceEnd") {
    return {
      kind: "utterance_end",
      ...(typeof parsed.last_word_end === "number" ? { lastWordEnd: parsed.last_word_end } : {}),
    };
  }
  if (msgType === "SpeechStarted") {
    return {
      kind: "speech_started",
      ...(typeof parsed.timestamp === "number" ? { timestamp: parsed.timestamp } : {}),
    };
  }
  if (msgType === "Error" || msgType === "error") {
    const errCode = typeof parsed.err_code === "string" ? parsed.err_code : null;
    const errMsg =
      typeof parsed.err_msg === "string"
        ? parsed.err_msg
        : typeof parsed.description === "string"
          ? parsed.description
          : typeof parsed.message === "string"
            ? parsed.message
            : rawText;
    return { kind: "error", code: errCode, message: errMsg };
  }

  return { kind: "unknown", type: msgType };
}

export interface DeepgramTurnStepOutcome {
  readonly isNonEmptyInterim: boolean;
  readonly isFirstNonEmptyResult: boolean;
  readonly isFinalChunk: boolean;
  readonly fromFinalize: boolean;
  readonly transcriptText: string;
}

export interface DeepgramTurnSummary {
  readonly transcript: string;
  readonly finalChunks: readonly string[];
  readonly interimCount: number;
  readonly nonEmptyInterimCount: number;
  readonly finalChunkCount: number;
  readonly fromFinalizeReceived: boolean;
  readonly fromFinalizeWasEmpty: boolean;
  readonly firstAnyResultMs: number | null;
  readonly firstNonEmptyResultMs: number | null;
  readonly sttFinalMs: number | null;
}

/**
 * Pure per-turn accumulator for Deepgram streaming Results.
 * Concatenates all is_final transcripts for the turn and tracks Finalize -> from_finalize.
 */
export class DeepgramTurnAccumulator {
  private readonly finalChunks: string[] = [];
  private interimCount = 0;
  private nonEmptyInterimCount = 0;
  private fromFinalizeReceived = false;
  private fromFinalizeWasEmpty = false;
  private firstAnyResultAtMs: number | null = null;
  private firstNonEmptyResultAtMs: number | null = null;
  private fromFinalizeAtMs: number | null = null;
  private streamStartMs: number | null = null;
  private finalizeSentMs: number | null = null;

  markStreamStart(atMs: number): void {
    this.streamStartMs = atMs;
  }

  markFinalizeSent(atMs: number): void {
    this.finalizeSentMs = atMs;
  }

  pushResults(msg: DeepgramResultsMessage, receivedAtMs: number): DeepgramTurnStepOutcome {
    const rawTranscript = msg.channel?.alternatives?.[0]?.transcript ?? "";
    const trimmed = rawTranscript.trim();
    const isFinal = msg.is_final === true;
    const fromFinalize = msg.from_finalize === true;

    if (this.firstAnyResultAtMs === null) {
      this.firstAnyResultAtMs = receivedAtMs;
    }

    let isFirstNonEmptyResult = false;
    if (trimmed.length > 0 && this.firstNonEmptyResultAtMs === null) {
      this.firstNonEmptyResultAtMs = receivedAtMs;
      isFirstNonEmptyResult = true;
    }

    if (!isFinal) {
      this.interimCount += 1;
      if (trimmed.length > 0) {
        this.nonEmptyInterimCount += 1;
      }
    } else if (trimmed.length > 0) {
      this.finalChunks.push(trimmed);
    }

    if (fromFinalize && !this.fromFinalizeReceived) {
      this.fromFinalizeReceived = true;
      this.fromFinalizeWasEmpty = trimmed.length === 0;
      this.fromFinalizeAtMs = receivedAtMs;
    }

    return {
      isNonEmptyInterim: !isFinal && trimmed.length > 0,
      isFirstNonEmptyResult,
      isFinalChunk: isFinal,
      fromFinalize,
      transcriptText: trimmed,
    };
  }

  summary(): DeepgramTurnSummary {
    const firstAnyResultMs =
      this.firstAnyResultAtMs !== null && this.streamStartMs !== null
        ? Math.max(0, this.firstAnyResultAtMs - this.streamStartMs)
        : null;
    const firstNonEmptyResultMs =
      this.firstNonEmptyResultAtMs !== null && this.streamStartMs !== null
        ? Math.max(0, this.firstNonEmptyResultAtMs - this.streamStartMs)
        : null;
    const sttFinalMs =
      this.fromFinalizeAtMs !== null && this.finalizeSentMs !== null
        ? Math.max(0, this.fromFinalizeAtMs - this.finalizeSentMs)
        : null;

    return {
      transcript: this.finalChunks.join(" ").replace(/\s+/g, " ").trim(),
      finalChunks: [...this.finalChunks],
      interimCount: this.interimCount,
      nonEmptyInterimCount: this.nonEmptyInterimCount,
      finalChunkCount: this.finalChunks.length,
      fromFinalizeReceived: this.fromFinalizeReceived,
      fromFinalizeWasEmpty: this.fromFinalizeWasEmpty,
      firstAnyResultMs,
      firstNonEmptyResultMs,
      sttFinalMs,
    };
  }
}

const DIGIT_WORDS: Readonly<Record<string, string>> = {
  zero: "0",
  oh: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

/**
 * Normalizes text for WER comparison and replaces spoken single-digit sequences
 * (e.g. "one zero four two" -> "1042") so spoken and smart-formatted numerals compare fairly.
 */
export function normalizeForSttScoring(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return [];

  const tokens = cleaned.split(" ");
  const out: string[] = [];
  let digitBuf = "";

  const flushDigits = (): void => {
    if (digitBuf.length > 0) {
      out.push(digitBuf);
      digitBuf = "";
    }
  };

  for (const tok of tokens) {
    const mappedDigit = DIGIT_WORDS[tok];
    if (mappedDigit !== undefined) {
      digitBuf += mappedDigit;
    } else if (/^\d+$/.test(tok) && digitBuf.length > 0) {
      digitBuf += tok;
    } else {
      flushDigits();
      out.push(tok);
    }
  }
  flushDigits();
  return out;
}

export function wordLevenshtein(ref: readonly string[], hyp: readonly string[]): number {
  const rows = ref.length + 1;
  const cols = hyp.length + 1;
  const dp = new Int32Array(rows * cols);

  for (let i = 0; i < rows; i += 1) dp[i * cols] = i;
  for (let j = 0; j < cols; j += 1) dp[j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      const del = (dp[(i - 1) * cols + j] ?? 0) + 1;
      const ins = (dp[i * cols + (j - 1)] ?? 0) + 1;
      const sub = (dp[(i - 1) * cols + (j - 1)] ?? 0) + cost;
      dp[i * cols + j] = Math.min(del, ins, sub);
    }
  }

  return dp[ref.length * cols + hyp.length] ?? 0;
}

export interface SttAccuracyScore {
  readonly nonEmpty: boolean;
  readonly wer: number;
  readonly editDistance: number;
  readonly refWords: number;
  readonly exactNormalizedMatch: boolean;
  readonly orderIdMatched: boolean | null;
}

/**
 * Scores an STT transcript (Deepgram or Whisper) identically against ground truth,
 * including normalized WER and expected order ID ("1042") matching.
 */
export function scoreTranscriptAccuracy(
  expectedText: string,
  actualText: string,
  expectedOrderId: string | null = null,
): SttAccuracyScore {
  const refTokens = normalizeForSttScoring(expectedText);
  const hypTokens = normalizeForSttScoring(actualText);
  const editDistance = wordLevenshtein(refTokens, hypTokens);
  const wer = refTokens.length > 0 ? editDistance / refTokens.length : hypTokens.length === 0 ? 0 : 1;

  let orderIdMatched: boolean | null = null;
  if (expectedOrderId !== null) {
    const compactDigits = actualText.replace(/\s+/g, "");
    orderIdMatched =
      hypTokens.includes(expectedOrderId) || compactDigits.includes(expectedOrderId);
  }

  return {
    nonEmpty: actualText.trim().length > 0,
    wer,
    editDistance,
    refWords: refTokens.length,
    exactNormalizedMatch: editDistance === 0,
    orderIdMatched,
  };
}
