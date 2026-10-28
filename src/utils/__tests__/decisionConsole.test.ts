import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DECISION_CONSOLE_MAX_LINE, writeDecisionConsole } from "../decisionConsole";

const label = "[AI EXPERT] Décision";
function readExport(lines: readonly string[]) {
  const directory = mkdtempSync(join(tmpdir(), "tankwars-console-"));
  try {
    const file = join(directory, "console.txt");
    // Include DevTools file/line prefixes and Windows line endings in the saved export.
    writeFileSync(file, lines.map(line => `AISmartStrategy.ts:140 ${line}`).join("\r\n"), "utf8");
    const result = spawnSync(process.execPath, ["Scripts/read-decision-console.mjs", file], { encoding: "utf8" });
    return { status: result.status, data: JSON.parse(result.stdout) as {
      complete: boolean; malformedLines: number[]; unsupportedLines: number[];
      decisions: { complete: boolean; errors: string[]; details: unknown; summary: unknown }[];
    } };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("browser decision console export", () => {
  it("round-trips a large real-shaped decision through saved text and the reader, using one bounded string per call", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const details = { shooterId: "expert", round: 7, turn: 7,
      selectionReason: "profit net supérieur", lethalTransition: { reason: "initial-retained", analysis: { reason: "existing-threat" } },
      targets: [{ playerId: "human", profit: 80 }, { playerId: "ok", profit: 50 }],
      damage: Array.from({ length: 1000 }, (_, index) => ({ victimId: "human", index, health: 1, text: "é🤖\n\t\u0000" })),
    };
    writeDecisionConsole(label, { shooterId: "expert", selectionReason: details.selectionReason, targets: details.targets }, details);
    expect(log.mock.calls.every(call => call.length === 1 && typeof call[0] === "string" && call[0].length <= DECISION_CONSOLE_MAX_LINE)).toBe(true);
    expect(log.mock.calls.filter(([line]) => line.startsWith(`${label} {`))).toHaveLength(1);
    const exported = readExport(log.mock.calls.map(([line]) => line));
    expect(exported.status).toBe(0); expect(exported.data.complete).toBe(true);
    expect(exported.data.decisions[0].details).toEqual(details);
    expect(exported.data.decisions[0].summary).toMatchObject({ selectionReason: details.selectionReason, targets: details.targets });
  });

  it("marks a missing fragment incomplete instead of claiming the explanation is available", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    writeDecisionConsole(label, { reason: "fallback" }, { text: "terrain".repeat(5000) });
    const lines = log.mock.calls.map(([line]) => line); lines.splice(2, 1);
    const result = readExport(lines);
    expect(result.status).toBe(2); expect(result.data.complete).toBe(false);
    expect(result.data.decisions[0]).toMatchObject({ complete: false, errors: ["missing-detail-fragments"], details: null });
  });

  it("also bounds oversized summaries and reassembles escaped strings without loss", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const summary = { text: "\u0000\t\\\"é🤖".repeat(2000) };
    writeDecisionConsole(label, summary);
    expect(log.mock.calls.every(([line]) => line.length <= DECISION_CONSOLE_MAX_LINE)).toBe(true);
    const result = readExport(log.mock.calls.map(([line]) => line));
    expect(result.status).toBe(0); expect(result.data.decisions[0].summary).toEqual(summary);
    expect(result.data.decisions[0].details).toEqual(summary);
  });

  it("detects the missing and truncated decisions from the supplied legacy export", () => {
    const lines = [label, `${label} {"shooterId":"expert","phase":"REPLI"}`,
      `${label} {"shooterId":"expert","damage":[`];
    const result = readExport(lines);
    expect(result.status).toBe(2); expect(result.data.complete).toBe(false);
    expect(result.data.malformedLines.length).toBeGreaterThan(0);
    expect(result.data.unsupportedLines.length).toBeGreaterThan(0);
  });

  it("never emits public production logs", () => {
    vi.stubEnv("DEV", false);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    writeDecisionConsole(label, { reason: "test" });
    expect(log).not.toHaveBeenCalled();
  });
});
