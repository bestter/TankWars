import type { GameState } from "../../../types/game";
import type { Player } from "../../../types/player";
import { secureRandom } from "../../../utils/random";
import type { TerrainManager } from "../../engine/Terrain";
import { calculateImpactOffsetMagnitude } from "./fallibleAim";
import { LethalTransitionDetector, type TransitionAnalysis } from "./lethalTransition";
import { solveSniperAim } from "./sniperAim";
import { chooseSniperPhysicalShot, getSniperChoiceForecast, type SniperPhysicalChoice } from "./sniperPhysicalSelection";

interface VirtualChoice {
  readonly target: Player;
  readonly attempts: number;
  readonly offsetDirection: number;
  readonly offset: number;
  readonly choice: SniperPhysicalChoice;
}

function summary(value: VirtualChoice) {
  const { choice, target, ...aim } = value;
  return { targetId: target.id, ...aim, weaponId: choice.weaponId, reason: choice.reason,
    certified: choice.certified, rawCommand: choice.rawCommand, command: choice.command,
    selection: choice.trace };
}

/** Virtual attempts never mutate memory, the current weapon or hit reaction. */
export function chooseSniperTransitionShot(self: Player, initialTarget: Player, state: GameState,
  terrain: TerrainManager, initialAttempts: number, observe = false,
  detector = new LethalTransitionDetector(),
) {
  const started = performance.now();
  let amplitude = initialAttempts < 3 ? secureRandom() : undefined;
  let extraAmplitude: number | undefined;
  const evaluate = (target: Player, attempts: number): VirtualChoice => {
    const x = target.tank.position.x;
    const offsetDirection = (x > terrain.width - x ? -1 : 1) * (attempts === 2 ? -1 : 1);
    const offset = offsetDirection * calculateImpactOffsetMagnitude(attempts, "v3-sniper", state.roundNumber, amplitude ?? 0);
    const choice = chooseSniperPhysicalShot(self, target, state, terrain, offset,
      (point, weapon, variant) => solveSniperAim(self, point.x, point.y, state.windForce, state.gravity, terrain, weapon, variant), observe);
    return { target, attempts, offsetDirection, offset, choice };
  };
  const analyze = (value: VirtualChoice) => detector.analyze({
    primaryTargetId: value.target.id, weaponId: value.choice.weaponId, command: value.choice.command,
    certified: value.choice.certified,
    result: { forecast: getSniperChoiceForecast(value.choice), rawCommand: value.choice.rawCommand },
  }, self, state, terrain);
  const initial = evaluate(initialTarget, initialAttempts);
  const selectionCounters = { searches: initial.choice.trace.searches, forecasts: initial.choice.trace.forecasts, cacheHits: initial.choice.trace.cacheHits };
  const analysis = analyze(initial);
  const alternatives: { choice: ReturnType<typeof summary>; accepted: boolean; analysis: TransitionAnalysis | null }[] = [];
  let selected = initial;
  let reason = "initial-retained";
  if (analysis.status === "risk") {
    reason = "initial-retained-no-alternative";
    const others = state.players.filter(player => player.id !== self.id && player.id !== initialTarget.id && !player.tank.isDead)
      .toSorted((a, b) => Number(a.isHuman) - Number(b.isHuman) || a.tank.health - b.tank.health);
    for (const target of others) {
      if (amplitude === undefined) { amplitude = secureRandom(); extraAmplitude = amplitude; }
      const alternative = evaluate(target, 1);
      selectionCounters.searches += alternative.choice.trace.searches;
      selectionCounters.forecasts += alternative.choice.trace.forecasts;
      selectionCounters.cacheHits += alternative.choice.trace.cacheHits;
      const useful = ["bullet", "driller", "missile-useful"].includes(alternative.choice.reason);
      const evaluated = useful && alternative.choice.certified ? analyze(alternative) : null;
      const accepted = evaluated?.status === "safe";
      alternatives.push({ choice: summary(alternative), accepted, analysis: evaluated });
      if (accepted) { selected = alternative; reason = "alternative-accepted"; break; }
    }
  }
  return { ...selected, trace: { reason, initial: summary(initial), final: summary(selected), analysis, alternatives,
    shooterStock: { MISSILE: self.inventory.MISSILE ?? 0, BULLET: self.inventory.BULLET ?? 0, DRILLER: self.inventory.DRILLER ?? 0 },
    selectionCounters, detectionCounters: { ...detector.counters }, extraAmplitude, elapsedMs: performance.now() - started } };
}
