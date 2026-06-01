/**
 * TankWars - Destructible Terrain Engine (src/game/engine/Terrain.ts)
 *
 * Uses a high-density 1D heightmap for performance and simplicity.
 * This approach is explicitly allowed by project guidelines ("high-density heightmaps").
 *
 * - Generation: Layered sine waves + light random noise for rolling hills.
 * - Destruction: Circular crater carving by raising surface heights.
 * - Fully decoupled from React and from the rendering loop.
 *
 * Coordinate system:
 *   - (0,0) = top-left of canvas
 *   - Y increases downward (standard Canvas2D)
 *   - heights[x] = y coordinate of the terrain surface at column x
 *   - Everything with y >= heights[x] is solid ground.
 */

export class Terrain {
  public readonly width: number;
  public readonly height: number;

  /** y-position of surface for each integer x column. */
  private readonly heights: number[];

  constructor(width: number, height: number) {
    if (width <= 0 || height <= 0) {
      throw new Error('Terrain dimensions must be positive');
    }
    this.width = Math.floor(width);
    this.height = Math.floor(height);
    this.heights = new Array(this.width).fill(this.height * 0.72);
  }

  /**
   * Generates rolling hills using multiple sine octaves + small noise.
   * Deterministic when a seed is provided (simple LCG).
   */
  generate(seed: number = 1337): void {
    // Simple LCG for reproducibility
    let rng = seed >>> 0;

    const random = (): number => {
      rng = (rng * 1664525 + 1013904223) >>> 0;
      return (rng >>> 8) / 0x1000000; // [0, 1)
    };

    const baseHeight = this.height * 0.68;
    const amplitude1 = this.height * 0.09;
    const amplitude2 = this.height * 0.055;
    const amplitude3 = this.height * 0.025;

    for (let x = 0; x < this.width; x++) {
      const xf = x / this.width;

      let h = baseHeight;

      // Large rolling hills
      h += Math.sin(xf * Math.PI * 2.7 + random() * 0.6) * amplitude1;
      // Medium detail
      h += Math.sin(xf * Math.PI * 5.3 + 1.7 + random() * 0.4) * amplitude2;
      // Fine hills
      h += Math.sin(xf * Math.PI * 11.8 + 4.2) * amplitude3;

      // Very light high-frequency noise (jaggedness)
      h += (random() - 0.5) * 7.5;

      // Clamp to reasonable playable range
      const minSurface = Math.floor(this.height * 0.22);
      const maxSurface = Math.floor(this.height * 0.88);
      this.heights[x] = Math.max(minSurface, Math.min(maxSurface, h));
    }

    // Light smoothing pass (reduces single-column spikes while keeping hills)
    const smoothed = [...this.heights];
    for (let x = 1; x < this.width - 1; x++) {
      smoothed[x] = (this.heights[x - 1] + this.heights[x] * 1.6 + this.heights[x + 1]) / 3.6;
    }
    for (let x = 1; x < this.width - 1; x++) {
      this.heights[x] = smoothed[x];
    }
  }

  /** Returns the terrain surface Y at the given x (clamped). */
  getHeightAt(x: number): number {
    const xi = Math.max(0, Math.min(this.width - 1, Math.floor(x)));
    return this.heights[xi];
  }

  /**
   * Carves a circular crater centered at (centerX, centerY) with given radius.
   * This is the core destructible terrain method called by explosions.
   */
  destroyTerrain(centerX: number, centerY: number, radius: number): void {
    if (radius <= 0) return;

    const r = radius;
    const r2 = r * r;
    const startX = Math.max(0, Math.floor(centerX - r));
    const endX = Math.min(this.width - 1, Math.floor(centerX + r));

    for (let x = startX; x <= endX; x++) {
      const dx = x - centerX;
      const dx2 = dx * dx;

      if (dx2 > r2) continue;

      const dy = Math.sqrt(r2 - dx2);

      // Because Y increases downward, digging deeper = larger Y value
      const newHeight = centerY + dy;

      if (newHeight > this.heights[x]) {
        this.heights[x] = newHeight;
      }
    }

    // Optional: very light re-smoothing near crater edges for nicer visuals
    this.smoothRegion(Math.max(0, startX - 2), Math.min(this.width - 1, endX + 2), 0.6);
  }

  /** Simple local smoothing helper used after destruction. */
  private smoothRegion(start: number, end: number, strength: number = 0.5): void {
    const original = this.heights.slice(start, end + 1);

    for (let i = 1; i < original.length - 1; i++) {
      const x = start + i;
      const avg = (original[i - 1] + original[i] + original[i + 1]) / 3;
      this.heights[x] = this.heights[x] * (1 - strength) + avg * strength;
    }
  }

  /** Returns true if the point (x, y) is inside solid ground. */
  isSolid(x: number, y: number): boolean {
    if (x < 0 || x >= this.width) return false;
    return y >= this.heights[Math.floor(x)];
  }

  /** Returns a readonly copy of the heightmap (useful for debugging / serialization). */
  getHeightmap(): ReadonlyArray<number> {
    return this.heights;
  }
}
