import { describe, it, expect, beforeEach } from 'vitest';
import { PhysicsEngine } from '../PhysicsEngine';

describe('PhysicsEngine', () => {
  let engine: PhysicsEngine;

  beforeEach(() => {
    engine = new PhysicsEngine();
  });

  describe('hasActiveProjectiles', () => {
    it('should return false when there are no projectiles', () => {
      // Initially, there are no projectiles
      expect(engine.hasActiveProjectiles()).toBe(false);
    });

    it('should return true after launching a projectile', () => {
      // Launch a projectile
      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');

      // Verify hasActiveProjectiles is now true
      expect(engine.hasActiveProjectiles()).toBe(true);
    });

    it('should return false after clearing all projectiles', () => {
      // Launch a projectile
      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');

      // Clear projectiles
      engine.clear();

      // Verify hasActiveProjectiles is now false again
      expect(engine.hasActiveProjectiles()).toBe(false);
    });

    it('should return true when multiple projectiles are launched', () => {
      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');
      engine.launchProjectile(10, 10, 60, 50, 'MISSILE');
      expect(engine.hasActiveProjectiles()).toBe(true);
    });

    it('should return true when some but not all projectiles are removed via out of bounds', () => {
      // Create a fake terrain manager
      const terrainManager = { width: 800, height: 600, checkCollision: () => false };

      // Launch two projectiles.
      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');
      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');

      // Manually set the first one to be out of bounds
      engine.getProjectiles()[0].x = 10000;

      // Update logic will remove the out-of-bounds projectile
      engine.updateProjectiles(0.1, 9.8, 0, terrainManager as unknown as import("../Terrain").TerrainManager);

      // Still one active projectile left
      expect(engine.hasActiveProjectiles()).toBe(true);
    });

    it('should return false when all projectiles are removed via out of bounds', () => {
      const terrainManager = { width: 800, height: 600, checkCollision: () => false };

      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');
      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');

      // Set all to be out of bounds
      engine.getProjectiles()[0].x = 10000;
      engine.getProjectiles()[1].y = 10000;

      // Update will remove all
      engine.updateProjectiles(0.1, 9.8, 0, terrainManager as unknown as import("../Terrain").TerrainManager);

      // No active projectiles left
      expect(engine.hasActiveProjectiles()).toBe(false);
    });

    it('should accurately report status when a projectile impacts terrain', () => {
      const terrainManager = {
        width: 800,
        height: 600,
        checkCollision: () => true, // simulate hitting terrain
        destroyTerrain: () => {}
      };

      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');

      expect(engine.hasActiveProjectiles()).toBe(true);

      // Update will process impact and remove the projectile
      engine.updateProjectiles(0.1, 9.8, 0, terrainManager as unknown as import("../Terrain").TerrainManager);

      expect(engine.hasActiveProjectiles()).toBe(false);
    });
  });
});
