import type { Player } from "../../../types/player";
import type { TerrainManager } from "../../engine/Terrain";
import { searchBallisticSolution } from "./BallisticsSimulator";
import type { AimCommand } from "./aimCorruption";

/**
 * Solveur balistique de base d'OK, partagé avec SIMPLE sans importer la classe
 * AIHeuristicStrategy.
 */
export function computeHeuristicShot(
  self: Player,
  targetX: number,
  targetY: number,
  wind: number,
  gravity: number,
  terrain: TerrainManager,
): AimCommand {
  const sx = self.tank.position.x;
  const sy = self.tank.position.y;
  const dx = targetX - sx;
  const isRight = dx > 0;
  const aMin = isRight ? 22 : 98;
  const aMax = isRight ? 82 : 158;

  const best = searchBallisticSolution({
    sx,
    sy,
    tx: targetX,
    ty: targetY,
    wind,
    gravity,
    terrain,
    isRight,
    aMin,
    aMax,
    coarseStep: 3.5,
    fineStep: 1.5,
    fineWindow: 3,
    powerLo: 26,
    powerHi: 90,
    powerIterations: 7,
    obstaclePenaltyHigh: 10000,
    obstaclePenaltyLow: 30,
    earlyExitError: 6,
  });

  return {
    angle: Math.max(8, Math.min(172, best.angle)),
    power: Math.max(30, Math.min(90, best.power)),
  };
}
