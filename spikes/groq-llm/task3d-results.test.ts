import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DailyQuotaError,
  exitCodeForStopReason,
  serializeTask3dResults,
  writeJsonFileAtomic,
} from "./task3d-results.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "groq-task3d-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("task3d-results", () => {
  it("writes JSON atomically via temp file + rename and leaves no leftover temp files", () => {
    const dir = makeTempDir();
    const outPath = path.join(dir, "nested", "task3d-results.json");

    writeJsonFileAtomic(outPath, { step: 1, ok: true });
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual({ step: 1, ok: true });

    // Overwrite existing file atomically
    writeJsonFileAtomic(outPath, { step: 2, ok: true });
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual({ step: 2, ok: true });

    const files = readdirSync(path.dirname(outPath));
    expect(files).toEqual(["task3d-results.json"]);
  });

  it("cleans up temp file and preserves prior file when serialization throws", () => {
    const dir = makeTempDir();
    const outPath = path.join(dir, "task3d-results.json");
    writeFileSync(outPath, '{"preserved":true}\n', "utf8");

    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => writeJsonFileAtomic(outPath, circular)).toThrow();
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual({ preserved: true });
    expect(readdirSync(dir)).toEqual(["task3d-results.json"]);
  });

  it("serializes stop_reason ('sigint' | 'daily_quota' | 'complete') and per-cell n", () => {
    const dir = makeTempDir();
    const base = {
      nTask3d: 10,
      matrixCells: [
        { modelId: "qwen_none", promptId: "c_time", n: 4 },
        { modelId: "qwen_none", promptId: "c_order", n: 3 },
        { modelId: "gpt_oss_120b_low", promptId: "plain", n: 0 },
      ],
    };

    for (const reason of ["sigint", "daily_quota", "complete"] as const) {
      const payload = serializeTask3dResults(base, reason);
      const outPath = path.join(dir, `results-${reason}.json`);
      writeJsonFileAtomic(outPath, payload);

      const parsed = JSON.parse(readFileSync(outPath, "utf8")) as {
        stop_reason: string;
        per_cell_n: Record<string, number>;
        matrixCells: Array<{ modelId: string; promptId: string; n: number }>;
      };
      expect(parsed.stop_reason).toBe(reason);
      expect(parsed.per_cell_n).toEqual({
        "qwen_none:c_time": 4,
        "qwen_none:c_order": 3,
        "gpt_oss_120b_low:plain": 0,
      });
      expect(parsed.matrixCells.map((c) => c.n)).toEqual([4, 3, 0]);
    }
  });

  it("maps stop_reason exit codes (0 for complete, non-zero for sigint and daily_quota)", () => {
    expect(exitCodeForStopReason("complete")).toBe(0);
    expect(exitCodeForStopReason("sigint")).toBeGreaterThan(0);
    expect(exitCodeForStopReason("daily_quota")).toBeGreaterThan(0);

    const err = new DailyQuotaError("qwen/qwen3.8-27b", "Limit 200000 (TPD)");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DailyQuotaError");
    expect(err.model).toBe("qwen/qwen3.8-27b");
    expect(err.message).toContain("429");
  });
});
