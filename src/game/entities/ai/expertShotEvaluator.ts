import type { GameState } from "../../../types/game";
import type { Player } from "../../../types/player";
import { WEAPON_REGISTRY, type WeaponId } from "../../../types/weapon";
import { TANK_HITBOX_HEIGHT, TANK_HITBOX_WIDTH } from "../../combatConstants";
import { calculateShotRewards } from "../../economy/shotRewards";
import { TerrainManager } from "../../engine/Terrain";
import { solveExpertAim } from "./expertAim";
import { finalizeAdvancedAim } from "./aimCorruption";
import { compareExpertConsequences, type ExpertConsequences } from "./expertConsequences";

import { resolvePhysicalShot, FORECAST_SHOT_ID, FORECAST_MAX_STEPS, type PhysicalResolution } from "./physicalShotForecast";
import { TERRAIN_MATERIAL } from "../../../types/terrain";
import { materialBoundaryPoints, bulldozerPoint } from "./materialCandidates";
import { hasPhysicalEffect } from "./localMaterialPlanner";
import { MATERIAL_AIM_VARIANTS, ORDINARY_AIM_POLICY, type AimSearchPolicy } from "./aimSearch";
export const EXPERT_FORECAST_MAX_STEPS = FORECAST_MAX_STEPS;

export interface ExpertPoint {
  readonly x: number;
  readonly y: number;
  readonly origin?: "boundary";
  readonly kind: "tank" | "terrain" | "pair";
}

interface ExpertShotBase {
  readonly profit: number;
  readonly destroyedIds: ReadonlySet<string>;
  readonly shooterDestroyed: boolean;
  readonly pointOrder: number;
  /** Available for development diagnostics without repeating the physical forecast. */
  readonly forecast?: DecisionForecast;
  readonly policy?: AimSearchPolicy;
  readonly idealCommand?: { readonly angle: number; readonly power: number };
}

export interface ValidExpertShotResult extends ExpertShotBase, ExpertConsequences {
  readonly destination: ExpertPoint;
}

export type ExpertShotResult = ValidExpertShotResult | (ExpertShotBase & {
  readonly destination: -1;
});

export function isValidExpertShot(result: ExpertShotResult): result is ValidExpertShotResult {
  return result.destination !== -1;
}

export type PhysicalForecast = PhysicalResolution & { readonly profit: number };
type DecisionForecast = PhysicalResolution & { readonly profit: number | null };

/** One cache belongs to one immutable decision snapshot. No entries survive the decision. */
export interface ExpertForecastCache {
  readonly search: Map<string, ReturnType<typeof solveExpertAim>>;
  readonly physics: Map<string, DecisionForecast>;
  readonly diagnostics?: { ownProposals: number; adverseProposals: number; drillerRockRejections: number };
}

export function createExpertForecastCache(): ExpertForecastCache {
  return { search: new Map(), physics: new Map(), diagnostics: import.meta.env.DEV
    ? { ownProposals: 0, adverseProposals: 0, drillerRockRejections: 0 } : undefined };
}

function tankCenter(player: Player): ExpertPoint {
  return {
    x: player.tank.position.x,
    y: player.tank.position.y - TANK_HITBOX_HEIGHT / 2,
    kind: "tank",
  };
}

function groundPoint(x: number, terrain: TerrainManager): ExpertPoint | null {
  return x >= 0 && x < terrain.width
    ? { x, y: terrain.getHeightAt(x), kind: "terrain" }
    : null;
}

/** Tactical points are generated in ticket order, with no edge clamping. */
export function expertTacticalPoints(
  shooter: Player,
  targets: readonly Player[],
  weaponId: WeaponId,
  terrain: TerrainManager,
  roster: readonly Player[],
  mode: "own" | "adverse" = "adverse",
): ExpertPoint[] {
  const radius = WEAPON_REGISTRY[weaponId].blastRadius;
  const points: ExpertPoint[] = [];
  if (targets.length === 1) {
    const target = targets[0];
    const center = tankCenter(target);
    if (center.x >= 0 && center.x < terrain.width) points.push(center);
    if (radius > 0) {
      for (const x of [center.x - radius / 2, center.x + radius / 2]) {
        const point = groundPoint(x, terrain);
        if (point) points.push(point);
      }
    }
  } else if (targets.length === 2) {
    const a = tankCenter(targets[0]);
    const b = tankCenter(targets[1]);
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, kind: "pair" as const };
    if (midpoint.x >= 0 && midpoint.x < terrain.width) points.push(midpoint);
  }
  if (weaponId === "DRILLER" && targets.length > 0) {
    const nearest = [...targets].sort((a, b) =>
      Math.abs(a.tank.position.x - shooter.tank.position.x) -
        Math.abs(b.tank.position.x - shooter.tank.position.x) ||
      roster.indexOf(a) - roster.indexOf(b))[0];
    const side = shooter.tank.position.x <= nearest.tank.position.x ? -1 : 1;
    const offset = TANK_HITBOX_WIDTH / 2 + radius / 2;
    const point = groundPoint(nearest.tank.position.x + side * offset, terrain);
    if (point) points.push(point);
  }
  if (mode === "own") points.push(...materialBoundaryPoints(targets, weaponId, terrain, roster));
  const seen = new Set<string>();
  return points.filter((point) => {
    const key = JSON.stringify([point.x, point.y]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function forecastPhysicalShot(
  state: GameState, terrain: TerrainManager, shooter: Player, weaponId: WeaponId,
  command: { angle: number; power: number }, isFirstShotOfRound: boolean,
): PhysicalForecast {
  const resolution = resolvePhysicalShot(state, terrain, shooter, weaponId, command);
  if (!resolution.complete) return { ...resolution, profit: 0 };
  if (!state.localShotContext) throw new Error("Economic forecast requires a round context");
  const reward = calculateShotRewards({
    shotId: FORECAST_SHOT_ID, shooterId: shooter.id, weaponId,
    playerCountAtMatchStart: state.localShotContext.playerCountAtMatchStart,
    isFirstShotOfRound,
    aliveBeforeShot: state.players.filter((player) => !player.tank.isDead).map((player) => player.id),
    survivorsAfterShot: [...resolution.survivors],
    damageEvents: [...resolution.damage], destructionEvents: [...resolution.destruction],
  });
  const award = reward.awards.find((entry) => entry.playerId === shooter.id)?.amount ?? 0;
  return { ...resolution, profit: award - (weaponId === "MISSILE" ? 0 : WEAPON_REGISTRY[weaponId].price) };
}

const INVALID: ExpertShotResult = {
  destination: -1,
  profit: 0,
  destroyedIds: new Set<string>(),
  shooterDestroyed: false,
  pointOrder: -1,
};

export type ExpertEvaluationMode = "own" | "adverse";

/** Search and physical caches belong to one decision, including its ordinary fallback. */
function* expertProposals(
  state: GameState, terrain: TerrainManager, shooter: Player, weaponId: WeaponId,
  targets: readonly Player[], isFirstShotOfRound: boolean, cache: ExpertForecastCache,
  mode: ExpertEvaluationMode,
): Generator<{ point: ExpertPoint; pointOrder: number; policy: AimSearchPolicy;
  command: { angle: number; power: number }; forecast: DecisionForecast }> {
  const points = weaponId === "BULLDOZER" ? [bulldozerPoint(targets[0])] :
    expertTacticalPoints(shooter, targets, weaponId, terrain, state.players, mode);
  const variants = mode === "own" ? MATERIAL_AIM_VARIANTS : ["full"] as const;
  for (const [pointOrder, point] of points.entries()) {
    for (const variant of variants) {
      if (cache.diagnostics) {
        if (mode === "own") cache.diagnostics.ownProposals++;
        else cache.diagnostics.adverseProposals++;
      }
      const policy: AimSearchPolicy = mode === "own"
        ? { variant, penalizeProximity: false } : ORDINARY_AIM_POLICY;
      const searchKey = JSON.stringify([shooter.id, weaponId, point.x, point.y,
        state.windForce, state.gravity, policy]);
      let solution = cache.search.get(searchKey);
      if (!solution) {
        solution = solveExpertAim(shooter, point.x, point.y, state.windForce, state.gravity, terrain, weaponId, policy);
        cache.search.set(searchKey, solution);
      }
      if (!solution.complete) continue;
      const command = finalizeAdvancedAim(solution.command);
      const physicsKey = JSON.stringify([shooter.id, weaponId, command.angle, command.power,
        state.windForce, state.gravity, state.localShotContext?.playerCountAtMatchStart, isFirstShotOfRound]);
      let forecast = cache.physics.get(physicsKey);
      if (!forecast) {
        forecast = state.localShotContext
          ? forecastPhysicalShot(state, terrain, shooter, weaponId, command, isFirstShotOfRound)
          : { ...resolvePhysicalShot(state, terrain, shooter, weaponId, command), profit: null };
        cache.physics.set(physicsKey, forecast);
      }
      yield { point, pointOrder, policy, command, forecast };
    }
  }
}

export function evaluateExpertShot(
  state: GameState,
  terrain: TerrainManager,
  shooter: Player,
  weaponId: WeaponId,
  targets: readonly Player[],
  requireTargetDestruction: boolean,
  isFirstShotOfRound: boolean,
  cache: ExpertForecastCache,
  mode: ExpertEvaluationMode = "adverse",
): ExpertShotResult {
  if (weaponId === "BULLDOZER" ||
      (weaponId !== "MISSILE" && (shooter.inventory[weaponId] ?? 0) <= 0) ||
      !state.localShotContext || targets.length < 1 || targets.length > 2) return INVALID;
  if (mode === "own" && weaponId === "DRILLER" && targets.some((target) =>
    terrain.getMaterialAt(Math.floor(target.tank.position.x)) === TERRAIN_MATERIAL.ROCK)) {
    if (cache.diagnostics) cache.diagnostics.drillerRockRejections++;
    return INVALID;
  }
  let best = INVALID;
  for (const { point, pointOrder, policy, command, forecast } of expertProposals(
    state, terrain, shooter, weaponId, targets, isFirstShotOfRound, cache, mode,
  )) {
    if (!forecast.complete || forecast.profit === null) continue;
    const destroyedIds = new Set(forecast.destruction
      .filter((event) => event.shotId === FORECAST_SHOT_ID && event.shooterId === shooter.id)
      .map((event) => event.victimId));
    const hasEnemyEffect = forecast.damage.some((event) =>
      event.victimId !== shooter.id && event.shooterId === shooter.id &&
      event.shieldAbsorbedMilli + event.healthDamageMilli > 0) ||
      [...destroyedIds].some((id) => id !== shooter.id);
    if (!hasEnemyEffect || (requireTargetDestruction && !destroyedIds.has(targets[0].id))) continue;
    const pointMatches = point.kind === "tank"
      ? forecast.hits.some((hit) => hit.directTargetId === targets[0].id) ||
        forecast.damage.some((event) => event.victimId === targets[0].id &&
          event.shieldAbsorbedMilli + event.healthDamageMilli > 0) ||
        destroyedIds.has(targets[0].id)
      : forecast.hits.some((hit) => Math.hypot(hit.x - point.x, hit.y - point.y) <=
          Math.max(24, WEAPON_REGISTRY[weaponId].blastRadius));
    if (!pointMatches) continue;
    const candidate: ValidExpertShotResult = {
      humanDestroyedCount: forecast.humanDestroyedCount,
      humanDamageMilli: forecast.humanDamageMilli,
      aiDestroyedCount: forecast.aiDestroyedCount,
      aiDamageMilli: forecast.aiDamageMilli,
      destination: point,
      profit: forecast.profit,
      destroyedIds,
      shooterDestroyed: mode === "own" ? !forecast.survivors.includes(shooter.id) : destroyedIds.has(shooter.id),
      pointOrder,
      policy,
      forecast,
      idealCommand: command,
    };
    if (!isValidExpertShot(best) ||
        (Number(candidate.shooterDestroyed) - Number(best.shooterDestroyed) ||
          best.profit - candidate.profit ||
          compareExpertConsequences(candidate, best) || candidate.pointOrder - best.pointOrder) < 0) {
      best = candidate;
    }
  }
  return best;
}

export interface ExpertFallbackChoice {
  readonly weaponId: WeaponId;
  readonly point: ExpertPoint;
  readonly policy: AimSearchPolicy;
  readonly useful: boolean;
  readonly forecast?: DecisionForecast;
}

export function chooseExpertFallback(
  state: GameState, terrain: TerrainManager, self: Player, target: Player,
  ordinary: WeaponId, cache: ExpertForecastCache,
): ExpertFallbackChoice {
  let best: ExpertFallbackChoice | undefined;
  const victims = new Set(state.players.filter((player) => player.id !== self.id).map((player) => player.id));
  for (const weaponId of [...new Set([ordinary, "MISSILE" as const])]) {
    if ((weaponId !== "MISSILE" && (self.inventory[weaponId] ?? 0) <= 0) ||
      (weaponId === "DRILLER" && terrain.getMaterialAt(target.tank.position.x) === TERRAIN_MATERIAL.ROCK)) continue;
    for (const { point, policy, forecast } of expertProposals(
      state, terrain, self, weaponId, [target], state.localShotContext?.isFirstShotOfRound ?? false, cache, "own",
    )) {
      if (!forecast.complete || !forecast.survivors.includes(self.id)) continue;
      const useful = hasPhysicalEffect(forecast, self, victims);
      const previous = best?.forecast;
      const comparison = best && previous?.complete
        ? Number(best.useful) - Number(useful) ||
          (previous.profit !== null && forecast.profit !== null ? previous.profit - forecast.profit : 0) ||
          compareExpertConsequences(forecast, previous) : -1;
      if (comparison < 0) best = { weaponId, point, policy, useful, forecast };
    }
  }
  return best ?? { weaponId: "MISSILE", point: {
    x: target.tank.position.x, y: target.tank.position.y - 6, kind: "tank",
  }, policy: ORDINARY_AIM_POLICY, useful: false };
}
