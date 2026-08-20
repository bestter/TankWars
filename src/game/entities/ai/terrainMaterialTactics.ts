/**
 * Ajustements d'arme selon le matériau sous la cible.
 * ROCK : indestructible — le DRILLER ne creuse pas ; le souffle explosif reste utile (+50 %).
 * SOFT : 2.5× plus destructible — le DRILLER creuse plus profond et fait tomber le tank.
 * v1-random n'utilise pas ce module (volontairement naïf).
 */
import { TERRAIN_MATERIAL, type TerrainMaterial } from "../../../types/terrain";
import type { WeaponId } from "../../../types/weapon";

export function adjustWeaponForMaterial(
  weapon: WeaponId,
  material: TerrainMaterial,
  has: (id: WeaponId) => boolean,
): WeaponId {
  if (material === TERRAIN_MATERIAL.ROCK && weapon === "DRILLER") {
    return "MISSILE";
  }
  if (
    material === TERRAIN_MATERIAL.SOFT &&
    weapon === "MISSILE" &&
    has("DRILLER")
  ) {
    return "DRILLER";
  }
  return weapon;
}
