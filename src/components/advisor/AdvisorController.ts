import { writeDecisionConsole } from "../../utils/decisionConsole";
import type { AdvisorObjective } from "../../game/entities/ai/expertPolicy";
import type { AdvisorSnapshot } from "../../game/entities/ai/shotAdvisor";
import { isAdvisorResult, type AdvisorResult } from "../../game/entities/ai/advisorProtocol";

export interface AdvisorHost {
  capture(): AdvisorSnapshot | null;
  apply(result: AdvisorResult): boolean;
}
export interface AdvisorView {
  playerId?: string;
  objective: AdvisorObjective;
  status: "idle" | "calculating" | "result" | "empty" | "error" | "expired";
  result?: AdvisorResult;
  names?: Readonly<Record<string, string>>;
}
export interface AdvisorWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: { snapshot: AdvisorSnapshot; objective: AdvisorObjective; requestId?: number }): void;
  terminate(): void;
}

export class AdvisorController {
  private nextRequestId = 0;
  private pending: { requestId: number; objective: AdvisorObjective; playerId?: string } | null = null;
  private terminal(status: string, decision?: unknown, summary?: unknown): void {
    if (!this.pending) return;
    if (import.meta.env.DEV) writeDecisionConsole("[Shot advisor] Décision", { ...this.pending, status, decision: summary }, { ...this.pending, status, decision });
    this.pending = null;
  }
  private preferences = new Map<string, AdvisorObjective>();
  private worker: AdvisorWorker | null = null;
  private key: string | null = null;
  private view: AdvisorView = { objective: "SURVIE", status: "idle" };

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

  /** Poll relevance, not physics frame state. Publish only on a relevant change. */
  refresh(): AdvisorSnapshot | null {
    const snapshot = this.host.capture();
    const key = snapshot ? JSON.stringify(snapshot) : null;
    if (key !== this.key) {
      this.stop();
      this.key = key;
      const playerId = snapshot?.state.players[snapshot.state.currentPlayerIndex]?.id;
      this.view = { playerId, objective: playerId ? this.preferences.get(playerId) ?? "SURVIE" : "SURVIE", status: "idle" };
      this.publish(this.view);
    }
    return snapshot;
  }

  setObjective(objective: AdvisorObjective): void {
    this.refresh();
    if (!this.view.playerId || objective === this.view.objective) return;
    this.preferences.set(this.view.playerId, objective);
    this.stop();
    this.view = { playerId: this.view.playerId, objective, status: "idle" };
    this.publish(this.view);
  }

  request(): void {
    const snapshot = this.refresh();
    if (!snapshot || this.worker) return;
    const key = this.key;
    const objective = this.view.objective;
    const names = Object.fromEntries(snapshot.state.players.map((player) => [player.id, player.name]));
    const requestId = ++this.nextRequestId;
    this.pending = { requestId, objective, playerId: this.view.playerId };
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
        if (this.worker !== worker || this.key !== key || this.view.objective !== objective) return;
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
      worker.postMessage({ snapshot, objective, requestId });
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
    if (!this.host.apply(result)) {
      this.view = { ...this.view, status: "expired", result: undefined };
      this.publish(this.view);
    }
  }

  reset(): void {
    this.stop();
    this.preferences.clear();
    this.key = null;
    this.view = { objective: "SURVIE", status: "idle" };
    this.publish(this.view);
  }

  dispose(): void { this.stop(); }
}
