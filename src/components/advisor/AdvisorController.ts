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
  postMessage(message: { snapshot: AdvisorSnapshot; objective: AdvisorObjective }): void;
  terminate(): void;
}

export class AdvisorController {
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
    this.view = { ...this.view, status: "calculating", result: undefined, names };
    this.publish(this.view);
    try {
      const worker = this.createWorker();
      this.worker = worker;
      const fail = (error: unknown) => {
        if (this.worker !== worker) return;
        console.error("[Shot advisor] Worker failed", { error, playerId: this.view.playerId });
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
        this.stop();
        this.view = { ...this.view, status: data.advice === null ? "empty" : "result", result: data.advice ?? undefined };
        this.publish(this.view);
      };
      worker.postMessage({ snapshot, objective });
    } catch (error) {
      console.error("[Shot advisor] Unable to start worker", error);
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
