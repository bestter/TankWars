import type { Player } from "../types/player";
import { SHOP_WEAPON_IDS, WEAPON_REGISTRY, type WeaponId } from "../types/weapon";

/**
 * Pure shop buy/sell. Returns a new player snapshot, or null when the action is illegal.
 * MISSILE is not sold (unlimited). Online/local callers apply the result to the roster.
 */
export function applyShopDelta(
  player: Player,
  weaponId: WeaponId,
  delta: 1 | -1,
): Player | null {
  if (!SHOP_WEAPON_IDS.includes(weaponId)) return null;
  const def = WEAPON_REGISTRY[weaponId];
  if (!def) return null;

  const currentStock = player.inventory?.[weaponId] ?? 0;

  if (delta > 0) {
    if ((player.money ?? 0) < def.price) return null;
    return {
      ...player,
      money: (player.money ?? 0) - def.price,
      inventory: {
        ...player.inventory,
        [weaponId]: currentStock + 1,
      },
    };
  }

  if (currentStock <= 0) return null;
  return {
    ...player,
    money: (player.money ?? 0) + def.price,
    inventory: {
      ...player.inventory,
      [weaponId]: currentStock - 1,
    },
  };
}
