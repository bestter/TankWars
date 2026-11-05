import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDisk } from "./bundleMemory";
import { buildBundle, type BundleSource } from "../bundle/build";
import { exportOptions, PartWriter, type FileReference } from "../bundle/format";
import { encoder, one, readBytes, readJson, safePath } from "../bundle/io";
import { extractShot, validateBundle } from "../bundle/read";
import { writeZip } from "../bundle/zip";
import { fixture } from "./helpers";
import type { JournalEntry } from "../journal";
import { indexEntry, renderReport } from "../bundle/report";
import { GameEngine } from "../../engine/GameEngine";
import { makePlayer, makeTank, makeRoundMap } from "../../__tests__/helpers";
import { ShotRecorder, fingerprint } from "../../diagnostics/archive";
import { replayShot } from "../../diagnostics/replay";
import type { ArchiveRecord } from "../../diagnostics/types";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { IndexedEnduranceStorage } from "../storage";
import { EnduranceSession } from "../session";

beforeEach(() => { vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() }); });
afterEach(() => { vi.unstubAllGlobals(); });

function entry(sequence: number, event: JournalEntry["event"] = { kind: "phase", reason: null, players: [] }): JournalEntry {
  return { schemaVersion: 1, sessionId: "id-1", sequence, at: "2026-11-05T00:00:00Z", atMs: sequence,
    blockId: "b", blockIndex: 1, round: 1, turn: 1, seed: 1, phase: "COMBAT", decisionId: "journal-decision", context: null, contextError: null, event };
}
function source(rows: JournalEntry[]): BundleSource {
  const f = fixture();
  return { session: f.run.session, status: { schemaVersion: 1, sessionId: f.run.session.id, persisted: rows.length, emitted: rows.length, complete: true, error: null },
    journal: async after => rows.filter(row => row.sequence > after).slice(0, 256), terrain: async () => { throw new Error("MISSING_TERRAIN"); }, collection: async () => [] };
}
describe("progressive endurance bundle", () => {
  it("validates safe integer export settings without changing game configuration", () => {
    expect(exportOptions()).toEqual({ partSizeMiB: 20, slowDecisionMs: 1000 });
    for (const partSizeMiB of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) expect(() => exportOptions({ partSizeMiB })).toThrow("INVALID_EXPORT_OPTIONS");
    expect(() => exportOptions({ slowDecisionMs: 0 })).toThrow();
    for (const path of ["../secret", "/tmp/file", "C:/outside", "a/../b", "a//b", "a/%2e%2e/b"]) expect(() => safePath(path)).toThrow("INVALID_BUNDLE_PATH");
  });
  it("rotates exact UTF-8 bytes before records, permits equality, isolates oversized lines", async () => {
    const disk = new MemoryDisk(), files: FileReference[] = [];
    const bytes = encoder.encode('é😀\u2028\n'), writer = new PartWriter(disk, "journal", bytes.length * 2, async file => { files.push(file); });
    await writer.append(bytes, 1); await writer.append(bytes, 2); await writer.append(bytes, 3);
    const big = encoder.encode("x".repeat(bytes.length * 3) + "\n"); await writer.append(big, 4); await writer.append(bytes, 5); await writer.flush();
    expect(files.map(f => f.count)).toEqual([2, 1, 1, 1]); expect(files[0].bytes).toBe(bytes.length * 2);
    expect(files.map(f => f.oversized)).toEqual([false, false, true, false]);
    expect(await readBytes(disk, files[2].path)).toEqual(big);
  });
  it("exports and validates an empty session without inventing shots or statistics", async () => {
    const disk = new MemoryDisk(), manifest = await buildBundle(source([]), disk);
    expect(manifest.reportComplete).toBe(true); expect(manifest.captureLast).toBe(0);
    expect(await validateBundle(disk)).toMatchObject({ journal: { persisted: 0 } });
    await expect(extractShot(disk, "missing")).rejects.toThrow();
  });
  it("freezes the upper boundary and appends immutable parts for the next generation", async () => {
    const rows = [entry(1), entry(2)], input = source(rows), disk = new MemoryDisk(); input.status.persisted = 1;
    const first = await buildBundle(input, disk); const bytes = disk.files.get("journal/part-000001.jsonl")!.slice();
    input.status.persisted = 2;
    const second = await buildBundle(input, disk);
    expect(first.journal.persisted).toBe(1); expect(second.journal.persisted).toBe(2);
    expect(disk.files.get("journal/part-000001.jsonl")).toEqual(bytes);
    expect(disk.files.has("journal/part-000002.jsonl")).toBe(true);
    expect(second.catalogue).not.toBe(first.catalogue);
  });
  it("keeps a live export's current block snapshot after later stop/checkpoint writes", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    const storage = new IndexedEnduranceStorage(), f = fixture(), run = new EnduranceSession(f.config, storage);
    await run.start(); const snapshot = await run.bundleSource(), upper = snapshot.status.persisted;
    await run.stop("manual");
    const first = await snapshot.collection("blocks");
    expect(first).toHaveLength(1); expect(first[0].value).toMatchObject({ status: "running", reason: null });
    expect(await snapshot.collection("blocks", first[0].key)).toEqual([]);
    const disk = new MemoryDisk(), manifest = await buildBundle(snapshot, disk);
    expect(manifest.journal.persisted).toBe(upper); expect(manifest.session.status).toBe("running");
    expect(new TextDecoder().decode(await readBytes(disk, "journal/part-000001.jsonl"))).not.toContain('"kind":"session-stop"');
    storage.close();
  });
  it("rejects holes, changed files and missing parts instead of presenting a full export", async () => {
    await expect(buildBundle(source([entry(2)]), new MemoryDisk())).rejects.toThrow("JOURNAL_SEQUENCE_GAP");
    const disk = new MemoryDisk(); await buildBundle(source([entry(1)]), disk);
    disk.files.get("journal/part-000001.jsonl")![0] ^= 1;
    await expect(validateBundle(disk)).rejects.toThrow("BUNDLE_FILE_INTEGRITY_FAILED");
    const missing = new MemoryDisk(); await buildBundle(source([entry(1)]), missing); missing.files.delete("journal/part-000001.jsonl");
    await expect(validateBundle(missing)).rejects.toThrow("MISSING_FILE");
  });
  it("retains a valid data manifest when only derived rendering fails", async () => {
    class FailedReport extends MemoryDisk { override async write(path: string, chunks: AsyncIterable<Uint8Array>) { if (path === "index.html") throw new Error("REPORT_DISK_FULL"); await super.write(path, chunks); } }
    const disk = new FailedReport(); const manifest = await buildBundle(source([]), disk);
    expect(manifest.complete).toBe(true); expect(manifest.reportComplete).toBe(false); expect(manifest.reportError).toContain("rapport incomplet");
    expect(await validateBundle(disk)).toMatchObject({ complete: true });
  });
  it("does not conflate canceled decisions, launches, roles or captured duplicates", async () => {
    const disk = new MemoryDisk(), f = fixture(), player = f.players[0];
    const decision = entry(1, { kind: "combat", event: { kind: "decision", playerId: player.id, durationMs: 1000, command: { weaponId: "MISSILE", angle: 45, power: 50 } } });
    decision.context = { players: f.players, windForce: 0 }; player.name = '<script>"😀</script>';
    await indexEntry(disk, decision, { path: "journal/part-000001.jsonl", offset: 0, length: 100 }, undefined, 1000);
    await indexEntry(disk, entry(2, { kind: "decision-cancelled", reason: "replaced" }), { path: "journal/part-000001.jsonl", offset: 100, length: 100 }, undefined, 1000);
    expect(await disk.get("player-totals", player.id)).toMatchObject({ decisions: 1, shots: 0 });
    const manifest = await buildBundle(source([]), new MemoryDisk()); await renderReport(disk, manifest);
    const pages = [...disk.files].filter(([name]) => name.endsWith(".html")).map(([, value]) => new TextDecoder().decode(value));
    expect(pages.some(value => value.includes("&lt;script&gt;"))).toBe(true); expect(pages.every(value => !value.includes("<script>"))).toBe(true);
    expect(pages.join("")).not.toContain("fetch(");
    const root = await readJson(disk, "index/root.json") as { statistics: Array<{ median: number; p95: number }> };
    expect(root.statistics[0]).toMatchObject({ median: 1000, p95: 1000 });
  });
  it("writes a streaming ZIP64 with valid descriptors and a disk-backed central directory", async () => {
    const disk = new MemoryDisk(); await disk.write("index.html", one(encoder.encode("é😀"))); await writeZip(disk);
    const bytes = await readBytes(disk, "bundle.zip"), view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(bytes.length - 98, true)).toBe(0x06064b50);
    expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
    expect(view.getBigUint64(bytes.length - 98 + 32, true)).toBe(1n);
  });
  it.each([[[], null, null], [[7], 7, 7], [[1, 3], 2, 3], [[1, 2, 9], 2, 9], [Array.from({ length: 20 }, (_, i) => i + 1), 10.5, 19]])("computes exact duration ranks for %j", async (durations, median, p95) => {
    const disk = new MemoryDisk(), f = fixture(), player = f.players[0]; let sequence = 0;
    const emit = async (event: JournalEntry["event"]) => {
      const row = entry(++sequence, event); row.context = { players: f.players, windForce: 0 };
      await indexEntry(disk, row, { path: "journal/part-000001.jsonl", offset: sequence, length: 1 }, undefined, 1000);
    };
    await emit({ kind: "combat", event: { kind: "decision-start", playerId: player.id } });
    for (const durationMs of durations as number[]) await emit({ kind: "combat", event: { kind: "decision", playerId: player.id, durationMs,
      command: { weaponId: "MISSILE", angle: 45, power: 50 } } });
    await renderReport(disk, await buildBundle(source([]), new MemoryDisk()));
    const root = await readJson(disk, "index/root.json") as { statistics: unknown[] };
    expect(root.statistics[0]).toMatchObject({ count: durations.length, median, p95 });
  });
  it("keeps a failed later generation from replacing the last report pointer", async () => {
    class FailingDisk extends MemoryDisk { fail = false; override async write(path: string, data: AsyncIterable<Uint8Array>) { if (this.fail && path.includes("/report/")) throw new Error("derived failure"); return super.write(path, data); } }
    const disk = new FailingDisk(), input = source([entry(1)]);
    const first = await buildBundle(input, disk); disk.fail = true;
    input.status.persisted = 2; input.status.emitted = 2; input.journal = async after => [entry(1), entry(2)].filter(e => e.sequence > after);
    const second = await buildBundle(input, disk);
    expect(second.reportComplete).toBe(false); expect(second.index).toBe(first.index); expect(second.journal.persisted).toBe(2);
  });
  it("reuses closed view content and removes superseded derived generations after publication", async () => {
    class ObservedDisk extends MemoryDisk {
      reads: string[] = [];
      override async *read(path: string, offset?: number, length?: number) { this.reads.push(path); yield* super.read(path, offset, length); }
    }
    const rows = Array.from({ length: 205 }, (_, i) => entry(i + 1)), input = source(rows), disk = new ObservedDisk();
    const first = await buildBundle(input, disk);
    disk.reads = []; rows.push(entry(206)); input.status.persisted = 206; input.status.emitted = 206;
    await buildBundle(input, disk);
    expect(disk.reads.some(path => path.startsWith(`derived/${first.generation}/report/`))).toBe(true);
    expect([...disk.files.keys()].some(path => path.startsWith(`derived/${first.generation}/`))).toBe(false);
  });
  it("extracts and replays a real shot across parts with an earlier terrain dependency", async () => {
    const engine = new GameEngine(800, 480, { headless: true }), recorder = new ShotRecorder("test-session");
    engine.setPlayers([makePlayer({ id: "a", tank: makeTank("ta", 120, 300) }), makePlayer({ id: "b", tank: makeTank("tb", 420, 300) })], makeRoundMap());
    engine.diagnosticSink = input => recorder.record(input);
    const observer = { emit: (event: import("../types").EnduranceEvent) => { recorder.record({ kind: "combat", event }); return true; } };
    engine.combatObserver = observer; engine.getTurnManager().combatObserver = observer;
    const actor = engine.getTankManager().getPlayers()[0]; actor.tank.angle = 50; actor.tank.power = 55;
    expect(engine.getTurnManager().tryFire()).toBe(true);
    const update = Reflect.get(engine, "update") as (dt: number) => void;
    for (let i = 0; i < 10000 && !engine.getPendingShotResult(); i++) update.call(engine, 1 / 120);
    const original = recorder.export(); engine.stop();
    const key = original.records.find(r => r.input.kind === "pre-shot")!.shotKey!;
    const records: ArchiveRecord[] = [];
    for (const record of original.records) {
      records.push(structuredClone(record));
      if (record.input.kind === "pre-shot") for (let n = 0; n < 3; n++) records.push({ ...record,
        input: { kind: "boundary", status: "padding", detail: "é".repeat(300000) } });
    }
    records.forEach((record, i) => { record.sequence = i + 1; record.integrity = fingerprint({ ...record, integrity: undefined }); });
    const rows = records.map((record, i) => entry(i + 1, { kind: "archive", write: { record, terrains: [] } }));
    const input = source(rows); input.terrain = async id => original.terrains.find(t => t.id === id)!;
    const disk = new MemoryDisk(); await buildBundle(input, disk, { partSizeMiB: 1 });
    expect([...disk.files.keys()].filter(p => p.startsWith("captures/")).length).toBeGreaterThanOrEqual(3);
    const archive = await extractShot(disk, key), replay = replayShot(archive, key);
    expect(replay.complete).toBe(true); expect(replay.physicalDivergence).toBeNull(); expect(replay.economicDivergence).toBeNull();
    // A fresh reader validates the full source independently of a prior targeted read.
    disk.tables.delete("verified-files");
    expect((await validateBundle(disk)).captureLast).toBe(records.length);
  });
});
