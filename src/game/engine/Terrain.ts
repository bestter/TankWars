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

import { VGA_PALETTE } from '../../types/game';

export class TerrainManager {
  public readonly width: number;
  public readonly height: number;

  /** Tableau privé des hauteurs de surface (taille = width) */
  private readonly heights: number[];

  constructor(width: number, height: number) {
    if (width <= 0 || height <= 0) {
      throw new Error('TerrainManager: width and height must be positive');
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
    const base = this.height * 0.62;           // offset vertical principal
    const amp1 = this.height * 0.11;           // grandes collines
    const amp2 = this.height * 0.065;          // collines moyennes
    const amp3 = this.height * 0.032;          // détails fins

    for (let x = 0; x < this.width; x++) {
      const nx = x * 0.012;                    // fréquence de base

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
   * Dessine le terrain sur le contexte canvas en utilisant une couleur unie
   * de la palette VGA.
   */
  public draw(ctx: CanvasRenderingContext2D): void {
    // Couleur de remplissage du terrain (Marron de la palette VGA)
    ctx.fillStyle = VGA_PALETTE.BROWN;

    ctx.beginPath();
    ctx.moveTo(0, this.height);

    for (let x = 0; x < this.width; x++) {
      ctx.lineTo(x, this.heights[x]);
    }

    ctx.lineTo(this.width, this.height);
    ctx.closePath();
    ctx.fill();

    // Ligne supérieure du terrain (vert VGA pour l'herbe)
    ctx.strokeStyle = VGA_PALETTE.GREEN;
    ctx.lineWidth = 3;
    ctx.beginPath();

    for (let x = 0; x < this.width; x++) {
      if (x === 0) {
        ctx.moveTo(x, this.heights[x]);
      } else {
        ctx.lineTo(x, this.heights[x]);
      }
    }
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  /**
   * Creuse un cratère circulaire parfait dans le terrain.
   * Utilise la formule de Pythagore : Δy = √(radius² - (x - impactX)²)
   */
  public destroyTerrain(impactX: number, impactY: number, radius: number): void {
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
    this.smoothHeights(0.35, startX - 3, endX + 3, true);
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

    const copy = this.heights.slice(s, e + 1);

    for (let i = 1; i < copy.length - 1; i++) {
      const idx = s + i;
      const avg = (copy[i - 1] + copy[i] + copy[i + 1]) / 3;
      const blended = copy[i] * (1 - strength) + avg * strength;
      this.heights[idx] = preserveDepth ? Math.max(copy[i], blended) : blended;
    }
  }
}

