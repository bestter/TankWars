import type { GameState, FireCommand } from "../../../types/game";
import type { Player } from "../../../types/player";
import type { AIObservation, AIObserver, Aim } from "../../observation";

/** Captures existing values only. No solver, forecast or RNG calls belong here. */
export class DecisionObservation {
  private readonly value: AIObservation;
  private readonly observer: AIObserver;
  constructor(observer: AIObserver, self: Player, target: Player, state: GameState) {
    this.observer = observer;
    this.value = { playerId: self.id, tankId: self.tank.id, profile: self.aiProfile ?? null,
      shooter: structuredClone(self), target: { playerId: target.id, tankId: target.tank.id, position: { ...target.tank.position } },
      point: null, nominal: null, evaluated: null, final: { angle: 45, power: 50, weaponId: "MISSILE" },
      environment: { windForce: state.windForce, gravity: state.gravity }, steps: [], reason: null, diagnostics: null };
  }
  evaluated(command: FireCommand, point: { x: number; y: number }): void {
    this.value.evaluated = { ...command }; this.value.point = { ...point };
  }
  step(kind: AIObservation["steps"][number]["kind"], before: Aim | null, after: Aim | null, parameters: Record<string, unknown> = {}): void {
    this.value.steps.push(structuredClone({ kind, before, after, parameters }));
  }
  finish(command: FireCommand, reason: string | null = null, diagnostics: unknown = null): void {
    this.value.final = { ...command }; this.value.reason = reason; this.value.diagnostics = diagnostics;
    this.observer(structuredClone(this.value));
  }
}

export function observedFallback(observer: AIObserver | undefined, self: Player | undefined, tankId: string, reason: string): FireCommand {
  const command: FireCommand = { angle: 45, power: 50, weaponId: "MISSILE" };
  observer?.({ playerId: self?.id ?? null, tankId, profile: self?.aiProfile ?? null,
    shooter: self ? structuredClone(self) : null, target: null, point: null, nominal: null, evaluated: null,
    final: { ...command }, environment: null, steps: [], reason, diagnostics: null });
  return command;
}
