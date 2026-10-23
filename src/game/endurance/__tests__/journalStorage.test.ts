import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexedEnduranceStorage } from "../storage";
import type { JournalEntry, JournalStatus } from "../journal";

beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange); });
afterEach(() => vi.unstubAllGlobals());
const status: JournalStatus = { schemaVersion: 1, sessionId: "s", emitted: 300, persisted: 300, complete: false, error: null };
const rows: JournalEntry[] = Array.from({ length: 300 }, (_, i) => ({
  schemaVersion: 1, sessionId: "s", sequence: i + 1, at: "2026-01-01", atMs: i,
  blockId: null, blockIndex: 0, seed: null, round: 0, turn: 0, phase: "PREPARATION", decisionId: null,
  event: { kind: "session-start", metadata: {} }, context: null, contextError: null,
}));
describe("additive IndexedDB journal migration", () => {
  it("preserves v1 records, pages the journal in sequence and atomically rejects duplicate sequences", async () => {
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("tankwars-endurance", 1);
      request.onupgradeneeded = () => {
        for (const name of ["sessions", "blocks", "rounds", "incidents"]) {
          const store = request.result.createObjectStore(name, { keyPath: "id" });
          store.createIndex(name === "sessions" ? "startedAt" : "sessionId", name === "sessions" ? "startedAt" : "sessionId");
        }
      };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = old.transaction("blocks", "readwrite"); tx.objectStore("blocks").put({ id: "legacy", sessionId: "old", marker: 1 });
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    }); old.close();
    const storage = new IndexedEnduranceStorage();
    expect(await storage.journalStatus("old")).toBeNull();
    await storage.appendJournal(rows.slice(0, 256), { ...status, emitted: 256, persisted: 256 });
    await storage.appendJournal(rows.slice(256), status);
    expect(await storage.readJournal("s", 0, 256)).toEqual(rows.slice(0, 256));
    expect(await storage.readJournal("s", 256, 256)).toEqual(rows.slice(256));
    expect(await storage.readJournal("other", 0, 256)).toEqual([]);
    await expect(storage.appendJournal([rows[0]], { ...status, complete: true })).rejects.toThrow();
    expect(await storage.journalStatus("s")).toEqual(status);
    await expect(storage.readJournal("s", -1, 256)).rejects.toThrow("INVALID_JOURNAL_PAGE");
    await expect(storage.readJournal("s", 0, 257)).rejects.toThrow("INVALID_JOURNAL_PAGE");
    const check = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open("tankwars-endurance", 2); r.onsuccess = () => resolve(r.result); });
    const legacy = await new Promise<unknown>(resolve => { const r = check.transaction("blocks").objectStore("blocks").get("legacy"); r.onsuccess = () => resolve(r.result); });
    expect(legacy).toEqual({ id: "legacy", sessionId: "old", marker: 1 }); check.close(); storage.close();
  });
});
