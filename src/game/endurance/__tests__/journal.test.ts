import { afterEach, describe, expect, it, vi } from "vitest";
import { EnduranceJournal, type JournalEntry, type JournalStatus } from "../journal";

export const entry: Omit<JournalEntry, "schemaVersion" | "sequence" | "sessionId"> = {
  at: "2026-01-01T00:00:00Z", atMs: 0, blockId: null, blockIndex: 0, seed: null,
  round: 0, turn: 0, phase: "PREPARATION", decisionId: null,
  event: { kind: "session-start", metadata: {} }, context: null, contextError: null,
};
afterEach(() => vi.useRealTimers());
describe("bounded JSONL journal", () => {
  it("flushes within one second, snapshots values, serializes batches and acknowledges only confirmed writes", async () => {
    vi.useFakeTimers(); const rows: JournalEntry[] = []; const batches: number[] = [];
    let active = 0;
    const journal = new EnduranceJournal("s", async batch => {
      expect(active++).toBe(0); await Promise.resolve();
      batches.push(batch.length); rows.push(...batch); active--;
    }, vi.fn());
    const value = structuredClone(entry); journal.append(value); value.phase = "mutated";
    expect(journal.status.persisted).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(rows[0].phase).toBe("PREPARATION");
    for (let i = 0; i < 600; i++) journal.append(entry);
    await journal.finish();
    expect(rows.map(r => r.sequence)).toEqual(Array.from({ length: 601 }, (_, i) => i + 1));
    expect(Math.max(...batches)).toBeLessThanOrEqual(256);
    expect(journal.status).toMatchObject({ complete: true, emitted: 601, persisted: 601 });
    journal.append(entry); expect(journal.status.emitted).toBe(601);
  });
  it("stops on saturation without silently deleting accepted entries or interrupting the caller", async () => {
    let release: () => void = () => {}; const blocked = new Promise<void>(r => { release = r; });
    const rows: JournalEntry[] = []; const failure = vi.fn();
    const journal = new EnduranceJournal("s", async batch => { await blocked; rows.push(...batch); }, failure);
    for (let i = 0; i < 2049; i++) journal.append(entry);
    expect(failure).not.toHaveBeenCalled();
    expect(journal.status.error).toContain("BACKPRESSURE");
    await Promise.resolve(); expect(failure).toHaveBeenCalledOnce(); release(); await journal.finish();
    expect(rows).toHaveLength(2048);
    expect(journal.status).toMatchObject({ emitted: 2049, persisted: 2048, complete: false });
  });
  it("keeps failed entries exportable, reports one failure and never acknowledges a rejected batch", async () => {
    const failure = vi.fn(); const write = vi.fn<(batch: readonly JournalEntry[], status: JournalStatus) => Promise<void>>(async () => { throw new Error("quota"); });
    const journal = new EnduranceJournal("s", write, failure); journal.append(entry);
    await journal.finish(); await Promise.resolve();
    expect(journal.pending()).toHaveLength(1);
    expect(journal.status).toMatchObject({ persisted: 0, complete: false });
    expect(failure).toHaveBeenCalledOnce();
  });
});
