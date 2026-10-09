import type { GameState } from "../../../types/game";
import type { Player } from "../../../types/player";
import type { WeaponId } from "../../../types/weapon";
import type { CombatDamageEvent, CombatDestructionEvent } from "../../economy/shotRewards";
import { PhysicsEngine, type ProjectileHitEvent } from "../../engine/PhysicsEngine";
import { TerrainManager } from "../../engine/Terrain";
import { TankManager } from "../TankManager";
import { applyBulldozerHit } from "../../engine/bulldozerImpact";
import { BALLISTICS_DT, launchFromBarrel } from "../../engine/projectileMotion";
import type { DirectBulldozerTrajectory } from "./BallisticsSimulator";
import { aggregateExpertConsequences, type ExpertConsequences } from "./expertConsequences";

const PHYSICS_DT = BALLISTICS_DT;
export const FORECAST_MAX_STEPS = 2400;
export const FORECAST_SHOT_ID = 1;
interface PhysicalResolutionBase {
  readonly hits: readonly ProjectileHitEvent[];
  readonly damage: readonly CombatDamageEvent[];
  readonly destruction: readonly CombatDestructionEvent[];
  readonly survivors: readonly string[];
  readonly support: readonly { playerId: string; x: number; before: number; after: number }[];
  readonly steps: number;
}
export type PhysicalResolution = PhysicalResolutionBase & (
  { readonly complete: true } & ExpertConsequences | { readonly complete: false }
);

function createResolution(state: GameState, terrain: TerrainManager, shooter: Player, weaponId: WeaponId) {
  const players = structuredClone(state.players);
  const copiedTerrain = new TerrainManager(terrain.width, terrain.height);
  copiedTerrain.loadHeights([...terrain.getHeightmap()], [...terrain.getMaterials()]);
  const tanks = new TankManager();
  tanks.setPlayers(players);
  const hits: ProjectileHitEvent[] = [];
  const damage: CombatDamageEvent[] = [];
  const destruction: CombatDestructionEvent[] = [];
  tanks.onDamageApplied = (event) => damage.push(event);
  tanks.onTankDestroyed = (event) => destruction.push(event);
  const supportBefore = state.players.map((player) => terrain.getHeightAt(player.tank.position.x));
  tanks.beginShotAttribution(FORECAST_SHOT_ID, shooter.id, weaponId);
  return { players, copiedTerrain, tanks, hits, damage, destruction, supportBefore };
}

function finishResolution(
  state: GameState, shooter: Player, resolution: ReturnType<typeof createResolution>, complete: boolean, steps: number,
): PhysicalResolution {
  const { players, copiedTerrain, tanks, hits, damage, destruction, supportBefore } = resolution;
  if (!complete) {
    return { complete: false, hits: [], damage: [], destruction: [], survivors: [], support: [], steps };
  }
  const survivors = tanks.getAlivePlayers().map((player) => player.id);
  return {
    complete: true,
    ...aggregateExpertConsequences(players, FORECAST_SHOT_ID, shooter.id, damage, destruction),
    hits,
    damage,
    destruction,
    survivors,
    support: state.players.map((player, index) => ({
      playerId: player.id, x: player.tank.position.x, before: supportBefore[index],
      after: copiedTerrain.getHeightAt(player.tank.position.x),
    })),
    steps,
  };
}

/** Resolves a normalized ideal command without economics or any live side effects. */
export function resolvePhysicalShot(
  state: GameState, terrain: TerrainManager, shooter: Player, weaponId: WeaponId,
  command: { angle: number; power: number },
): PhysicalResolution {
  const resolution = createResolution(state, terrain, shooter, weaponId);
  const { tanks, copiedTerrain, hits } = resolution;
  const physics = new PhysicsEngine(() => 0.5, false);
  physics.onProjectileHit = (event) => hits.push(event);
  const launch = launchFromBarrel(shooter.tank.position.x, shooter.tank.position.y, command.angle);
  physics.launchProjectile(launch.x, launch.y, command.angle, command.power, weaponId,
    shooter.id, shooter.tank.color, { shotId: FORECAST_SHOT_ID, munitionId: 0 });
  let complete = false;
  let steps = 0;
  for (let step = 0; step < FORECAST_MAX_STEPS; step++) {
    steps++;
    physics.updateProjectiles(PHYSICS_DT, state.gravity, state.windForce, copiedTerrain, tanks);
    tanks.applyGravity(PHYSICS_DT, copiedTerrain);
    tanks.checkTankBurial(copiedTerrain);
    if (!physics.hasActiveProjectiles() && !tanks.anyTankIsFalling()) {
      complete = true;
      break;
    }
  }
  return finishResolution(state, shooter, resolution, complete, steps);
}

/** Direct search has already established the impact: no PhysicsEngine or projectile here. */
export function resolveBulldozerImpact(
  state: GameState, terrain: TerrainManager, shooter: Player, hit: DirectBulldozerTrajectory,
): PhysicalResolution {
  const resolution = createResolution(state, terrain, shooter, "BULLDOZER");
  const { tanks, copiedTerrain, hits } = resolution;
  if (hit.terminal !== "tank" || !hit.targetId) return finishResolution(state, shooter, resolution, false, 0);
  applyBulldozerHit(hit.targetId, hit.vx, shooter.id, 0, copiedTerrain, tanks);
  tanks.updateTankPositions(copiedTerrain);
  tanks.checkTankBurial(copiedTerrain);
  hits.push({ shotId: FORECAST_SHOT_ID, munitionId: 0, weaponId: "BULLDOZER",
    x: hit.x, y: hit.y, directTargetId: hit.targetId });
  for (let step = 1; step <= FORECAST_MAX_STEPS; step++) {
    tanks.applyGravity(PHYSICS_DT, copiedTerrain);
    tanks.checkTankBurial(copiedTerrain);
    if (!tanks.anyTankIsFalling()) return finishResolution(state, shooter, resolution, true, step);
  }
  return finishResolution(state, shooter, resolution, false, FORECAST_MAX_STEPS);
}
