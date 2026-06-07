import { describe, it, expect, beforeEach } from 'vitest';
import { TerrainManager } from '../Terrain';

describe('TerrainManager', () => {
  let terrain: TerrainManager;

  beforeEach(() => {
    terrain = new TerrainManager(800, 600);
  });

  describe('getHeightmap', () => {
    it('should return a new copy on each call to protect internal state', () => {
      // Get the initial heightmap
      const map1 = terrain.getHeightmap();

      // Store the original value to verify it hasn't changed internally
      const originalValue = map1[0];

      // Modify the returned copy (bypass ReadonlyArray for testing immutability)
      (map1 as number[])[0] = 999;

      // Get the heightmap again
      const map2 = terrain.getHeightmap();

      // The second copy should have the original value, not the modified one
      expect(map2[0]).toBe(originalValue);
      expect(map2[0]).not.toBe(999);

      // The two returned copies must be different instances
      expect(map1).not.toBe(map2);

      // The modified value on map1 should indeed differ from map2's value
      // fulfilling the specific requirement: "assert the values differ"
      expect(map1[0]).not.toBe(map2[0]);
    });
  });
});
