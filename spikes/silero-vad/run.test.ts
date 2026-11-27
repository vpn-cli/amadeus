import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SILERO_MODEL_SHA256 } from "./download-model.js";
import { SileroRunJsonSchema } from "./json-schema.js";

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const tsxCli = resolve(import.meta.dirname, "node_modules", "tsx", "dist", "cli.mjs");
  const runScript = resolve(import.meta.dirname, "run.ts");

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [tsxCli, runScript, ...args], {
      cwd: import.meta.dirname,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

describe("silero run.ts --json CLI", () => {
  it("outputs exactly one valid JSON object matching SileroRunJsonSchema for sample-16k.wav", async () => {
    const sampleWav = resolve(import.meta.dirname, "out", "sample-16k.wav");
    const { code, stdout, stderr } = await runCli([sampleWav, "--json"]);

    expect(code, `stderr: ${stderr}`).toBe(0);
    const rawJson: unknown = JSON.parse(stdout);
    const parsed = SileroRunJsonSchema.parse(rawJson);

    expect(Object.keys(parsed).sort()).toEqual([
      "durationMs",
      "modelSha256",
      "params",
      "sampleRate",
      "segments",
    ]);
    expect(parsed.modelSha256).toBe(SILERO_MODEL_SHA256);
    expect(parsed.sampleRate).toBe(16000);
    expect(parsed.durationMs).toBeGreaterThan(8000);
    expect(parsed.segments).toHaveLength(2);
    for (const seg of parsed.segments) {
      expect(seg.endMs).toBeGreaterThan(seg.startMs);
    }
  }, 15000);

  it("rejects malformed payloads via SileroRunJsonSchema", () => {
    expect(() =>
      SileroRunJsonSchema.parse({
        modelSha256: "not-a-sha",
        params: {},
        sampleRate: 16000,
        durationMs: 100,
        segments: [],
      }),
    ).toThrow();
  });
});
