import { version } from "../../../package.json";
import { WEAPON_REGISTRY } from "../../types/weapon";
import type { ArchiveInput, ArchiveRecord, ArchiveWrite, DiagnosticInput, ShotArchive, TerrainRecord } from "./types";

export const MIB = 1024 * 1024;
export const ACTION_RESERVE = 8 * MIB;
export const CLOSURE_RESERVE = 2 * MIB;
export const QUEUE_BYTES = 32 * MIB;
export const byteSize = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

/** Stable JSON for integrity checks; absent optional properties have JSON's usual semantics. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(v => canonical(v)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Content address plus full equality verification on insertion (not a security signature). */
export function fingerprint(value: unknown): string {
  const data = canonical(value);
  let a = 2166136261, b = 5381;
  for (let i = 0; i < data.length; i++) { a = Math.imul(a ^ data.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ data.charCodeAt(i); }
  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}
export const RULES_ID = `local-physics-0.13.3/${fingerprint(WEAPON_REGISTRY)}`;

export function sealArchive(archive: ShotArchive): ShotArchive {
  return { ...archive, integrity: fingerprint({ ...archive, integrity: undefined,
    records: archive.records.map(r => r.integrity), terrains: archive.terrains.map(t => t.id) }) };
}

export function emptyArchive(sessionId: string, build = import.meta.env.VITE_BUILD_ID ?? "development"): ShotArchive {
  return { format: "tankwars-shot-archive", schemaVersion: 1, gameVersion: version, build, rules: RULES_ID,
    sessionId, firstSequence: 0, lastSequence: 0, evicted: 0, complete: false, error: null, records: [], terrains: [] };
}

export class ShotRecorder {
  private archive: ShotArchive;
  private terrains = new Map<string, TerrainRecord>();
  private decision = 0;
  private decisionId: string | null = null;
  private shotKey: string | null = null;
  private round = 0;
  private turn = 0;
  private blockId: string | null = null;
  private started = performance.now();
  private bytes = 0;
  private retaining = true;
  private groups: Array<{ key: string | null; records: ArchiveRecord[]; bytes: number }> = [];
  private readonly persist?: (write: ArchiveWrite) => void;
  private readonly maxShots: number;
  private readonly maxBytes: number;
  constructor(sessionId: string, persist?: (write: ArchiveWrite) => void, maxShots = 128, maxBytes = 32 * MIB) {
    this.archive = emptyArchive(sessionId); this.persist = persist;
    this.maxShots = maxShots; this.maxBytes = maxBytes;
  }
  context(blockId: string | null, round?: number, turn?: number): void {
    if (blockId !== this.blockId) { this.shotKey = null; this.decisionId = null; }
    this.blockId = blockId;
    if (round !== undefined) this.round = round;
    if (turn !== undefined) this.turn = turn;
  }
  record(input: DiagnosticInput, initialTerrain?: TerrainRecord): void {
    if (this.archive.lastSequence === 0 && !(input.kind === "boundary" && input.status === "archive-manifest")) this.record({ kind: "boundary", status: "archive-manifest",
      detail: { ...this.archive, records: undefined, terrains: undefined } });
    if (input.kind === "combat" && input.event.kind === "recovery" && input.event.reason === "decision-timeout") {
      this.record({ kind: "boundary", status: "decision-cancelled", detail: { reason: "decision-timeout", replacedDecisionId: this.decisionId } });
      this.decisionId = `${this.archive.sessionId}:fallback:${++this.decision}`;
    }
    const start = performance.now();
    const copy = structuredClone(input);
    const dependencies: TerrainRecord[] = [];
    if (initialTerrain) {
      const terrain = structuredClone(initialTerrain);
      this.terrains.set(terrain.id, terrain); dependencies.push(terrain);
    }
    let stored: ArchiveInput;
    if ("snapshot" in copy) {
      const { heights, materials, ...snapshot } = copy.snapshot;
      const content = { width: snapshot.width, height: snapshot.height, heights, materials };
      const id = fingerprint(content);
      const previous = this.terrains.get(id);
      if (previous && canonical({ ...previous, id: undefined }) !== canonical(content)) throw new Error("TERRAIN_HASH_COLLISION");
      if (!previous) { const terrain = { id, ...content }; this.terrains.set(id, terrain); dependencies.push(terrain); }
      stored = { ...copy, snapshot: { ...snapshot, terrainId: id } };
      this.round = snapshot.state.roundNumber ?? 1; this.turn = snapshot.state.turn;
    } else stored = copy;
    if (copy.kind === "combat") {
      if (copy.event.kind === "turn") { this.turn = copy.event.turn; this.round = copy.event.roundNumber ?? this.round; this.decisionId = null; this.shotKey = null; }
      if (copy.event.kind === "decision-start") this.decisionId = `${this.archive.sessionId}:decision:${++this.decision}`;
      if (copy.event.kind === "shot") this.shotKey = `${this.blockId ?? this.archive.sessionId}:${this.round}:${copy.event.shotId}`;
    }
    if (copy.kind === "pre-shot") this.shotKey = `${this.blockId ?? this.archive.sessionId}:${this.round}:${copy.shot.shotId}`;
    const record: ArchiveRecord = { integrity: "", sequence: ++this.archive.lastSequence, atMs: start - this.started,
      blockId: this.blockId, round: this.round, turn: this.turn, decisionId: this.decisionId, shotKey: this.shotKey, input: stored };
    record.integrity = fingerprint({ ...record, integrity: undefined });
    this.persist?.({ record, terrains: dependencies });
    const newTurn = copy.kind === "combat" && copy.event.kind === "turn";
    if (newTurn) this.retaining = true;
    this.bytes += dependencies.reduce((sum, terrain) => sum + byteSize(terrain), 0);
    // Endurance persists every record; only the bounded recent view stays in RAM.
    let group = this.groups.at(-1);
    if (this.retaining && (!group || newTurn)) {
      group = { key: this.shotKey, records: [], bytes: 0 }; this.groups.push(group);
    }
    if (group && this.retaining) {
      if (copy.kind === "pre-shot") group.key = this.shotKey;
      const size = byteSize(record);
      group.records.push(record); group.bytes += size; this.bytes += size;
    } else this.archive.evicted++;
    this.pruneTerrains();
    while (this.groups.length && (this.groups.length > this.maxShots || this.bytes > this.maxBytes)) {
      const removed = this.groups.shift()!; this.bytes -= removed.bytes; this.archive.evicted += removed.records.length;
      if (removed === group) this.retaining = false;
      this.pruneTerrains();
    }
    const elapsed = performance.now() - start;
    this.captureMs += elapsed; this.maxCaptureMs = Math.max(this.maxCaptureMs, elapsed); this.captures++;
  }
  private pruneTerrains(): void {
    const referenced = new Set(this.groups.flatMap(g => g.records.flatMap(recordTerrainIds)));
    for (const [id, terrain] of this.terrains) if (!referenced.has(id)) { this.bytes -= byteSize(terrain); this.terrains.delete(id); }
  }
  captures = 0;
  captureMs = 0;
  maxCaptureMs = 0;
  export(filter?: { shotKey?: string; from?: number; to?: number; incidents?: boolean }): ShotArchive {
    let records = this.groups.flatMap(g => g.records);
    if (filter?.shotKey) {
      const selected = records.find(r => r.shotKey === filter.shotKey);
      records = records.filter(r => r.shotKey === filter.shotKey || (selected?.decisionId && r.decisionId === selected.decisionId));
    }
    if (filter?.from !== undefined) records = records.filter(r => r.sequence >= filter.from!);
    if (filter?.to !== undefined) records = records.filter(r => r.sequence <= filter.to!);
    const ids = new Set(records.flatMap(recordTerrainIds));
    return structuredClone(sealArchive({ ...this.archive, records, firstSequence: records[0]?.sequence ?? 0,
      terrains: [...this.terrains.values()].filter(t => ids.has(t.id)) }));
  }
  finish(error: string | null = null): void { this.archive.complete = error === null; this.archive.error = error; }
  get stats() { return { bytes: this.bytes, captures: this.captures, captureMs: this.captureMs,
    maxCaptureMs: this.maxCaptureMs, evicted: this.archive.evicted, sequence: this.archive.lastSequence }; }
}

/** Initial terrain is a dependency too, even before any shot snapshot exists. */
export function recordTerrainIds(record: ArchiveRecord): string[] {
  const input = record.input;
  if ("snapshot" in input) return [input.snapshot.terrainId];
  if (input.kind === "boundary" && input.status === "initial-scenario" && typeof input.detail === "object" && input.detail !== null &&
    "terrainId" in input.detail && typeof input.detail.terrainId === "string") return [input.detail.terrainId];
  return [];
}
