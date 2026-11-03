import type { GameState } from "../../../types/game";
import type { Player } from "../../../types/player";
import type { TerrainManager } from "../../engine/Terrain";
import { finalizeAdvancedAim } from "./aimCorruption";
import { hasPhysicalEffect } from "./localMaterialPlanner";
import { resolvePhysicalShot, type PhysicalResolution } from "./physicalShotForecast";
import { solveSniperAim } from "./sniperAim";
import {
  ordinaryTankPoint, prefer, retainSniperChoiceForecast, sniperBulletRefusal,
  sniperFallbackRefusal, targetDestroyed, targetLoss,
  type SniperPhysicalChoice, type SniperSelectionTrace,
} from "./sniperPhysicalSelection";

interface FallbackCandidate {
  readonly target: Player;
  readonly offset: number;
  readonly offsetDirection: number;
  readonly attempts: 1;
  readonly choice: SniperPhysicalChoice;
  readonly destroyed: boolean;
  readonly loss: number;
  readonly weaponId: "MISSILE";
}

/** Two ordinary arcs per target; BULLET reuses a ranked MISSILE's normalized command. */
export function searchSniperFallbacks(self: Player, targets: readonly Player[], state: GameState,
  terrain: TerrainManager, offsetFor: (target: Player) => { offset: number; offsetDirection: number }, observe: boolean,
) {
  const candidates: FallbackCandidate[] = [];
  const counters = { searches: 0, solverCalls: 0, ballisticCacheHits: 0, forecasts: 0, cacheHits: 0 };
  const tracing = import.meta.env.DEV || observe;
  const evaluations: { targetId: string; offset: number; offsetDirection: number; selection: SniperSelectionTrace }[] = [];
  const caches = new Map<string, Map<string, PhysicalResolution>>();
  const count = (trace: SniperSelectionTrace, key: keyof typeof counters) => {
    counters[key] += 1;
    // Keep each target's trace live until its lazy BULLET evaluations finish.
    Object.assign(trace, { [key]: trace[key] + 1 });
  };
  const forecastFor = (target: Player, choice: SniperPhysicalChoice, weapon: "MISSILE" | "BULLET") => {
    const cache = caches.get(target.id)!;
    const key = JSON.stringify([weapon, choice.command.angle, choice.command.power]);
    const cached = cache.get(key);
    if (cached) { count(choice.trace, "cacheHits"); return cached; }
    count(choice.trace, "forecasts");
    const forecast = resolvePhysicalShot(state, terrain, self, weapon, choice.command, { captureAfterState: true });
    cache.set(key, forecast);
    return forecast;
  };
  const note = (choice: SniperPhysicalChoice, refusal: ReturnType<typeof sniperBulletRefusal>) => {
    if (!tracing || !refusal) return;
    Object.assign(choice.trace, { refusals: [...choice.trace.refusals, {
      weaponId: choice.weaponId, kind: choice.point.kind, variant: choice.variant,
      x: choice.point.x, y: choice.point.y, command: choice.command, refusal,
    }] });
  };
  const noteAdmissible = (choice: SniperPhysicalChoice, target: Player, forecast: PhysicalResolution) => {
    if (!tracing) return;
    Object.assign(choice.trace, { admissible: [...choice.trace.admissible, {
      weaponId: choice.weaponId, kind: choice.point.kind, variant: choice.variant,
      x: choice.point.x, y: choice.point.y, command: choice.command,
      destroyed: targetDestroyed(forecast, self, target, choice.weaponId),
      loss: targetLoss(forecast, self, target, choice.weaponId),
    }] });
  };
  for (const target of targets) {
    const trace: SniperSelectionTrace = { selectionReason: "repli utile", admissible: [], refusals: [],
      searches: 0, solverCalls: 0, ballisticCacheHits: 0, forecasts: 0, cacheHits: 0 };
    caches.set(target.id, new Map());
    const aim = offsetFor(target);
    if (tracing) evaluations.push({ targetId: target.id, ...aim, selection: trace });
    const point = ordinaryTankPoint(target);
    for (const variant of ["full", "high"] as const) {
      count(trace, "searches"); count(trace, "solverCalls");
      const solution = solveSniperAim(self, point.x + aim.offset, point.y, state.windForce, state.gravity, terrain, "MISSILE", variant);
      const choice: SniperPhysicalChoice = { weaponId: "MISSILE", point, variant,
        rawCommand: solution.command, command: finalizeAdvancedAim(solution.command),
        certified: true, reason: "missile-useful", trace };
      if (!solution.complete) { note(choice, "recherche incomplète"); continue; }
      const forecast = forecastFor(target, choice, "MISSILE");
      const refusal = sniperFallbackRefusal(forecast, self, target, "MISSILE");
      if (refusal) { note(choice, refusal); continue; }
      if (!hasPhysicalEffect(forecast, self, new Set([target.id]))) { note(choice, "sans effet"); continue; }
      retainSniperChoiceForecast(choice, forecast);
      noteAdmissible(choice, target, forecast);
      const candidate: FallbackCandidate = { target, ...aim, attempts: 1, choice, weaponId: "MISSILE",
        destroyed: targetDestroyed(forecast, self, target, "MISSILE"), loss: targetLoss(forecast, self, target, "MISSILE") };
      candidates.push(candidate);
    }
  }
  // Stable sort preserves target priority and full before high on equal consequences.
  candidates.sort((a, b) => prefer(a, b) ? -1 : prefer(b, a) ? 1 : 0);
  const withBullet = (candidate: FallbackCandidate): SniperPhysicalChoice => {
    if ((self.inventory.BULLET ?? 0) <= 0) return candidate.choice;
    const { target, choice } = candidate;
    count(choice.trace, "searches"); count(choice.trace, "ballisticCacheHits");
    const bullet: SniperPhysicalChoice = { ...choice, weaponId: "BULLET", reason: "bullet" };
    const forecast = forecastFor(target, bullet, "BULLET");
    const refusal = sniperBulletRefusal(forecast, self, target) ?? sniperFallbackRefusal(forecast, self, target, "BULLET");
    if (refusal) { note(bullet, refusal); return choice; }
    noteAdmissible(bullet, target, forecast);
    const rank = { weaponId: "BULLET" as const, destroyed: targetDestroyed(forecast, self, target, "BULLET"),
      loss: targetLoss(forecast, self, target, "BULLET") };
    if (!prefer(rank, candidate)) return choice;
    retainSniperChoiceForecast(bullet, forecast);
    return bullet;
  };
  return { candidates, withBullet, counters, evaluations };
}
