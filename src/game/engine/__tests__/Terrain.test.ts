import { describe, it, expect, beforeEach } from 'vitest';
import { TerrainManager } from '../Terrain';

describe('TerrainManager', () => {
  let terrain: TerrainManager;
  const WIDTH = 100;
  const HEIGHT = 100;

  beforeEach(() => {
    terrain = new TerrainManager(WIDTH, HEIGHT);
    // Initialize terrain. By default, heights are filled with height * 0.7 = 70.
    // Let's set some specific heights to test clamping correctly.
    const heights = (terrain as any).heights;
    for (let i = 0; i < WIDTH; i++) {
      heights[i] = i; // heights[0] = 0, heights[1] = 1, ... heights[99] = 99
    }
  });

  describe('getHeightAt', () => {
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
});
