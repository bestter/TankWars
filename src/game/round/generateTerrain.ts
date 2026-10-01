import {
  TERRAIN_MATERIAL,
  TERRAIN_GENERATION_SMOOTH_STRENGTH,
  TERRAIN_MATERIAL_MARGIN_RATIO,
  TERRAIN_ROCK_ZONE_COUNT_MIN,
  TERRAIN_ROCK_ZONE_COUNT_MAX,
  TERRAIN_ROCK_ZONE_WIDTH_MIN,
  TERRAIN_ROCK_ZONE_WIDTH_MAX,
  TERRAIN_SOFT_ZONE_COUNT_MIN,
  TERRAIN_SOFT_ZONE_COUNT_MAX,
  TERRAIN_SOFT_ZONE_WIDTH_MIN,
  TERRAIN_SOFT_ZONE_WIDTH_MAX,
  type TerrainMaterial,
} from "../../types/terrain";

export interface GeneratedTerrain {
  heights: number[];
  materials: TerrainMaterial[];
}

export function generateTerrain(width: number, height: number, rng: () => number): GeneratedTerrain {
  const heights: number[] = new Array(width);
  const materials: TerrainMaterial[] = new Array(width);
  // 1. Paramètres aléatoires de base et d'harmoniques
  const base = height * (0.58 + rng() * 0.08); // 58% à 66% de la hauteur
  const f1 = 0.006 + rng() * 0.007; // Macro relief
  const f2 = 0.014 + rng() * 0.012; // Relief moyen (bosses)
  const f3 = 0.028 + rng() * 0.016; // Micro relief (crêtes)

  const amp1 = height * (0.09 + rng() * 0.07);
  const amp2 = height * (0.05 + rng() * 0.045);
  const amp3 = height * (0.02 + rng() * 0.025);

  const phi1 = rng() * Math.PI * 2;
  const phi2 = rng() * Math.PI * 2;
  const phi3 = rng() * Math.PI * 2;

  // 2. Génération de creux tactiques et de bosses prononcées (Gaussian features)
  const featureCount = 3 + Math.floor(rng() * 3); // 3 à 5 reliefs locaux
  interface TerrainFeature {
    cx: number;
    sigma: number;
    amplitude: number; // positif = creux (vers le bas en canvas Y), négatif = bosse
  }
  const features: TerrainFeature[] = [];
  const minFeatureX = width * 0.12;
  const maxFeatureX = width * 0.88;

  for (let i = 0; i < featureCount; i++) {
    const cx = minFeatureX + rng() * (maxFeatureX - minFeatureX);
    const sigma = 35 + rng() * 45; // largeur
    // Alternance ou choix aléatoire creux vs bosse
    const isDip = rng() > 0.45;
    const amplitude = isDip
      ? (height * (0.06 + rng() * 0.08)) // creux (descend en Y)
      : -(height * (0.06 + rng() * 0.08)); // bosse (monte en Y)
    features.push({ cx, sigma, amplitude });
  }

  const minH = height * 0.28;
  const maxH = height * 0.86;

  for (let x = 0; x < width; x++) {
    let h =
      base +
      Math.sin(x * f1 + phi1) * amp1 +
      Math.sin(x * f2 + phi2) * amp2 +
      Math.sin(x * f3 + phi3) * amp3;

    // Ajout des bosses et creux gaussiens
    for (let f = 0; f < features.length; f++) {
      const feat = features[f];
      const dist = x - feat.cx;
      const g = Math.exp(-(dist * dist) / (2 * feat.sigma * feat.sigma));
      h += feat.amplitude * g;
    }

    // Micro texture haute fréquence
    h += Math.sin(x * 0.45 + phi1) * 2.2;

    heights[x] = Math.max(minH, Math.min(maxH, h));
    materials[x] = TERRAIN_MATERIAL.DIRT;
  }

  // Lissage pour des pentes jouables et harmonieuses
  const original = heights.slice();
  // Same initial smoothing range as TerrainManager.smoothHeights (1..width-2).
  for (let x = 2; x < width - 2; x++) {
    const avg = (original[x - 1] + original[x] + original[x + 1]) / 3;
    heights[x] = original[x] * (1 - TERRAIN_GENERATION_SMOOTH_STRENGTH) + avg * TERRAIN_GENERATION_SMOOTH_STRENGTH;
  }

  // 3. Distribution des matériaux (zones de roche et zones meubles)
  distributeMaterials(width, materials, rng);
  return { heights, materials };
}

  /**
   * Distribue aléatoirement des zones de roche indestructible et de terrain meuble.
   */
function distributeMaterials(width: number, materials: TerrainMaterial[], rng: () => number): void {
  const margin = width * TERRAIN_MATERIAL_MARGIN_RATIO;
  const availableWidth = width - 2 * margin;

  // Zones de roche (ROCK)
  const rockZoneCount =
    TERRAIN_ROCK_ZONE_COUNT_MIN +
    Math.floor(
      rng() *
        (TERRAIN_ROCK_ZONE_COUNT_MAX - TERRAIN_ROCK_ZONE_COUNT_MIN + 1),
    );
  for (let i = 0; i < rockZoneCount; i++) {
    const center = margin + rng() * availableWidth;
    const zoneWidth =
      TERRAIN_ROCK_ZONE_WIDTH_MIN +
      Math.floor(
        rng() *
          (TERRAIN_ROCK_ZONE_WIDTH_MAX - TERRAIN_ROCK_ZONE_WIDTH_MIN + 1),
      );
    const startX = Math.max(0, Math.floor(center - zoneWidth / 2));
    const endX = Math.min(width - 1, Math.floor(center + zoneWidth / 2));

    for (let x = startX; x <= endX; x++) {
      materials[x] = TERRAIN_MATERIAL.ROCK;
    }
  }

  // Zones de terrain mou (SOFT)
  const softZoneCount =
    TERRAIN_SOFT_ZONE_COUNT_MIN +
    Math.floor(
      rng() *
        (TERRAIN_SOFT_ZONE_COUNT_MAX - TERRAIN_SOFT_ZONE_COUNT_MIN + 1),
    );
  for (let i = 0; i < softZoneCount; i++) {
    const center = margin + rng() * availableWidth;
    const zoneWidth =
      TERRAIN_SOFT_ZONE_WIDTH_MIN +
      Math.floor(
        rng() *
          (TERRAIN_SOFT_ZONE_WIDTH_MAX - TERRAIN_SOFT_ZONE_WIDTH_MIN + 1),
      );
    const startX = Math.max(0, Math.floor(center - zoneWidth / 2));
    const endX = Math.min(width - 1, Math.floor(center + zoneWidth / 2));

    for (let x = startX; x <= endX; x++) {
      // Ne pas écraser la roche
      if (materials[x] !== TERRAIN_MATERIAL.ROCK) {
        materials[x] = TERRAIN_MATERIAL.SOFT;
      }
    }
  }

}
