/**
 * TankWars - TerrainManager
 *
 * Module de gestion du terrain destructible (heightmap).
 * Respecte strictement les règles du projet :
 * - TypeScript strict, zéro any
 * - Palette VGA 16 couleurs (via VGA_PALETTE)
 * - Algorithme de terrain custom via heightmap (pas de moteur physique externe)
 * - Relief riche et diversifié (bosses, creux stratégiques, pas de tunnels)
 * - Matériaux de terrain : DIRT (normal), ROCK (indestructible), SOFT (meuble / 2 à 3x plus destructible)
 *
 * Coordinate system:
 *   - (0,0) = top-left
 *   - Y augmente vers le bas (standard Canvas 2D)
 *   - heights[x] = position Y de la surface du terrain à la colonne x
 *   - Tout point avec y >= heights[x] est considéré comme solide
 */

import { VGA_PALETTE } from "../../types/game";
import {
  TERRAIN_MATERIAL,
  SOFT_TERRAIN_DESTRUCTION_MULTIPLIER,
  type TerrainMaterial,
} from "../../types/terrain";
import { secureRandom } from "../../utils/random";

/** Margin from canvas bottom for the lava "floor" level. When terrain is destroyed to/beyond this, lava is exposed visually and tanks touching it die instantly. */
const LAVA_TOP_MARGIN = 6;

/** Must match GameEngine sky fill (#0000AA) so offscreen pixels are always opaque. */
const SKY_COLOR = VGA_PALETTE.DARK_BLUE;

/** Vertical depth of the grass / surface cap ribbon along the terrain surface. */
const CAP_THICKNESS = 3;

export class TerrainManager {
  public readonly width: number;
  public readonly height: number;

  /** Tableau privé des hauteurs de surface (taille = width) */
  private readonly heights: number[];

  /** Tableau des matériaux de surface par colonne (taille = width) */
  private readonly materials: TerrainMaterial[];

  // === Performance Optimization: Offscreen Canvas Caching ===
  private offscreenCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private offscreenCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  private isDirty: boolean = true;
  /** When true, next draw rebuilds the entire offscreen buffer (generate / first paint). */
  private needsFullRedraw = true;
  /** Horizontal band invalidated by destroyTerrain (inclusive column indices). */
  private dirtyStartX = 0;
  private dirtyEndX = 0;
  /** Reusable scratch buffer for smoothHeights (avoids per-crater .slice()). */
  private smoothScratch: number[] = [];

  constructor(width: number, height: number) {
    if (width <= 0 || height <= 0) {
      throw new Error("TerrainManager: width and height must be positive");
    }

    this.width = Math.floor(width);
    this.height = Math.floor(height);
    this.heights = new Array(this.width).fill(this.height * 0.7);
    this.materials = new Array(this.width).fill(TERRAIN_MATERIAL.DIRT);
  }

  /**
   * Génère un paysage riche, varié et aléatoire à chaque manche :
   * - Superposition multi-octaves d'ondes sinusoïdales à paramètres aléatoires (amplitudes, fréquences, phases)
   * - Relief accidenté avec bosses (pics) et creux stratégiques abritant les tanks
   * - Distribution aléatoire de zones de roche indestructible (ROCK) et de terrain meuble (SOFT)
   */
  public generate(): void {
    this.needsFullRedraw = true;
    this.isDirty = true;
    this.dirtyStartX = 0;
    this.dirtyEndX = this.width - 1;

    // 1. Paramètres aléatoires de base et d'harmoniques
    const base = this.height * (0.58 + secureRandom() * 0.08); // 58% à 66% de la hauteur
    const f1 = 0.006 + secureRandom() * 0.007; // Macro relief
    const f2 = 0.014 + secureRandom() * 0.012; // Relief moyen (bosses)
    const f3 = 0.028 + secureRandom() * 0.016; // Micro relief (crêtes)

    const amp1 = this.height * (0.09 + secureRandom() * 0.07);
    const amp2 = this.height * (0.05 + secureRandom() * 0.045);
    const amp3 = this.height * (0.02 + secureRandom() * 0.025);

    const phi1 = secureRandom() * Math.PI * 2;
    const phi2 = secureRandom() * Math.PI * 2;
    const phi3 = secureRandom() * Math.PI * 2;

    // 2. Génération de creux tactiques et de bosses prononcées (Gaussian features)
    const featureCount = 3 + Math.floor(secureRandom() * 3); // 3 à 5 reliefs locaux
    interface TerrainFeature {
      cx: number;
      sigma: number;
      amplitude: number; // positif = creux (vers le bas en canvas Y), négatif = bosse
    }
    const features: TerrainFeature[] = [];
    const minFeatureX = this.width * 0.12;
    const maxFeatureX = this.width * 0.88;

    for (let i = 0; i < featureCount; i++) {
      const cx = minFeatureX + secureRandom() * (maxFeatureX - minFeatureX);
      const sigma = 35 + secureRandom() * 45; // largeur
      // Alternance ou choix aléatoire creux vs bosse
      const isDip = secureRandom() > 0.45;
      const amplitude = isDip
        ? (this.height * (0.06 + secureRandom() * 0.08)) // creux (descend en Y)
        : -(this.height * (0.06 + secureRandom() * 0.08)); // bosse (monte en Y)
      features.push({ cx, sigma, amplitude });
    }

    const minH = this.height * 0.28;
    const maxH = this.height * 0.86;

    for (let x = 0; x < this.width; x++) {
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

      this.heights[x] = Math.max(minH, Math.min(maxH, h));
      this.materials[x] = TERRAIN_MATERIAL.DIRT;
    }

    // Lissage pour des pentes jouables et harmonieuses
    this.smoothHeights(0.42);

    // 3. Distribution des matériaux (zones de roche et zones meubles)
    this.distributeMaterials();
  }

  /**
   * Distribue aléatoirement des zones de roche indestructible et de terrain meuble.
   */
  private distributeMaterials(): void {
    const margin = this.width * 0.1;
    const availableWidth = this.width - 2 * margin;

    // 1 à 2 zones de roche (ROCK)
    const rockZoneCount = 1 + Math.floor(secureRandom() * 2);
    for (let i = 0; i < rockZoneCount; i++) {
      const center = margin + secureRandom() * availableWidth;
      const zoneWidth = 40 + Math.floor(secureRandom() * 45); // 40 à 85px
      const startX = Math.max(0, Math.floor(center - zoneWidth / 2));
      const endX = Math.min(this.width - 1, Math.floor(center + zoneWidth / 2));

      for (let x = startX; x <= endX; x++) {
        this.materials[x] = TERRAIN_MATERIAL.ROCK;
      }
    }

    // 1 à 3 zones de terrain mou (SOFT)
    const softZoneCount = 1 + Math.floor(secureRandom() * 3);
    for (let i = 0; i < softZoneCount; i++) {
      const center = margin + secureRandom() * availableWidth;
      const zoneWidth = 50 + Math.floor(secureRandom() * 50); // 50 à 100px
      const startX = Math.max(0, Math.floor(center - zoneWidth / 2));
      const endX = Math.min(this.width - 1, Math.floor(center + zoneWidth / 2));

      for (let x = startX; x <= endX; x++) {
        // Ne pas écraser la roche
        if (this.materials[x] !== TERRAIN_MATERIAL.ROCK) {
          this.materials[x] = TERRAIN_MATERIAL.SOFT;
        }
      }
    }
  }

  /**
   * Initializes the offscreen canvas for caching if it doesn't exist yet.
   */
  private initOffscreenCanvas(): void {
    if (this.offscreenCanvas) return;

    const contextOptions: CanvasRenderingContext2DSettings = { alpha: false };

    if (typeof OffscreenCanvas !== "undefined") {
      this.offscreenCanvas = new OffscreenCanvas(this.width, this.height);
      this.offscreenCtx = this.offscreenCanvas.getContext(
        "2d",
        contextOptions,
      ) as OffscreenCanvasRenderingContext2D;
    } else if (typeof document !== "undefined") {
      this.offscreenCanvas = document.createElement("canvas");
      this.offscreenCanvas.width = this.width;
      this.offscreenCanvas.height = this.height;
      this.offscreenCtx = this.offscreenCanvas.getContext(
        "2d",
        contextOptions,
      ) as CanvasRenderingContext2D;
    } else {
      // Fallback for tests environments without canvas
      return;
    }

    this.offscreenCtx.imageSmoothingEnabled = false;
  }

  private drawLavaBand(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    bandStart: number,
    bandEnd: number,
    lavaTop: number,
  ): void {
    const bandWidth = bandEnd - bandStart + 1;
    ctx.fillStyle = VGA_PALETTE.DARK_RED;
    ctx.fillRect(bandStart, lavaTop, bandWidth, this.height - lavaTop);

    ctx.fillStyle = VGA_PALETTE.RED;
    for (let x = bandStart; x <= bandEnd; x += 3) {
      const offset = x % 5;
      ctx.fillRect(x, lavaTop + 1 + offset, 2, 2 + (x % 2));
    }
    ctx.fillStyle = VGA_PALETTE.YELLOW;
    for (let x = bandStart + 2; x <= bandEnd; x += 5) {
      ctx.fillRect(x, lavaTop + 3 + (x % 3), 1, 1);
    }
  }

  /**
   * Earth / Rock / Soft body strictly below the surface ribbon.
   * Visual rendering depends on the material of each column:
   * - DIRT: VGA_PALETTE.BROWN
   * - ROCK: VGA_PALETTE.DARK_GRAY + subtle stone specks
   * - SOFT: VGA_PALETTE.BROWN + VGA_PALETTE.YELLOW sand specks
   */
  private drawTerrainFillBandColumns(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    bandStart: number,
    bandEnd: number,
    lavaTop: number,
  ): void {
    for (let x = bandStart; x <= bandEnd; x++) {
      const surfaceY = Math.min(this.heights[x], lavaTop);
      if (surfaceY >= lavaTop) continue;
      const bodyTop = Math.min(surfaceY + CAP_THICKNESS, lavaTop);
      if (bodyTop >= lavaTop) continue;

      const mat = this.materials[x];
      if (mat === TERRAIN_MATERIAL.ROCK) {
        ctx.fillStyle = VGA_PALETTE.DARK_GRAY;
        ctx.fillRect(x, bodyTop, 1, lavaTop - bodyTop);
        // Texture pierre rétro
        if ((x + Math.floor(surfaceY)) % 6 === 0) {
          ctx.fillStyle = VGA_PALETTE.GRAY;
          ctx.fillRect(x, bodyTop + 2, 1, Math.min(5, lavaTop - bodyTop - 2));
        }
      } else if (mat === TERRAIN_MATERIAL.SOFT) {
        // Sous-sol complet en jaune sable jusqu'à la lave
        ctx.fillStyle = VGA_PALETTE.YELLOW;
        ctx.fillRect(x, bodyTop, 1, lavaTop - bodyTop);
        // Grains de sable / sédiments rétro
        if ((x * 7 + Math.floor(surfaceY)) % 6 === 0) {
          ctx.fillStyle = VGA_PALETTE.BROWN;
          ctx.fillRect(x, bodyTop + 2, 1, Math.min(4, lavaTop - bodyTop - 2));
        }
      } else {
        ctx.fillStyle = VGA_PALETTE.BROWN;
        ctx.fillRect(x, bodyTop, 1, lavaTop - bodyTop);
      }
    }
  }

  /**
   * Re-paint sky above the surface to remove antialiased green/brown fringe ("fuzzy" edge).
   */
  private clipSkyAboveSurface(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    bandStart: number,
    bandEnd: number,
    lavaTop: number,
  ): void {
    ctx.fillStyle = SKY_COLOR;
    for (let x = bandStart; x <= bandEnd; x++) {
      const surfaceY = Math.min(this.heights[x], lavaTop);
      if (surfaceY <= 0) continue;
      ctx.fillRect(x, 0, 1, surfaceY);
    }
  }

  private fillSkyBand(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    bandStart: number,
    bandWidth: number,
  ): void {
    ctx.fillStyle = SKY_COLOR;
    ctx.fillRect(bandStart, 0, bandWidth, this.height);
  }

  /**
   * Filled ribbon that follows terrain curves with uniform thickness.
   * Renders color corresponding to material:
   * - DIRT: VGA_PALETTE.GREEN (herbe)
   * - ROCK: VGA_PALETTE.LIGHT_GRAY (crête de pierre)
   * - SOFT: VGA_PALETTE.YELLOW (sable / sédiment meuble)
   */
  private drawGrassBand(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    bandStart: number,
    bandEnd: number,
    lavaTop: number,
  ): void {
    let segmentStart: number | null = null;
    let currentMat: TerrainMaterial = TERRAIN_MATERIAL.DIRT;

    const flushSegment = (segmentEnd: number, mat: TerrainMaterial): void => {
      if (segmentStart === null) return;

      const start = segmentStart;
      const end = segmentEnd;

      if (mat === TERRAIN_MATERIAL.ROCK) {
        ctx.fillStyle = VGA_PALETTE.GRAY;
      } else if (mat === TERRAIN_MATERIAL.SOFT) {
        ctx.fillStyle = VGA_PALETTE.YELLOW;
      } else {
        ctx.fillStyle = VGA_PALETTE.GREEN;
      }

      ctx.beginPath();
      for (let x = start; x <= end; x++) {
        const h = Math.min(this.heights[x], lavaTop);
        if (x === start) {
          ctx.moveTo(x, h);
        } else {
          ctx.lineTo(x, h);
        }
      }
      for (let x = end; x >= start; x--) {
        const h = Math.min(this.heights[x], lavaTop);
        ctx.lineTo(x, Math.min(h + CAP_THICKNESS, lavaTop));
      }
      ctx.closePath();
      ctx.fill();

      segmentStart = null;
    };

    for (let x = bandStart; x <= bandEnd; x++) {
      if (this.heights[x] < lavaTop) {
        const mat = this.materials[x];
        if (segmentStart === null) {
          segmentStart = x;
          currentMat = mat;
        } else if (mat !== currentMat) {
          flushSegment(x - 1, currentMat);
          segmentStart = x;
          currentMat = mat;
        }
      } else {
        if (segmentStart !== null) {
          flushSegment(x - 1, currentMat);
        }
      }
    }

    if (segmentStart !== null) {
      flushSegment(bandEnd, currentMat);
    }
  }

  /**
   * Renders the full terrain to the offscreen canvas.
   */
  private renderFullOffscreen(): void {
    this.initOffscreenCanvas();
    const ctx = this.offscreenCtx;
    if (!ctx) return;

    this.fillSkyBand(ctx, 0, this.width);
    const lavaTop = this.lavaTop;

    this.drawLavaBand(ctx, 0, this.width - 1, lavaTop);
    this.drawTerrainFillBandColumns(ctx, 0, this.width - 1, lavaTop);
    this.drawGrassBand(ctx, 0, this.width - 1, lavaTop);
    this.clipSkyAboveSurface(ctx, 0, this.width - 1, lavaTop);
  }

  /**
   * Redraws only the dirty horizontal band after a localized crater mutation.
   */
  private renderPartialOffscreen(startX: number, endX: number): void {
    this.initOffscreenCanvas();
    const ctx = this.offscreenCtx;
    if (!ctx) return;

    const pad = 8;
    const bandStart = Math.max(0, startX - pad);
    const bandEnd = Math.min(this.width - 1, endX + pad);
    const bandWidth = bandEnd - bandStart + 1;
    const lavaTop = this.lavaTop;

    this.fillSkyBand(ctx, bandStart, bandWidth);
    this.drawLavaBand(ctx, bandStart, bandEnd, lavaTop);
    this.drawTerrainFillBandColumns(ctx, bandStart, bandEnd, lavaTop);
    this.drawGrassBand(ctx, bandStart, bandEnd, lavaTop);
    this.clipSkyAboveSurface(ctx, bandStart, bandEnd, lavaTop);
  }

  /**
   * Dessine le terrain sur le contexte canvas en utilisant une couleur unie
   * de la palette VGA.
   */
  public draw(ctx: CanvasRenderingContext2D): void {
    if (this.isDirty) {
      if (this.needsFullRedraw || !this.offscreenCanvas) {
        this.renderFullOffscreen();
        this.needsFullRedraw = false;
      } else {
        this.renderPartialOffscreen(this.dirtyStartX, this.dirtyEndX);
      }
      this.isDirty = false;
    }

    if (this.offscreenCanvas) {
      // Fast path: draw from cached offscreen canvas
      ctx.drawImage(this.offscreenCanvas as CanvasImageSource, 0, 0);
    } else {
      // Fallback path (e.g. some node test environments that mock things poorly)
      this.drawFallback(ctx);
    }
  }

  private drawFallback(ctx: CanvasRenderingContext2D): void {
    const lavaTop = this.lavaTop;

    // Draw lava at the absolute bottom (the "floor level" when all ground is destroyed)
    ctx.fillStyle = VGA_PALETTE.DARK_RED;
    ctx.fillRect(0, lavaTop, this.width, this.height - lavaTop);

    // Simple pixel-art lava texture / bubbles
    ctx.fillStyle = VGA_PALETTE.RED;
    for (let x = 0; x < this.width; x += 3) {
      const offset = x % 5;
      ctx.fillRect(x, lavaTop + 1 + offset, 2, 2 + (x % 2));
    }
    ctx.fillStyle = VGA_PALETTE.YELLOW;
    for (let x = 2; x < this.width; x += 5) {
      ctx.fillRect(x, lavaTop + 3 + (x % 3), 1, 1);
    }

    this.drawTerrainFillBandColumns(ctx, 0, this.width - 1, lavaTop);
    this.drawGrassBand(ctx, 0, this.width - 1, lavaTop);
    this.clipSkyAboveSurface(ctx, 0, this.width - 1, lavaTop);
  }

  /**
   * Creuse un cratère dans le terrain :
   * - Ignore les colonnes ROCK (roche indestructible).
   * - Multiplie le creusement par SOFT_TERRAIN_DESTRUCTION_MULTIPLIER sur les colonnes SOFT.
   * - Creuse normalement sur les colonnes DIRT.
   */
  public destroyTerrain(
    impactX: number,
    impactY: number,
    radius: number,
  ): void {
    if (radius <= 0) return;

    this.carveCircle(impactX, impactY, radius);

    const maxReach = radius * SOFT_TERRAIN_DESTRUCTION_MULTIPLIER;
    const startX = Math.max(0, Math.floor(impactX - maxReach));
    const endX = Math.min(this.width - 1, Math.floor(impactX + maxReach));
    const smoothStart = Math.max(0, startX - 3);
    const smoothEnd = Math.min(this.width - 1, endX + 3);
    // Smooth crater edges only — never raise the surface (which would undo destruction).
    this.smoothHeights(0.35, smoothStart, smoothEnd, true);
    this.markTerrainDirty(smoothStart, smoothEnd);
  }

  /**
   * Puits de forage le long d’une direction (heightmap).
   * Tamponne carveCircle du point d’impact jusqu’à `depth` le long de (dirX, dirY).
   * Pas de lissage: les parois restent raides.
   */
  public destroyTerrainShaft(
    impactX: number,
    impactY: number,
    dirX: number,
    dirY: number,
    depth: number,
    radius: number,
  ): void {
    if (radius <= 0 || depth <= 0) return;

    const len = Math.hypot(dirX, dirY);
    const nx = len > 1e-6 ? dirX / len : 0;
    const ny = len > 1e-6 ? dirY / len : 1;

    const travel = Math.max(0, depth - radius);
    const steps = Math.max(1, Math.ceil(travel));

    for (let i = 0; i <= steps; i++) {
      const t = travel === 0 ? 0 : i / steps;
      this.carveCircle(impactX + nx * travel * t, impactY + ny * travel * t, radius);
    }

    const maxReach = radius * SOFT_TERRAIN_DESTRUCTION_MULTIPLIER;
    const minX = Math.min(impactX, impactX + nx * travel) - maxReach;
    const maxX = Math.max(impactX, impactX + nx * travel) + maxReach;
    this.markTerrainDirty(Math.floor(minX), Math.ceil(maxX));
  }

  /**
   * Vérifie si un point (x, y) touche ou pénètre dans le terrain.
   */
  public checkCollision(x: number, y: number): boolean {
    if (x < 0 || x >= this.width) {
      return false;
    }
    const surfaceY = this.heights[Math.floor(x)];
    return y >= surfaceY;
  }

  /** Retourne la hauteur de surface à la position x (bornée) */
  public getHeightAt(x: number): number {
    const xi = Math.max(0, Math.min(this.width - 1, Math.floor(x)));
    return this.heights[xi];
  }

  /** Retourne le type de matériau à la position x (borné) */
  public getMaterialAt(x: number): TerrainMaterial {
    const xi = Math.max(0, Math.min(this.width - 1, Math.floor(x)));
    return this.materials[xi];
  }

  /**
   * Roche = mur pour le souffle. True si le segment (from → to) traverse le
   * volume solide d'une colonne ROCK (y canvas >= surface).
   * Explosion PAR DESSUS la roche (colonne d'impact ROCK) : pas d'occlusion.
   * Rayon qui passe dans l'air au-dessus de la surface : pas d'occlusion.
   */
  public isBlastOccludedByRock(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): boolean {
    if (this.getMaterialAt(fromX) === TERRAIN_MATERIAL.ROCK) {
      return false;
    }
    const x0 = Math.floor(fromX);
    const x1 = Math.floor(toX);
    if (x0 === x1) return false;

    const xStart = Math.min(x0, x1);
    const xEnd = Math.max(x0, x1);
    const spanX = toX - fromX;
    if (spanX === 0) return false;

    for (let x = xStart + 1; x < xEnd; x++) {
      if (this.materials[x] !== TERRAIN_MATERIAL.ROCK) continue;
      const t = (x - fromX) / spanX;
      const rayY = fromY + (toY - fromY) * t;
      if (rayY >= this.heights[x]) return true;
    }
    return false;
  }

  /** Définit le matériau pour une colonne x */
  public setMaterialAt(x: number, material: TerrainMaterial): void {
    const xi = Math.max(0, Math.min(this.width - 1, Math.floor(x)));
    this.materials[xi] = material;
    this.markTerrainDirty(xi, xi);
  }

  /** Définit le matériau pour une plage de colonnes [startX, endX] */
  public setMaterialRange(
    startX: number,
    endX: number,
    material: TerrainMaterial,
  ): void {
    const s = Math.max(0, Math.floor(startX));
    const e = Math.min(this.width - 1, Math.floor(endX));
    for (let x = s; x <= e; x++) {
      this.materials[x] = material;
    }
    this.markTerrainDirty(s, e);
  }

  /** Retourne une copie en lecture seule de la heightmap */
  public getHeightmap(): ReadonlyArray<number> {
    return this.heights.slice();
  }

  /** Retourne une copie en lecture seule du tableau de matériaux */
  public getMaterials(): ReadonlyArray<TerrainMaterial> {
    return this.materials.slice();
  }

  /** Load an authoritative heightmap and optional materials sent by the server.
   *  Marks the terrain dirty so it will be redrawn. */
  public loadHeights(
    newHeights: number[],
    newMaterials?: TerrainMaterial[],
  ): void {
    if (!Array.isArray(newHeights) || newHeights.length !== this.width) {
      console.warn("[TerrainManager] loadHeights: size mismatch, ignoring");
      return;
    }
    for (let i = 0; i < this.width; i++) {
      this.heights[i] = newHeights[i];
    }
    if (
      newMaterials &&
      Array.isArray(newMaterials) &&
      newMaterials.length === this.width
    ) {
      for (let i = 0; i < this.width; i++) {
        this.materials[i] = newMaterials[i];
      }
    }
    this.isDirty = true;
    this.needsFullRedraw = true;
    this.dirtyStartX = 0;
    this.dirtyEndX = this.width - 1;
  }

  /** Load materials array. */
  public loadMaterials(newMaterials: TerrainMaterial[]): void {
    if (!Array.isArray(newMaterials) || newMaterials.length !== this.width) {
      console.warn("[TerrainManager] loadMaterials: size mismatch, ignoring");
      return;
    }
    for (let i = 0; i < this.width; i++) {
      this.materials[i] = newMaterials[i];
    }
    this.isDirty = true;
    this.needsFullRedraw = true;
    this.dirtyStartX = 0;
    this.dirtyEndX = this.width - 1;
  }

  /** Y position of the lava "floor" at the bottom of the map. Exposed when terrain heights reach or exceed this (no ground left). Tanks that reach this y die instantly. */
  public get lavaTop(): number {
    return this.height - LAVA_TOP_MARGIN;
  }

  // ==================== Méthodes privées ====================

  /**
   * Calcule la friabilité/douceur progressive du sol à la colonne x (0 = terre pure, 1 = sable pur).
   * Applique un mélange progressif sur les bordures sable-terre pour un comportement physique naturel.
   */
  private getLocalSoftness(x: number, blendRadius: number = 8): number {
    const xi = Math.max(0, Math.min(this.width - 1, Math.floor(x)));
    if (this.materials[xi] === TERRAIN_MATERIAL.ROCK) return 0;

    let softCount = 0;
    let totalCount = 0;
    const s = Math.max(0, xi - blendRadius);
    const e = Math.min(this.width - 1, xi + blendRadius);

    for (let i = s; i <= e; i++) {
      if (this.materials[i] === TERRAIN_MATERIAL.ROCK) continue;
      totalCount++;
      if (this.materials[i] === TERRAIN_MATERIAL.SOFT) {
        softCount++;
      }
    }

    if (totalCount === 0) return 0;
    return softCount / totalCount;
  }

  /**
   * Creuse un cratère avec transition progressive entre matériaux :
   * - ROCK : préservé intact (aucun creusement).
   * - SOFT / DIRT : la friabilité s'interpole en douceur (comme si la terre était mêlée à du sable),
   *   produisant un cratère organique et continu sans falaise artificielle.
   */
  private carveCircle(impactX: number, impactY: number, radius: number): void {
    if (radius <= 0) return;

    const r = radius;
    const maxMult = SOFT_TERRAIN_DESTRUCTION_MULTIPLIER;
    const maxReach = r * maxMult;
    const startX = Math.max(0, Math.floor(impactX - maxReach));
    const endX = Math.min(this.width - 1, Math.floor(impactX + maxReach));
    const maxSurfaceY = this.height - 1;

    const impactSoftness = this.getLocalSoftness(impactX);

    for (let x = startX; x <= endX; x++) {
      if (this.materials[x] === TERRAIN_MATERIAL.ROCK) {
        // Roche indestructible : aucune modification de hauteur
        continue;
      }
      if (this.isBlastOccludedByRock(impactX, impactY, x, this.heights[x])) {
        continue;
      }

      const dx = x - impactX;
      const absDx = Math.abs(dx);

      // Friabilité locale (mélange progressif sable-terre)
      const localSoftness = this.getLocalSoftness(x);

      // Si l'impact est dans le sable, le souffle transmet une énergie dégressive vers l'extérieur
      const blastSoftness =
        impactSoftness > 0
          ? impactSoftness * Math.max(0, 1 - absDx / maxReach)
          : 0;

      // Degré de friabilité effectif pour cette colonne (entre 0 et 1)
      const effectiveSoftness = Math.max(localSoftness, blastSoftness);

      // Multiplicateur continu entre 1.0 (terre pure) et maxMult (sable pur)
      const mult = 1.0 + (maxMult - 1.0) * effectiveSoftness;
      const effectiveR = r * mult;

      if (absDx > effectiveR) continue;

      const dy = Math.sqrt(effectiveR * effectiveR - dx * dx);
      const craterDepth = impactY + dy;
      if (craterDepth > this.heights[x]) {
        this.heights[x] = Math.min(maxSurfaceY, craterDepth);
      }
    }
  }

  private markTerrainDirty(startX: number, endX: number): void {
    const bandStart = Math.max(0, startX - 10);
    const bandEnd = Math.min(this.width - 1, endX + 10);
    if (!this.isDirty) {
      this.dirtyStartX = bandStart;
      this.dirtyEndX = bandEnd;
    } else {
      this.dirtyStartX = Math.min(this.dirtyStartX, bandStart);
      this.dirtyEndX = Math.max(this.dirtyEndX, bandEnd);
    }
    this.isDirty = true;
  }

  /**
   * Lissage de la heightmap (passe moyenne).
   * @param preserveDepth When true, smoothing never shallowens the surface (keeps craters open)
   *                      et n'érode pas les colonnes de roche indestructible.
   */
  private smoothHeights(
    strength: number = 0.5,
    start?: number,
    end?: number,
    preserveDepth = false,
  ): void {
    const s = Math.max(0, start ?? 1);
    const e = Math.min(this.width - 1, end ?? this.width - 2);

    if (e - s < 2) return;

    const len = e - s + 1;
    if (this.smoothScratch.length < len) {
      this.smoothScratch.length = len;
    }
    for (let i = 0; i < len; i++) {
      this.smoothScratch[i] = this.heights[s + i];
    }

    for (let i = 1; i < len - 1; i++) {
      const idx = s + i;
      // Ne pas éroder la roche lors du lissage des cratères
      if (preserveDepth && this.materials[idx] === TERRAIN_MATERIAL.ROCK) {
        continue;
      }
      const cur = this.smoothScratch[i];
      const avg =
        (this.smoothScratch[i - 1] +
          this.smoothScratch[i] +
          this.smoothScratch[i + 1]) /
        3;
      const blended = cur * (1 - strength) + avg * strength;
      this.heights[idx] = preserveDepth ? Math.max(cur, blended) : blended;
    }
  }
}
