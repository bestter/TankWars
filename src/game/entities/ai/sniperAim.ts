import type { Player } from "../../../types/player";
import type { WeaponId } from "../../../types/weapon";
import type { TerrainManager } from "../../engine/Terrain";
import { searchBallisticSolution } from "./BallisticsSimulator";
import { aimCone, type AimVariant } from "./aimSearch";
import type { AimCommand } from "./aimCorruption";

export function solveSniperAim(
  self: Player, targetX: number, targetY: number, wind: number, gravity: number,
  terrain: TerrainManager, weaponId?: WeaponId, variant: AimVariant = "full",
): { command: AimCommand; complete: boolean } {
  const sx = self.tank.position.x;
  const sy = self.tank.position.y;
  const isRight = targetX - sx > 0;
  const aMin = isRight ? 15 : 95;
  const aMax = isRight ? 85 : 165;
  const best = searchBallisticSolution({
    sx,
    sy,
    tx: targetX,
    ty: targetY,
    wind,
    gravity,
    terrain,
    isRight,
    ...aimCone(isRight, aMin, aMax, variant),
    projectFallbackToCone: variant !== "full",
    weaponId,
    coarseStep: 5,
    fineStep: 1,
    fineWindow: 4,
    powerLo: 20,
    powerHi: 95,
    powerIterations: 10,
    obstaclePenaltyHigh: 10000,
    earlyExitError: 2,
  });
  return { command: { angle: best.angle, power: best.power }, complete: best.complete !== false };
}
