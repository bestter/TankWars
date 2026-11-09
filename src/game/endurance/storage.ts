import type { BlockRecord, EnduranceExport, Incident, RoundRecord, SessionRecord } from "./types";
import { validateScenario } from "./scenario";
import { metrics } from "./metrics";
import { isPlayers } from "../online/protocol";
import type { JournalEntry, JournalStatus, JournalStorage } from "./journal";
import type { ArchiveFilter } from "../diagnostics/export";
import { byteSize, recordTerrainId } from "../diagnostics/archive";
import type { ArchiveRecord, ArchiveWrite, TerrainRecord, ShotListPage } from "../diagnostics/types";

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
    if (value.config.scenario != null) {
      const scenario = validateScenario(value.config.scenario);
      if (scenario.spawnXs.length !== value.config.players.length) throw new Error("INVALID_STORED_SCENARIO_ROSTER");
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
export function validateSessionRecord(value: unknown): SessionRecord { return stored<SessionRecord>(value, "sessions"); }

export interface Checkpoint {
  journalSequence?: number;
  session: SessionRecord;
  block: BlockRecord | null;
  round?: RoundRecord & { blockId: string; sessionId: string; id: string };
  incident?: Incident;
}
export interface EnduranceStorage {
  capturePage?(sessionId: string, upper: number, after: number): Promise<Array<{ key: number; record: ArchiveRecord }>>;
  readTerrain?(id: string): Promise<TerrainRecord>;
  collectionPage?(name: "blocks" | "rounds" | "incidents", sessionId: string, after?: IDBValidKey): Promise<Array<{ key: IDBValidKey; value: unknown; capturedAtSequence?: number | null }>>;
  readArchive?(sessionId: string, upper: number, filter?: ArchiveFilter): Promise<ArchiveWrite[]>;
  listShots?(sessionId: string, upper: number, query: string, page: number): Promise<ShotListPage>;
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
      const request = indexedDB.open("tankwars-endurance", 3);
      request.onupgradeneeded = () => {
        for (const name of STORES) {
          if (request.result.objectStoreNames.contains(name)) continue;
          const store = request.result.createObjectStore(name, { keyPath: "id" });
          if (name !== "sessions") store.createIndex("sessionId", "sessionId");
          else store.createIndex("startedAt", "startedAt");
        }
        if (!request.result.objectStoreNames.contains("journal")) request.result.createObjectStore("journal", { keyPath: ["sessionId", "sequence"] });
        if (!request.result.objectStoreNames.contains("journalMeta")) request.result.createObjectStore("journalMeta", { keyPath: "sessionId" });
        if (!request.result.objectStoreNames.contains("captures")) request.result.createObjectStore("captures", { keyPath: ["sessionId", "sequence"] });
        if (!request.result.objectStoreNames.contains("terrains")) request.result.createObjectStore("terrains", { keyPath: "id" });
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
      if (checkpoint.block) tx.objectStore("blocks").put({ ...checkpoint.block, bundleCheckpointSequence: checkpoint.journalSequence ?? null });
      if (checkpoint.round) tx.objectStore("rounds").put({ ...checkpoint.round, bundleCheckpointSequence: checkpoint.journalSequence ?? null });
      if (checkpoint.incident) tx.objectStore("incidents").put({ ...checkpoint.incident, bundleCheckpointSequence: checkpoint.journalSequence ?? null });
    });
  }
  async appendJournal(entries: readonly JournalEntry[], status: JournalStatus): Promise<void> {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["journal", "journalMeta", "captures", "terrains"], "readwrite");
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error("JOURNAL_WRITE_FAILED"));
      tx.onerror = () => reject(tx.error ?? new Error("JOURNAL_WRITE_FAILED"));
      for (const entry of entries) {
        if (entry.event.kind === "archive") {
          const { record, terrains } = entry.event.write;
          tx.objectStore("captures").add({ sessionId: entry.sessionId, sequence: entry.sequence, record });
          for (const terrain of terrains) {
            const store = tx.objectStore("terrains");
            const request = store.get(terrain.id);
            request.onsuccess = () => {
              if (request.result === undefined) store.add(terrain);
              else if (JSON.stringify(request.result) !== JSON.stringify(terrain)) tx.abort();
            };
          }
          tx.objectStore("journal").add({ ...entry, event: { kind: "archive", write: { record, terrains: [] } } });
        } else tx.objectStore("journal").add(entry);
      }
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
  /** Short transactions yield to the writer; each page is bounded by count and serialized bytes. */
  async capturePage(sessionId: string, upper: number, after: number, reverse = false): Promise<Array<{ key: number; record: ArchiveRecord }>> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("captures"), rows: Array<{ key: number; record: ArchiveRecord }> = [];
      let bytes = 0;
      const range = reverse ? IDBKeyRange.bound([sessionId, 0], [sessionId, Math.min(upper, after)], false, after <= upper) :
        IDBKeyRange.bound([sessionId, after], [sessionId, upper], true);
      const request = tx.objectStore("captures").openCursor(range, reverse ? "prev" : "next");
      request.onsuccess = () => {
        try {
          const cursor = request.result; if (!cursor || rows.length >= 128 || bytes >= 1024 * 1024) return;
          const value: unknown = cursor.value;
          if (!object(value) || !Number.isSafeInteger(value.sequence) || !object(value.record) || !object(value.record.input) ||
            typeof value.record.input.kind !== "string" || !Number.isSafeInteger(value.record.sequence)) throw new Error("INVALID_STORED_CAPTURE");
          bytes += byteSize(value);
          rows.push({ key: Number(value.sequence), record: value.record as unknown as ArchiveRecord }); cursor.continue();
        } catch (error) { reject(error); tx.abort(); }
      };
      tx.oncomplete = () => resolve(rows); tx.onerror = () => reject(tx.error ?? new Error("ARCHIVE_READ_FAILED"));
      tx.onabort = () => reject(tx.error ?? new Error("ARCHIVE_READ_FAILED"));
    });
  }
  async readArchive(sessionId: string, upper: number, filter?: ArchiveFilter): Promise<ArchiveWrite[]> {
    if (!Number.isSafeInteger(upper) || upper < 0) throw new Error("INVALID_ARCHIVE_BOUNDARY");
    const writes: ArchiveWrite[] = [], seen = new Set<number>(), terrainIds = new Set<string>();
    let group: ArchiveRecord[] = [], context = "", wanted = false, last: ArchiveRecord | undefined, after = 0;
    const selecting = filter && (filter.shotKey !== undefined || filter.from !== undefined || filter.to !== undefined || filter.incidents);
    const append = (record: ArchiveRecord) => {
      if (seen.has(record.sequence)) return;
      seen.add(record.sequence); writes.push({ record, terrains: [] });
      if ("snapshot" in record.input) {
        if (!object(record.input.snapshot) || typeof record.input.snapshot.terrainId !== "string") throw new Error("INVALID_STORED_CAPTURE");
      }
      const id = recordTerrainId(record);
      if (id !== undefined) terrainIds.add(id);
    };
    const flush = () => { if (wanted) for (const record of group) append(record); group = []; wanted = false; };
    while (after < upper) {
      // Each short transaction starts after the preceding confirmed page, leaving the writer free between pages.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const rows = await this.capturePage(sessionId, upper, after);
      if (!rows.length) break;
      for (const { record } of rows) {
        last = record;
        if (!selecting) { append(record); continue; }
        if (record.input.kind === "boundary" && record.input.status === "archive-manifest") append(record);
        const key = `${record.blockId}/${record.round}/${record.turn}`;
        if (key !== context) { flush(); context = key; }
        group.push(record);
        const incident = (record.input.kind === "combat" && ["failure", "recovery", "shot-refused"].includes(record.input.event.kind)) ||
          (record.input.kind === "boundary" && ["incident", "manual-incident"].includes(record.input.status));
        if ((filter.shotKey !== undefined && record.shotKey === filter.shotKey) || (filter.incidents && incident) ||
          ((filter.from !== undefined || filter.to !== undefined) && record.sequence >= (filter.from ?? 0) && record.sequence <= (filter.to ?? Infinity))) wanted = true;
      }
      after = rows[rows.length - 1].key;
    }
    flush(); if (last) append(last); // Preserve the stable archive upper sequence, even for a filtered export.
    const db = await this.db(), ids = [...terrainIds];
    for (let offset = 0; offset < ids.length; offset += 128) {
      // Dependencies are immutable; bounded transactions need no combat lock.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const terrains = await new Promise<TerrainRecord[]>((resolve, reject) => {
        const tx = db.transaction("terrains"), records: TerrainRecord[] = [];
        for (const id of ids.slice(offset, offset + 128)) {
          const request = tx.objectStore("terrains").get(id);
          request.onsuccess = () => {
            const value: unknown = request.result;
            if (!object(value) || value.id !== id) { tx.abort(); return; }
            records.push(value as unknown as TerrainRecord);
          };
        }
        tx.oncomplete = () => resolve(records); tx.onabort = () => reject(tx.error ?? new Error("ARCHIVE_DEPENDENCY_MISSING"));
        tx.onerror = () => reject(tx.error ?? new Error("ARCHIVE_READ_FAILED"));
      });
      if (writes[0]) writes[0].terrains.push(...terrains);
    }
    return writes;
  }
  async listShots(sessionId: string, upper: number, query: string, page: number): Promise<ShotListPage> {
    if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(upper) || upper < 0) throw new Error("INVALID_ARCHIVE_PAGE");
    const result: ShotListPage = { rows: [], total: 0, firstSequence: 0, lastSequence: 0, evicted: 0 };
    let after = Number.MAX_SAFE_INTEGER, terminalKey = "", terminalStatus = "";
    for (;;) {
      // Read newest first so a shot's terminal status precedes its launch; at most one active shot exists.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const rows = await this.capturePage(sessionId, upper, after, true); if (!rows.length) break;
      for (const { record } of rows) {
        result.firstSequence = record.sequence; result.lastSequence = Math.max(result.lastSequence, record.sequence);
        const input = record.input;
        if (result.captureInProgress === undefined && "snapshot" in input) {
          if (!object(input.snapshot) || typeof input.snapshot.inProgress !== "boolean") throw new Error("INVALID_STORED_CAPTURE");
          result.captureInProgress = input.snapshot.inProgress;
        }
        if (record.shotKey && (input.kind === "settled" || input.kind === "interrupted")) {
          if (terminalKey !== record.shotKey || input.kind === "settled") { terminalKey = record.shotKey; terminalStatus = input.kind; }
        }
        if (input.kind !== "pre-shot" || !record.shotKey) continue;
        if (!object(input.snapshot) || !object(input.snapshot.state) || !isPlayers(input.snapshot.state.players) || !object(input.shot)) throw new Error("INVALID_STORED_CAPTURE");
        const player = input.snapshot.state.players.find(p => p.id === input.shot.playerId);
        const row = { key: record.shotKey, label: `${player?.name ?? input.shot.playerId} · ${record.blockId ?? "DEV"}/${record.round}/${record.turn} · #${record.sequence} · ${record.shotKey}`,
          status: terminalKey === record.shotKey ? terminalStatus : "in-progress" };
        terminalKey = ""; terminalStatus = "";
        if (!`${row.label} ${row.status}`.toLowerCase().includes(query.toLowerCase())) continue;
        if (result.total >= page * 20 && result.rows.length < 20) result.rows.push(row);
        result.total++;
      }
      after = rows[rows.length - 1].key; if (after === 0) break;
    }
    return result;
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
  async readTerrain(id: string): Promise<TerrainRecord> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction("terrains").objectStore("terrains").get(id);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const value: unknown = request.result;
        if (!object(value) || value.id !== id) reject(new Error("ARCHIVE_DEPENDENCY_MISSING"));
        else resolve(value as unknown as TerrainRecord);
      };
    });
  }
  async collectionPage(name: "blocks" | "rounds" | "incidents", sessionId: string, after?: IDBValidKey): Promise<Array<{ key: IDBValidKey; value: unknown; capturedAtSequence?: number | null }>> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name), page: Array<{ key: IDBValidKey; value: unknown; capturedAtSequence?: number | null }> = [];
      let bytes = 0;
      const request = tx.objectStore(name).index("sessionId").openCursor(IDBKeyRange.only(sessionId));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || page.length >= 128 || bytes >= 1024 * 1024) return;
        if (after === undefined || indexedDB.cmp(cursor.primaryKey, after) > 0) {
          try {
            const raw = stored<Record<string, unknown>>(cursor.value as unknown, name);
            const { bundleCheckpointSequence, ...value } = raw;
            const capturedAtSequence = typeof bundleCheckpointSequence === "number" ? bundleCheckpointSequence : null;
            bytes += byteSize(value); page.push({ key: cursor.primaryKey, value, capturedAtSequence });
          } catch (error) { reject(error); tx.abort(); return; }
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve(page);
      tx.onabort = () => reject(tx.error ?? new Error("COLLECTION_READ_FAILED"));
    });
  }
  close(): void {
    if (this.connection) void this.connection.then(db => db.close(), error => console.error("[Endurance] Storage close failed", error));
    this.connection = null;
  }
}
