import type { Player } from "../../../types/player";
import { WEAPON_REGISTRY, type WeaponId } from "../../../types/weapon";
import { TANK_HITBOX_WIDTH } from "../../combatConstants";
import type { TerrainManager } from "../../engine/Terrain";
import type { AimCommand } from "./aimCorruption";
import { aimCone, ORDINARY_AIM_POLICY, type AimSearchPolicy } from "./aimSearch";
import { searchBallisticSolution } from "./BallisticsSimulator";

/** Bounded #212 search: ideal adverse shots, offset own proposals, ordinary last resort. */
export function solveExpertAim(
  self: Player,
  targetX: number,
  targetY: number,
  wind: number,
  gravity: number,
  terrain: TerrainManager,
  weaponId: WeaponId,
  policy: AimSearchPolicy = ORDINARY_AIM_POLICY,
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
    ...aimCone(isRight, isRight ? 15 : 95, isRight ? 85 : 165, policy.variant),
    projectFallbackToCone: policy.variant !== "full",
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
    selfHarmPenalty: policy.penalizeProximity ? (landX, landY) =>
      Math.hypot(landX - sx, landY - sy) <= blastRadius + TANK_HITBOX_WIDTH ? 50000 : 0 : undefined,
  });
  return {
    command: {
      angle: Math.max(6, Math.min(174, best.angle)),
      power: Math.max(25, Math.min(95, best.power)),
    },
    complete: best.complete !== false,
  };
}
