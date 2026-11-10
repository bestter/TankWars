import { writeDecisionConsole } from "../../utils/decisionConsole";
import type { AdvisorObjective } from "../../game/entities/ai/expertPolicy";
import type { AdvisorSnapshot } from "../../game/entities/ai/shotAdvisor";
import { isAdvisorResult, type AdvisorResult } from "../../game/entities/ai/advisorProtocol";

export interface AdvisorHost {
  observing?(): boolean;
  observe?(event: { requestId: number; status: string; detail: unknown }): void;
  capture(): AdvisorSnapshot | null;
  apply(result: AdvisorResult): boolean;
}
export interface AdvisorView {
  playerId?: string;
  objective: AdvisorObjective;
  status: "idle" | "calculating" | "result" | "empty" | "error" | "expired";
  result?: AdvisorResult;
  names?: Readonly<Record<string, string>>;
  lockedTargetId?: string;
}
export interface AdvisorWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: { snapshot: AdvisorSnapshot; objective: AdvisorObjective; requestId?: number; observe?: boolean; lockedTargetId?: string }): void;
  terminate(): void;
}

export class AdvisorController {
  private nextRequestId = 0;
  private resultRequestId: number | null = null;
  private pending: { requestId: number; objective: AdvisorObjective; playerId?: string; lockedTargetId?: string } | null = null;
  private terminal(status: string, decision?: unknown, summary?: unknown): void {
    if (!this.pending) return;
    this.host.observe?.({ requestId: this.pending.requestId, status, detail: { ...this.pending, decision } });
    if (status === "result") this.resultRequestId = this.pending.requestId;
    if (import.meta.env.DEV) writeDecisionConsole("[Shot advisor] Décision", { ...this.pending, status, decision: summary }, { ...this.pending, status, decision });
    this.pending = null;
  }
  private preferences = new Map<string, AdvisorObjective>();
  private locks = new Map<string, string>();
  private lockEpoch = 0;
  private roundNumber: number | null = null;
  private worker: AdvisorWorker | null = null;
  private key: string | null = null;
  private view: AdvisorView = { objective: "OPTIMISER_PROFIT", status: "idle" };

  private host: AdvisorHost;
  private createWorker: () => AdvisorWorker;
  private publish: (view: AdvisorView) => void;

  constructor(host: AdvisorHost, createWorker: () => AdvisorWorker, publish: (view: AdvisorView) => void) {
    this.host = host;
    this.createWorker = createWorker;
    this.publish = publish;
  }

  private stop(): void {
    this.terminal("cancelled");
    this.worker?.terminate();
    this.worker = null;
  }

  private lockFor(playerId: string | undefined): string | undefined {
    return playerId ? this.locks.get(playerId) : undefined;
  }

  private idleView(playerId: string | undefined, objective: AdvisorObjective): AdvisorView {
    const lockedTargetId = this.lockFor(playerId);
    return { playerId, objective, status: "idle", ...(lockedTargetId ? { lockedTargetId } : {}) };
  }

  /** Poll relevance, not physics frame state. Publish only on a relevant change. */
  refresh(): AdvisorSnapshot | null {
    const snapshot = this.host.capture();
    if (snapshot !== null) {
      const nextRound = snapshot.state.roundNumber ?? 1;
      if (nextRound !== this.roundNumber) {
        this.preferences.clear();
        this.roundNumber = nextRound;
      }
    }
    const key = snapshot ? JSON.stringify(snapshot) : null;
    if (key !== this.key) {
      if (this.resultRequestId !== null) {
        this.host.observe?.({ requestId: this.resultRequestId, status: "expired", detail: null }); this.resultRequestId = null;
      }
      this.stop();
      this.key = key;
      const playerId = snapshot?.state.players[snapshot.state.currentPlayerIndex]?.id;
      this.view = this.idleView(playerId, playerId ? this.preferences.get(playerId) ?? "OPTIMISER_PROFIT" : "OPTIMISER_PROFIT");
      this.publish(this.view);
    }
    return snapshot;
  }

  setObjective(objective: AdvisorObjective): void {
    this.refresh();
    if (!this.view.playerId || objective === this.view.objective) return;
    this.preferences.set(this.view.playerId, objective);
    this.stop();
    this.view = this.idleView(this.view.playerId, objective);
    this.publish(this.view);
  }

  /** One lock per human. A second click on the same target removes it. */
  toggleLock(targetId: string): void {
    this.refresh();
    const playerId = this.view.playerId;
    if (!playerId || playerId === targetId) return;
    if (this.locks.get(playerId) === targetId) this.locks.delete(playerId);
    else this.locks.set(playerId, targetId);
    this.lockEpoch += 1;
    this.stop();
    this.view = this.idleView(playerId, this.view.objective);
    this.publish(this.view);
  }

  /** Drop every human lock that points at a tank already dead before respawn. */
  releaseDeadTargets(deadIds: readonly string[]): void {
    if (deadIds.length === 0) return;
    const dead = new Set(deadIds);
    let removed = false;
    for (const [owner, targetId] of this.locks) {
      if (!dead.has(targetId)) continue;
      this.locks.delete(owner);
      removed = true;
    }
    if (!removed) return;
    const lockedTargetId = this.lockFor(this.view.playerId);
    if (this.view.lockedTargetId === lockedTargetId) return;
    this.lockEpoch += 1;
    const playerId = this.view.playerId;
    const objective = this.view.objective;
    this.stop();
    this.view = this.idleView(playerId, objective);
    this.publish(this.view);
  }

  request(): void {
    const snapshot = this.refresh();
    if (!snapshot || this.worker) return;
    const key = this.key;
    const objective = this.view.objective;
    const lockedTargetId = this.view.lockedTargetId;
    const lockEpoch = this.lockEpoch;
    const names = Object.fromEntries(snapshot.state.players.map((player) => [player.id, player.name]));
    const requestId = ++this.nextRequestId;
    if (this.resultRequestId !== null) this.host.observe?.({ requestId: this.resultRequestId, status: "replaced", detail: null });
    this.resultRequestId = null;
    this.pending = { requestId, objective, playerId: this.view.playerId, ...(lockedTargetId ? { lockedTargetId } : {}) };
    this.host.observe?.({ requestId, status: "calculating", detail: {
      state: snapshot.state, width: snapshot.width, height: snapshot.height, objective,
      playerId: this.view.playerId, ...(lockedTargetId ? { lockedTargetId } : {}),
    } });
    if (import.meta.env.DEV) writeDecisionConsole("[Shot advisor] Décision", { ...this.pending, status: "calculating" });
    this.view = { ...this.view, status: "calculating", result: undefined, names };
    this.publish(this.view);
    try {
      const worker = this.createWorker();
      this.worker = worker;
      const fail = (error: unknown) => {
        if (this.worker !== worker) return;
        console.error("[Shot advisor] Worker failed", { error, playerId: this.view.playerId });
        this.terminal("error");
        this.stop();
        this.view = { ...this.view, status: "error", result: undefined };
        this.publish(this.view);
      };
      worker.onerror = fail;
      worker.onmessageerror = () => fail("MESSAGE_ERROR");
      worker.onmessage = (event) => {
        if (this.worker !== worker) return;
        this.refresh();
        if (this.worker !== worker || this.key !== key || this.view.objective !== objective || this.lockEpoch !== lockEpoch) return;
        const data = event.data;
        if (typeof data !== "object" || data === null || !("advice" in data)) {
          fail("INVALID_RESULT"); return;
        }
        if (data.advice !== null && (!isAdvisorResult(data.advice) || data.advice.objective !== objective ||
          (objective === "SURVIE" && data.advice.shooterDestroyed))) { fail("INVALID_ADVICE"); return; }
        this.terminal(data.advice === null ? "empty" : "result", "decision" in data ? data.decision : undefined,
          { planner: "decisionSummary" in data ? data.decisionSummary : undefined, advice: data.advice });
        this.stop();
        this.view = { ...this.view, status: data.advice === null ? "empty" : "result", result: data.advice ?? undefined };
        this.publish(this.view);
      };
      worker.postMessage({ snapshot, objective, requestId, ...(lockedTargetId ? { lockedTargetId } : {}), ...(this.host.observing?.() ? { observe: true } : {}) });
    } catch (error) {
      console.error("[Shot advisor] Unable to start worker", error);
      this.terminal("error");
      this.stop();
      this.view = { ...this.view, status: "error" };
      this.publish(this.view);
    }
  }

  apply(): void {
    const key = this.key;
    const result = this.view.result;
    this.refresh();
    if (!result || this.key !== key || this.view.result !== result) return;
    const applied = this.host.apply(result);
    if (this.resultRequestId !== null) this.host.observe?.({ requestId: this.resultRequestId, status: applied ? "applied" : "expired", detail: result });
    if (!applied) {
      this.view = { ...this.view, status: "expired", result: undefined };
      this.publish(this.view);
    }
  }

  reset(): void {
    this.stop();
    this.preferences.clear();
    this.locks.clear();
    this.lockEpoch += 1;
    this.roundNumber = null;
    this.key = null;
    this.view = { objective: "OPTIMISER_PROFIT", status: "idle" };
    this.publish(this.view);
  }

  dispose(): void { this.stop(); }
}
