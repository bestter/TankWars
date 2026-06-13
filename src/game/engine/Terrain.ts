/**
 * TankWars - TerrainManager
 *
 * Module de gestion du terrain destructible (heightmap).
 * Respecte strictement les règles du projet :
 * - TypeScript strict, zéro any
 * - Palette VGA 16 couleurs (via VGA_PALETTE)
 * - Algorithme de terrain custom via heightmap (pas de moteur physique externe)
 *
 * Coordinate system:
 *   - (0,0) = top-left
 *   - Y augmente vers le bas (standard Canvas 2D)
 *   - heights[x] = position Y de la surface du terrain à la colonne x
 *   - Tout point avec y >= heights[x] est considéré comme solide
 */

import { VGA_PALETTE } from "../../types/game";

/** Margin from canvas bottom for the lava "floor" level. When terrain is destroyed to/beyond this, lava is exposed visually and tanks touching it die instantly. */
const LAVA_TOP_MARGIN = 6;

/** Must match GameEngine sky fill (#0000AA) so offscreen pixels are always opaque. */
const SKY_COLOR = VGA_PALETTE.DARK_BLUE;

/** Vertical depth of the green grass ribbon along the terrain surface. */
const GRASS_THICKNESS = 3;

export class TerrainManager {
  public readonly width: number;
  public readonly height: number;

  /** Tableau privé des hauteurs de surface (taille = width) */
  private readonly heights: number[];

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
  }

  /**
   * Génère un paysage vallonné fluide en utilisant des ondes sinusoïdales cumulées.
   * Ajoute un offset vertical pour positionner correctement le terrain.
   */
  public generate(): void {
    this.needsFullRedraw = true;
    this.isDirty = true;
    this.dirtyStartX = 0;
    this.dirtyEndX = this.width - 1;
    const base = this.height * 0.62; // offset vertical principal
    const amp1 = this.height * 0.11; // grandes collines
    const amp2 = this.height * 0.065; // collines moyennes
    const amp3 = this.height * 0.032; // détails fins

    for (let x = 0; x < this.width; x++) {
      const nx = x * 0.012; // fréquence de base

      // Ondes sinusoïdales cumulées (superposition)
      let h =
        base +
        Math.sin(nx * 0.9) * amp1 +
        Math.sin(nx * 1.85 + 1.2) * amp2 +
        Math.sin(nx * 3.7 + 2.7) * amp3;

      // Léger bruit haute fréquence pour du relief naturel
      h += Math.sin(x * 0.47) * 2.8;

      // Bornage pour éviter un terrain trop extrême
      const minH = this.height * 0.28;
      const maxH = this.height * 0.86;

      this.heights[x] = Math.max(minH, Math.min(maxH, h));
    }

    // Lissage léger pour un rendu plus fluide
    this.smoothHeights(0.55);
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
   * Brown earth strictly below the grass ribbon (never above the surface).
   * Per-column fill avoids 1px sky gaps on curves; grass is drawn on top separately.
   */
  private drawTerrainFillBandColumns(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    bandStart: number,
    bandEnd: number,
    lavaTop: number,
  ): void {
    ctx.fillStyle = VGA_PALETTE.BROWN;
    for (let x = bandStart; x <= bandEnd; x++) {
      const surfaceY = Math.min(this.heights[x], lavaTop);
      if (surfaceY >= lavaTop) continue;
      const brownTop = Math.min(surfaceY + GRASS_THICKNESS, lavaTop);
      if (brownTop >= lavaTop) continue;
      ctx.fillRect(x, brownTop, 1, lavaTop - brownTop);
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
   * Filled grass ribbon that follows terrain curves with uniform thickness.
   * Stroke/column fills look jagged or "cut" on slopes after partial offscreen updates.
   */
  private drawGrassBand(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    bandStart: number,
    bandEnd: number,
    lavaTop: number,
  ): void {
    ctx.fillStyle = VGA_PALETTE.GREEN;

    let segmentStart: number | null = null;

    const flushSegment = (segmentEnd: number): void => {
      if (segmentStart === null) return;

      const start = segmentStart;
      const end = segmentEnd;

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
        ctx.lineTo(x, Math.min(h + GRASS_THICKNESS, lavaTop));
      }
      ctx.closePath();
      ctx.fill();

      segmentStart = null;
    };

    for (let x = bandStart; x <= bandEnd; x++) {
      if (this.heights[x] < lavaTop) {
        if (segmentStart === null) {
          segmentStart = x;
        }
      } else {
        flushSegment(x - 1);
      }
    }

    if (segmentStart !== null) {
      flushSegment(bandEnd);
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
    // Retro VGA-style lava using DARK_RED base + RED/YELLOW accents for bubbly look
    ctx.fillStyle = VGA_PALETTE.DARK_RED;
    ctx.fillRect(0, lavaTop, this.width, this.height - lavaTop);

    // Simple pixel-art lava texture / bubbles (static for perf + retro feel)
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
   * Creuse un cratère circulaire parfait dans le terrain.
   * Utilise la formule de Pythagore : Δy = √(radius² - (x - impactX)²)
   */
  public destroyTerrain(
    impactX: number,
    impactY: number,
    radius: number,
  ): void {
    if (radius <= 0) return;

    const r = radius;
    const r2 = r * r;

    const startX = Math.max(0, Math.floor(impactX - r));
    const endX = Math.min(this.width - 1, Math.floor(impactX + r));

    for (let x = startX; x <= endX; x++) {
      const dx = x - impactX;
      const dx2 = dx * dx;

      if (dx2 > r2) continue;

      // Formule demandée : Pythagore pour cratère circulaire
      const dy = Math.sqrt(r2 - dx2);

      // Comme Y augmente vers le bas, creuser = augmenter la valeur de hauteur
      const craterDepth = impactY + dy;

      if (craterDepth > this.heights[x]) {
        // Surface can be dug down to the canvas floor (y = height).
        const maxSurfaceY = this.height - 1;
        this.heights[x] = Math.min(maxSurfaceY, craterDepth);
      }
    }

    // Smooth crater edges only — never raise the surface (which would undo destruction).
    const smoothStart = Math.max(0, startX - 3);
    const smoothEnd = Math.min(this.width - 1, endX + 3);
    this.smoothHeights(0.35, smoothStart, smoothEnd, true);

    const bandStart = Math.max(0, smoothStart - 10);
    const bandEnd = Math.min(this.width - 1, smoothEnd + 10);
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

  /** Retourne une copie en lecture seule de la heightmap */
  public getHeightmap(): ReadonlyArray<number> {
    return this.heights.slice();
  }

  /** Y position of the lava "floor" at the bottom of the map. Exposed when terrain heights reach or exceed this (no ground left). Tanks that reach this y die instantly. */
  public get lavaTop(): number {
    return this.height - LAVA_TOP_MARGIN;
  }

  // ==================== Méthodes privées ====================

  /**
   * Lissage de la heightmap (passe moyenne)
   */
  /**
   * @param preserveDepth When true, smoothing never shallowens the surface (keeps craters open).
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
      const cur = this.smoothScratch[i];
      const avg =
        (this.smoothScratch[i - 1] + this.smoothScratch[i] + this.smoothScratch[i + 1]) / 3;
      const blended = cur * (1 - strength) + avg * strength;
      this.heights[idx] = preserveDepth ? Math.max(cur, blended) : blended;
    }
  }
}
