import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const ONE_HOUR_MS = 60 * 60 * 1000;
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface WhisperUsageEntry {
  readonly ts: string;
  readonly model: string;
  readonly audio_seconds: number;
}

function isValidWhisperEntry(val: unknown): val is WhisperUsageEntry {
  if (typeof val !== "object" || val === null) return false;
  const r = val as Record<string, unknown>;
  return (
    typeof r.ts === "string" &&
    r.ts.length > 0 &&
    typeof r.model === "string" &&
    r.model.length > 0 &&
    typeof r.audio_seconds === "number" &&
    Number.isFinite(r.audio_seconds) &&
    r.audio_seconds >= 0
  );
}

export function readWhisperUsageLedger(filePath: string): WhisperUsageEntry[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8");
  const entries: WhisperUsageEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isValidWhisperEntry(parsed)) {
        entries.push(parsed);
      }
    } catch {
      // Ignore malformed lines.
    }
  }
  return entries;
}

export function appendWhisperUsageEntry(filePath: string, entry: WhisperUsageEntry): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}

export function summarizeWhisperUsage(
  entries: readonly WhisperUsageEntry[],
  nowMs: number = Date.now(),
): {
  readonly audioSecondsLast1h: number;
  readonly audioSecondsLast24h: number;
  readonly requestsLast24h: number;
} {
  let audioSecondsLast1h = 0;
  let audioSecondsLast24h = 0;
  let requestsLast24h = 0;

  for (const entry of entries) {
    const tsMs = Date.parse(entry.ts);
    if (!Number.isFinite(tsMs) || tsMs > nowMs + 60_000) continue;
    const age = nowMs - tsMs;
    if (age <= ONE_DAY_MS) {
      audioSecondsLast24h += entry.audio_seconds;
      requestsLast24h += 1;
      if (age <= ONE_HOUR_MS) {
        audioSecondsLast1h += entry.audio_seconds;
      }
    }
  }

  return {
    audioSecondsLast1h,
    audioSecondsLast24h,
    requestsLast24h,
  };
}
