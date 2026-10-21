import { version } from "../../../package.json";
import { randomUUID } from "../../utils/randomUUID";
import { assertRoster, validateConfig } from "./config";
import { addMetrics, groups, RoundCollector } from "./metrics";
import type { Checkpoint, EnduranceStorage } from "./storage";
import type { BlockRecord, CombatObserver, EnduranceConfig, EnduranceEvent, EnduranceExport, Incident, RecentEvent, RoundRecord, SessionRecord } from "./types";
import type { Player } from "../../types/player";
import { WEAPON_REGISTRY } from "../../types/weapon";

export interface EnduranceHost {
  stop(): void;
  context(): { players: Player[]; heights: readonly number[]; materials: readonly string[]; phase: string };
}
export interface EnduranceClock { now(): number; date(): string; id(): string; seed(): number }
const clock: EnduranceClock = { now: () => performance.now(), date: () => new Date().toISOString(),
  id: randomUUID, seed: () => crypto.getRandomValues(new Uint32Array(1))[0] };

export class EnduranceSession implements CombatObserver {
  readonly session: SessionRecord;
  block: BlockRecord | null = null;
  ready = false;
  busy = false;
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
  private roundDate = "";
  private collector: RoundCollector | null = null;
  private recent: RecentEvent[] = [];
  private sequence = 0;
  private revision = 0;
  private listeners = new Set<() => void>();
  private writes: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
  private fallback: Checkpoint[] = [];
  private stopped = false;
  private storageUnavailable = false;
  private finishing: Promise<void> | null = null;

  private readonly storage: EnduranceStorage;
  private readonly time: EnduranceClock;
  constructor(config: EnduranceConfig, storage: EnduranceStorage, time = clock, build = import.meta.env.VITE_BUILD_ID ?? "development") {
    this.storage = storage; this.time = time;
    this.started = time.now();
    this.session = { runtime: { width: 800, height: 480, gravity: 260, baseShotSpeed: 420, localMatch: true, weapons: structuredClone(WEAPON_REGISTRY) },
      schemaVersion: 1, id: time.id(), gameVersion: version, build, config: validateConfig(config),
      startedAt: time.date(), durationMs: 0, status: "running", reason: null, attempted: 0, completed: 0,
      abandoned: 0, interrupted: 0, suspect: 0, roundsStarted: 0, roundsCompleted: 0, incidents: 0,
      collection: "incomplete", storageError: null, completedMetrics: groups(), partialMetrics: groups(),
      retention: { recentEvents: 256, checkpointMs: 15000, fullEventHistory: false } };
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
    this.phase = "PREPARATION"; this.roundNumber = 0; this.turn = 0; this.sequence = 0; this.recent = [];
    this.block = { id: this.time.id(), sessionId: this.session.id, index: ++this.session.attempted, seed: this.time.seed(),
      config: structuredClone(this.session.config), gameVersion: this.session.gameVersion, build: this.session.build,
      schemaVersion: 1, physics: "local", startedAt: this.time.date(), durationMs: 0, status: "running", reason: null,
      suspect: false, roundsStarted: 0, roundsCompleted: 0, completedMetrics: groups(), partialMetrics: groups() };
    this.busy = true; this.changed();
    await this.save();
    if (this.stopped) return;
    this.busy = false; this.ready = true; this.active = true; this.changed();
  }
  attach(host: EnduranceHost): void {
    if (!this.active || this.host) throw new Error("INVALID_ENDURANCE_ATTACH");
    this.host = host;
    this.beginRound(1);
  }
  detach(host: EnduranceHost): void { if (this.host === host) this.host = null; }
  beginRound(number: number): boolean {
    if (!this.active || this.stopped || !this.block || this.limitReached()) { if (this.limitReached()) void this.stop("duration"); return false; }
    this.roundNumber = number; this.turn = 0; this.roundStarted = this.time.now(); this.roundDate = this.time.date();
    this.actionStarted = null; this.phase = "COMBAT";
    this.collector = new RoundCollector(this.session.config.players);
    this.block.roundsStarted++; this.session.roundsStarted++;
    return true;
  }
  setPhase(phase: string): void {
    if (!this.active || this.phase === phase) return;
    this.phase = phase; this.transitionStarted = this.time.now(); this.changed();
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
    if (this.limitReached()) { void this.stop("duration"); return false; }
    try {
      if (event.kind === "turn") {
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
      const recent = { sequence: ++this.sequence, atMs: this.time.now() - this.blockStarted, round: this.roundNumber, event: structuredClone(event) };
      this.recent.push(recent); if (this.recent.length > 256) this.recent.shift();
      if (event.kind === "recovery") this.incident("warning", `SAFETY_${event.reason}`);
      if (event.kind === "failure") { this.incident("exception", event.reason, 0, event.error); return false; }
      // Keep the action deadline until the next turn or inter-round transition: a resolved
      // projectile/Zeus result alone does not prove that turn finalization advanced.
      if (event.kind === "resolved" || event.kind === "zeus") this.validate();
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
    if (!this.block.suspect) { this.block.suspect = true; this.session.suspect++; }
    if (kind === "warning") { void this.save(undefined, incident); this.changed(); return; }
    void this.finishBlock(kind === "external" ? "interrupted" : "abandoned", reason, incident);
  }
  private save(round?: Checkpoint["round"], incident?: Incident): Promise<void> {
    this.session.durationMs = this.time.now() - this.started;
    this.checkpointAt = this.time.now();
    const checkpoint = structuredClone({ session: this.session, block: this.block, round, incident });
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
    this.active = false; this.ready = false;
    try { this.host?.stop(); } finally { this.host = null; }
  }
  private storageFailed(error: unknown): void {
    this.storageUnavailable = true;
    console.error("[Endurance] Storage failed", error);
    this.session.storageError = error instanceof Error ? error.message : String(error);
    this.session.collection = "incomplete";
    void this.stop("storage-failure"); this.changed();
  }
  private finishBlock(status: BlockRecord["status"], reason: string, incident?: Incident): Promise<void> {
    if (this.finishing) return this.finishing;
    if (!this.block || this.block.status !== "running") return Promise.resolve();
    let cleanupFailed = false;
    try { this.halt(); } catch (error) { cleanupFailed = true; this.session.storageError = `Cleanup: ${String(error)}`; }
    this.busy = true;
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
      this.finishing = null; this.busy = false;
      if (cleanupFailed || this.session.storageError) { await this.stop(cleanupFailed ? "cleanup-failure" : "storage-failure"); return; }
      if (!this.stopped && status === "abandoned" && this.session.config.stopOnIncident) { await this.stop("incident"); return; }
      if (!this.stopped) await this.nextBlock();
      this.changed();
    });
    return this.finishing;
  }
  async stop(reason = "manual"): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.session.status = "stopped"; this.session.reason = reason;
    if (this.block?.status === "running") await this.finishBlock("interrupted", reason);
    else { try { this.halt(); } catch (error) { this.session.storageError = `Cleanup: ${String(error)}`; } }
    this.session.collection = this.session.storageError ? "incomplete" : "complete";
    await this.save(); this.changed();
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
