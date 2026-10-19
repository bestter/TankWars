import { describe, expect, it, vi } from "vitest";
import { VGA_PALETTE } from "../../../types/game";
import type { TerrainMaterial } from "../../../types/terrain";
import { WEAPON_REGISTRY } from "../../../types/weapon";
import { TerrainManager } from "../Terrain";

// Sample pixel centers so coverage assertions exercise the rendered result,
// rather than just counting drawing calls. This small rasterizer supports both
// the previous polygon ribbons and the new column caps (without antialiasing).
class PixelCanvas {
  readonly pixels: string[];
  private readonly width: number;
  readonly context: CanvasRenderingContext2D;

  constructor(width: number, height: number) {
    this.width = width;
    this.pixels = Array<string>(width * height).fill("");
    let color = "";
    let path: [number, number][] = [];
    this.context = {
      get fillStyle() { return color; },
      set fillStyle(value: string) { color = value; },
      fillRect: (x: number, y: number, w: number, h: number) => {
        for (let row = 0; row < height; row++) {
          if (row + 0.5 < y || row + 0.5 >= y + h) continue;
          for (let col = 0; col < width; col++) {
            if (col + 0.5 >= x && col + 0.5 < x + w) {
              this.pixels[row * width + col] = color;
            }
          }
        }
      },
      beginPath() { path = []; },
      moveTo(x: number, y: number) { path.push([x, y]); },
      lineTo(x: number, y: number) { path.push([x, y]); },
      closePath() {},
      fill: () => {
        for (let row = 0; row < height; row++) {
          for (let col = 0; col < width; col++) {
            const px = col + 0.5;
            const py = row + 0.5;
            let inside = false;
            for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
              const [xi, yi] = path[i];
              const [xj, yj] = path[j];
              if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
                inside = !inside;
              }
            }
            if (inside) this.pixels[row * width + col] = color;
          }
        }
      },
      drawImage() {},
    } as unknown as CanvasRenderingContext2D;
  }

  getContext(): CanvasRenderingContext2D { return this.context; }
  at(x: number, y: number): string { return this.pixels[y * this.width + x]; }
}

describe("terrain material junctions", () => {
  it("covers isolated material columns and the last column, clipping caps at lava", () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    try {
      const terrain = new TerrainManager(6, 30);
      const materials: TerrainMaterial[] = ["DIRT", "ROCK", "SOFT", "DIRT", "ROCK", "SOFT"];
      terrain.loadHeights([10, 13, 9, 23, 24, 22], materials);
      const canvas = new PixelCanvas(6, 30);
      terrain.draw(canvas.context);
      const colors = [VGA_PALETTE.GREEN, VGA_PALETTE.GRAY, VGA_PALETTE.YELLOW];
      for (let x = 0; x < 3; x++) {
        const y = terrain.getHeightAt(x);
        for (let offset = 0; offset < 3; offset++) {
          expect(canvas.at(x, y + offset)).toBe(colors[x]);
        }
        expect(canvas.at(x, y - 1)).toBe(VGA_PALETTE.DARK_BLUE);
      }
      expect(canvas.at(3, 23)).toBe(VGA_PALETTE.GREEN);
      expect(canvas.at(5, 22)).toBe(VGA_PALETTE.YELLOW);
      expect(canvas.at(5, 23)).toBe(VGA_PALETTE.YELLOW);
      for (const x of [3, 4, 5]) {
        expect(canvas.at(x, terrain.lavaTop)).toBe(VGA_PALETTE.DARK_RED);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("matches full, partial and fallback terrain pixels after a nuclear crater", () => {
    const buffers: PixelCanvas[] = [];
    vi.stubGlobal("OffscreenCanvas", class extends PixelCanvas {
      constructor(width: number, height: number) {
        super(width, height);
        buffers.push(this);
      }
    });
    try {
      const terrain = new TerrainManager(180, 100);
      const materials: TerrainMaterial[] = Array.from({ length: 180 }, (_, x) =>
        x < 70 ? "DIRT" : x < 100 ? "ROCK" : "SOFT",
      );
      terrain.loadHeights(Array<number>(180).fill(40), materials);
      const output = new PixelCanvas(180, 100);
      terrain.draw(output.context);
      terrain.destroyTerrain(75.6, 40, 20, { canCarveRock: true });
      terrain.draw(output.context);
      expect(buffers).toHaveLength(1); // Reused cache exercises partial redraw.
      const partial = buffers[0];
      const full = new TerrainManager(180, 100);
      full.loadHeights([...terrain.getHeightmap()], [...terrain.getMaterials()]);
      full.draw(output.context);
      expect(buffers).toHaveLength(2);
      // Lava texture has its own band-relative pattern; compare terrain and sky.
      const terrainPixels = 180 * terrain.lavaTop;
      expect(partial.pixels.slice(0, terrainPixels)).toEqual(buffers[1].pixels.slice(0, terrainPixels));
      vi.stubGlobal("OffscreenCanvas", undefined);
      const fallback = new TerrainManager(180, 100);
      fallback.loadHeights([...terrain.getHeightmap()], [...terrain.getMaterials()]);
      const direct = new PixelCanvas(180, 100);
      fallback.draw(direct.context);
      // The fallback receives a sky background from GameEngine in production.
      for (let x = 0; x < 180; x++) {
        for (let y = Math.ceil(terrain.getHeightAt(x)); y < terrain.lavaTop; y++) {
          expect(direct.at(x, y)).toBe(partial.at(x, y));
        }
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["NUKE", "THERMONUCLEAR"] as const)("uses one parabola across both DIRT/ROCK orientations for %s", (weapon) => {
    const radius = WEAPON_REGISTRY[weapon].blastRadius;
    const impactX = 250.6;
    const impactY = 100;
    for (const rockOnRight of [true, false]) {
      const terrain = new TerrainManager(520, 500);
      terrain.loadHeights(Array<number>(520).fill(impactY));
      const boundary = Math.floor(impactX + radius / 2);
      terrain.setMaterialRange(rockOnRight ? boundary : 0, rockOnRight ? 519 : boundary - 1, "ROCK");
      terrain.destroyTerrain(impactX, impactY, radius, { canCarveRock: true });
      for (let x = boundary - 3; x <= boundary + 3; x++) {
        const expected = impactY + radius * (1 - ((x - impactX) / radius) ** 2);
        expect(terrain.getHeightAt(x)).toBeCloseTo(expected, 8);
      }
    }
  });
});
