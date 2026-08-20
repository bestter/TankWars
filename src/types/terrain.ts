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

// === Constantes de lissage et de mélange (blend) ===

/** Rayon de recherche (colonnes) pour le calcul du mélange progressif de friabilité entre sable et terre. */
export const TERRAIN_SOFT_BLEND_RADIUS = 8;

/** Facteur de lissage global appliqué lors de la génération procédurale du terrain. */
export const TERRAIN_GENERATION_SMOOTH_STRENGTH = 0.42;

/** Facteur de lissage appliqué aux bordures d'un cratère après creusement (sans combler la dépression). */
export const TERRAIN_CRATER_SMOOTH_STRENGTH = 0.35;

// === Constantes de distribution procédurale des matériaux ===

/** Marge latérale relative (fraction de la largeur) exclue pour le placement des zones de matériaux spéciaux. */
export const TERRAIN_MATERIAL_MARGIN_RATIO = 0.1;

/** Nombre minimum et maximum de zones de roche générées par manche. */
export const TERRAIN_ROCK_ZONE_COUNT_MIN = 1;
export const TERRAIN_ROCK_ZONE_COUNT_MAX = 2;

/** Largeur minimale et maximale (en pixels) d'une zone de roche (40 à 85px). */
export const TERRAIN_ROCK_ZONE_WIDTH_MIN = 40;
export const TERRAIN_ROCK_ZONE_WIDTH_MAX = 85;

/** Nombre minimum et maximum de zones meubles (sable) générées par manche. */
export const TERRAIN_SOFT_ZONE_COUNT_MIN = 1;
export const TERRAIN_SOFT_ZONE_COUNT_MAX = 3;

/** Largeur minimale et maximale (en pixels) d'une zone meuble (50 à 100px). */
export const TERRAIN_SOFT_ZONE_WIDTH_MIN = 50;
export const TERRAIN_SOFT_ZONE_WIDTH_MAX = 100;

// === Constantes de spawn des tanks ===

/** Marge latérale relative (fraction de la largeur) pour la zone d'apparition des tanks (13%). */
export const TANK_SPAWN_MARGIN_RATIO = 0.13;

/** Distance minimale (en pixels) requise entre deux points d'apparition de tanks. */
export const TANK_SPAWN_MIN_DISTANCE = 100;

/** Nombre maximal de tentatives globales pour trouver un placement valide de tank. */
export const TANK_SPAWN_MAX_ATTEMPTS = 500;

/** Nombre d'échantillons candidats évalués par position pour favoriser le meilleur creux tactique. */
export const TANK_SPAWN_PER_POS_ATTEMPTS = 200;

/** Skip this fraction of penalized spawn samples (humans vs SOFT in local, AI vs ROCK everywhere). */
export const SPAWN_AVOID_MATERIAL_CHANCE = 0.25;

export function spawnAcceptsMaterial(
  material: TerrainMaterial,
  isHuman: boolean,
  localMode: boolean,
  rng: () => number,
): boolean {
  const avoid =
    (localMode && isHuman && material === TERRAIN_MATERIAL.SOFT) ||
    (!isHuman && material === TERRAIN_MATERIAL.ROCK);
  if (!avoid) return true;
  return rng() >= SPAWN_AVOID_MATERIAL_CHANCE;
}

/** Hauteur de rebond GRENADE sur ROCK ≈ 2× la terre (restitution × √2). */
export const GRENADE_ROCK_BOUNCE_SCALE = Math.SQRT2;
export const GRENADE_MAX_RESTITUTION = 0.98;
export const GRENADE_DIRT_RESTITUTION_MIN = 0.58;
export const GRENADE_DIRT_RESTITUTION_SPAN = 0.12;
export const GRENADE_DIRT_FRICTION = 0.78;
export const GRENADE_ROCK_FRICTION = 0.9;
export const GRENADE_MAX_BOUNCES = 4;

export function grenadeBounceParams(
  material: TerrainMaterial,
  rng: () => number,
): { explodeOnContact: boolean; restitution: number; friction: number } {
  if (material === TERRAIN_MATERIAL.SOFT) {
    return { explodeOnContact: true, restitution: 0, friction: 0 };
  }
  let restitution =
    GRENADE_DIRT_RESTITUTION_MIN + rng() * GRENADE_DIRT_RESTITUTION_SPAN;
  let friction = GRENADE_DIRT_FRICTION;
  if (material === TERRAIN_MATERIAL.ROCK) {
    restitution = Math.min(
      GRENADE_MAX_RESTITUTION,
      restitution * GRENADE_ROCK_BOUNCE_SCALE,
    );
    friction = GRENADE_ROCK_FRICTION;
  }
  return { explodeOnContact: false, restitution, friction };
}

