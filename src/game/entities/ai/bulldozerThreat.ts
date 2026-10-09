import type { GameState } from "../../../types/game";
import type { Player } from "../../../types/player";
import { BULLDOZER_PUSH_FACTOR, MAX_BULLDOZER_PUSH, WEAPON_REGISTRY } from "../../../types/weapon";
import { BOTTOM_SUPPORT_MARGIN, TANK_HITBOX_WIDTH } from "../../combatConstants";
import { calculateShotRewards } from "../../economy/shotRewards";
import type { TerrainManager } from "../../engine/Terrain";
import type { AimCommand } from "./aimCorruption";
import { searchDirectBulldozerSolutions } from "./BallisticsSimulator";
import type { ExpertForecastCache } from "./expertShotEvaluator";
import { FORECAST_SHOT_ID, resolveBulldozerImpact, type PhysicalResolution } from "./physicalShotForecast";

export interface LethalBulldozerThreat {
  readonly command: Readonly<AimCommand>;
  readonly expertDestroyed: true;
  readonly shooterDestroyed: boolean;
  readonly profit: number;
  readonly forecast: PhysicalResolution & { readonly complete: true };
}

export interface BulldozerThreatSearch {
  readonly best: LethalBulldozerThreat | null;
  readonly simulations: number;
}

export function canThreatenWithBulldozer(player: Player): boolean {
  if (player.tank.isDead || (player.inventory.BULLDOZER ?? 0) <= 0) return false;
  if (player.isHuman) return true;
  switch (player.aiProfile) {
    case "v3-sniper": return false;
    case "v2-heuristic":
    case "v4-smart": return true;
    default: return player.tank.currentWeapon === "BULLDOZER";
  }
}

/** A deliberately narrow proof: every possible target stop stays on the same safe plane.
 * Other tanks must be stable and unable to enter that corridor, even under recoil.
 */
export function isBulldozerCorridorSafe(self: Player, players: readonly Player[], terrain: TerrainManager): boolean {
  const { x, y } = self.tank.position;
  if (self.tank.isDead || !(self.tank.health > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  const minimum = x - MAX_BULLDOZER_PUSH - TANK_HITBOX_WIDTH / 2;
  const maximum = x + MAX_BULLDOZER_PUSH + TANK_HITBOX_WIDTH / 2;
  if (minimum < 0 || maximum >= terrain.width || y >= terrain.lavaTop ||
    y >= terrain.height - BOTTOM_SUPPORT_MARGIN) return false;
  for (let column = Math.floor(minimum); column <= Math.floor(maximum); column++) {
    if (terrain.getHeightAt(column) !== y) return false;
  }
  for (const player of players) {
    if (player.tank.isDead) continue;
    const position = player.tank.position;
    if (!(player.tank.health > 0) || !Number.isFinite(position.x) || !Number.isFinite(position.y) ||
      position.x < 0 || position.x >= terrain.width || position.y !== terrain.getHeightAt(position.x) ||
      position.y >= terrain.lavaTop || position.y >= terrain.height - BOTTOM_SUPPORT_MARGIN) return false;
    if (player.id !== self.id &&
      position.x + MAX_BULLDOZER_PUSH + TANK_HITBOX_WIDTH / 2 >= minimum &&
      position.x - MAX_BULLDOZER_PUSH - TANK_HITBOX_WIDTH / 2 <= maximum) return false;
  }
  return true;
}

/** A cache entry, including a negative result, is valid only for this decision snapshot. */
export function evaluateBulldozerThreat(
  state: GameState, terrain: TerrainManager, shooter: Player, self: Player, cache: ExpertForecastCache,
): BulldozerThreatSearch {
  const cached = cache.bulldozer.get(shooter.id);
  if (cached) return cached;
  let best: LethalBulldozerThreat | null = null;
  let simulations = 0;
  if (state.localShotContext && canThreatenWithBulldozer(shooter) &&
    !isBulldozerCorridorSafe(self, state.players, terrain)) {
    for (const { command, trajectory } of searchDirectBulldozerSolutions({
      shooter, target: self, players: state.players, terrain, wind: state.windForce, gravity: state.gravity,
    })) {
      simulations++;
      if (trajectory.terminal !== "tank" || trajectory.targetId !== self.id ||
        Math.min(Math.abs(trajectory.vx) * BULLDOZER_PUSH_FACTOR, MAX_BULLDOZER_PUSH) <= 0) continue;
      const forecast = resolveBulldozerImpact(state, terrain, shooter, trajectory);
      if (!forecast.complete || forecast.survivors.includes(self.id)) continue;
      const rewards = calculateShotRewards({
        shotId: FORECAST_SHOT_ID, shooterId: shooter.id, weaponId: "BULLDOZER",
        playerCountAtMatchStart: state.localShotContext.playerCountAtMatchStart,
        isFirstShotOfRound: false,
        aliveBeforeShot: state.players.filter((player) => !player.tank.isDead).map((player) => player.id),
        survivorsAfterShot: [...forecast.survivors],
        damageEvents: [...forecast.damage], destructionEvents: [...forecast.destruction],
      });
      const profit = (rewards.awards.find((award) => award.playerId === shooter.id)?.amount ?? 0) -
        WEAPON_REGISTRY.BULLDOZER.price;
      const candidate: LethalBulldozerThreat = {
        command, expertDestroyed: true, shooterDestroyed: !forecast.survivors.includes(shooter.id), profit, forecast,
      };
      if (!best || Number(candidate.shooterDestroyed) < Number(best.shooterDestroyed) ||
        (candidate.shooterDestroyed === best.shooterDestroyed && candidate.profit > best.profit)) best = candidate;
    }
  }
  const result = { best, simulations };
  cache.bulldozer.set(shooter.id, result);
  return result;
}
