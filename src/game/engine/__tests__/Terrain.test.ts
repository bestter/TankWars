import { describe, it, expect, beforeEach } from 'vitest';
import { TerrainManager } from '../Terrain';

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


  describe('getHeightAt with extreme values', () => {
    let terrain: TerrainManager;
    const WIDTH = 100;
    const HEIGHT = 100;

    beforeEach(() => {
      terrain = new TerrainManager(WIDTH, HEIGHT);
      const heights = (terrain as unknown as { heights: number[] }).heights;
      for (let i = 0; i < WIDTH; i++) {
        heights[i] = i;
      }
    });

    it('should handle Infinity and -Infinity', () => {
      expect(terrain.getHeightAt(Infinity)).toBe(WIDTH - 1);
      expect(terrain.getHeightAt(-Infinity)).toBe(0);
    });

    it('should handle NaN', () => {
      // Because Math.max(0, Math.min(99, Math.floor(NaN))) is NaN, and heights[NaN] is undefined.
      // But the return type is 'number', so returning undefined is technically an edge case
      // which we should verify as it exposes the function's true behavior on NaN.
      expect(terrain.getHeightAt(NaN)).toBeUndefined();
    });

    it('should handle -0', () => {
      expect(terrain.getHeightAt(-0)).toBe(0);
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



  describe('checkCollision with extreme values', () => {
    let terrain: TerrainManager;
    const width = 100;
    const height = 200;

    beforeEach(() => {
      terrain = new TerrainManager(width, height);
      // constructor sets all heights to height * 0.7 = 140
      // So surfaceY is 140 for all x in 0..99
    });

    it('should return false for NaN, Infinity, -Infinity coordinates', () => {
      // For x
      expect(terrain.checkCollision(NaN, 150)).toBe(false);
      expect(terrain.checkCollision(Infinity, 150)).toBe(false);
      expect(terrain.checkCollision(-Infinity, 150)).toBe(false);

      // For y (assuming x is valid)
      expect(terrain.checkCollision(50, NaN)).toBe(false); // NaN >= 140 is false
      expect(terrain.checkCollision(50, -Infinity)).toBe(false); // -Infinity >= 140 is false
      expect(terrain.checkCollision(50, Infinity)).toBe(true); // Infinity >= 140 is true
    });

    it('should handle -0 properly', () => {
      expect(terrain.checkCollision(-0, 150)).toBe(true);
      expect(terrain.checkCollision(50, -0)).toBe(false);
    });
  });

});
