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

    it('should return false after projectile goes out of bounds', () => {
      // Launch projectile that will immediately go out of bounds
      // X out of bounds is < -60
      engine.launchProjectile(-100, 0, 180, 10, 'MISSILE');

      const terrain = new TerrainManager(800, 600);
      // Update engine to simulate tick
      engine.updateProjectiles(1/60, 100, 0, terrain);

      expect(engine.hasActiveProjectiles()).toBe(false);
    });

    it('should return false after projectile hits the terrain', () => {
      // Launch projectile directly into terrain
      engine.launchProjectile(400, 400, 90, 10, 'MISSILE');

      const terrain = new TerrainManager(800, 600);
      terrain.generate(); // Initialize heightmap

      // Update engine to simulate tick
      engine.updateProjectiles(1/60, 100, 0, terrain);

      expect(engine.hasActiveProjectiles()).toBe(false);
    });
  });
});
