import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export type Task3dStopReason = "sigint" | "daily_quota" | "complete";

/**
 * Thrown when Groq responds with HTTP 429 for daily token/request quota (TPD/RPD).
 */
export class DailyQuotaError extends Error {
  readonly model: string;
  readonly bodyText: string;

  constructor(model: string, bodyText: string) {
    super(`Daily quota exhausted on ${model} (429): ${bodyText}`);
    this.name = "DailyQuotaError";
    this.model = model;
    this.bodyText = bodyText;
  }
}

let tempCounter = 0;

/**
 * Writes JSON to a sibling temporary file and atomically renames it over `filePath`.
 */
export function writeJsonFileAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  tempCounter += 1;
  const tempPath = `${filePath}.${process.pid}.${tempCounter}.tmp`;
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  try {
    writeFileSync(tempPath, serialized, "utf8");
    renameSync(tempPath, filePath);
  } catch (err) {
    rmSync(tempPath, { force: true });
    throw err;
  }
}

export interface Task3dCellCountSource {
  readonly modelId: string;
  readonly promptId: string;
  readonly n: number;
}

/**
 * Attaches `stop_reason` and `per_cell_n` to a Task 3d results payload.
 */
export function serializeTask3dResults<
  T extends { readonly matrixCells: readonly Task3dCellCountSource[] },
>(
  basePayload: T,
  stopReason: Task3dStopReason | null,
): T & {
  readonly stop_reason: Task3dStopReason | null;
  readonly per_cell_n: Readonly<Record<string, number>>;
} {
  const perCellN: Record<string, number> = {};
  for (const cell of basePayload.matrixCells) {
    perCellN[`${cell.modelId}:${cell.promptId}`] = cell.n;
  }
  return {
    ...basePayload,
    stop_reason: stopReason,
    per_cell_n: perCellN,
  };
}

/**
 * Returns process exit code for a Task 3d stop reason (non-zero unless "complete").
 */
export function exitCodeForStopReason(stopReason: Task3dStopReason): number {
  switch (stopReason) {
    case "complete":
      return 0;
    case "sigint":
      return 130;
    case "daily_quota":
      return 1;
  }
}
