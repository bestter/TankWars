/**
 * TankWars - Terrain Types (src/types/terrain.ts)
 *
 * Types et constantes pour les matériaux du terrain et leur destructibilité.
 * - Strict TypeScript, zéro any.
 * - Palette VGA 16 couleurs pour le rendu.
 */

export const TERRAIN_MATERIAL = {
  DIRT: "DIRT",
  ROCK: "ROCK",
  SOFT: "SOFT",
} as const;

export type TerrainMaterial =
  (typeof TERRAIN_MATERIAL)[keyof typeof TERRAIN_MATERIAL];

/** Multiplicateur de destructibilité pour le terrain mou (2 à 3 fois plus destructible). */
export const SOFT_TERRAIN_DESTRUCTION_MULTIPLIER = 2.5;

/** Multiplicateur de dégâts de souffle d'explosion sur la roche (+50% de dégâts, portée inchangée). */
export const ROCK_EXPLOSION_DAMAGE_MULTIPLIER = 1.5;

