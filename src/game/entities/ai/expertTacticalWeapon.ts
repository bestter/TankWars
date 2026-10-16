import type { Player } from "../../../types/player";
import type { GameState } from "../../../types/game";
import type { WeaponId } from "../../../types/weapon";
import type { TerrainManager } from "../../engine/Terrain";
import { shouldPickBulldozer } from "./bulldozerTactics";

export function chooseExpertTacticalWeapon(
  self: Player,
  target: Player,
  terrain: TerrainManager,
  gameState: GameState,
): WeaponId {
  const has = (id: WeaponId) => (self.inventory[id] ?? 0) > 0;
  const sx = self.tank.position.x;
  const tx = target.tank.position.x;
  const startX = Math.min(sx, tx);
  const endX = Math.max(sx, tx);
  const step = (endX - startX) / 10;
  let maximumTerrainHeight = 0;
  for (let index = 1; index < 10; index += 1) {
    const height = terrain.getHeightAt(startX + index * step);
    maximumTerrainHeight = Math.max(maximumTerrainHeight, terrain.height - height);
  }
  const selfHeight = terrain.height - self.tank.position.y;
  const targetHeight = terrain.height - target.tank.position.y;
  const isHidden =
    maximumTerrainHeight > Math.max(selfHeight, targetHeight) + 35;
  if (isHidden && has("GRENADE")) return "GRENADE";

  const neighbors = gameState.players.filter(
    (player) =>
      player.id !== self.id &&
      !player.tank.isDead &&
      Math.abs(player.tank.position.x - tx) < 80,
  ).length;
  if (neighbors >= 2 && has("CLUSTER")) return "CLUSTER";
  if (isHidden && has("DRILLER")) return "DRILLER";
  if (shouldPickBulldozer(self, target, terrain)) return "BULLDOZER";
  return "MISSILE";
}
