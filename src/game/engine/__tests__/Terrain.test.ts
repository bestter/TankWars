import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerrainManager } from '../Terrain';
import { terrainInternals } from '../../__tests__/helpers';
import { DRILLER_SHAFT_DEPTH } from '../../../types/weapon';

describe('TerrainManager', () => {
  describe('getHeightAt', () => {
    let terrain: TerrainManager;
    const WIDTH = 100;
    const HEIGHT = 100;

    beforeEach(() => {
      terrain = new TerrainManager(WIDTH, HEIGHT);
      // Initialize terrain. By default, heights are filled with height * 0.7 = 70.
      // Let's set some specific heights to test clamping correctly.
      const heights = (terrain as unknown as { heights: number[] }).heights;
      for (let i = 0; i < WIDTH; i++) {
        heights[i] = i; // heights[0] = 0, heights[1] = 1, ... heights[99] = 99
      }
    });

    it('should return correct height for in-bounds coordinate', () => {
      expect(terrain.getHeightAt(50)).toBe(50);
    });

    it('should clamp negative coordinates to 0', () => {
      expect(terrain.getHeightAt(-10)).toBe(0);
      expect(terrain.getHeightAt(-1)).toBe(0);
    });

    it('should clamp out-of-bounds coordinates to width - 1', () => {
      expect(terrain.getHeightAt(WIDTH)).toBe(WIDTH - 1);
      expect(terrain.getHeightAt(WIDTH + 50)).toBe(WIDTH - 1);
    });

    it('should floor non-integer coordinates', () => {
      expect(terrain.getHeightAt(5.7)).toBe(5);
      expect(terrain.getHeightAt(5.1)).toBe(5);
    });
  });




  describe('checkCollision', () => {
    let terrain: TerrainManager;
    const width = 100;
    const height = 200;

    beforeEach(() => {
      terrain = new TerrainManager(width, height);
      // constructor sets all heights to height * 0.7 = 140
      // So surfaceY is 140 for all x in 0..99
    });

    it('should return false for out-of-bounds x coordinates', () => {
      // Negative x
      expect(terrain.checkCollision(-1, 150)).toBe(false);
      expect(terrain.checkCollision(-10, 150)).toBe(false);

      // x >= width
      expect(terrain.checkCollision(100, 150)).toBe(false);
      expect(terrain.checkCollision(105, 150)).toBe(false);
    });

    it('should return false for points above the surface', () => {
      // Surface is at y = 140. Above surface means y < 140
      expect(terrain.checkCollision(50, 0)).toBe(false);
      expect(terrain.checkCollision(50, 139)).toBe(false);
      expect(terrain.checkCollision(0, 50)).toBe(false);
      expect(terrain.checkCollision(99, 139)).toBe(false);
    });

    it('should return true for points exactly on the surface', () => {
      // Surface is at y = 140.
      expect(terrain.checkCollision(50, 140)).toBe(true);
      expect(terrain.checkCollision(0, 140)).toBe(true);
      expect(terrain.checkCollision(99, 140)).toBe(true);
    });

    it('should return true for points below the surface', () => {
      // Surface is at y = 140. Below surface means y > 140
      expect(terrain.checkCollision(50, 141)).toBe(true);
      expect(terrain.checkCollision(50, 199)).toBe(true);
      expect(terrain.checkCollision(0, 150)).toBe(true);
      expect(terrain.checkCollision(99, 200)).toBe(true);
    });

    it('should correctly evaluate collision with non-integer x coordinates', () => {
      // Math.floor(x) is used internally
      expect(terrain.checkCollision(50.5, 140)).toBe(true);
      expect(terrain.checkCollision(50.5, 139)).toBe(false);
      expect(terrain.checkCollision(99.9, 140)).toBe(true);
      expect(terrain.checkCollision(-0.1, 150)).toBe(false); // Math.floor(-0.1) is -1, out of bounds
    });

    it('should evaluate collision correctly after terrain destruction', () => {
      // Create a crater at x=50, radius=10, impact at y=140
      terrain.destroyTerrain(50, 140, 10);

      // The surface should be deeper around x=50 now.
      const newHeightAt50 = terrain.getHeightAt(50);

      // Points that were previously colliding (e.g. y=140) might not collide now if crater is deeper than that
      // Assuming destruction formula dy = sqrt(100 - 0) = 10 -> depth = 140 + 10 = 150
      // So new surface at x=50 should be close to 150 (depends on smoothing, but deeper than 140)
      expect(newHeightAt50).toBeGreaterThan(140);

      // Collision should be false at the old surface point
      expect(terrain.checkCollision(50, 140)).toBe(false);

      // Collision should be true below the new surface point
      expect(terrain.checkCollision(50, newHeightAt50)).toBe(true);
      expect(terrain.checkCollision(50, newHeightAt50 + 5)).toBe(true);
    });
  });



  describe('destroyTerrain crater', () => {
    it('does nothing when radius is 0 or negative', () => {
      const terrain = new TerrainManager(100, 200);
      const before = terrain.getHeightAt(50);
      terrain.destroyTerrain(50, 140, 0);
      terrain.destroyTerrain(50, 140, -4);
      expect(terrain.getHeightAt(50)).toBe(before);
    });

    it('digs a circular crater under the impact and leaves far columns unchanged', () => {
      const terrain = new TerrainManager(200, 200);
      const farBefore = terrain.getHeightAt(180);
      const underBefore = terrain.getHeightAt(50);

      terrain.destroyTerrain(50, underBefore, 20);

      expect(terrain.getHeightAt(50)).toBeGreaterThan(underBefore);
      expect(terrain.getHeightAt(180)).toBe(farBefore);
    });

    it('treats NaN collision coordinates as a miss', () => {
      const terrain = new TerrainManager(100, 200);
      expect(terrain.checkCollision(NaN, 150)).toBe(false);
    });
  });

  describe('partial offscreen dirty band', () => {
    const WIDTH = 200;
    const HEIGHT = 200;

    function mockCtx(): CanvasRenderingContext2D {
      return {
        clearRect: vi.fn(),
        fillRect: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        closePath: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        drawImage: vi.fn(),
      } as unknown as CanvasRenderingContext2D;
    }

    it('marks needsFullRedraw after generate()', () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      const internal = terrainInternals(terrain);

      terrain.generate();

      expect(internal.needsFullRedraw).toBe(true);
      expect(internal.isDirty).toBe(true);
    });

    it('clears needsFullRedraw after first full draw', () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      const internal = terrainInternals(terrain);
      terrain.generate();

      terrain.draw(mockCtx());

      expect(internal.needsFullRedraw).toBe(false);
      expect(internal.isDirty).toBe(false);
    });

    it('tracks dirty horizontal band after destroyTerrain without forcing full redraw', () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      const internal = terrainInternals(terrain);
      terrain.generate();
      terrain.draw(mockCtx());

      terrain.destroyTerrain(40, 140, 12);

      expect(internal.isDirty).toBe(true);
      expect(internal.needsFullRedraw).toBe(false);
      expect(internal.dirtyStartX).toBeLessThanOrEqual(40);
      expect(internal.dirtyEndX).toBeGreaterThanOrEqual(40);
    });

    it('merges dirty bands across multiple destroyTerrain calls', () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      const internal = terrainInternals(terrain);
      terrain.generate();
      terrain.draw(mockCtx());

      terrain.destroyTerrain(25, 140, 10);
      const firstStart = internal.dirtyStartX;
      const firstEnd = internal.dirtyEndX;

      terrain.destroyTerrain(170, 140, 10);

      expect(internal.dirtyStartX).toBeLessThanOrEqual(firstStart);
      expect(internal.dirtyEndX).toBeGreaterThanOrEqual(firstEnd);
      expect(internal.dirtyEndX).toBeGreaterThan(150);
      expect(internal.needsFullRedraw).toBe(false);
    });

    it('resets dirty band to full width after generate()', () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      const internal = terrainInternals(terrain);
      terrain.generate();
      terrain.draw(mockCtx());
      terrain.destroyTerrain(40, 140, 12);

      terrain.generate();

      expect(internal.dirtyStartX).toBe(0);
      expect(internal.dirtyEndX).toBe(WIDTH - 1);
      expect(internal.needsFullRedraw).toBe(true);
    });
  });

  describe('loadHeights (online authoritative terrain)', () => {
    const WIDTH = 50;
    const HEIGHT = 100;

    it('replaces heightmap when array length matches terrain width', () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      const internal = terrainInternals(terrain);
      const serverHeights = Array.from({ length: WIDTH }, (_, i) => 40 + i);

      terrain.loadHeights(serverHeights);

      expect(terrain.getHeightAt(10)).toBe(50);
      expect(terrain.getHeightAt(49)).toBe(89);
      expect(internal.isDirty).toBe(true);
      expect(internal.needsFullRedraw).toBe(true);
      expect(internal.dirtyStartX).toBe(0);
      expect(internal.dirtyEndX).toBe(WIDTH - 1);
    });

    it('ignores loadHeights when server array length mismatches', () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      const before = terrain.getHeightAt(10);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      terrain.loadHeights([1, 2, 3]);

      expect(terrain.getHeightAt(10)).toBe(before);
      warnSpy.mockRestore();
    });
  });

  describe("destroyTerrainShaft (DRILLER)", () => {
    const WIDTH = 200;
    const HEIGHT = 200;
    const FLAT_Y = 80;
    const RADIUS = 14;
    const DEPTH = DRILLER_SHAFT_DEPTH;

    function flatTerrain(): TerrainManager {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      terrain.loadHeights(Array.from({ length: WIDTH }, () => FLAT_Y));
      return terrain;
    }

    it("creuse ~3× plus profond qu’un cratère circulaire du même rayon (impact vertical)", () => {
      const bowl = flatTerrain();
      bowl.destroyTerrain(100, FLAT_Y, RADIUS);
      const bowlDepth = bowl.getHeightAt(100) - FLAT_Y;

      const shaft = flatTerrain();
      shaft.destroyTerrainShaft(100, FLAT_Y, 0, 1, DEPTH, RADIUS);
      const shaftDepth = shaft.getHeightAt(100) - FLAT_Y;

      expect(bowlDepth).toBeGreaterThan(0);
      expect(shaftDepth).toBeGreaterThan(bowlDepth * 2.5);
      expect(shaftDepth).toBeGreaterThanOrEqual(DEPTH - 2);
      expect(shaftDepth).toBeLessThanOrEqual(DEPTH + 1);
    });

    it("à 45° vers la droite, le point le plus profond est décalé vers +x", () => {
      const terrain = flatTerrain();
      terrain.destroyTerrainShaft(100, FLAT_Y, 1, 1, DEPTH, RADIUS);

      let deepestX = 100;
      let deepestY = terrain.getHeightAt(100);
      for (let x = 70; x <= 150; x++) {
        const y = terrain.getHeightAt(x);
        if (y > deepestY) {
          deepestY = y;
          deepestX = x;
        }
      }

      expect(deepestX).toBeGreaterThan(100);
      expect(terrain.getHeightAt(100)).toBeGreaterThan(FLAT_Y);
      expect(terrain.getHeightAt(180)).toBe(FLAT_Y);
    });

    it("à 45° vers la gauche, le point le plus profond est décalé vers −x", () => {
      const terrain = flatTerrain();
      terrain.destroyTerrainShaft(100, FLAT_Y, -1, 1, DEPTH, RADIUS);

      let deepestX = 100;
      let deepestY = terrain.getHeightAt(100);
      for (let x = 50; x <= 130; x++) {
        const y = terrain.getHeightAt(x);
        if (y > deepestY) {
          deepestY = y;
          deepestX = x;
        }
      }

      expect(deepestX).toBeLessThan(100);
    });

    it("ne fait rien si depth ou radius ≤ 0", () => {
      const terrain = flatTerrain();
      terrain.destroyTerrainShaft(100, FLAT_Y, 0, 1, 0, RADIUS);
      terrain.destroyTerrainShaft(100, FLAT_Y, 0, 1, DEPTH, 0);
      expect(terrain.getHeightAt(100)).toBe(FLAT_Y);
    });

    it("marque une dirty band horizontale sans full redraw", () => {
      const terrain = flatTerrain();
      const internal = terrainInternals(terrain);
      internal.needsFullRedraw = false;
      internal.isDirty = false;

      terrain.destroyTerrainShaft(40, FLAT_Y, 0, 1, DEPTH, RADIUS);

      expect(internal.isDirty).toBe(true);
      expect(internal.needsFullRedraw).toBe(false);
      expect(internal.dirtyStartX).toBeLessThanOrEqual(40);
      expect(internal.dirtyEndX).toBeGreaterThanOrEqual(40);
    });
  });

  describe("Terrain Materials (DIRT, ROCK, SOFT)", () => {
    const WIDTH = 100;
    const HEIGHT = 200;

    it("initializes default material to DIRT", () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      expect(terrain.getMaterialAt(0)).toBe("DIRT");
      expect(terrain.getMaterialAt(50)).toBe("DIRT");
      expect(terrain.getMaterialAt(99)).toBe("DIRT");
    });

    it("allows getting and setting materials individually and in ranges", () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      terrain.setMaterialAt(20, "ROCK");
      expect(terrain.getMaterialAt(20)).toBe("ROCK");
      expect(terrain.getMaterialAt(21)).toBe("DIRT");

      terrain.setMaterialRange(30, 45, "SOFT");
      for (let x = 30; x <= 45; x++) {
        expect(terrain.getMaterialAt(x)).toBe("SOFT");
      }
      expect(terrain.getMaterialAt(29)).toBe("DIRT");
      expect(terrain.getMaterialAt(46)).toBe("DIRT");
    });

    it("clamps out-of-bounds coordinates for getMaterialAt and setMaterialAt", () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      terrain.setMaterialAt(-10, "ROCK");
      expect(terrain.getMaterialAt(0)).toBe("ROCK");
      expect(terrain.getMaterialAt(-5)).toBe("ROCK");

      terrain.setMaterialAt(150, "SOFT");
      expect(terrain.getMaterialAt(WIDTH - 1)).toBe("SOFT");
      expect(terrain.getMaterialAt(200)).toBe("SOFT");
    });

    it("supports loading full material array via loadMaterials", () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      const mats = Array.from({ length: WIDTH }, (_, i) =>
        i < 50 ? ("ROCK" as const) : ("SOFT" as const),
      );
      terrain.loadMaterials(mats);

      expect(terrain.getMaterialAt(10)).toBe("ROCK");
      expect(terrain.getMaterialAt(80)).toBe("SOFT");
    });

    it("supports loading heights and materials together in loadHeights", () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      const heights = Array.from({ length: WIDTH }, () => 120);
      const mats = Array.from({ length: WIDTH }, () => "ROCK" as const);

      terrain.loadHeights(heights, mats);

      expect(terrain.getHeightAt(10)).toBe(120);
      expect(terrain.getMaterialAt(10)).toBe("ROCK");
    });

    it("resets materials to DIRT when loadHeights is called without newMaterials to prevent hybrid state", () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      terrain.setMaterialRange(0, WIDTH - 1, "ROCK");
      expect(terrain.getMaterialAt(10)).toBe("ROCK");

      const heights = Array.from({ length: WIDTH }, () => 130);
      terrain.loadHeights(heights);

      expect(terrain.getHeightAt(10)).toBe(130);
      expect(terrain.getMaterialAt(10)).toBe("DIRT");
      expect(terrain.getMaterials().every((m) => m === "DIRT")).toBe(true);
    });

    it("resets materials to DIRT and warns when loadHeights receives mismatched materials array", () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      terrain.setMaterialRange(0, WIDTH - 1, "SOFT");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const heights = Array.from({ length: WIDTH }, () => 140);
      terrain.loadHeights(heights, ["ROCK" as const, "SOFT" as const]); // length 2 !== WIDTH (100)

      expect(terrain.getHeightAt(10)).toBe(140);
      expect(terrain.getMaterialAt(10)).toBe("DIRT");
      expect(terrain.getMaterials().every((m) => m === "DIRT")).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("materials size mismatch"));
      warnSpy.mockRestore();
    });
  });

  describe("Procedural Generation & Diversity", () => {
    it("generates varied terrain heightmaps across multiple runs", () => {
      const t1 = new TerrainManager(200, 300);
      const t2 = new TerrainManager(200, 300);

      t1.generate();
      t2.generate();

      const h1 = t1.getHeightmap();
      const h2 = t2.getHeightmap();

      let diffCount = 0;
      for (let x = 0; x < 200; x++) {
        if (Math.abs(h1[x] - h2[x]) > 1.0) {
          diffCount++;
        }
      }

      expect(diffCount).toBeGreaterThan(50);
    });

    it("generates terrain heights strictly within playable boundaries", () => {
      const height = 400;
      const terrain = new TerrainManager(300, height);

      for (let run = 0; run < 5; run++) {
        terrain.generate();
        const minAllowed = height * 0.28 - 1e-4;
        const maxAllowed = height * 0.86 + 1e-4;

        for (let x = 0; x < 300; x++) {
          const h = terrain.getHeightAt(x);
          expect(h).toBeGreaterThanOrEqual(minAllowed);
          expect(h).toBeLessThanOrEqual(maxAllowed);
        }
      }
    });

    it("generates rock (ROCK) and soft (SOFT) zones during generate()", () => {
      const terrain = new TerrainManager(400, 300);
      let hasRock = false;
      let hasSoft = false;
      let hasDirt = false;
      for (let i = 0; i < 8; i++) {
        terrain.generate();
        const mats = terrain.getMaterials();
        hasRock = hasRock || mats.some((m) => m === "ROCK");
        hasSoft = hasSoft || mats.some((m) => m === "SOFT");
        hasDirt = hasDirt || mats.some((m) => m === "DIRT");
        if (hasRock && hasSoft && hasDirt) break;
      }

      expect(hasRock).toBe(true);
      expect(hasSoft).toBe(true);
      expect(hasDirt).toBe(true);
    });
  });

  describe("Indestructible Rock (ROCK)", () => {
    const WIDTH = 100;
    const HEIGHT = 200;
    const FLAT_Y = 100;

    it("does not deform or carve when explosions hit rock columns", () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      terrain.loadHeights(Array.from({ length: WIDTH }, () => FLAT_Y));
      terrain.setMaterialRange(40, 60, "ROCK");

      // Explosion directly in the rock zone
      terrain.destroyTerrain(50, FLAT_Y, 15);

      for (let x = 40; x <= 60; x++) {
        expect(terrain.getHeightAt(x)).toBe(FLAT_Y);
      }
    });

    it("only carves non-rock columns when explosion spans across rock and dirt", () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      terrain.loadHeights(Array.from({ length: WIDTH }, () => FLAT_Y));
      // Rock on x: [50, 70], Dirt on x: [30, 49]
      terrain.setMaterialRange(50, 70, "ROCK");

      terrain.destroyTerrain(50, FLAT_Y, 15);

      // Rock half (x >= 50) is intact
      for (let x = 50; x <= 65; x++) {
        expect(terrain.getHeightAt(x)).toBe(FLAT_Y);
      }

      // Dirt half (x < 50) is carved
      expect(terrain.getHeightAt(45)).toBeGreaterThan(FLAT_Y);
    });

    it("blocks a ground-level blast through intermediate rock columns even when exploding on rock, but not over it or on the same column", () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      terrain.loadHeights(Array.from({ length: WIDTH }, () => FLAT_Y));
      terrain.setMaterialRange(40, 60, "ROCK");

      // Side impact: dirt → dirt beyond the wall
      expect(terrain.isBlastOccludedByRock(20, FLAT_Y, 80, FLAT_Y)).toBe(true);
      // Same side of the wall
      expect(terrain.isBlastOccludedByRock(20, FLAT_Y, 30, FLAT_Y)).toBe(false);
      // Exploding on top of the rock at y=FLAT_Y: intermediate rock columns 51..60 touch y=FLAT_Y and occlude
      expect(terrain.isBlastOccludedByRock(50, FLAT_Y, 80, FLAT_Y)).toBe(true);
      // Same rock column (no intermediate column) is not occluded
      expect(terrain.isBlastOccludedByRock(50, FLAT_Y, 50.8, FLAT_Y)).toBe(false);
      // Blast flies over the rock (ray stays in the air)
      expect(terrain.isBlastOccludedByRock(20, 40, 80, 40)).toBe(false);
    });

    it("does not carve dirt on the far side of a rock wall", () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      terrain.loadHeights(Array.from({ length: WIDTH }, () => FLAT_Y));
      terrain.setMaterialRange(40, 60, "ROCK");

      terrain.destroyTerrain(20, FLAT_Y, 70);

      expect(terrain.getHeightAt(25)).toBeGreaterThan(FLAT_Y);
      expect(terrain.getHeightAt(80)).toBe(FLAT_Y);
    });

    it("preserves rock columns during driller shaft impacts", () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      terrain.loadHeights(Array.from({ length: WIDTH }, () => FLAT_Y));
      terrain.setMaterialRange(40, 60, "ROCK");

      terrain.destroyTerrainShaft(50, FLAT_Y, 0, 1, 50, 10);

      for (let x = 40; x <= 60; x++) {
        expect(terrain.getHeightAt(x)).toBe(FLAT_Y);
      }
    });
  });

  describe("Soft Terrain (SOFT)", () => {
    const WIDTH = 200;
    const HEIGHT = 300;
    const FLAT_Y = 100;
    const RADIUS = 12;

    it("preserves the historical 2.5x depth and reach on SOFT with rounded shoulders", () => {
      const dirtTerrain = new TerrainManager(WIDTH, HEIGHT);
      dirtTerrain.loadHeights(Array.from({ length: WIDTH }, () => FLAT_Y));
      dirtTerrain.destroyTerrain(50, FLAT_Y, RADIUS);
      const dirtDepth = dirtTerrain.getHeightAt(50) - FLAT_Y;

      const softTerrain = new TerrainManager(WIDTH, HEIGHT);
      softTerrain.loadHeights(Array.from({ length: WIDTH }, () => FLAT_Y));
      softTerrain.setMaterialRange(0, WIDTH - 1, "SOFT");
      softTerrain.destroyTerrain(50, FLAT_Y, RADIUS);
      const softDepth = softTerrain.getHeightAt(50) - FLAT_Y;

      expect(softDepth).toBeCloseTo(dirtDepth * 2.5, 6);
      // Outside nominal radius (dx = 14 > 12), dirt is untouched while soft is carved
      expect(dirtTerrain.getHeightAt(50 + 14)).toBe(FLAT_Y);
      expect(softTerrain.getHeightAt(50 + 14)).toBeGreaterThan(FLAT_Y);
      // The former reduced halo ended at 1.45r; the restored halo reaches 2.5r.
      expect(softTerrain.getHeightAt(50 + 29)).toBeGreaterThan(FLAT_Y);
      expect(softTerrain.getHeightAt(50 + 32)).toBe(FLAT_Y);
      // Rounding the shoulders redistributes excavation toward the bowl interior.
      expect(softTerrain.getHeightAt(50 + 15)).toBeCloseTo(FLAT_Y + 24.2578125, 9);
    });

    it.each([10, 28, 62])("rounds SOFT rims without losing depth, reach or excavation at radius %s", (radius) => {
      for (const impactX of [400, 400.35]) {
        const terrain = new TerrainManager(801, 800);
        terrain.loadHeights(new Array(801).fill(FLAT_Y), new Array(801).fill("SOFT"));
        terrain.destroyTerrain(impactX, FLAT_Y, radius);
        const reach = 2.5 * radius;
        const heights = terrain.getHeightmap();
        const maxDepth = Math.max(...heights) - FLAT_Y;
        expect(maxDepth).toBeCloseTo(reach, 2);
        for (const direction of [-1, 1]) {
          const edge = impactX + direction * reach;
          const inside = direction === 1 ? Math.floor(edge) : Math.ceil(edge);
          // The old parabola leaves a roughly 2px/column corner at a flat rim.
          expect(Math.abs(heights[inside] - heights[inside + direction])).toBeLessThan(0.6);
          expect(heights[inside - direction]).toBeGreaterThan(FLAT_Y);
          expect(heights[inside + 3 * direction]).toBe(FLAT_Y);
        }
        // Same continuous raw area as the previous parabola (4/3 * reach^2).
        // Raster sampling and removal-only smoothing/slumping add small differences.
        const removed = heights.reduce((total, height) => total + height - FLAT_Y, 0);
        const parabolicArea = (4 / 3) * reach * reach;
        expect(removed).toBeGreaterThan(parabolicArea * 0.99);
        expect(removed).toBeLessThan(parabolicArea * 1.04);
      }
    });

    it.each([-0.25, 0.25])("joins the original SOFT slope smoothly in both directions (slope %s)", (slope) => {
      const terrain = new TerrainManager(401, 500);
      const heights = Array.from({ length: 401 }, (_, x) => 150 + slope * (x - 200));
      terrain.loadHeights(heights, new Array(401).fill("SOFT"));
      terrain.destroyTerrain(200, 150, 28);
      for (const x of [130, 270]) {
        // Compare excavation to the original slope, not to a horizontal impact plane.
        const excavation = terrain.getHeightAt(x) - heights[x];
        const inside = x < 200 ? x + 1 : x - 1;
        const insideExcavation = terrain.getHeightAt(inside) - heights[inside];
        expect(excavation).toBeLessThan(0.1);
        expect(insideExcavation).toBeGreaterThan(0);
        expect(insideExcavation - excavation).toBeLessThan(0.3);
      }
      expect(terrain.getHeightAt(200)).toBe(220);
      expect(terrain.getHeightmap().every((height, x) => height >= heights[x])).toBe(true);
    });

    it("carves adjacent normal dirt appropriately when explosion occurs in soft terrain", () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      terrain.loadHeights(Array.from({ length: WIDTH }, () => FLAT_Y));
      // Soft from 0 to 50, Dirt from 51 to 100
      terrain.setMaterialRange(0, 50, "SOFT");
      terrain.setMaterialRange(51, 100, "DIRT");

      // Impact at x=50 (in soft, right on border)
      terrain.destroyTerrain(50, FLAT_Y, RADIUS);

      // Soft side is deeply carved
      expect(terrain.getHeightAt(45) - FLAT_Y).toBeGreaterThan(0);
      // Dirt side is also carved (not left as flat untouched wall)
      expect(terrain.getHeightAt(55) - FLAT_Y).toBeGreaterThan(0);
      // But soft side is deeper than dirt side at equal distance from impact
      expect(terrain.getHeightAt(45)).toBeGreaterThan(terrain.getHeightAt(55));
    });

    it.each([305, 310, 315, 320])("keeps a DIRT impact connected and monotone beside SOFT starting at %s", (boundary) => {
      for (const direction of [-1, 1]) {
        const terrain = new TerrainManager(800, 600);
        const surfaceY = 317.9;
        const impactX = direction === 1 ? 272.7 : 799 - 272.7;
        terrain.loadHeights(new Array(800).fill(surfaceY));
        if (direction === 1) terrain.setMaterialRange(boundary, 799, "SOFT");
        else terrain.setMaterialRange(0, 799 - boundary, "SOFT");
        terrain.destroyTerrain(impactX, surfaceY, 28);

        let previousDepth = Infinity;
        const first = direction === 1 ? Math.ceil(impactX) : Math.floor(impactX);
        for (let step = 0; step <= 74; step++) {
          const depth = terrain.getHeightAt(first + direction * step) - surfaceY;
          // No secondary bowl or ridge introduced by the DIRT/SOFT transition.
          expect(depth).toBeGreaterThanOrEqual(0);
          expect(depth).toBeLessThanOrEqual(previousDepth + 1e-9);
          previousDepth = depth;
        }
        if (boundary >= 315) {
          const remoteSand = direction === 1 ? 327 : 799 - 327;
          expect(terrain.getHeightAt(remoteSand)).toBe(surfaceY);
        }
      }
    });

    it("does not create a detached SOFT pocket in a DRILLER stamp originating in DIRT", () => {
      const terrain = new TerrainManager(800, 600);
      terrain.loadHeights(new Array(800).fill(317.9));
      terrain.setMaterialRange(315, 799, "SOFT");
      terrain.destroyTerrainShaft(272.7, 317.9, 0, 1, 28, 28);
      expect(terrain.getHeightAt(273)).toBeGreaterThan(317.9);
      for (let x = 305; x <= 343; x++) expect(terrain.getHeightAt(x)).toBe(317.9);
    });

    it("preserves inclusive DIRT boundaries when an impact is below the original surface", () => {
      for (const shaft of [false, true]) {
        const terrain = new TerrainManager(200, 300);
        terrain.loadHeights(new Array(200).fill(100));
        if (shaft) terrain.destroyTerrainShaft(100, 110, 0, 1, 10, 10);
        else terrain.destroyTerrain(100, 110, 10);
        expect(terrain.getHeightAt(90)).toBeGreaterThanOrEqual(110);
        expect(terrain.getHeightAt(110)).toBeGreaterThanOrEqual(110);
        if (shaft) {
          expect(terrain.getHeightAt(89)).toBe(100);
          expect(terrain.getHeightAt(111)).toBe(100);
        }
      }
    });

    it("does not let occluded SOFT change the crater on the near side of a ROCK wall", () => {
      const makeTerrain = (hiddenSand: boolean) => {
        const terrain = new TerrainManager(200, 300);
        terrain.loadHeights(new Array(200).fill(100));
        terrain.setMaterialAt(60, "ROCK");
        if (hiddenSand) terrain.setMaterialRange(70, 199, "SOFT");
        terrain.destroyTerrain(50, 100, 20);
        return terrain;
      };
      const dirt = makeTerrain(false);
      const hiddenSand = makeTerrain(true);
      expect(hiddenSand.getHeightmap().slice(0, 60)).toEqual(dirt.getHeightmap().slice(0, 60));
      expect(hiddenSand.getHeightmap().slice(60)).toEqual(new Array(140).fill(100));
    });

    it("produces a smooth progressive crater gradient across sand-dirt boundary", () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      terrain.loadHeights(Array.from({ length: WIDTH }, () => FLAT_Y));
      terrain.setMaterialRange(0, 50, "SOFT");
      terrain.setMaterialRange(51, WIDTH - 1, "DIRT");

      // Impact at x=40 (inside sand near dirt border)
      terrain.destroyTerrain(40, FLAT_Y, RADIUS);

      // Verify that as x increases into dirt (x=41 to x=65), crater depth decreases smoothly
      let prevHeight = terrain.getHeightAt(40);
      for (let x = 41; x <= 65; x++) {
        const h = terrain.getHeightAt(x);
        // The surface height is never deeper than the preceding column closer to impact center
        expect(h).toBeLessThanOrEqual(prevHeight + 0.1);
        prevHeight = h;
      }
    });
  });

  describe("Canvas Rendering with Materials", () => {
    it("draws fallback and full offscreen with mixed materials without error", () => {
      const terrain = new TerrainManager(100, 100);
      terrain.generate();

      const mockCtx = {
        fillStyle: "",
        fillRect: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        closePath: vi.fn(),
        fill: vi.fn(),
        drawImage: vi.fn(),
      } as unknown as CanvasRenderingContext2D;

      expect(() => terrain.draw(mockCtx)).not.toThrow();
    });
  });

  describe("Local Nuclear Rock Carving & Rectangle Occlusion (#302)", () => {
    const WIDTH = 200;
    const HEIGHT = 300;
    const FLAT_Y = 120;

    it("carves ROCK at nominal 1.0x radius without smoothing or material change when canCarveRock is true", () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      terrain.loadHeights(Array.from({ length: WIDTH }, () => FLAT_Y));
      terrain.setMaterialRange(0, WIDTH - 1, "ROCK");

      const impactX = 100;
      const radius = 20;
      terrain.destroyTerrain(impactX, FLAT_Y, radius, { canCarveRock: true });

      // Center depth = FLAT_Y + radius (no smoothing on ROCK)
      expect(terrain.getHeightAt(impactX)).toBeCloseTo(FLAT_Y + radius, 6);
      // Inclusive boundary |x - impactX| == r has dy = 0, while |x - impactX| == r - 1 is carved
      expect(terrain.getHeightAt(impactX - radius + 1)).toBeCloseTo(
        FLAT_Y + radius * (1 - ((radius - 1) / radius) ** 2),
        6,
      );
      expect(terrain.getHeightAt(impactX + radius - 1)).toBeCloseTo(
        FLAT_Y + radius * (1 - ((radius - 1) / radius) ** 2),
        6,
      );
      expect(terrain.getHeightAt(impactX - radius)).toBe(FLAT_Y);
      expect(terrain.getHeightAt(impactX + radius)).toBe(FLAT_Y);
      expect(terrain.getHeightAt(impactX - radius - 1)).toBe(FLAT_Y);
      expect(terrain.getHeightAt(impactX + radius + 1)).toBe(FLAT_Y);
      expect(terrain.getMaterials().every((m) => m === "ROCK")).toBe(true);
    });

    it("carves boundary column |x - impactX| === radius when impactY is below surfaceY", () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      terrain.loadHeights(Array.from({ length: WIDTH }, () => FLAT_Y));
      terrain.setMaterialRange(0, WIDTH - 1, "ROCK");

      const impactX = 100;
      const radius = 15;
      // Impact 10px below surface so dy=0 at |dx|===r still lowers surface from 120 to 130
      terrain.destroyTerrain(impactX, FLAT_Y + 10, radius, { canCarveRock: true });

      expect(terrain.getHeightAt(impactX - radius)).toBe(FLAT_Y + 10);
      expect(terrain.getHeightAt(impactX + radius)).toBe(FLAT_Y + 10);
      expect(terrain.getHeightAt(impactX - radius - 1)).toBe(FLAT_Y);
      expect(terrain.getHeightAt(impactX + radius + 1)).toBe(FLAT_Y);
    });

    it("never applies SOFT expansion to ROCK columns even when impact is in SOFT", () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      terrain.loadHeights(Array.from({ length: WIDTH }, () => FLAT_Y));
      terrain.setMaterialRange(0, 105, "SOFT");
      terrain.setMaterialRange(106, WIDTH - 1, "ROCK");

      const impactX = 100;
      const radius = 10;
      terrain.destroyTerrain(impactX, FLAT_Y, radius, { canCarveRock: true });

      // ROCK inside nominal radius (x=108, dx=8 <= 10) is carved at 1.0x radius (depth = 3.6)
      expect(terrain.getHeightAt(108)).toBeCloseTo(FLAT_Y + 3.6, 6);
      // ROCK strictly outside nominal radius (x=111, dx=11 > 10) is untouched despite SOFT impact
      expect(terrain.getHeightAt(111)).toBe(FLAT_Y);
      // SOFT side beyond nominal radius (x=86, dx=-14) is carved via 2.5x SOFT halo
      expect(terrain.getHeightAt(86)).toBeGreaterThan(FLAT_Y);
    });

    it("allows SOFT halo carving past ROCK columns within nominal radius, but blocks it behind outer ROCK in both directions", () => {
      const radius = 10;

      // Case 1: ROCK column inside nominal radius (|c - impactX| <= r) never blocks halo beyond it
      const innerRockRight = new TerrainManager(WIDTH, HEIGHT);
      innerRockRight.loadHeights(Array.from({ length: WIDTH }, () => FLAT_Y));
      innerRockRight.setMaterialRange(0, WIDTH - 1, "SOFT");
      innerRockRight.setMaterialRange(105, 108, "ROCK"); // dx in [5, 8] <= 10
      innerRockRight.destroyTerrain(100, FLAT_Y, radius, { canCarveRock: true });
      expect(innerRockRight.getHeightAt(114)).toBeGreaterThan(FLAT_Y);

      const innerRockLeft = new TerrainManager(WIDTH, HEIGHT);
      innerRockLeft.loadHeights(Array.from({ length: WIDTH }, () => FLAT_Y));
      innerRockLeft.setMaterialRange(0, WIDTH - 1, "SOFT");
      innerRockLeft.setMaterialRange(92, 95, "ROCK"); // |dx| in [5, 8] <= 10
      innerRockLeft.destroyTerrain(100, FLAT_Y, radius, { canCarveRock: true });
      expect(innerRockLeft.getHeightAt(86)).toBeGreaterThan(FLAT_Y);

      // Case 2: ROCK column strictly outside nominal radius (|c - impactX| > r) blocks SOFT halo behind it
      const outerRockRight = new TerrainManager(WIDTH, HEIGHT);
      outerRockRight.loadHeights(Array.from({ length: WIDTH }, () => FLAT_Y));
      outerRockRight.setMaterialRange(0, WIDTH - 1, "SOFT");
      outerRockRight.setMaterialAt(112, "ROCK"); // dx = 12 > 10
      outerRockRight.destroyTerrain(100, FLAT_Y, radius, { canCarveRock: true });
      expect(outerRockRight.getHeightAt(111)).toBeGreaterThan(FLAT_Y);
      expect(outerRockRight.getHeightAt(112)).toBe(FLAT_Y);
      expect(outerRockRight.getHeightAt(114)).toBe(FLAT_Y);

      const outerRockLeft = new TerrainManager(WIDTH, HEIGHT);
      outerRockLeft.loadHeights(Array.from({ length: WIDTH }, () => FLAT_Y));
      outerRockLeft.setMaterialRange(0, WIDTH - 1, "SOFT");
      outerRockLeft.setMaterialAt(88, "ROCK"); // |dx| = 12 > 10
      outerRockLeft.destroyTerrain(100, FLAT_Y, radius, { canCarveRock: true });
      expect(outerRockLeft.getHeightAt(89)).toBeGreaterThan(FLAT_Y);
      expect(outerRockLeft.getHeightAt(88)).toBe(FLAT_Y);
      expect(outerRockLeft.getHeightAt(86)).toBe(FLAT_Y);
    });

    it("evaluates rectangle occlusion (top, left flank, right flank, and air pass) symmetrically in all modes", () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      const heights = Array.from({ length: WIDTH }, () => 200);
      // Single ROCK column at c = 50 with surfaceY = 100 (solid rectangle [50, 51) x [100, inf))
      heights[50] = 100;
      terrain.loadHeights(heights);
      terrain.setMaterialAt(50, "ROCK");

      // Even if fromX is on ROCK, intermediate ROCK column 50 still blocks in both modes (#184 8B)
      terrain.setMaterialAt(40, "ROCK");
      terrain.setMaterialAt(60, "ROCK");

      // 1. Passes strictly above across [50, 51]: y(50) < 100 and y(51) < 100 -> false
      expect(terrain.isBlastOccludedByRock(40, 99, 60, 99, { canCarveRock: true })).toBe(false);
      expect(terrain.isBlastOccludedByRock(60, 99, 40, 99, { canCarveRock: true })).toBe(false);
      expect(terrain.isBlastOccludedByRock(40, 99, 60, 99)).toBe(false);

      // 2. Touches top surface exactly at y = 100 -> true
      expect(terrain.isBlastOccludedByRock(40, 100, 60, 100, { canCarveRock: true })).toBe(true);
      expect(terrain.isBlastOccludedByRock(60, 100, 40, 100, { canCarveRock: true })).toBe(true);
      expect(terrain.isBlastOccludedByRock(40, 100, 60, 100)).toBe(true);

      // 3. Touches left flank at x = 50 (y(50) == 100, y(51) < 100):
      // From (40, 110) to (60, 90): at x=50, t=0.5 -> y=100; at x=51, t=0.55 -> y=99
      expect(terrain.isBlastOccludedByRock(40, 110, 60, 90, { canCarveRock: true })).toBe(true);
      expect(terrain.isBlastOccludedByRock(60, 90, 40, 110, { canCarveRock: true })).toBe(true);
      expect(terrain.isBlastOccludedByRock(40, 110, 60, 90)).toBe(true);

      // 4. Touches right flank at x = 51 (y(50) < 100, y(51) == 100):
      // From (41, 90) to (61, 110): at x=50, t=9/20 -> y=99; at x=51, t=10/20 -> y=100
      expect(terrain.isBlastOccludedByRock(41, 90, 61, 110, { canCarveRock: true })).toBe(true);
      expect(terrain.isBlastOccludedByRock(61, 110, 41, 90, { canCarveRock: true })).toBe(true);
      expect(terrain.isBlastOccludedByRock(41, 90, 61, 110)).toBe(true);

      // 5. Default mode also blocks across intermediate ROCK column 50 even when fromX is ROCK (#184 8B)
      expect(terrain.isBlastOccludedByRock(40, 120, 60, 120)).toBe(true);
    });
  });

  describe("Profil brut du cratère, sans lissage ni affaissement", () => {
    it("conserve la parabole DIRT nominale à chaque colonne, même avec un impact fractionnaire", () => {
      const terrain = new TerrainManager(101, 300);
      terrain.loadHeights(new Array(101).fill(100));
      for (const impactX of [50, 50.25]) {
        const shape = terrain["buildCraterShape"](impactX, 10, 20, 80, []);
        expect(shape.depth).toBe(10);
        for (let x = 20; x <= 80; x++) {
          const profile = shape.profiles[x - shape.startX];
          if (Math.abs(x - impactX) > 10) {
            expect(profile).toBe(-1);
          } else {
            const surface = terrain["craterSurface"](100, 90, shape.depth, profile, 0);
            expect(surface).toBeCloseTo(110 - (x - impactX) ** 2 / 10, 12);
          }
        }
      }
    });

    it("conserve les dimensions et l’aire SOFT avec une tangente nulle aux rebords", () => {
      const terrain = new TerrainManager(101, 300);
      terrain.loadHeights(new Array(101).fill(100), new Array(101).fill("SOFT"));
      const shape = terrain["buildCraterShape"](50, 10, 20, 80, []);
      expect(shape.depth).toBe(25);
      expect(shape.profiles[50 - shape.startX]).toBe(1);
      for (const edge of [25, 75]) {
        expect(shape.profiles[edge - shape.startX]).toBeCloseTo(0, 12);
        const outside = edge < 50 ? edge - 1 : edge + 1;
        expect(shape.profiles[outside - shape.startX]).toBe(-1);
      }

      // Quadrature de Simpson : aire continue indépendante de la rastérisation.
      const intervals = 1000;
      let integral = 0;
      for (let i = 0; i <= intervals; i++) {
        const u = -1 + 2 * i / intervals;
        const weight = i === 0 || i === intervals ? 1 : i % 2 === 0 ? 2 : 4;
        integral += weight * terrain["craterProfile"](u, 1);
      }
      integral *= 2 / (3 * intervals);
      expect(integral * 25 * shape.depth).toBeCloseTo((4 / 3) * 25 ** 2, 7);
      for (const edge of [-1, 1]) {
        const inside = edge * (1 - 1e-5);
        const profile = terrain["craterProfile"](inside, 1);
        expect(profile / 1e-5).toBeLessThan(0.001);
        expect(terrain["craterSurface"](100, 110, 25, profile, 1)).toBeCloseTo(110, 7);
      }
    });

    it("intègre le premier pas fractionnaire et la résistance d’une colonne protégée sans bonus SOFT", () => {
      for (const material of ["ROCK", "SOFT"] as const) {
        const terrain = new TerrainManager(101, 300);
        terrain.loadHeights(new Array(101).fill(100), new Array(101).fill("SOFT"));
        terrain.setMaterialAt(51, material);
        const protectedColumns = new Array<boolean>(101).fill(false);
        // ROCK ou SOFT occulté : même résistance nulle en friabilité.
        protectedColumns[51] = true;
        const shape = terrain["buildCraterShape"](50.25, 2, 44, 57, protectedColumns);
        // Résistances SOFT = 1/5, protégée = 1/2; pas initial de 0.75 colonne.
        // u(52) = 0.75 * (1/5 + 1/2)/2 + (1/2 + 1/5)/2 = 0.6125.
        expect(shape.profiles[52 - shape.startX]).toBeCloseTo(0.6467559684820174, 12);
        expect(shape.profiles[53 - shape.startX]).toBeGreaterThan(0);
        expect(shape.profiles[54 - shape.startX]).toBe(-1);
        expect(shape.profiles[55 - shape.startX]).toBe(-1);
        // L’autre côté conserve son premier pas SOFT de 0.25 colonne (u = 0.05).
        expect(shape.profiles[50 - shape.startX]).toBeCloseTo(0.99935940234375, 12);
      }
    });
  });

  describe("Parabolic Craters, Slumping & Standard Rock Occlusion (#184)", () => {
    const WIDTH = 200;
    const HEIGHT = 300;
    const FLAT_Y = 100;

    it("matches exact numerical oracles for pure DIRT, pure SOFT, and GRENADE impacts", () => {
      // 1. Pure DIRT (f = 0, r = 10) on flat height 100
      const dirt = new TerrainManager(WIDTH, HEIGHT);
      dirt.loadHeights(new Array(WIDTH).fill(FLAT_Y), new Array(WIDTH).fill("DIRT"));
      dirt.destroyTerrain(100, FLAT_Y, 10);
      expect(dirt.getHeightAt(100)).toBeCloseTo(110, 9);
      expect(dirt.getHeightAt(89)).toBe(100);
      expect(dirt.getHeightAt(111)).toBe(100);

      // 2. Pure SOFT (f = 1, r = 10) on flat height 100
      const soft = new TerrainManager(WIDTH, HEIGHT);
      soft.loadHeights(new Array(WIDTH).fill(FLAT_Y), new Array(WIDTH).fill("SOFT"));
      soft.destroyTerrain(100, FLAT_Y, 10);
      expect(soft.getHeightAt(100)).toBeCloseTo(125, 9);
      expect(soft.getHeightAt(85)).toBeCloseTo(116.6912, 9);
      expect(soft.getHeightAt(115)).toBeCloseTo(116.6912, 9);
      const expectedSoftRim25 = 100 + (0.4014932992 * 0.35) / 3;
      expect(soft.getHeightAt(75)).toBeCloseTo(expectedSoftRim25, 9);
      expect(soft.getHeightAt(125)).toBeCloseTo(expectedSoftRim25, 9);
      expect(soft.getHeightAt(74)).toBe(100);
      expect(soft.getHeightAt(126)).toBe(100);

      // 3. GRENADE on pure DIRT (r = 24, impactY = surfaceY - 1.2 = 98.8) on flat height 100
      const grenadeDirt = new TerrainManager(WIDTH, HEIGHT);
      grenadeDirt.loadHeights(new Array(WIDTH).fill(FLAT_Y), new Array(WIDTH).fill("DIRT"));
      grenadeDirt.destroyTerrain(100, 98.8, 24);
      expect(grenadeDirt.getHeightAt(100)).toBeCloseTo(122.8, 9);
      const expectedGrenadeRim24 = 100 + ((47 / 24 - 1.2) * 0.35) / 3;
      expect(grenadeDirt.getHeightAt(76)).toBeCloseTo(expectedGrenadeRim24, 9);
      expect(grenadeDirt.getHeightAt(124)).toBeCloseTo(expectedGrenadeRim24, 9);
    });

    it("resolves slumpHeights deterministically on SOFT steps while leaving DIRT untouched", () => {
      const terrain = new TerrainManager(10, HEIGHT);
      terrain.loadHeights([100, 120, 100, 100, 100, 100, 100, 100, 100, 100], new Array(10).fill("SOFT"));

      terrain.slumpHeights(0, 1);
      expect(terrain.getHeightAt(0)).toBeCloseTo(118, 9);
      expect(terrain.getHeightAt(1)).toBeCloseTo(120, 9);

      terrain.loadHeights([100, 100, 100, 120, 100, 100, 100, 100, 100, 100], new Array(10).fill("SOFT"));
      terrain.slumpHeights(0, 3);
      expect([0, 1, 2, 3].map((x) => terrain.getHeightAt(x))).toEqual([114, 116, 118, 120]);

      // Pure DIRT outside 8-column SOFT blend has softness 0 -> no slumping
      const dirtTerrain = new TerrainManager(30, HEIGHT);
      const dirtHeights = new Array(30).fill(100);
      dirtHeights[15] = 120;
      dirtTerrain.loadHeights(dirtHeights, new Array(30).fill("DIRT"));
      dirtTerrain.slumpHeights(14, 15);
      expect(dirtTerrain.getHeightAt(14)).toBe(100);
      expect(dirtTerrain.getHeightAt(15)).toBe(120);
    });

    it("never modifies ROCK or occluded columns during carving, smoothing, or slumping in [bandStart, bandEnd]", () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      const initialHeights = new Array(WIDTH).fill(FLAT_Y);
      const materials = new Array(WIDTH).fill("SOFT" as const);
      // Single ROCK column at x=104 blocks columns x >= 105 from impact at (100, 100)
      materials[104] = "ROCK";
      terrain.loadHeights(initialHeights, materials);

      terrain.destroyTerrain(100, FLAT_Y, 15);

      expect(terrain.getHeightAt(104)).toBe(FLAT_Y);
      for (let x = 105; x < WIDTH; x++) {
        expect(terrain.getHeightAt(x)).toBe(FLAT_Y);
      }
      // Unoccluded SOFT side (x <= 103) is carved and slumped
      expect(terrain.getHeightAt(100)).toBeGreaterThan(FLAT_Y);
      expect(terrain.getHeightAt(103)).toBeGreaterThan(FLAT_Y);
    });

    it("applies material-specific stamps without smoothing or slumping in destroyTerrainShaft and enforces initial + stamp occlusion", () => {
      // 1. Parabolic stamp without smoothing/slumping on pure DIRT (depth=10, radius=10 -> travel=0, stamp at y=100)
      const shaftDirt = new TerrainManager(WIDTH, HEIGHT);
      shaftDirt.loadHeights(new Array(WIDTH).fill(FLAT_Y), new Array(WIDTH).fill("DIRT"));
      shaftDirt.destroyTerrainShaft(100, FLAT_Y, 0, 1, 10, 10);
      expect(shaftDirt.getHeightAt(100)).toBeCloseTo(110, 9);
      expect(shaftDirt.getHeightAt(95)).toBeCloseTo(100 + 10 * (1 - 25 / 100), 9);
      // Column 90 (|dx| = 10 = halfWidth) has candidate = 100, and without smoothing stays 100
      expect(shaftDirt.getHeightAt(90)).toBe(100);
      expect(shaftDirt.getHeightAt(110)).toBe(100);

      // SOFT stamps restore the same 2.5x extent without changing the shaft travel.
      const shaftSoft = new TerrainManager(WIDTH, HEIGHT);
      shaftSoft.loadHeights(new Array(WIDTH).fill(FLAT_Y), new Array(WIDTH).fill("SOFT"));
      shaftSoft.destroyTerrainShaft(100, FLAT_Y, 0, 1, 10, 10);
      expect(shaftSoft.getHeightAt(100)).toBeCloseTo(125, 9);
      expect(shaftSoft.getHeightAt(80)).toBeCloseTo(106.8688, 9);
      expect(shaftSoft.getHeightAt(120)).toBeCloseTo(106.8688, 9);
      expect(shaftSoft.getHeightAt(75)).toBe(100);
      expect(shaftSoft.getHeightAt(125)).toBe(100);

      // 2. Diagonal shaft behind a ROCK column: initial occlusion forbids columns behind ROCK for all stamps
      const rockBlocked = new TerrainManager(WIDTH, HEIGHT);
      const heights = new Array(WIDTH).fill(FLAT_Y);
      const materials = new Array(WIDTH).fill("SOFT" as const);
      materials[102] = "ROCK";
      rockBlocked.loadHeights(heights, materials);

      // Impact at (100, 100) drilling diagonally down-right across ROCK column 102
      rockBlocked.destroyTerrainShaft(100, FLAT_Y, Math.SQRT1_2, Math.SQRT1_2, 40, 12);
      expect(rockBlocked.getHeightAt(102)).toBe(FLAT_Y);
      for (let x = 103; x < WIDTH; x++) {
        expect(rockBlocked.getHeightAt(x)).toBe(FLAT_Y);
      }
    });

    it("distinguishes standard shell at surfaceY (occluded by flat ROCK) from GRENADE at surfaceY - 1.2 (passes above)", () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      terrain.loadHeights(new Array(WIDTH).fill(FLAT_Y), new Array(WIDTH).fill("ROCK"));

      // Standard shell exploding at (50, FLAT_Y): ray to (60, FLAT_Y) hits intermediate ROCK columns 51..59
      expect(terrain.isBlastOccludedByRock(50, FLAT_Y, 60, FLAT_Y)).toBe(true);
      // GRENADE exploding at (50, FLAT_Y - 1.2): ray to a point at y = FLAT_Y - 0.1 stays strictly above FLAT_Y
      expect(terrain.isBlastOccludedByRock(50, FLAT_Y - 1.2, 60, FLAT_Y - 0.1)).toBe(false);
    });
  });
});
