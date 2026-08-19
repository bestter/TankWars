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

    it("blocks a ground-level blast through a rock wall but not over it or on top of it", () => {
      const terrain = new TerrainManager(WIDTH, HEIGHT);
      terrain.loadHeights(Array.from({ length: WIDTH }, () => FLAT_Y));
      terrain.setMaterialRange(40, 60, "ROCK");

      // Side impact: dirt → dirt beyond the wall
      expect(terrain.isBlastOccludedByRock(20, FLAT_Y, 80, FLAT_Y)).toBe(true);
      // Same side of the wall
      expect(terrain.isBlastOccludedByRock(20, FLAT_Y, 30, FLAT_Y)).toBe(false);
      // Exploding on top of the rock: current full blast
      expect(terrain.isBlastOccludedByRock(50, FLAT_Y, 80, FLAT_Y)).toBe(false);
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

    it("carves deeper and wider on soft terrain than on normal dirt", () => {
      const dirtTerrain = new TerrainManager(WIDTH, HEIGHT);
      dirtTerrain.loadHeights(Array.from({ length: WIDTH }, () => FLAT_Y));
      dirtTerrain.destroyTerrain(50, FLAT_Y, RADIUS);
      const dirtDepth = dirtTerrain.getHeightAt(50) - FLAT_Y;

      const softTerrain = new TerrainManager(WIDTH, HEIGHT);
      softTerrain.loadHeights(Array.from({ length: WIDTH }, () => FLAT_Y));
      softTerrain.setMaterialRange(0, WIDTH - 1, "SOFT");
      softTerrain.destroyTerrain(50, FLAT_Y, RADIUS);
      const softDepth = softTerrain.getHeightAt(50) - FLAT_Y;

      expect(softDepth).toBeGreaterThan(dirtDepth * 2.0);
      expect(softDepth).toBeLessThanOrEqual(dirtDepth * 2.6);
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
});

