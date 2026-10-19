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
  SOFT_TERRAIN_WIDTH_BONUS,
  SOFT_TERRAIN_DEPTH_BONUS,
  TERRAIN_SLUMP_THRESHOLD,
  TERRAIN_SLUMP_MAX_STEP,
  TERRAIN_SLUMP_MAX_PASSES,
  TERRAIN_SOFT_BLEND_RADIUS,
  TERRAIN_CRATER_SMOOTH_STRENGTH,
  type TerrainMaterial,
} from "../../types/terrain";
import { generateTerrain } from "../round/generateTerrain";
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
    const generated = generateTerrain(this.width, this.height, secureRandom);
    this.loadHeights(generated.heights, generated.materials);
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
   * Surface cap covering every column through its right edge, including material boundaries.
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
    for (let x = bandStart; x <= bandEnd; x++) {
      const surfaceY = Math.min(this.heights[x], lavaTop);
      if (surfaceY >= lavaTop) continue;

      const mat = this.materials[x];
      ctx.fillStyle = mat === TERRAIN_MATERIAL.ROCK
        ? VGA_PALETTE.GRAY
        : mat === TERRAIN_MATERIAL.SOFT
          ? VGA_PALETTE.YELLOW
          : VGA_PALETTE.GREEN;
      ctx.fillRect(x, surfaceY, 1, Math.min(CAP_THICKNESS, lavaTop - surfaceY));
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
   * - Ignore les colonnes ROCK par défaut (roche indestructible), ou creuse ROCK au profil parabolique nominal (1.0x) lorsque canCarveRock est actif.
   *   Ces rayons correspondent à `WEAPON_REGISTRY.NUKE.blastRadius` (62 px) et `WEAPON_REGISTRY.THERMONUCLEAR.blastRadius` (160 px).
   * - Applique un profil parabolique sur DIRT/SOFT modulé par la friabilité locale et de souffle (largeur jusqu'à 1.45x, profondeur jusqu'à 1.15x).
   * - Lisse puis applique l'éboulis local sans éroder les colonnes ROCK ni les colonnes occultées.
   */
  public destroyTerrain(
    impactX: number,
    impactY: number,
    radius: number,
    options?: { canCarveRock?: boolean },
  ): void {
    if (radius <= 0) return;

    const canCarveRock = options?.canCarveRock === true;
    const maxReach = radius * SOFT_TERRAIN_DESTRUCTION_MULTIPLIER;
    const startX = Math.max(0, Math.floor(impactX - maxReach));
    const endX = Math.min(this.width - 1, Math.floor(impactX + maxReach));
    const bandStart = Math.max(0, startX - 3);
    const bandEnd = Math.min(this.width - 1, endX + 3);

    // 1. Photographier les hauteurs avant toute écriture et déterminer les colonnes protégées.
    const snapshotHeights = this.heights.slice();
    const protectedColumns = new Array<boolean>(this.width).fill(false);

    for (let x = bandStart; x <= bandEnd; x++) {
      if (this.materials[x] === TERRAIN_MATERIAL.ROCK) {
        protectedColumns[x] = true;
        continue;
      }
      const isOccluded = canCarveRock
        ? this.isHaloOccludedByOuterRock(
            impactX,
            impactY,
            x,
            snapshotHeights[x],
            radius,
            snapshotHeights,
          )
        : this.isSegmentOccludedByRock(
            impactX,
            impactY,
            x,
            snapshotHeights[x],
            snapshotHeights,
          );
      if (isOccluded) {
        protectedColumns[x] = true;
      }
    }

    // 2. Creuser le cratère sur [startX, endX].
    this.carveCraterBand(
      impactX,
      impactY,
      radius,
      startX,
      endX,
      snapshotHeights,
      protectedColumns,
      canCarveRock,
    );

    // 3. Lisser la fenêtre [bandStart, bandEnd] en excluant ROCK et colonnes occultées.
    this.smoothHeights(
      TERRAIN_CRATER_SMOOTH_STRENGTH,
      bandStart,
      bandEnd,
      true,
      protectedColumns,
    );

    // 4. Résoudre l'éboulis local sur [bandStart, bandEnd].
    this.slumpHeights(
      bandStart,
      bandEnd,
      TERRAIN_SLUMP_MAX_PASSES,
      protectedColumns,
    );

    // 5. Garantir la hauteur photographiée des colonnes protégées et des colonnes ROCK non creusées.
    for (let x = bandStart; x <= bandEnd; x++) {
      if (!protectedColumns[x]) continue;
      if (
        canCarveRock &&
        this.materials[x] === TERRAIN_MATERIAL.ROCK &&
        Math.abs(x - impactX) <= radius
      ) {
        continue;
      }
      this.heights[x] = snapshotHeights[x];
    }

    // 6. Marquer le terrain sale pour [bandStart, bandEnd].
    this.markTerrainDirty(bandStart, bandEnd);
  }

  /**
   * Puits de forage le long d’une direction (heightmap).
   * Tamponne le profil parabolique du point d’impact jusqu’à `depth` le long de (dirX, dirY).
   * Ni lissage ni éboulis : le forage conserve des parois franches.
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

    const snapshotHeights = this.heights.slice();
    const maxReach = radius * SOFT_TERRAIN_DESTRUCTION_MULTIPLIER;
    const minX = Math.max(
      0,
      Math.floor(Math.min(impactX, impactX + nx * travel) - maxReach),
    );
    const maxX = Math.min(
      this.width - 1,
      Math.ceil(Math.max(impactX, impactX + nx * travel) + maxReach),
    );

    const forbiddenForAllStamps = new Array<boolean>(this.width).fill(false);
    for (let x = minX; x <= maxX; x++) {
      if (
        this.materials[x] === TERRAIN_MATERIAL.ROCK ||
        this.isSegmentOccludedByRock(
          impactX,
          impactY,
          x,
          snapshotHeights[x],
          snapshotHeights,
        )
      ) {
        forbiddenForAllStamps[x] = true;
      }
    }

    const maxSurfaceY = this.height - 1;

    for (let i = 0; i <= steps; i++) {
      const t = travel === 0 ? 0 : i / steps;
      const stampX = impactX + nx * travel * t;
      const stampY = impactY + ny * travel * t;
      const stampStartX = Math.max(0, Math.floor(stampX - maxReach));
      const stampEndX = Math.min(this.width - 1, Math.floor(stampX + maxReach));
      const impactSoftness = this.getLocalSoftness(stampX);

      for (let x = stampStartX; x <= stampEndX; x++) {
        if (forbiddenForAllStamps[x]) continue;
        if (
          this.isSegmentOccludedByRock(
            stampX,
            stampY,
            x,
            snapshotHeights[x],
            snapshotHeights,
          )
        ) {
          continue;
        }

        const dx = x - stampX;
        const absDx = Math.abs(dx);
        const localSoftness = this.getLocalSoftness(x);
        const blastSoftness =
          impactSoftness > 0
            ? impactSoftness * Math.max(0, 1 - absDx / maxReach)
            : 0;
        const f = Math.max(localSoftness, blastSoftness);
        const halfWidth = radius * (1 + SOFT_TERRAIN_WIDTH_BONUS * f);
        if (absDx > halfWidth) continue;

        const craterDepth = radius * (1 + SOFT_TERRAIN_DEPTH_BONUS * f);
        const ratio = dx / halfWidth;
        const candidate = stampY + craterDepth * (1 - ratio * ratio);
        if (candidate > this.heights[x]) {
          this.heights[x] = Math.min(maxSurfaceY, candidate);
        }
      }
    }

    for (let x = minX; x <= maxX; x++) {
      if (forbiddenForAllStamps[x]) {
        this.heights[x] = snapshotHeights[x];
      }
    }

    this.markTerrainDirty(minX, maxX);
  }

  /**
   * Éboulis déterministe local après lissage des cratères.
   * Relaxe les paires voisines (x, x + 1) en place jusqu'à `maxPasses` aller-retours.
   * Seule la colonne la plus haute (plus petit Y Canvas) descend; ROCK et les colonnes protégées ne bougent jamais.
   */
  public slumpHeights(
    start?: number,
    end?: number,
    maxPasses: number = TERRAIN_SLUMP_MAX_PASSES,
    protectedColumns?: ReadonlyArray<boolean>,
  ): void {
    const s = Math.max(0, start ?? 0);
    const e = Math.min(this.width - 1, end ?? this.width - 1);
    if (e - s < 1 || maxPasses <= 0) return;

    const maxSurfaceY = this.height - 1;

    const relaxPair = (x: number): boolean => {
      const hLeft = this.heights[x];
      const hRight = this.heights[x + 1];
      if (hLeft === hRight) return false;

      const highCol = hLeft < hRight ? x : x + 1;
      const lowCol = highCol === x ? x + 1 : x;

      if (
        this.materials[highCol] === TERRAIN_MATERIAL.ROCK ||
        protectedColumns?.[highCol]
      ) {
        return false;
      }

      const diff = this.heights[lowCol] - this.heights[highCol];
      if (diff <= TERRAIN_SLUMP_THRESHOLD) return false;

      const softness = this.getLocalSoftness(highCol);
      if (softness <= 0) return false;

      const delta =
        Math.min(TERRAIN_SLUMP_MAX_STEP, diff - TERRAIN_SLUMP_THRESHOLD) *
        softness;
      if (delta <= 0) return false;

      const nextHeight = Math.min(maxSurfaceY, this.heights[highCol] + delta);
      if (nextHeight > this.heights[highCol]) {
        this.heights[highCol] = nextHeight;
        return true;
      }
      return false;
    };

    for (let pass = 0; pass < maxPasses; pass++) {
      let changed = false;
      for (let x = s; x < e; x++) {
        if (relaxPair(x)) {
          changed = true;
        }
      }
      for (let x = e - 1; x >= s; x--) {
        if (relaxPair(x)) {
          changed = true;
        }
      }
      if (!changed) break;
    }
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
   * Roche = mur pour le souffle et le creusement. True si le segment (from → to)
   * coupe ou frôle le rectangle solide [c, c+1) × [surfaceY, ∞) d'une colonne ROCK
   * strictement intermédiaire (floor(min) + 1 .. floor(max) - 1), même si fromX est sur ROCK.
   */
  public isBlastOccludedByRock(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    options?: { canCarveRock?: boolean },
  ): boolean {
    void options;
    return this.isSegmentOccludedByRock(fromX, fromY, toX, toY, this.heights);
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
   *  Resets materials to DIRT if newMaterials is absent or mismatched to avoid a silent hybrid state.
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
    } else {
      if (
        newMaterials !== undefined &&
        (!Array.isArray(newMaterials) || newMaterials.length !== this.width)
      ) {
        console.warn(
          "[TerrainManager] loadHeights: materials size mismatch, falling back to DIRT",
        );
      }
      this.materials.fill(TERRAIN_MATERIAL.DIRT);
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
   * Colonnes ROCK strictement intermédiaires : rectangle [c, c+1) × [surfaceY, ∞).
   * Teste si le segment (fromX, fromY) -> (toX, toY) touche ce rectangle
   * pour une colonne c comprise strictement entre floor(fromX) et floor(toX)
   * (contact de frontière inclus).
   */
  private segmentHitsRockColumn(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    c: number,
    surfaceY: number,
  ): boolean {
    const spanX = toX - fromX;
    if (spanX === 0) return false;
    const t0 = (c - fromX) / spanX;
    const t1 = (c + 1 - fromX) / spanX;
    const y0 = fromY + (toY - fromY) * t0;
    const y1 = fromY + (toY - fromY) * t1;
    return Math.max(y0, y1) >= surfaceY;
  }

  /**
   * Teste l'occlusion standard par les colonnes ROCK strictement intermédiaires
   * en lisant la table de hauteurs fournie (`heightsView`).
   */
  private isSegmentOccludedByRock(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    heightsView: ReadonlyArray<number>,
  ): boolean {
    const x0 = Math.floor(fromX);
    const x1 = Math.floor(toX);
    if (x0 === x1) return false;

    const cStart = Math.max(0, Math.min(x0, x1) + 1);
    const cEnd = Math.min(this.width - 1, Math.max(x0, x1) - 1);
    for (let c = cStart; c <= cEnd; c++) {
      if (this.materials[c] !== TERRAIN_MATERIAL.ROCK) continue;
      if (
        this.segmentHitsRockColumn(fromX, fromY, toX, toY, c, heightsView[c])
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Colonnes ROCK strictement intermédiaires : rectangle [c, c+1) × [surfaceY, ∞).
   * Lecture sur photographie des hauteurs avant toute mutation.
   * En mode canCarveRock, le creusement d'une colonne DIRT/SOFT est bloqué par une
   * colonne ROCK strictement hors du rayon nominal (|c - impactX| > radius).
   */
  private isHaloOccludedByOuterRock(
    impactX: number,
    impactY: number,
    targetX: number,
    targetSurfaceY: number,
    radius: number,
    snapshotHeights: ReadonlyArray<number>,
  ): boolean {
    const x0 = Math.floor(impactX);
    const x1 = Math.floor(targetX);
    if (x0 === x1) return false;

    const cStart = Math.max(0, Math.min(x0, x1) + 1);
    const cEnd = Math.min(this.width - 1, Math.max(x0, x1) - 1);
    for (let c = cStart; c <= cEnd; c++) {
      if (this.materials[c] !== TERRAIN_MATERIAL.ROCK) continue;
      if (Math.abs(c - impactX) <= radius) continue;
      if (
        this.segmentHitsRockColumn(
          impactX,
          impactY,
          targetX,
          targetSurfaceY,
          c,
          snapshotHeights[c],
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Calcule la friabilité/douceur progressive du sol à la colonne x (0 = terre pure, 1 = sable pur).
   * Applique un mélange progressif sur les bordures sable-terre pour un comportement physique naturel.
   */
  private getLocalSoftness(
    x: number,
    blendRadius: number = TERRAIN_SOFT_BLEND_RADIUS,
  ): number {
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
   * Creuse la bande [startX, endX] d'un cratère :
   * - ROCK : préservé intact par défaut, ou creusé au profil parabolique nominal (1.0x) si canCarveRock est vrai.
   * - DIRT / SOFT : profil parabolique modulé par la friabilité locale et de souffle.
   */
  private carveCraterBand(
    impactX: number,
    impactY: number,
    radius: number,
    startX: number,
    endX: number,
    snapshotHeights: ReadonlyArray<number>,
    protectedColumns: ReadonlyArray<boolean>,
    canCarveRock: boolean,
  ): void {
    const maxReach = radius * SOFT_TERRAIN_DESTRUCTION_MULTIPLIER;
    const maxSurfaceY = this.height - 1;
    const impactSoftness = this.getLocalSoftness(impactX);

    for (let x = startX; x <= endX; x++) {
      const dx = x - impactX;
      const absDx = Math.abs(dx);

      if (this.materials[x] === TERRAIN_MATERIAL.ROCK) {
        if (canCarveRock && absDx <= radius) {
          const ratio = dx / radius;
          const candidate = impactY + radius * (1 - ratio * ratio);
          if (candidate > snapshotHeights[x]) {
            this.heights[x] = Math.min(maxSurfaceY, candidate);
          }
        }
        continue;
      }

      if (protectedColumns[x]) {
        continue;
      }

      const localSoftness = this.getLocalSoftness(x);
      const blastSoftness =
        impactSoftness > 0
          ? impactSoftness * Math.max(0, 1 - absDx / maxReach)
          : 0;
      const f = Math.max(localSoftness, blastSoftness);
      const halfWidth = radius * (1 + SOFT_TERRAIN_WIDTH_BONUS * f);

      if (absDx > halfWidth) continue;

      const craterDepth = radius * (1 + SOFT_TERRAIN_DEPTH_BONUS * f);
      const ratio = dx / halfWidth;
      const candidate = impactY + craterDepth * (1 - ratio * ratio);
      if (candidate > snapshotHeights[x]) {
        this.heights[x] = Math.min(maxSurfaceY, candidate);
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
   *                      et n'érode pas les colonnes de roche ni les colonnes protégées.
   */
  private smoothHeights(
    strength: number = 0.5,
    start?: number,
    end?: number,
    preserveDepth = false,
    protectedColumns?: ReadonlyArray<boolean>,
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

    const maxSurfaceY = this.height - 1;

    for (let i = 1; i < len - 1; i++) {
      const idx = s + i;
      if (
        preserveDepth &&
        (this.materials[idx] === TERRAIN_MATERIAL.ROCK ||
          protectedColumns?.[idx])
      ) {
        continue;
      }
      const cur = this.smoothScratch[i];
      const avg =
        (this.smoothScratch[i - 1] +
          this.smoothScratch[i] +
          this.smoothScratch[i + 1]) /
        3;
      const blended = cur * (1 - strength) + avg * strength;
      this.heights[idx] = preserveDepth
        ? Math.min(maxSurfaceY, Math.max(cur, blended))
        : blended;
    }
  }
}
