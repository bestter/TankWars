import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PhysicsEngine } from '../PhysicsEngine';
import { TerrainManager } from '../Terrain';

describe('PhysicsEngine', () => {
  let engine: PhysicsEngine;

  beforeEach(() => {
    engine = new PhysicsEngine();
  });

  describe('active projectile queries', () => {
    it('starts empty and reports a launch', () => {
      expect(engine.hasActiveProjectiles()).toBe(false);
      expect(engine.count).toBe(0);

      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');
      expect(engine.hasActiveProjectiles()).toBe(true);
      expect(engine.count).toBe(1);
    });

    it('clears without notifying settlement when asked', () => {
      const spy = vi.fn();
      engine.onAllProjectilesSettled = spy;
      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');
      engine.clear(false);
      expect(engine.hasActiveProjectiles()).toBe(false);
      expect(engine.count).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    });

    it('clears and notifies settlement when projectiles were in flight', () => {
      const spy = vi.fn();
      engine.onAllProjectilesSettled = spy;
      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');
      engine.clear();
      expect(engine.hasActiveProjectiles()).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Projectile updates and out of bounds', () => {
    it('should maintain state when some but not all projectiles are removed via out of bounds', () => {
      const terrainManager = { width: 800, height: 600, checkCollision: () => false };

      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');
      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');

      engine.getProjectiles()[0].x = 10000;

      engine.updateProjectiles(0.1, 9.8, 0, terrainManager as unknown as TerrainManager);

      expect(engine.hasActiveProjectiles()).toBe(true);
      expect(engine.count).toBe(1);
    });

    it('returns false and triggers settlement when the last projectile leaves bounds', () => {
      let settlementCalled = false;
      engine.onAllProjectilesSettled = () => {
        settlementCalled = true;
      };

      const terrainManager = { width: 800, height: 600, checkCollision: () => false };
      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');
      engine.getProjectiles()[0].x = 10000;
      engine.updateProjectiles(0.1, 9.8, 0, terrainManager as unknown as TerrainManager);

      expect(engine.hasActiveProjectiles()).toBe(false);
      expect(engine.count).toBe(0);
      expect(settlementCalled).toBe(true);
    });

    it('should accurately report status when a projectile impacts terrain', () => {
      const terrainManager = {
        width: 800,
        height: 600,
        checkCollision: () => true,
        destroyTerrain: () => {},
        destroyTerrainShaft: () => {},
      };

      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');
      engine.updateProjectiles(0.1, 9.8, 0, terrainManager as unknown as TerrainManager);

      expect(engine.hasActiveProjectiles()).toBe(false);
      expect(engine.count).toBe(0);
    });

    it('should allow a projectile at maximum power (100) to travel across the screen width (800px)', () => {
      const terrainManager = { width: 1200, height: 1000, checkCollision: () => false };

      engine.launchProjectile(0, 300, 45, 100, 'MISSILE');

      const dt = 1 / 120;
      let steps = 0;

      while (engine.hasActiveProjectiles() && steps < 1000) {
        engine.updateProjectiles(dt, 260, 0, terrainManager as unknown as TerrainManager);
        steps++;

        const projectiles = engine.getProjectiles();
        if (projectiles.length > 0 && projectiles[0].vy > 0 && projectiles[0].y >= 300) {
          break;
        }
      }

      const projectiles = engine.getProjectiles();
      expect(projectiles.length).toBeGreaterThan(0);
      expect(projectiles[0].x).toBeGreaterThan(800);
    });
  });

  describe('checkSettlement', () => {
    it('does nothing when previousCount is 0 and current is 0', () => {
      const spy = vi.fn();
      engine.onAllProjectilesSettled = spy;
      engine.checkSettlement();
      expect(spy).not.toHaveBeenCalled();
    });

    it('does nothing when projectiles are added', () => {
      const spy = vi.fn();
      engine.onAllProjectilesSettled = spy;

      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');
      engine.checkSettlement();

      expect(spy).not.toHaveBeenCalled();
    });

    it('calls onAllProjectilesSettled only once when the last projectile is cleared', () => {
      const spy = vi.fn();
      engine.onAllProjectilesSettled = spy;

      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');
      engine.clear();
      engine.checkSettlement();

      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});
