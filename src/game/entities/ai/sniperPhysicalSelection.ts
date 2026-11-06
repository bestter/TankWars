import type { GameState } from "../../../types/game";
import type { Player } from "../../../types/player";
import { TERRAIN_MATERIAL } from "../../../types/terrain";
import type { WeaponId } from "../../../types/weapon";
import type { TerrainManager } from "../../engine/Terrain";
import type { CombatDamageEvent } from "../../economy/shotRewards";
import { finalizeAdvancedAim, type AimCommand } from "./aimCorruption";
import type { AimVariant } from "./aimSearch";
import { hasPhysicalEffect, type MaterialSolver } from "./localMaterialPlanner";
import { localMaterialPoints, type TacticalPoint } from "./materialCandidates";
import {
  FORECAST_SHOT_ID,
  resolvePhysicalShot,
  type PhysicalResolution,
} from "./physicalShotForecast";

/** Two BULLET arcs, four DRILLER arcs, and four MISSILE arcs only as fallback. */
export const SNIPER_SEARCH_LIMITS = {
  bullet: 2,
  driller: 4,
  missile: 4,
  total: 10,
} as const;

const ARCS = ["full", "high"] as const;

export type SniperChoiceReason =
  | "bullet"
  | "driller"
  | "missile-useful"
  | "missile-surviving"
  | "missile-ordinary";

export type SniperRefusal =
  | "stock vide"
  | "veto ROCK"
  | "recherche incomplète"
  | "prévision incomplète"
  | "tireur détruit"
  | "autodégâts"
  | "pas d'impact direct"
  | "interception"
  | "absorption seule"
  | "sans effet"
  | "survivant écarté"
  | "impact direct"
  | "pas d'impact terrain"
  | "sans perte de support"
  | "excavation seule"
  | "chute sans dommage"
  | "souffle seul"
  | "destruction health-zero"
  | "hors carte"
  | "attribution étrangère";

export type SniperSelectionReason =
  | "seul candidat"
  | "destruction de la cible"
  | "perte réelle supérieure"
  | "BULLET à égalité"
  | "point ou arc antérieur"
  | "repli utile"
  | "repli survivant"
  | "secours ordinaire"
  | "secours synthétique";

export interface SniperCandidateSummary {
  readonly weaponId: WeaponId;
  readonly kind: TacticalPoint["kind"];
  readonly variant: AimVariant;
  readonly x: number;
  readonly y: number;
  readonly command: AimCommand;
  readonly destroyed: boolean;
  readonly loss: number;
  readonly cause?: string;
}

export interface SniperRefusalTrace {
  readonly weaponId: WeaponId;
  readonly kind: TacticalPoint["kind"];
  readonly variant: AimVariant;
  readonly x: number;
  readonly y: number;
  readonly refusal: SniperRefusal;
  readonly command?: AimCommand;
  readonly directTargetId?: string;
  readonly supportBefore?: number;
  readonly supportAfter?: number;
  readonly loss?: number;
  readonly cause?: string;
}

export interface SniperSelectionTrace {
  readonly selectionReason: SniperSelectionReason;
  readonly runnerUp?: SniperCandidateSummary;
  readonly admissible: readonly SniperCandidateSummary[];
  readonly refusals: readonly SniperRefusalTrace[];
  readonly searches: number;
  readonly solverCalls: number;
  readonly ballisticCacheHits: number;
  readonly forecasts: number;
  readonly cacheHits: number;
}

export interface SniperPhysicalChoice {
  readonly weaponId: WeaponId;
  readonly point: TacticalPoint;
  readonly variant: AimVariant;
  readonly rawCommand: AimCommand;
  readonly command: AimCommand;
  readonly certified: boolean;
  readonly reason: SniperChoiceReason;
  readonly trace: SniperSelectionTrace;
}

// Preserve the original forecast identity without exposing it in serialized choices.
const choiceForecasts = new WeakMap<SniperPhysicalChoice, PhysicalResolution>();
export function getSniperChoiceForecast(choice: SniperPhysicalChoice): PhysicalResolution | undefined {
  return choiceForecasts.get(choice);
}

export interface SniperContinuationOutcome {
  readonly success: boolean;
  readonly candidate?: {
    readonly choice: SniperPhysicalChoice;
    readonly forecast: PhysicalResolution;
  };
  readonly counters: {
    readonly searches: number;
    readonly solverCalls: number;
    readonly ballisticCacheHits: number;
    readonly forecasts: number;
    readonly cacheHits: number;
  };
}

const sniperChoiceContinuations = new WeakMap<SniperPhysicalChoice, () => SniperContinuationOutcome>();

export function continueSniperSameTargetLethal(choice: SniperPhysicalChoice): SniperContinuationOutcome | null {
  const run = sniperChoiceContinuations.get(choice);
  if (!run) return null;
  sniperChoiceContinuations.delete(choice);
  return run();
}

interface SearchResult {
  readonly point: TacticalPoint;
  readonly variant: AimVariant;
  readonly rawCommand: AimCommand;
  readonly command: AimCommand;
  readonly forecast: PhysicalResolution | null;
}

interface RankedCandidate extends SearchResult {
  readonly weaponId: "BULLET" | "DRILLER" | "MISSILE";
  readonly destroyed: boolean;
  readonly loss: number;
}

function stock(self: Player, weapon: WeaponId): number {
  return self.inventory[weapon] ?? 0;
}

function attributed(
  event: { shotId: number; shooterId: string; victimId: string; weaponId: WeaponId },
  self: Player,
  target: Player,
  weapon: WeaponId,
): boolean {
  return event.shotId === FORECAST_SHOT_ID && event.shooterId === self.id &&
    event.weaponId === weapon && event.victimId === target.id;
}

export function targetLoss(forecast: PhysicalResolution, self: Player, target: Player, weapon: WeaponId): number {
  if (!forecast.complete) return 0;
  return forecast.damage.reduce((sum, event) => (
    attributed(event, self, target, weapon) ? sum + event.healthDamageMilli + event.shieldLostMilli : sum
  ), 0);
}

export function targetDestroyed(forecast: PhysicalResolution, self: Player, target: Player, weapon: WeaponId): boolean {
  return forecast.complete && forecast.destruction.some((event) => attributed(event, self, target, weapon));
}

/** Null means the complete forecast satisfies the BULLET proof. */
export function sniperBulletRefusal(
  forecast: PhysicalResolution, self: Player, target: Player,
): SniperRefusal | null {
  if (!forecast.complete) return "prévision incomplète";
  if (!forecast.survivors.includes(self.id)) return "tireur détruit";
  const hits = forecast.hits.filter((hit) => hit.shotId === FORECAST_SHOT_ID && hit.weaponId === "BULLET");
  const hitsTarget = hits.some((hit) => hit.directTargetId === target.id);
  if (!hitsTarget) {
    return hits.some((hit) => hit.directTargetId !== undefined) ? "interception" : "pas d'impact direct";
  }
  if (hasPhysicalEffect(forecast, self, new Set([target.id]))) return null;
  const absorbedOnly = forecast.damage.some((event) => attributed(event, self, target, "BULLET") &&
    event.shieldLostMilli + event.healthDamageMilli === 0 && event.shieldAbsorbedMilli > 0);
  return absorbedOnly ? "absorption seule" : "sans effet";
}

function foreignFallOrBurial(
  forecast: Extract<PhysicalResolution, { complete: true }>, self: Player, target: Player,
): boolean {
  const foreignFall = forecast.damage.some((event) => event.source === "fall" && event.healthDamageMilli > 0 &&
    event.victimId === target.id && !attributed(event, self, target, "DRILLER"));
  const foreignBurial = forecast.destruction.some((event) =>
    (event.cause === "buried" || event.cause === "lava") && event.victimId === target.id &&
    !attributed(event, self, target, "DRILLER"));
  return foreignFall || foreignBurial;
}

function drillerConsequenceRefusal(
  forecast: Extract<PhysicalResolution, { complete: true }>, self: Player, target: Player,
): SniperRefusal {
  if (foreignFallOrBurial(forecast, self, target)) return "attribution étrangère";
  if (forecast.destruction.some((event) => event.victimId === target.id && event.cause === "health-zero")) {
    return "destruction health-zero";
  }
  if (forecast.destruction.some((event) => event.victimId === target.id && event.cause === "out-of-bounds")) {
    return "hors carte";
  }
  if (forecast.damage.some((event) => event.victimId === target.id && event.source === "fall")) {
    return "chute sans dommage";
  }
  const blast = (event: CombatDamageEvent) => event.victimId === target.id && event.source === "projectile" &&
    event.healthDamageMilli + event.shieldLostMilli > 0;
  if (forecast.damage.some(blast)) return "souffle seul";
  return "excavation seule";
}

/** Null means the complete forecast satisfies the DRILLER proof. ROCK is rejected before the search. */
export function sniperDrillerRefusal(
  forecast: PhysicalResolution, self: Player, target: Player,
): SniperRefusal | null {
  if (!forecast.complete) return "prévision incomplète";
  if (!forecast.survivors.includes(self.id)) return "tireur détruit";
  const hits = forecast.hits.filter((hit) => hit.shotId === FORECAST_SHOT_ID && hit.weaponId === "DRILLER");
  if (hits.some((hit) => hit.directTargetId !== undefined)) return "impact direct";
  if (!hits.some((hit) => hit.directTargetId === undefined)) return "pas d'impact terrain";
  const support = forecast.support.find((entry) => entry.playerId === target.id);
  if (!support || !(support.after > support.before)) return "sans perte de support";
  const damagingFall = forecast.damage.some((event) => attributed(event, self, target, "DRILLER") &&
    event.source === "fall" && event.healthDamageMilli > 0);
  const burial = forecast.destruction.some((event) => attributed(event, self, target, "DRILLER") &&
    (event.cause === "buried" || event.cause === "lava"));
  return damagingFall || burial ? null : drillerConsequenceRefusal(forecast, self, target);
}

export function prefer(candidate: { destroyed: boolean; loss: number; weaponId: WeaponId }, current: { destroyed: boolean; loss: number; weaponId: WeaponId }): boolean {
  if (candidate.destroyed !== current.destroyed) return candidate.destroyed;
  if (candidate.loss !== current.loss) return candidate.loss > current.loss;
  if (candidate.weaponId !== current.weaponId) return candidate.weaponId === "BULLET";
  return false;
}

function pickBest(ranked: readonly RankedCandidate[]): { best: RankedCandidate; runner?: RankedCandidate } {
  let best = ranked[0];
  let runner: RankedCandidate | undefined;
  for (const candidate of ranked.slice(1)) {
    if (prefer(candidate, best)) {
      if (!runner || prefer(best, runner)) runner = best;
      best = candidate;
    } else if (!runner || prefer(candidate, runner)) {
      runner = candidate;
    }
  }
  return { best, runner };
}

function rankedReason(best: RankedCandidate, runner: RankedCandidate | undefined): SniperSelectionReason {
  if (!runner) return "seul candidat";
  if (best.destroyed !== runner.destroyed) return "destruction de la cible";
  if (best.loss !== runner.loss) return "perte réelle supérieure";
  if (best.weaponId !== runner.weaponId) return "BULLET à égalité";
  return "point ou arc antérieur";
}

export function ordinaryTankPoint(target: Player): TacticalPoint {
  return { x: target.tank.position.x, y: target.tank.position.y - 6, kind: "tank" };
}

export function selfLoss(forecast: PhysicalResolution, self: Player): number {
  return forecast.damage.reduce((sum, event) => event.shotId === FORECAST_SHOT_ID &&
    event.shooterId === self.id && event.victimId === self.id
    ? sum + event.healthDamageMilli + event.shieldLostMilli : sum, 0);
}

/** Applies only to fallback; the principal BULLET/DRILLER proofs stay unchanged. */
export function sniperFallbackRefusal(forecast: PhysicalResolution, self: Player, target: Player, weapon: WeaponId): SniperRefusal | null {
  if (!forecast.complete) return "prévision incomplète";
  if (!forecast.survivors.includes(self.id)) return "tireur détruit";
  return selfLoss(forecast, self) > 0 && !targetDestroyed(forecast, self, target, weapon) ? "autodégâts" : null;
}

export function retainSniperChoiceForecast(choice: SniperPhysicalChoice, forecast: PhysicalResolution): void {
  choiceForecasts.set(choice, forecast);
}

function missileUseful(forecast: PhysicalResolution, self: Player, target: Player): boolean {
  return forecast.complete && forecast.survivors.includes(self.id) &&
    hasPhysicalEffect(forecast, self, new Set([target.id])) &&
    sniperFallbackRefusal(forecast, self, target, "MISSILE") === null;
}

function missileSurviving(forecast: PhysicalResolution, self: Player): boolean {
  return forecast.complete && forecast.survivors.includes(self.id) && selfLoss(forecast, self) === 0;
}

/**
 * Ranks BULLET and DRILLER after one shared offset. MISSILE is reached only when neither proof holds.
 * The caller records the attempt, draws the offset and applies reaction and gaffe on the returned raw command.
 */
export function chooseSniperPhysicalShot(
  self: Player,
  target: Player,
  state: GameState,
  terrain: TerrainManager,
  offset: number,
  solve: MaterialSolver,
  observe = false,
): SniperPhysicalChoice {
  const tracing = import.meta.env.DEV || observe;
  const cache = new Map<string, PhysicalResolution>();
  // Only the three ordinary-flight SNIPER weapons share this evaluation's solver.
  // Numeric Map keys preserve exact coordinates, including after the shared offset.
  const ballisticCache = new Map<number, Map<number, Map<AimVariant, ReturnType<MaterialSolver>>>>();
  const refusals: SniperRefusalTrace[] = [];
  let searches = 0;
  let solverCalls = 0;
  let ballisticCacheHits = 0;
  let forecasts = 0;
  let cacheHits = 0;
  const proofOf = (
    forecast: PhysicalResolution | null | undefined, weapon: WeaponId,
  ): Pick<SniperRefusalTrace, "directTargetId" | "supportBefore" | "supportAfter" | "loss" | "cause"> => {
    if (!forecast?.complete) return {};
    const direct = forecast.hits.find((hit) => hit.shotId === FORECAST_SHOT_ID && hit.weaponId === weapon &&
      hit.directTargetId !== undefined);
    const support = forecast.support.find((entry) => entry.playerId === target.id);
    const cause = forecast.destruction.find((event) => event.victimId === target.id)?.cause;
    return {
      ...(direct?.directTargetId ? { directTargetId: direct.directTargetId } : {}),
      ...(support ? { supportBefore: support.before, supportAfter: support.after } : {}),
      loss: targetLoss(forecast, self, target, weapon),
      ...(cause ? { cause } : {}),
    };
  };
  const note = (
    weaponId: WeaponId, point: TacticalPoint, variant: AimVariant, refusal: SniperRefusal,
    command?: AimCommand, forecast?: PhysicalResolution | null,
  ) => {
    if (!tracing) return;
    refusals.push({
      weaponId, kind: point.kind, variant, x: point.x, y: point.y, refusal,
      ...(command ? { command } : {}),
      ...proofOf(forecast, weaponId),
    });
  };
  const summarize = (weaponId: WeaponId, found: SearchResult): SniperCandidateSummary => {
    const forecast = found.forecast;
    const cause = forecast?.complete
      ? forecast.destruction.find((event) => attributed(event, self, target, weaponId))?.cause
      : undefined;
    return {
      weaponId, kind: found.point.kind, variant: found.variant, x: found.point.x, y: found.point.y,
      command: found.command,
      destroyed: forecast ? targetDestroyed(forecast, self, target, weaponId) : false,
      loss: forecast ? targetLoss(forecast, self, target, weaponId) : 0,
      ...(cause ? { cause } : {}),
    };
  };
  const searchOne = (point: TacticalPoint, weapon: WeaponId, variant: AimVariant): SearchResult => {
    searches += 1;
    const aimedPoint = { ...point, x: point.x + offset };
    let byY = ballisticCache.get(aimedPoint.x);
    if (!byY) { byY = new Map(); ballisticCache.set(aimedPoint.x, byY); }
    let byArc = byY.get(aimedPoint.y);
    if (!byArc) { byArc = new Map(); byY.set(aimedPoint.y, byArc); }
    let solution = byArc.get(variant);
    if (solution) ballisticCacheHits += 1;
    else {
      solverCalls += 1;
      solution = solve(aimedPoint, weapon, variant);
      byArc.set(variant, solution);
    }
    const rawCommand = solution.command;
    const command = finalizeAdvancedAim(rawCommand);
    if (!solution.complete) {
      note(weapon, point, variant, "recherche incomplète", command);
      return { point, variant, rawCommand, command, forecast: null };
    }
    const key = JSON.stringify([weapon, command.angle, command.power]);
    let forecast = cache.get(key);
    if (forecast) cacheHits += 1;
    else {
      forecasts += 1;
      forecast = resolvePhysicalShot(state, terrain, self, weapon, command, { captureAfterState: true });
      cache.set(key, forecast);
    }
    if (!forecast.complete) note(weapon, point, variant, "prévision incomplète", command, forecast);
    return { point, variant, rawCommand, command, forecast };
  };
  const ranked: RankedCandidate[] = [];
  const consider = (weapon: "BULLET" | "DRILLER", limit: number, refusalOf: (forecast: PhysicalResolution) => SniperRefusal | null) => {
    let used = 0;
    for (const point of localMaterialPoints(self, target, weapon, terrain)) {
      for (const variant of ARCS) {
        if (used >= limit || searches >= SNIPER_SEARCH_LIMITS.total) return;
        used += 1;
        const found = searchOne(point, weapon, variant);
        const forecast = found.forecast;
        if (!forecast || !forecast.complete) continue;
        const refusal = refusalOf(forecast);
        if (refusal) {
          note(weapon, point, variant, refusal, found.command, forecast);
          continue;
        }
        ranked.push({
          ...found,
          weaponId: weapon,
          destroyed: targetDestroyed(forecast, self, target, weapon),
          loss: targetLoss(forecast, self, target, weapon),
        });
      }
    }
  };

  if (stock(self, "BULLET") <= 0) note("BULLET", ordinaryTankPoint(target), "full", "stock vide");
  else consider("BULLET", SNIPER_SEARCH_LIMITS.bullet, (forecast) => sniperBulletRefusal(forecast, self, target));

  const material = terrain.getMaterialAt(target.tank.position.x);
  if (stock(self, "DRILLER") <= 0) note("DRILLER", ordinaryTankPoint(target), "full", "stock vide");
  else if (material === TERRAIN_MATERIAL.ROCK) note("DRILLER", ordinaryTankPoint(target), "full", "veto ROCK");
  else consider("DRILLER", SNIPER_SEARCH_LIMITS.driller, (forecast) => sniperDrillerRefusal(forecast, self, target));

  const missilePoints = localMaterialPoints(self, target, "MISSILE", terrain);
  const allMissileArcs: { point: TacticalPoint; variant: AimVariant }[] = [];
  for (const point of missilePoints) {
    for (const variant of ARCS) {
      allMissileArcs.push({ point, variant });
    }
  }

  let choice: Omit<SniperPhysicalChoice, "trace"> | undefined;
  let retainedForecast: PhysicalResolution | null | undefined;
  let selectionReason: SniperSelectionReason;
  let runnerUp: SniperCandidateSummary | undefined;
  let usedMissile = 0;
  if (ranked.length > 0) {
    const picked = pickBest(ranked);
    const best = picked.best;
    retainedForecast = best.forecast;
    selectionReason = rankedReason(best, picked.runner);
    if (tracing && picked.runner) runnerUp = summarize(picked.runner.weaponId, picked.runner);
    choice = {
      weaponId: best.weaponId,
      point: best.point,
      variant: best.variant,
      rawCommand: best.rawCommand,
      command: best.command,
      certified: true,
      reason: best.weaponId === "BULLET" ? "bullet" : "driller",
    };
  } else {
    let useful: SearchResult | undefined;
    let surviving: SearchResult | undefined;
    let ordinary: SearchResult | undefined;
    missileArcs: for (const { point, variant } of allMissileArcs) {
      if (usedMissile >= SNIPER_SEARCH_LIMITS.missile || searches >= SNIPER_SEARCH_LIMITS.total) break missileArcs;
      usedMissile += 1;
      const found = searchOne(point, "MISSILE", variant);
      if (point.kind === "tank" && variant === "full") ordinary = found;
      if (!found.forecast) continue;
      if (missileUseful(found.forecast, self, target)) {
        useful = found;
        break missileArcs;
      }
      if (!surviving && missileSurviving(found.forecast, self)) surviving = found;
      else if (found.forecast.complete && !found.forecast.survivors.includes(self.id)) {
        note("MISSILE", point, variant, "tireur détruit", found.command, found.forecast);
      } else if (found.forecast.complete) note("MISSILE", point, variant,
        sniperFallbackRefusal(found.forecast, self, target, "MISSILE") ?? "sans effet", found.command, found.forecast);
    }
    const selected = useful ?? surviving ?? ordinary;
    retainedForecast = selected?.forecast;
    const tank = ordinaryTankPoint(target);
    if (tracing && surviving && selected !== surviving) {
      note("MISSILE", surviving.point, surviving.variant, "survivant écarté", surviving.command, surviving.forecast);
    }
    if (useful && selected === useful) selectionReason = "repli utile";
    else if (surviving && selected === surviving) selectionReason = "repli survivant";
    else if (selected) selectionReason = "secours ordinaire";
    else selectionReason = "secours synthétique";
    if (tracing && selected === useful && surviving) runnerUp = summarize("MISSILE", surviving);
    choice = selected
      ? {
        weaponId: "MISSILE",
        point: selected.point,
        variant: selected.variant,
        rawCommand: selected.rawCommand,
        command: selected.command,
        certified: selected === useful || selected === surviving,
        reason: selected === useful ? "missile-useful" : selected === surviving ? "missile-surviving" : "missile-ordinary",
      }
      : {
        weaponId: "MISSILE",
        point: tank,
        variant: "full",
        rawCommand: { angle: 45, power: 50 },
        command: finalizeAdvancedAim({ angle: 45, power: 50 }),
        certified: false,
        reason: "missile-ordinary",
      };
  }

  const initialMissileUsed = usedMissile;
  let continuationConsumed = false;
  const runContinuation = (): SniperContinuationOutcome => {
    if (continuationConsumed) {
      return { success: false, counters: { searches: 0, solverCalls: 0, ballisticCacheHits: 0, forecasts: 0, cacheHits: 0 } };
    }
    continuationConsumed = true;
    const startSearches = searches;
    const startSolverCalls = solverCalls;
    const startBallisticHits = ballisticCacheHits;
    const startForecasts = forecasts;
    const startCacheHits = cacheHits;

    const lethalCandidates: { found: SearchResult; loss: number }[] = [];
    let currentMissileUsed = initialMissileUsed;
    for (let i = initialMissileUsed; i < allMissileArcs.length; i++) {
      if (currentMissileUsed >= SNIPER_SEARCH_LIMITS.missile || searches >= SNIPER_SEARCH_LIMITS.total) break;
      currentMissileUsed += 1;
      const { point, variant } = allMissileArcs[i];
      const found = searchOne(point, "MISSILE", variant);
      if (!found.forecast || !found.forecast.complete) continue;
      if (!found.forecast.survivors.includes(self.id)) {
        note("MISSILE", point, variant, "tireur détruit", found.command, found.forecast);
        continue;
      }
      if (!targetDestroyed(found.forecast, self, target, "MISSILE")) {
        note("MISSILE", point, variant,
          sniperFallbackRefusal(found.forecast, self, target, "MISSILE") ?? "sans effet", found.command, found.forecast);
        continue;
      }
      if (sniperFallbackRefusal(found.forecast, self, target, "MISSILE") !== null) {
        note("MISSILE", point, variant,
          sniperFallbackRefusal(found.forecast, self, target, "MISSILE")!, found.command, found.forecast);
        continue;
      }
      const loss = targetLoss(found.forecast, self, target, "MISSILE");
      lethalCandidates.push({ found, loss });
    }

    const counters = {
      searches: searches - startSearches,
      solverCalls: solverCalls - startSolverCalls,
      ballisticCacheHits: ballisticCacheHits - startBallisticHits,
      forecasts: forecasts - startForecasts,
      cacheHits: cacheHits - startCacheHits,
    };

    if (lethalCandidates.length === 0) {
      return { success: false, counters };
    }

    let best = lethalCandidates[0];
    for (const cand of lethalCandidates.slice(1)) {
      if (cand.loss > best.loss) best = cand;
    }

    const continuationChoice: SniperPhysicalChoice = {
      weaponId: "MISSILE",
      point: best.found.point,
      variant: best.found.variant,
      rawCommand: best.found.rawCommand,
      command: best.found.command,
      certified: true,
      reason: "missile-useful",
      trace: {
        selectionReason: "destruction de la cible",
        admissible: tracing ? [summarize("MISSILE", best.found)] : [],
        refusals,
        searches,
        solverCalls,
        ballisticCacheHits,
        forecasts,
        cacheHits,
      },
    };
    choiceForecasts.set(continuationChoice, best.found.forecast!);
    return {
      success: true,
      candidate: { choice: continuationChoice, forecast: best.found.forecast! },
      counters,
    };
  };

  const result: SniperPhysicalChoice = {
    ...choice,
    trace: {
      selectionReason,
      ...(runnerUp ? { runnerUp } : {}),
      admissible: tracing ? ranked.map((candidate) => summarize(candidate.weaponId, candidate)) : [],
      refusals,
      searches,
      solverCalls,
      ballisticCacheHits,
      forecasts,
      cacheHits,
    },
  };
  if (retainedForecast) choiceForecasts.set(result, retainedForecast);
  sniperChoiceContinuations.set(result, runContinuation);
  return result;
}
