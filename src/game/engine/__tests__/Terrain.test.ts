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

});
