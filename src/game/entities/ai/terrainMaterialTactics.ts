/**
 * Propose une arme ordinaire selon le matériau sous la cible.
 * ROCK exclut DRILLER; SOFT peut proposer DRILLER avec stock.
 * La proposition ne démontre ni effet utile ni survie : le repli EXPERT la valide
 * physiquement avant de choisir. SIMPLE n'utilise jamais ce module.
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
