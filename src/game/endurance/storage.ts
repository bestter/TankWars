import type { BlockRecord, EnduranceExport, Incident, RoundRecord, SessionRecord } from "./types";
import { metrics } from "./metrics";
import { isPlayers } from "../online/protocol";
import type { JournalEntry, JournalStatus, JournalStorage } from "./journal";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function metricGroups(value: unknown): boolean {
  if (!object(value) || !object(value.total)) return false;
  const valid = (m: unknown) => object(m) && Object.keys(metrics()).every(k => typeof m[k] === "number" && Number.isFinite(m[k]) && m[k] >= 0);
  return valid(value.total) && [value.players, value.profiles, value.weapons].every(group => object(group) && Object.values(group).every(valid));
}
function stored<T>(value: unknown, store: Store): T {
  if (!object(value) || typeof value.id !== "string") throw new Error("INVALID_STORED_RECORD");
  if (store === "sessions" || store === "blocks") {
    if (value.schemaVersion !== 1 || !object(value.config) || !isPlayers(value.config.players) ||
      !metricGroups(value.completedMetrics) || !metricGroups(value.partialMetrics) ||
      typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0 ||
      typeof value.startedAt !== "string" || typeof value.status !== "string" || typeof value.gameVersion !== "string" || typeof value.build !== "string") {
      throw new Error("UNSUPPORTED_OR_INVALID_ENDURANCE_SCHEMA");
    }
    if (store === "sessions" && (!object(value.runtime) || value.runtime.width !== 800 || value.runtime.height !== 480 ||
      ![value.attempted, value.completed, value.abandoned, value.interrupted, value.suspect, value.roundsStarted, value.roundsCompleted, value.incidents].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0))) {
      throw new Error("INVALID_STORED_SESSION");
    }
  }
  if (store !== "sessions" && typeof value.sessionId !== "string") throw new Error("INVALID_STORED_SESSION_REFERENCE");
  if (store === "rounds" && (!metricGroups(value.metrics) || typeof value.blockId !== "string" ||
    typeof value.number !== "number" || typeof value.turns !== "number" || typeof value.durationMs !== "number" ||
    typeof value.completed !== "boolean" || !Array.isArray(value.survivors))) throw new Error("INVALID_STORED_ROUND");
  if (store === "incidents" && (typeof value.reason !== "string" || typeof value.kind !== "string" || !Array.isArray(value.recent))) throw new Error("INVALID_STORED_INCIDENT");
  return value as T;
}

export interface Checkpoint {
  session: SessionRecord;
  block: BlockRecord | null;
  round?: RoundRecord & { blockId: string; sessionId: string; id: string };
  incident?: Incident;
}
export interface EnduranceStorage {
  appendJournal?: JournalStorage["appendJournal"];
  readJournal?: JournalStorage["readJournal"];
  journalStatus?: JournalStorage["journalStatus"];
  save(checkpoint: Checkpoint): Promise<void>;
  latest(): Promise<SessionRecord | null>;
  exportSession(session: SessionRecord): Promise<EnduranceExport>;
  close(): void;
}
const STORES = ["sessions", "blocks", "rounds", "incidents"] as const;
type Store = typeof STORES[number];

export class IndexedEnduranceStorage implements EnduranceStorage {
  private connection: Promise<IDBDatabase> | null = null;
  private db(): Promise<IDBDatabase> {
    return this.connection ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("tankwars-endurance", 2);
      request.onupgradeneeded = () => {
        for (const name of STORES) {
          if (request.result.objectStoreNames.contains(name)) continue;
          const store = request.result.createObjectStore(name, { keyPath: "id" });
          if (name !== "sessions") store.createIndex("sessionId", "sessionId");
          else store.createIndex("startedAt", "startedAt");
        }
        if (!request.result.objectStoreNames.contains("journal")) request.result.createObjectStore("journal", { keyPath: ["sessionId", "sequence"] });
        if (!request.result.objectStoreNames.contains("journalMeta")) request.result.createObjectStore("journalMeta", { keyPath: "sessionId" });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error("INDEXEDDB_OPEN_FAILED"));
      request.onblocked = () => reject(new Error("INDEXEDDB_BLOCKED"));
    });
  }
  async save(checkpoint: Checkpoint): Promise<void> {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([...STORES], "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("INDEXEDDB_TRANSACTION_FAILED"));
      tx.onerror = () => reject(tx.error ?? new Error("INDEXEDDB_WRITE_FAILED"));
      tx.objectStore("sessions").put(checkpoint.session);
      if (checkpoint.block) tx.objectStore("blocks").put(checkpoint.block);
      if (checkpoint.round) tx.objectStore("rounds").put(checkpoint.round);
      if (checkpoint.incident) tx.objectStore("incidents").put(checkpoint.incident);
    });
  }
  async appendJournal(entries: readonly JournalEntry[], status: JournalStatus): Promise<void> {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["journal", "journalMeta"], "readwrite");
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error("JOURNAL_WRITE_FAILED"));
      tx.onerror = () => reject(tx.error ?? new Error("JOURNAL_WRITE_FAILED"));
      for (const entry of entries) tx.objectStore("journal").add(entry);
      tx.objectStore("journalMeta").put(status);
    });
  }
  async readJournal(sessionId: string, after: number, limit: number): Promise<JournalEntry[]> {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error("INVALID_JOURNAL_PAGE");
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction("journal").objectStore("journal").getAll(IDBKeyRange.bound([sessionId, after], [sessionId, Number.MAX_SAFE_INTEGER], true), limit);
      request.onsuccess = () => {
        try {
          const values: unknown[] = request.result;
          if (!values.every(v => object(v) && v.schemaVersion === 1 && v.sessionId === sessionId &&
            Number.isSafeInteger(v.sequence) && Number(v.sequence) > after && typeof v.at === "string" &&
            typeof v.atMs === "number" && Number.isFinite(v.atMs) && object(v.event) && typeof v.event.kind === "string")) throw new Error("INVALID_JOURNAL_RECORD");
          resolve(values as JournalEntry[]);
        } catch (error) { reject(error); }
      };
      request.onerror = () => reject(request.error);
    });
  }
  async journalStatus(sessionId: string): Promise<JournalStatus | null> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction("journalMeta").objectStore("journalMeta").get(sessionId);
      request.onsuccess = () => {
        const v: unknown = request.result;
        if (v === undefined) { resolve(null); return; }
        if (!object(v) || v.schemaVersion !== 1 || v.sessionId !== sessionId ||
          !Number.isSafeInteger(v.emitted) || !Number.isSafeInteger(v.persisted) || Number(v.persisted) < 0 ||
          Number(v.emitted) < Number(v.persisted) || typeof v.complete !== "boolean" || (v.error !== null && typeof v.error !== "string")) { reject(new Error("INVALID_JOURNAL_STATUS")); return; }
        resolve(v as unknown as JournalStatus);
      };
      request.onerror = () => reject(request.error);
    });
  }
  async latest(): Promise<SessionRecord | null> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions");
      const request = tx.objectStore("sessions").index("startedAt").openCursor(null, "prev");
      request.onsuccess = () => {
        try { resolve(request.result ? stored<SessionRecord>(request.result.value as unknown, "sessions") : null); }
        catch (error) { reject(error); }
      };
      request.onerror = () => reject(request.error);
    });
  }
  /** Cursor batches avoid retaining an unbounded live history while running. Export allocates its requested document. */
  private async rows<T>(name: Store, sessionId: string): Promise<T[]> {
    const db = await this.db();
    const result: T[] = [];
    let after: IDBValidKey | undefined;
    for (;;) {
      const page: Array<{ key: IDBValidKey; value: T }> = await new Promise((resolve, reject) => {
        const tx = db.transaction(name);
        const request = tx.objectStore(name).index("sessionId").openCursor(IDBKeyRange.only(sessionId));
        const page: Array<{ key: IDBValidKey; value: T }> = [];
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || page.length === 128) { resolve(page); return; }
          if (after === undefined || indexedDB.cmp(cursor.primaryKey, after) > 0) {
            try { page.push({ key: cursor.primaryKey, value: stored<T>(cursor.value as unknown, name) }); }
            catch (error) { reject(error); return; }
          }
          cursor.continue();
        };
      });
      result.push(...page.map(row => row.value));
      if (page.length < 128) return result;
      after = page[page.length - 1].key;
    }
  }
  async exportSession(session: SessionRecord): Promise<EnduranceExport> {
    const [blocks, rounds, incidents] = await Promise.all([
      this.rows<BlockRecord>("blocks", session.id),
      this.rows<RoundRecord & { blockId: string }>("rounds", session.id),
      this.rows<Incident>("incidents", session.id),
    ]);
    return { schemaVersion: 1, session: structuredClone(session), blocks: blocks.sort((a, b) => a.index - b.index), rounds, incidents,
      diagnostics: { evaluatedCommand: "unavailable", perturbations: "unavailable", deterministicReplay: false, combatResume: false } };
  }
  close(): void {
    if (this.connection) void this.connection.then(db => db.close(), error => console.error("[Endurance] Storage close failed", error));
    this.connection = null;
  }
}
