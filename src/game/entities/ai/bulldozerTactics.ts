/**
 * Quand v2–v4 doivent tirer le Bulldozer.
 * v1-random n'importe pas ce module (volontairement naïf).
 */
import { MAX_BULLDOZER_PUSH } from "../../../types/weapon";
import type { Player } from "../../../types/player";
import type { TerrainManager } from "../../engine/Terrain";

/** Drop canvas (Y vers le bas) qui justifie une poussée vers le vide. Aligné sur VOID_FALL_THRESHOLD. */
const USEFUL_DROP_PX = 12;

export function shouldPickBulldozer(
  self: Player,
  target: Player,
  terrain: TerrainManager,
): boolean {
  if ((self.inventory?.BULLDOZER ?? 0) <= 0) return false;
  const sx = self.tank.position.x;
  const tx = target.tank.position.x;
  const dist = Math.abs(tx - sx);
  if (dist < 80) return false;
  const dir: 1 | -1 = tx > sx ? 1 : -1;
  const probeX = tx + dir * Math.min(MAX_BULLDOZER_PUSH * 0.5, 60);
  if (probeX < 0 || probeX > terrain.width) return true;
  const drop = terrain.getHeightAt(probeX) - terrain.getHeightAt(tx);
  return drop >= USEFUL_DROP_PX;
}
