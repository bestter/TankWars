import type { Player } from "../../../types/player";
import { WEAPON_REGISTRY, type WeaponId } from "../../../types/weapon";
import { TANK_HITBOX_WIDTH } from "../../combatConstants";
import type { TerrainManager } from "../../engine/Terrain";
import type { AimCommand } from "./aimCorruption";
import { searchBallisticSolution } from "./BallisticsSimulator";

/** The same bounded #212 search serves ideal forecasts and the final fallible aim. */
export function solveExpertAim(
  self: Player,
  targetX: number,
  targetY: number,
  wind: number,
  gravity: number,
  terrain: TerrainManager,
  weaponId: WeaponId,
): { command: AimCommand; complete: boolean } {
  const sx = self.tank.position.x;
  const sy = self.tank.position.y;
  const isRight = targetX - sx > 0;
  const blastRadius = WEAPON_REGISTRY[weaponId].blastRadius;
  const best = searchBallisticSolution({
    sx,
    sy,
    tx: targetX,
    ty: targetY,
    wind,
    gravity,
    terrain,
    isRight,
    aMin: isRight ? 15 : 95,
    aMax: isRight ? 85 : 165,
    coarseStep: 5,
    fineStep: 1.5,
    fineWindow: 4,
    powerLo: 20,
    powerHi: 95,
    powerIterations: 10,
    obstaclePenaltyHigh: 10000,
    obstaclePenaltyLow: 20,
    weaponId,
    earlyExitError: 4,
    selfHarmPenalty: (landX, landY) =>
      Math.hypot(landX - sx, landY - sy) <= blastRadius + TANK_HITBOX_WIDTH ? 50000 : 0,
  });
  return {
    command: {
      angle: Math.max(6, Math.min(174, best.angle)),
      power: Math.max(25, Math.min(95, best.power)),
    },
    complete: best.complete !== false,
  };
}
