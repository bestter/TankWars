import { describe, it, expect, beforeEach } from 'vitest';
import { PhysicsEngine } from '../PhysicsEngine';
import { TerrainManager } from '../Terrain';

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

    it('should return true after launching multiple projectiles', () => {
      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');
      engine.launchProjectile(10, 10, 45, 100, 'MISSILE');

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
      engine.updateProjectiles(0.1, 9.8, 0, terrainManager as unknown as TerrainManager);

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
      engine.updateProjectiles(0.1, 9.8, 0, terrainManager as unknown as TerrainManager);

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
      engine.updateProjectiles(0.1, 9.8, 0, terrainManager as unknown as TerrainManager);

      expect(engine.hasActiveProjectiles()).toBe(false);
    });

    it('should allow a projectile at maximum power (100) to travel across the screen width (800px)', () => {
      // Simulate normal canvas conditions
      // Gravity = 260, Wind = 0, dt = 1/120, terrain with no collision (always returns false)
      const terrainManager = { width: 1200, height: 1000, checkCollision: () => false };
      
      // Launch a projectile from (0, 300) with 45 degrees angle and 100 power
      engine.launchProjectile(0, 300, 45, 100, 'MISSILE');
      
      const dt = 1 / 120;
      let steps = 0;
      
      // Run the simulation step by step
      while (engine.hasActiveProjectiles() && steps < 1000) {
        engine.updateProjectiles(dt, 260, 0, terrainManager as unknown as TerrainManager);
        steps++;
        
        // Break if the projectile falls back below its launch height
        const projectiles = engine.getProjectiles();
        if (projectiles.length > 0 && projectiles[0].vy > 0 && projectiles[0].y >= 300) {
          break;
        }
      }
      
      const projectiles = engine.getProjectiles();
      expect(projectiles.length).toBeGreaterThan(0);
      const finalX = projectiles[0].x;
      
      // Verify it traveled at least 800px (with baseSpeed = 6.0, it travels ~897px)
      expect(finalX).toBeGreaterThan(800);
    });
  });
});
