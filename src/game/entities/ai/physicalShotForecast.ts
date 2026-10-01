import type { GameState } from "../../../types/game";
import type { Player } from "../../../types/player";
import type { WeaponId } from "../../../types/weapon";
import type { CombatDamageEvent, CombatDestructionEvent } from "../../economy/shotRewards";
import { PhysicsEngine, type ProjectileHitEvent } from "../../engine/PhysicsEngine";
import { TerrainManager } from "../../engine/Terrain";
import { TankManager } from "../TankManager";
import { aggregateExpertConsequences, type ExpertConsequences } from "./expertConsequences";

const PHYSICS_DT = 1 / 120;
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

/** Resolves a normalized ideal command without economics or any live side effects. */
export function resolvePhysicalShot(
  state: GameState,
  terrain: TerrainManager,
  shooter: Player,
  weaponId: WeaponId,
  command: { angle: number; power: number },
): PhysicalResolution {
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
  const supportBefore = state.players.map((player) => terrain.getHeightAt(player.tank.position.x));
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
