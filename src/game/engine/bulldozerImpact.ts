import { BULLDOZER_PUSH_FACTOR, MAX_BULLDOZER_PUSH } from "../../types/weapon";
import type { TankManager } from "../entities/TankManager";
import type { TerrainManager } from "./Terrain";

/** Target first, shooter recoil second; self-hit has zero net displacement. */
export function applyBulldozerHit(
  targetId: string, vx: number, ownerId: string | undefined, munitionId: number,
  terrain: TerrainManager, tanks: TankManager,
): void {
  tanks.markDirectlyAffected(targetId, munitionId);
  const distance = Math.min(Math.abs(vx) * BULLDOZER_PUSH_FACTOR, MAX_BULLDOZER_PUSH);
  if (distance <= 0 || vx === 0 || targetId === ownerId) return;
  const direction = vx > 0 ? 1 : -1;
  tanks.applyBulldozerDisplacement(targetId, direction, distance, terrain);
  if (!ownerId || tanks.getPlayerById(ownerId)?.tank.isDead !== false) return;
  tanks.applyBulldozerDisplacement(ownerId, direction === 1 ? -1 : 1, distance, terrain);
}
