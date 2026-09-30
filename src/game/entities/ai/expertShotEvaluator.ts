import type { GameState } from "../../../types/game";
import type { Player } from "../../../types/player";
import { WEAPON_REGISTRY, type WeaponId } from "../../../types/weapon";
import { TANK_HITBOX_HEIGHT, TANK_HITBOX_WIDTH } from "../../combatConstants";
import { calculateShotRewards, type CombatDamageEvent, type CombatDestructionEvent } from "../../economy/shotRewards";
import { PhysicsEngine, type ProjectileHitEvent } from "../../engine/PhysicsEngine";
import { TerrainManager } from "../../engine/Terrain";
import { TankManager } from "../TankManager";
import { solveExpertAim } from "./expertAim";
import { finalizeAdvancedAim } from "./aimCorruption";
import { aggregateExpertConsequences, compareExpertConsequences, type ExpertConsequences } from "./expertConsequences";

const PHYSICS_DT = 1 / 120;
/** 20 simulated seconds, per forecast. A timeout invalidates only this point. */
export const EXPERT_FORECAST_MAX_STEPS = 2400;
const FORECAST_SHOT_ID = 1;

export interface ExpertPoint {
  readonly x: number;
  readonly y: number;
  readonly kind: "tank" | "terrain" | "pair";
}

interface ExpertShotBase {
  readonly profit: number;
  readonly destroyedIds: ReadonlySet<string>;
  readonly shooterDestroyed: boolean;
  readonly pointOrder: number;
  /** Available for development diagnostics without repeating the physical forecast. */
  readonly forecast?: PhysicalForecast;
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

interface PhysicalForecastBase {
  readonly hits: readonly ProjectileHitEvent[];
  readonly damage: readonly CombatDamageEvent[];
  readonly destruction: readonly CombatDestructionEvent[];
  readonly survivors: readonly string[];
  readonly profit: number;
}

export type PhysicalForecast = PhysicalForecastBase & (
  { readonly complete: true } & ExpertConsequences | { readonly complete: false }
);

/** One cache belongs to one immutable decision snapshot. No entries survive the decision. */
export interface ExpertForecastCache {
  readonly search: Map<string, ReturnType<typeof solveExpertAim>>;
  readonly physics: Map<string, PhysicalForecast>;
}

export function createExpertForecastCache(): ExpertForecastCache {
  return { search: new Map(), physics: new Map() };
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
  return points;
}

export function forecastPhysicalShot(
  state: GameState,
  terrain: TerrainManager,
  shooter: Player,
  weaponId: WeaponId,
  command: { angle: number; power: number },
  isFirstShotOfRound: boolean,
): PhysicalForecast {
  const players = structuredClone(state.players);
  const copiedTerrain = new TerrainManager(terrain.width, terrain.height);
  copiedTerrain.loadHeights([...terrain.getHeightmap()], [...terrain.getMaterials()]);
  const tanks = new TankManager();
  tanks.setPlayers(players);
  const physics = new PhysicsEngine(() => 0.5, false);
  const hits: ProjectileHitEvent[] = [];
  const damage: CombatDamageEvent[] = [];
  const destruction: CombatDestructionEvent[] = [];
  physics.onProjectileHit = (event) => hits.push(event);
  tanks.onDamageApplied = (event) => damage.push(event);
  tanks.onTankDestroyed = (event) => destruction.push(event);
  const aliveBefore = tanks.getAlivePlayers().map((player) => player.id);
  tanks.beginShotAttribution(FORECAST_SHOT_ID, shooter.id, weaponId);
  const radians = command.angle * Math.PI / 180;
  physics.launchProjectile(
    shooter.tank.position.x + Math.cos(radians) * 20,
    shooter.tank.position.y - 13 - Math.sin(radians) * 20,
    command.angle,
    command.power,
    weaponId,
    shooter.id,
    shooter.tank.color,
    { shotId: FORECAST_SHOT_ID, munitionId: 0 },
  );
  let complete = false;
  for (let step = 0; step < EXPERT_FORECAST_MAX_STEPS; step++) {
    physics.updateProjectiles(PHYSICS_DT, state.gravity, state.windForce, copiedTerrain, tanks);
    tanks.applyGravity(PHYSICS_DT, copiedTerrain);
    tanks.checkTankBurial(copiedTerrain);
    if (!physics.hasActiveProjectiles() && !tanks.anyTankIsFalling()) {
      complete = true;
      break;
    }
  }
  if (!complete) {
    return { complete: false, hits: [], damage: [], destruction: [], survivors: [], profit: 0 };
  }
  const survivors = tanks.getAlivePlayers().map((player) => player.id);
  const reward = calculateShotRewards({
    shotId: FORECAST_SHOT_ID,
    shooterId: shooter.id,
    weaponId,
    playerCountAtMatchStart: state.localShotContext!.playerCountAtMatchStart,
    isFirstShotOfRound,
    aliveBeforeShot: aliveBefore,
    survivorsAfterShot: survivors,
    damageEvents: damage,
    destructionEvents: destruction,
  });
  const shooterAward = reward.awards.find((award) => award.playerId === shooter.id)?.amount ?? 0;
  return {
    complete: true,
    ...aggregateExpertConsequences(players, FORECAST_SHOT_ID, shooter.id, damage, destruction),
    hits,
    damage,
    destruction,
    survivors,
    profit: shooterAward - (weaponId === "MISSILE" ? 0 : WEAPON_REGISTRY[weaponId].price),
  };
}

const INVALID: ExpertShotResult = {
  destination: -1,
  profit: 0,
  destroyedIds: new Set<string>(),
  shooterDestroyed: false,
  pointOrder: -1,
};

export function evaluateExpertShot(
  state: GameState,
  terrain: TerrainManager,
  shooter: Player,
  weaponId: WeaponId,
  targets: readonly Player[],
  requireTargetDestruction: boolean,
  isFirstShotOfRound: boolean,
  cache: ExpertForecastCache,
): ExpertShotResult {
  if (weaponId === "BULLDOZER" ||
      (weaponId !== "MISSILE" && (shooter.inventory[weaponId] ?? 0) <= 0) ||
      !state.localShotContext || targets.length < 1 || targets.length > 2) return INVALID;
  const points = expertTacticalPoints(shooter, targets, weaponId, terrain, state.players);
  let best = INVALID;
  for (const [pointOrder, point] of points.entries()) {
    const searchKey = JSON.stringify([shooter.id, weaponId, point.x, point.y,
      state.windForce, state.gravity]);
    let solution = cache.search.get(searchKey);
    if (!solution) {
      solution = solveExpertAim(shooter, point.x, point.y, state.windForce,
        state.gravity, terrain, weaponId);
      cache.search.set(searchKey, solution);
    }
    if (!solution.complete) continue;
    const command = finalizeAdvancedAim(solution.command);
    const { angle, power } = command;
    const physicsKey = JSON.stringify([shooter.id, weaponId, angle, power,
      state.windForce, state.gravity, state.localShotContext.playerCountAtMatchStart,
      isFirstShotOfRound]);
    let forecast = cache.physics.get(physicsKey);
    if (!forecast) {
      forecast = forecastPhysicalShot(state, terrain, shooter, weaponId,
        command, isFirstShotOfRound);
      cache.physics.set(physicsKey, forecast);
    }
    if (!forecast.complete) continue;
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
      shooterDestroyed: destroyedIds.has(shooter.id),
      pointOrder,
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
