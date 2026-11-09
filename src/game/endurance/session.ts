import { scenarioProvenance } from "./scenario";
import { version } from "../../../package.json";
import { ShotRecorder, ACTION_RESERVE, CLOSURE_RESERVE, MIB, QUEUE_BYTES, byteSize, emptyArchive } from "../diagnostics/archive";
import { exportStoredArchive, filterArchive, type ArchiveFilter } from "../diagnostics/export";
import type { DiagnosticInput, ShotArchive } from "../diagnostics/types";
import { randomUUID } from "../../utils/randomUUID";
import { assertRoster, validateConfig } from "./config";
import { addMetrics, groups, RoundCollector } from "./metrics";
import type { Checkpoint, EnduranceStorage } from "./storage";
import type { BlockRecord, CombatObserver, EnduranceConfig, EnduranceEvent, EnduranceExport, Incident, RecentEvent, RoundRecord, SessionRecord } from "./types";
import type { Player } from "../../types/player";
import { WEAPON_REGISTRY } from "../../types/weapon";
import { EnduranceJournal, type JournalEvent, type JournalEntry, type JournalStatus } from "./journal";
import type { PurchaseObservation } from "../observation";
import { exportJournalJsonl, formatJournalTextPage, validateJournalPageRequest, type JournalTextPage } from "./journalJsonl";
import { storedBundleSource, type BundleSource } from "./bundle/build";

export interface EnduranceHost {
  captureCurrent?(): void;
  stop(): void;
  context(): { players: Player[]; heights: readonly number[]; materials: readonly string[]; phase: string; windForce?: number };
}
export interface EnduranceClock { now(): number; date(): string; id(): string; seed(): number }
const clock: EnduranceClock = { now: () => performance.now(), date: () => new Date().toISOString(),
  id: randomUUID, seed: () => crypto.getRandomValues(new Uint32Array(1))[0] };

export class EnduranceSession implements CombatObserver {
  readonly recorder: ShotRecorder;
  private archiveBytes = 0;
  private actionBytes = 0;
  private reserved = false;
  private resolutionReported = false;
  private diagnosticFailed = false;
  private archiveLimit = 512 * MIB;
  private actionReserve = ACTION_RESERVE;
  private maxActionBytes = 0;
  private exportMs = 0;
  private stoppedAtDurationMs: number | null = null;
  get archiveMetrics() { return { limit: this.archiveLimit, reserve: this.actionReserve, maxActionBytes: this.maxActionBytes,
    pendingBytes: this.journal?.pendingBytes ?? 0, ...this.recorder.stats, totalBytes: this.archiveBytes, exportMs: this.exportMs,
    confirmedSequence: this.journal?.status.persisted ?? 0, emittedSequence: this.journal?.status.emitted ?? 0,
    durationMs: this.running ? this.time.now() - this.started : this.session.durationMs,
    stoppedAtDurationMs: this.stoppedAtDurationMs, status: this.session.status, reason: this.session.reason }; }
  diagnostic(input: DiagnosticInput): void {
    if (this.diagnosticFailed) return;
    this.recorder.context(this.block?.id ?? null, this.roundNumber, this.turn);
    try {
      this.recorder.record(input);
      if (input.kind === "settled") this.closeReservation();
    }
    catch (error) { this.diagnosticFailed = true; queueMicrotask(() => this.storageFailed(error)); }
  }
  async exportArchive(filter?: ArchiveFilter) {
    const started = performance.now();
    await this.journal?.flush();
    let archive: ShotArchive;
    try { archive = await exportStoredArchive(this.storage, this.session.id, this.session.build, filter); }
    catch (error) {
      if (!this.journal?.status.error) throw error;
      archive = emptyArchive(this.session.id, this.session.build);
      archive.error = `CONFIRMED_ARCHIVE_UNAVAILABLE: ${String(error)}`;
    }
    if (this.journal?.status.error) {
      const pending = this.journal.pending().flatMap(row => row.event.kind === "archive" ? [row.event.write] : []);
      const seen = new Set(archive.records.map(r => r.sequence));
      for (const write of pending) {
        if (!seen.has(write.record.sequence)) archive.records.push(write.record);
        for (const terrain of write.terrains) if (!archive.terrains.some(t => t.id === terrain.id)) archive.terrains.push(terrain);
      }
      archive.records.sort((a, b) => a.sequence - b.sequence);
      archive.lastSequence = archive.records.at(-1)?.sequence ?? 0;
      archive.firstSequence = archive.records[0]?.sequence ?? 0;
      archive.complete = false; archive.error = [archive.error, this.journal.status.error].filter(Boolean).join("; ");
    }
    const result = filterArchive(archive, filter); this.exportMs = performance.now() - started; this.changed(); return result;
  }
  async listShots(query: string, page: number) {
    if (!this.storage.listShots) throw new Error("ARCHIVE_CAPABILITY_UNAVAILABLE");
    await this.journal?.flush();
    const status = await this.storage.journalStatus?.(this.session.id);
    const shots = await this.storage.listShots(this.session.id, status?.persisted ?? 0, query, page);
    return { ...shots, incomplete: !status?.complete };
  }
  private admitArchive(): boolean {
    if (this.resolutionReported) this.closeReservation();
    if (this.reserved) return true;
    if (this.archiveBytes + this.actionReserve + CLOSURE_RESERVE > this.archiveLimit) {
      void this.stop("archive-budget"); return false;
    }
    if ((this.journal?.pendingBytes ?? 0) + this.actionReserve + CLOSURE_RESERVE > QUEUE_BYTES || (this.journal?.pendingCount ?? 0) > 1024) {
      this.journal?.invalidate(new Error("ARCHIVE_ADMISSION_BACKPRESSURE")); return false;
    }
    this.reserved = true; this.actionBytes = 0; return true;
  }
  private closeReservation(): void {
    this.actionReserve = Math.max(ACTION_RESERVE, this.maxActionBytes * 2 + CLOSURE_RESERVE);
    this.reserved = false; this.resolutionReported = false;
  }
  captureCurrent(): void { this.host?.captureCurrent?.(); }
  markDiagnostic(): void { this.captureCurrent(); this.incident("warning", "MANUAL_DIAGNOSTIC"); }
  readonly session: SessionRecord;
  block: BlockRecord | null = null;
  ready = false;
  private working = false;
  private finalizing = false;
  get busy(): boolean { return this.working || this.finalizing; }
  phase = "PREPARATION";
  latestIncident: Incident | null = null;
  private host: EnduranceHost | null = null;
  private active = false;
  private started: number;
  private blockStarted = 0;
  private roundStarted = 0;
  private actionStarted: number | null = null;
  private transitionStarted = 0;
  private checkpointAt = 0;
  private turn = 0;
  private roundNumber = 0;
  private roundPreparationPending = false;
  private roundDate = "";
  private collector: RoundCollector | null = null;
  private recent: RecentEvent[] = [];
  private recentBytes = 0;
  private sequence = 0;
  private revision = 0;
  private listeners = new Set<() => void>();
  private writes: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
  private fallback: Checkpoint[] = [];
  private stopped = false;
  private storageUnavailable = false;
  private finishing: Promise<void> | null = null;
  private journal: EnduranceJournal | null = null;
  private decisionCounter = 0;
  private decisionId: string | null = null;
  private decisionState: "computing" | "ready" | "launched" | null = null;
  private visitCounter = 0;

  private readonly storage: EnduranceStorage;
  private readonly time: EnduranceClock;
  constructor(config: EnduranceConfig, storage: EnduranceStorage, time = clock, build = import.meta.env.VITE_BUILD_ID ?? "development") {
    this.storage = storage; this.time = time;
    this.archiveLimit = (config.archiveBudgetMiB ?? 512) * MIB;
    this.started = time.now();
    const validated = validateConfig(config);
    this.session = { terrain: scenarioProvenance(validated.scenario), runtime: { width: 800, height: 480, gravity: 260, baseShotSpeed: 420, localMatch: true, weapons: structuredClone(WEAPON_REGISTRY) },
      schemaVersion: 1, id: time.id(), gameVersion: version, build, config: validated,
      startedAt: time.date(), durationMs: 0, status: "running", reason: null, attempted: 0, completed: 0,
      abandoned: 0, interrupted: 0, suspect: 0, roundsStarted: 0, roundsCompleted: 0, incidents: 0,
      collection: "incomplete", storageError: null, completedMetrics: groups(), partialMetrics: groups(),
      retention: { recentEvents: 256, checkpointMs: 15000, fullEventHistory: false } };
    this.recorder = new ShotRecorder(this.session.id, write => this.recordJournal({ kind: "archive", write }));
    if (storage.appendJournal && storage.readJournal) this.journal = new EnduranceJournal(this.session.id,
      (entries, status) => {
        const operation = this.writes.then(async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([storage.appendJournal!(entries, status), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("JOURNAL_TIMEOUT")), 10000);
          })]); } finally { if (timer !== undefined) clearTimeout(timer); }
        });
        // The journal reports failures and stops the session; keep the shared lane usable for its final checkpoint.
        this.writes = operation.catch(() => {});
        return operation;
      }, error => {
        console.error("[Endurance] Journal failed", error);
        this.session.storageError = `Journal: ${String(error)}`; this.session.collection = "incomplete";
        void this.stop("journal-failure"); this.changed();
      });
  }
  get journalStatus(): JournalStatus | null { return this.journal ? { ...this.journal.status } : null; }
  private recordJournal(event: JournalEvent, snapshot = false): void {
    if (!this.journal) return;
    if (event.kind !== "archive" && event.kind !== "combat") this.diagnostic({ kind: "boundary", status: event.kind,
      detail: event.kind === "incident" ? { id: event.incident.id, kind: event.incident.kind, reason: event.incident.reason,
        lastCaptureSequence: this.recorder.stats.sequence } : event });
    let context: ReturnType<EnduranceHost["context"]> | null = null, contextError: string | null = null;
    try { context = snapshot ? this.host?.context() ?? null : null; } catch (error) { contextError = String(error); }
    const entry = { at: this.time.date(), atMs: this.time.now() - this.started,
      blockId: this.block?.id ?? null, blockIndex: this.block?.index ?? 0, seed: this.block?.seed ?? null,
      round: this.roundNumber, turn: this.turn, phase: this.phase, decisionId: this.decisionId, event,
      context: context ? { players: context.players, windForce: context.windForce ?? null } : null, contextError };
    // Conservative serialized budget includes capture duplication in the journal index and key overhead.
    const size = byteSize(entry) * (event.kind === "archive" ? 2 : 1) + 2048;
    this.archiveBytes += size;
    if (this.reserved) {
      this.actionBytes += size;
      this.maxActionBytes = Math.max(this.maxActionBytes, this.actionBytes);
      if (this.actionBytes > this.actionReserve) {
        this.journal.invalidate(new Error("ARCHIVE_ACTION_RESERVATION_EXCEEDED"));
        return;
      }
    }
    this.journal.append(entry);
  }
  async journalPage(after = 0, limit = 256): Promise<{ status: JournalStatus | null; entries: JournalEntry[] }> {
    await this.journal?.flush();
    return { status: this.journalStatus, entries: await this.storage.readJournal?.(this.session.id, after, limit) ?? [] };
  }
  async readJournalText(after = 0, limit = 256): Promise<JournalTextPage> {
    const validated = validateJournalPageRequest(after, limit);
    await this.journal?.flush();
    const status = this.journalStatus;
    if (!status) return { status: null, firstSequence: null, lastSequence: null, count: 0, bytes: 0, text: "" };
    if (validated.after >= status.persisted) {
      return { status, firstSequence: null, lastSequence: null, count: 0, bytes: 0, text: "" };
    }
    const entries = await this.storage.readJournal?.(this.session.id, validated.after, validated.limit) ?? [];
    return formatJournalTextPage(entries, this.session.id, validated.after, validated.limit, status);
  }
  async journalJSONL(): Promise<string> {
    await this.journal?.flush();
    const status = this.journalStatus;
    if (!status) throw new Error("JOURNAL_UNAVAILABLE");
    return exportJournalJsonl({
      status,
      readPage: (after, limit) => this.storage.readJournal?.(this.session.id, after, limit) ?? Promise.resolve([]),
      pending: () => this.journal?.pending() ?? [],
    });
  }
  async bundleSource(): Promise<BundleSource> {
    await this.writes; await this.journal?.flush();
    const status = this.journalStatus;
    if (!status) throw new Error("JOURNAL_UNAVAILABLE");
    const source = storedBundleSource(this.storage, this.session, status);
    const mutable = { blocks: this.block ? structuredClone(this.block) : null,
      rounds: this.collector && this.block ? structuredClone(this.roundRecord(false, [])) : null };
    if (this.collector && mutable.blocks) addMetrics(mutable.blocks.partialMetrics, this.collector.data);
    const readCollection = source.collection;
    source.collection = async (name, after) => {
      const frozen = name === "incidents" ? null : mutable[name];
      const marker = "__bundle_frozen_current__";
      if (after === undefined && frozen) return [{ key: marker, value: frozen, capturedAtSequence: status.persisted }];
      let cursor = after === marker ? undefined : after;
      for (;;) {
        const rows = await readCollection(name, cursor);
        if (!rows.length) return [];
        const filtered = rows.filter(row => {
          if (row.capturedAtSequence !== undefined && row.capturedAtSequence !== null && row.capturedAtSequence > status.persisted) return false;
          if (!frozen || typeof row.value !== "object" || row.value === null) return true;
          const value = row.value as Record<string, unknown>;
          return name === "blocks" ? value.id !== mutable.blocks?.id : value.id !== mutable.rounds?.id;
        });
        if (filtered.length) {
          // Always advance past the physical page, including any filtered tail.
          filtered[filtered.length - 1] = { ...filtered[filtered.length - 1], key: rows[rows.length - 1].key };
          return filtered;
        }
        cursor = rows[rows.length - 1].key;
      }
    };
    if (status.error) source.pending = structuredClone(this.journal?.pending() ?? []);
    return source;
  }
  beginShopVisit(player: Player): string | null {
    if (!this.active || this.stopped) return null;
    const visitId = `${this.session.id}:shop:${++this.visitCounter}`;
    this.recordJournal({ kind: "shop-start", visitId, player }); return visitId;
  }
  endShopVisit(visitId: string, player: Player, purchases: readonly PurchaseObservation[]): void {
    if (!this.active || this.stopped) return;
    for (const purchase of purchases) this.recordJournal({ kind: "purchase", visitId, purchase });
    this.recordJournal({ kind: "shop-end", visitId, player }); void this.journal?.flush();
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = (): number => this.revision;
  private changed(): void { this.revision++; for (const listener of this.listeners) listener(); }
  get running(): boolean { return !this.stopped; }
  private limitReached(): boolean {
    const c = this.session.config;
    return (c.maxDurationMs !== null && this.time.now() - this.started >= c.maxDurationMs);
  }
  async start(): Promise<void> {
    if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        if (estimate.quota !== undefined && estimate.usage !== undefined) {
          this.archiveLimit = Math.min(this.archiveLimit, Math.max(0, Math.floor((estimate.quota - estimate.usage) * 0.8)));
        }
      } catch (error) { console.warn("[Endurance] Storage estimate unavailable", error); }
    }
    const scenario = this.session.config.scenario;
    if (scenario) this.recorder.record({ kind: "boundary", status: "initial-scenario", detail: scenarioProvenance(scenario) },
      { id: scenario.terrainId, width: 800, height: 480, heights: [...scenario.heights], materials: [...scenario.materials] });
    this.recordJournal({ kind: "session-start", metadata: { gameVersion: this.session.gameVersion, build: this.session.build,
      config: this.session.config, coordinates: "pixels; x right, y down; angle degrees: 0 right, 90 up, 180 left",
      unavailable: "null; nominal aim, target or reasoning are never reconstructed", runtime: this.session.runtime } });
    await this.save();
    if (!this.stopped) await this.nextBlock();
  }
  private async nextBlock(): Promise<void> {
    if (this.stopped) return;
    if (this.limitReached() || (this.session.config.maxBlocks !== null && this.session.attempted >= this.session.config.maxBlocks)) {
      await this.stop(this.limitReached() ? "duration" : "block-limit"); return;
    }
    this.blockStarted = this.time.now();
    this.transitionStarted = this.blockStarted;
    this.phase = "PREPARATION"; this.roundNumber = 0; this.turn = 0; this.sequence = 0; this.recent = []; this.recentBytes = 0;
    this.decisionId = null; this.decisionState = null;
    this.block = { id: this.time.id(), sessionId: this.session.id, index: ++this.session.attempted, seed: this.time.seed(),
      config: structuredClone(this.session.config), gameVersion: this.session.gameVersion, build: this.session.build,
      schemaVersion: 1, physics: "local", startedAt: this.time.date(), durationMs: 0, status: "running", reason: null,
      suspect: false, roundsStarted: 0, roundsCompleted: 0, completedMetrics: groups(), partialMetrics: groups() };
    this.recordJournal({ kind: "block-start", reason: null, players: this.block.config.players });
    this.working = true; this.changed();
    await this.save();
    if (this.stopped) return;
    this.working = false; this.ready = true; this.active = true; this.changed();
  }
  attach(host: EnduranceHost): void {
    if (!this.active || this.host) throw new Error("INVALID_ENDURANCE_ATTACH");
    this.host = host;
    this.beginRound(1);
  }
  detach(host: EnduranceHost): void { if (this.host === host) this.host = null; }
  beginRound(number: number): boolean {
    if (!this.active || this.stopped || !this.block || this.limitReached()) { if (this.limitReached()) void this.stop("duration"); return false; }
    if (this.collector && this.roundNumber === number) return true;
    this.roundNumber = number; this.turn = 0; this.roundStarted = this.time.now(); this.roundDate = this.time.date();
    this.actionStarted = null; this.phase = "COMBAT";
    this.collector = new RoundCollector(this.session.config.players);
    this.roundPreparationPending = true;
    this.decisionId = null; this.decisionState = null;
    if (!this.session.config.scenario) this.confirmRoundPreparation();
    return true;
  }
  confirmRoundPreparation(): void {
    if (!this.roundPreparationPending || !this.block) return;
    this.roundPreparationPending = false;
    this.block.roundsStarted++; this.session.roundsStarted++;
    this.recordJournal({ kind: "round-start", reason: null, players: [] }, true);
  }
  cancelRoundPreparation(): void {
    if (!this.roundPreparationPending) return;
    this.roundPreparationPending = false;
    this.collector = null;
  }
  setPhase(phase: string): void {
    if (!this.active || this.phase === phase) return;
    this.phase = phase; this.transitionStarted = this.time.now(); this.changed();
    this.recordJournal({ kind: "phase", reason: phase, players: [] }, true); void this.journal?.flush();
  }
  private validate(): void {
    if (!this.host) return;
    const c = this.host.context();
    assertRoster(c.players);
    if (c.players.some(p => !p.tank.isDead && (p.tank.position.x < 0 || p.tank.position.x > 800 || p.tank.position.y < 0 || p.tank.position.y > 480))) throw new Error("INVALID_LIVING_POSITION");
    if (c.heights.length !== 800 || c.materials.length !== c.heights.length ||
      c.heights.some(h => !Number.isFinite(h) || h < 0 || h > 480) ||
      c.materials.some(m => !["DIRT", "SOFT", "ROCK"].includes(m))) throw new Error("INVALID_TERRAIN");
  }
  emit(event: EnduranceEvent): boolean {
    if (!this.active || this.stopped) return false;
    if ((event.kind === "decision-start" || event.kind === "shot") && !this.admitArchive()) return false;
    if (this.limitReached()) { void this.stop("duration"); return false; }
    if (event.kind === "turn" && this.reserved) this.closeReservation();
    try {
      if (event.kind === "turn" || event.kind === "decision-start") {
        if (this.decisionId && (this.decisionState === "computing" || this.decisionState === "ready")) {
          this.recordJournal({ kind: "decision-cancelled", reason: "superseded" });
        }
        this.decisionId = null; this.decisionState = null;
      }
      if (event.kind === "decision-start") { this.decisionId = `${this.session.id}:decision:${++this.decisionCounter}`; this.decisionState = "computing"; }
      if (event.kind === "decision") this.decisionState = "ready";
      if (event.kind === "shot-launched") this.decisionState = "launched";
      if (event.kind === "turn") {
        this.confirmRoundPreparation();
        if (event.turn > this.session.config.limits.turns) {
          this.incident("limit", "turns", event.turn); return false;
        }
        const player = this.host?.context().players.find(p => p.id === event.playerId);
        if (player?.tank.isDead || !player) throw new Error("DEAD_OR_UNKNOWN_ACTOR");
        if (event.turn <= this.turn) throw new Error("DUPLICATE_OR_STALE_TURN");
        this.validate(); this.turn = event.turn; this.actionStarted = this.time.now();
      }
      if (event.kind === "shot") {
        const player = this.host?.context().players.find(p => p.id === event.playerId);
        if (!player || player.tank.isDead) throw new Error("DEAD_OR_UNKNOWN_SHOOTER");
        if (![event.command.angle, event.command.power].every(Number.isFinite)) throw new Error("INVALID_COMMAND");
      }
      if (event.kind === "target") {
        const players = this.host?.context().players ?? [];
        if (event.targetId === event.playerId || !players.some(p => p.id === event.targetId && !p.tank.isDead)) throw new Error("INVALID_EXPLICIT_TARGET");
      }
      this.collector?.observe(event);
      this.diagnostic({ kind: "combat", event });
      this.recordJournal({ kind: "combat", event }, ["decision-start", "shot-launched", "shot-result", "zeus"].includes(event.kind));
      const recent = { sequence: ++this.sequence, atMs: this.time.now() - this.blockStarted, round: this.roundNumber, event: structuredClone(event) };
      this.recent.push(recent); this.recentBytes += byteSize(recent);
      while (this.recent.length > 256 || this.recentBytes > 512 * 1024) this.recentBytes -= byteSize(this.recent.shift()!);
      if (event.kind === "recovery") this.incident("warning", `SAFETY_${event.reason}`);
      if (event.kind === "failure") { this.incident("exception", event.reason, 0, event.error); return false; }
      // Keep the action deadline until the next turn or inter-round transition: a resolved
      // projectile/Zeus result alone does not prove that turn finalization advanced.
      if (event.kind === "resolved" || event.kind === "zeus") this.validate();
      if (event.kind === "shot-result") {
        this.resolutionReported = true;
      }
      return true;
    } catch (error) { this.incident("invariant", error instanceof Error ? error.message : String(error)); return false; }
  }
  completeRound(survivors: string[]): void {
    if (!this.active || !this.collector || !this.block) return;
    try {
      this.validate();
      const actual = this.host?.context().players.filter(p => !p.tank.isDead && p.tank.health > 0).map(p => p.id) ?? [];
      if (survivors.length > 1 || JSON.stringify([...survivors].sort()) !== JSON.stringify([...actual].sort())) throw new Error("INVALID_ROUND_RESULT");
      this.collector.finish(survivors);
      const round = this.roundRecord(true, survivors);
      addMetrics(this.block.completedMetrics, this.collector.data); addMetrics(this.session.completedMetrics, this.collector.data);
      this.block.roundsCompleted++; this.session.roundsCompleted++;
      this.recordJournal({ kind: "round-end", reason: survivors.length === 0 ? "draw" : "winner", players: [] }, true);
      this.collector = null; this.actionStarted = null; this.setPhase("CELEBRATION");
      void this.save(round);
    } catch (error) { this.incident("invariant", String(error)); }
  }
  private roundRecord(completed: boolean, survivors: string[]): RoundRecord & { blockId: string; sessionId: string; id: string } {
    return { id: `${this.block!.id}/${this.roundNumber}`, blockId: this.block!.id, sessionId: this.session.id,
      number: this.roundNumber, startedAt: this.roundDate, durationMs: this.time.now() - this.roundStarted,
      turns: this.turn, completed, survivors, winnerId: completed && survivors.length === 1 ? survivors[0] : null,
      draw: completed && survivors.length === 0, metrics: structuredClone(this.collector?.data ?? groups()) };
  }
  finishPresentation(): void {
    if (this.block && this.block.roundsCompleted >= this.session.config.roundsPerBlock) void this.finishBlock("completed", "completed");
  }
  tick(): void {
    if (this.stopped) return;
    this.session.durationMs = this.time.now() - this.started;
    if (this.limitReached()) { void this.stop("duration"); return; }
    if (this.active && this.block) {
      this.block.durationMs = this.time.now() - this.blockStarted;
      const limits = this.session.config.limits;
      if (this.phase === "COMBAT") {
        if (this.time.now() - this.roundStarted >= limits.roundMs) this.incident("limit", "roundMs", this.time.now() - this.roundStarted);
        else if (this.actionStarted !== null && this.time.now() - this.actionStarted >= limits.actionMs) this.incident("limit", "actionMs", this.time.now() - this.actionStarted);
      } else if (this.time.now() - this.transitionStarted >= limits.transitionMs) this.incident("limit", "transitionMs", this.time.now() - this.transitionStarted);
    }
    if (this.active && this.time.now() - this.checkpointAt >= 15000 && this.pendingWrites === 0) void this.save(this.collector ? this.roundRecord(false, []) : undefined);
    this.changed();
  }
  incident(kind: Incident["kind"], reason: string, observedMs = 0, error?: string): void {
    if (!this.active || !this.block || this.stopped) return;
    let context: unknown;
    try { context = { game: this.host?.context() ?? null, error: error ?? null }; }
    catch (contextError) { context = { game: null, error: error ?? null, contextError: String(contextError) }; }
    const incident: Incident = { id: this.time.id(), sessionId: this.session.id, blockId: this.block.id, seed: this.block.seed,
      round: this.roundNumber, turn: this.turn, kind, reason, at: this.time.date(), phase: this.phase, observedMs,
      lastProgress: this.recent.at(-1) ?? null, recent: structuredClone(this.recent), context };
    this.latestIncident = structuredClone(incident); this.session.incidents++;
    this.recordJournal({ kind: "incident", incident });
    if (!this.block.suspect) { this.block.suspect = true; this.session.suspect++; }
    if (kind === "warning") { void this.save(undefined, incident); this.changed(); return; }
    void this.finishBlock(kind === "external" ? "interrupted" : "abandoned", reason, incident);
  }
  private save(round?: Checkpoint["round"], incident?: Incident): Promise<void> {
    void this.journal?.flush();
    this.session.durationMs = this.time.now() - this.started;
    this.checkpointAt = this.time.now();
    const checkpoint = structuredClone({ session: this.session, block: this.block, round, incident, journalSequence: this.journalStatus?.emitted });
    if (this.collector) {
      addMetrics(checkpoint.session.partialMetrics, this.collector.data);
      if (checkpoint.block) addMetrics(checkpoint.block.partialMetrics, this.collector.data);
    }
    this.pendingWrites++;
    this.writes = this.writes.then(async () => {
      try {
        if (this.storageUnavailable) { this.retainFallback(checkpoint); return; }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([this.storage.save(checkpoint), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("STORAGE_TIMEOUT")), 10000);
          })]);
        } finally { if (timer !== undefined) clearTimeout(timer); }
      }
      catch (error) { this.retainFallback(checkpoint); this.storageFailed(error); }
      finally { this.pendingWrites--; }
    });
    return this.writes;
  }
  private retainFallback(checkpoint: Checkpoint): void {
    this.fallback.push(checkpoint); if (this.fallback.length > 8) this.fallback.shift();
  }
  private halt(): void {
    if (this.decisionId && (this.decisionState === "computing" || this.decisionState === "ready")) {
      this.recordJournal({ kind: "decision-cancelled", reason: "execution-stopped" }); this.decisionState = null;
    }
    this.active = false; this.ready = false;
    try { this.host?.stop(); } finally { this.host = null; }
  }
  private storageFailed(error: unknown): void {
    this.storageUnavailable = true;
    console.error("[Endurance] Storage failed", error);
    this.session.storageError = error instanceof Error ? error.message : String(error);
    this.session.collection = "incomplete";
    this.journal?.invalidate(error);
    void this.stop("storage-failure"); this.changed();
  }
  private finishBlock(status: BlockRecord["status"], reason: string, incident?: Incident): Promise<void> {
    if (this.finishing) return this.finishing;
    if (!this.block || this.block.status !== "running") return Promise.resolve();
    this.recordJournal({ kind: "block-end", reason, players: [] }, true);
    let cleanupFailed = false;
    try { this.halt(); } catch (error) { cleanupFailed = true; this.session.storageError = `Cleanup: ${String(error)}`; }
    this.working = true;
    const round = this.collector ? this.roundRecord(false, []) : undefined;
    if (this.collector) {
      this.collector.finish(null);
      if (round) round.metrics = structuredClone(this.collector.data);
      addMetrics(this.block.partialMetrics, this.collector.data); addMetrics(this.session.partialMetrics, this.collector.data);
      this.collector = null;
    }
    this.block.status = status; this.block.reason = reason; this.block.durationMs = this.time.now() - this.blockStarted;
    if (status === "completed") this.session.completed++;
    if (status === "abandoned") this.session.abandoned++;
    if (status === "interrupted") this.session.interrupted++;
    this.changed();
    this.finishing = this.save(round, incident).then(async () => {
      await this.journal?.flush();
      this.finishing = null; this.working = false;
      if (cleanupFailed || this.session.storageError) { await this.stop(cleanupFailed ? "cleanup-failure" : "storage-failure"); return; }
      if (!this.stopped && status === "abandoned" && this.session.config.stopOnIncident) { await this.stop("incident"); return; }
      if (!this.stopped) await this.nextBlock();
      this.changed();
    });
    return this.finishing;
  }
  async stop(reason = "manual"): Promise<void> {
    if (this.stopped) return;
    this.stoppedAtDurationMs = this.time.now() - this.started;
    this.finalizing = true;
    this.stopped = true;
    this.session.status = "stopped"; this.session.reason = reason;
    if (this.block?.status === "running") await this.finishBlock("interrupted", reason);
    else { try { this.halt(); } catch (error) { this.session.storageError = `Cleanup: ${String(error)}`; } }
    this.session.collection = this.session.storageError ? "incomplete" : "complete";
    this.recorder.finish(this.session.storageError);
    this.recordJournal({ kind: "session-stop", reason, players: [] });
    await this.journal?.finish();
    await this.save(); this.finalizing = false; this.changed();
  }
  async export(): Promise<EnduranceExport> {
    await this.writes;
    let data: EnduranceExport;
    try { data = await this.storage.exportSession(this.session); }
    catch (error) {
      this.storageFailed(error);
      data = { schemaVersion: 1, session: structuredClone(this.session), blocks: [], rounds: [], incidents: [],
        diagnostics: { evaluatedCommand: "unavailable", perturbations: "unavailable", deterministicReplay: false, combatResume: false } };
    }
    const blocks = new Map(data.blocks.map(b => [b.id, b]));
    const rounds = new Map(data.rounds.map(r => [`${r.blockId}/${r.number}`, r]));
    const incidents = new Map(data.incidents.map(i => [i.id, i]));
    for (const checkpoint of this.fallback) {
      if (checkpoint.block) blocks.set(checkpoint.block.id, checkpoint.block);
      if (checkpoint.round) rounds.set(`${checkpoint.round.blockId}/${checkpoint.round.number}`, checkpoint.round);
      if (checkpoint.incident) incidents.set(checkpoint.incident.id, checkpoint.incident);
    }
    const session = structuredClone(this.session);
    if (this.collector) addMetrics(session.partialMetrics, this.collector.data);
    if (this.block) {
      const block = structuredClone(this.block);
      if (this.collector) addMetrics(block.partialMetrics, this.collector.data);
      blocks.set(block.id, block);
    }
    if (this.collector && this.block) rounds.set(`${this.block.id}/${this.roundNumber}`, this.roundRecord(false, []));
    if (this.latestIncident) incidents.set(this.latestIncident.id, structuredClone(this.latestIncident));
    return { ...data, session, blocks: [...blocks.values()], rounds: [...rounds.values()], incidents: [...incidents.values()] };
  }
  close(): void { if (!this.running && !this.busy) this.storage.close(); }
}
