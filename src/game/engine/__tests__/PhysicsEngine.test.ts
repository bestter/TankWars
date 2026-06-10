import { describe, it, expect, beforeEach } from 'vitest';
import { PhysicsEngine } from '../PhysicsEngine';
import { TerrainManager } from '../Terrain';

describe('PhysicsEngine', () => {
  let engine: PhysicsEngine;

  beforeEach(() => {
    engine = new PhysicsEngine();
  });

  describe('State Queries', () => {
    it('should return false for hasActiveProjectiles and 0 for count initially', () => {
      expect(engine.hasActiveProjectiles()).toBe(false);
      expect(engine.count).toBe(0);
    });

    it('should return true for hasActiveProjectiles and positive count after launching projectiles', () => {
      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');
      expect(engine.hasActiveProjectiles()).toBe(true);
      expect(engine.count).toBe(1);

      engine.launchProjectile(10, 10, 45, 100, 'MISSILE');
      expect(engine.hasActiveProjectiles()).toBe(true);
      expect(engine.count).toBe(2);
    });

    it('should return false for hasActiveProjectiles and 0 for count after clearing', () => {
      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');
      engine.clear();
      expect(engine.hasActiveProjectiles()).toBe(false);
      expect(engine.count).toBe(0);
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

    it('should return false when all projectiles are removed via out of bounds', () => {
      const terrainManager = { width: 800, height: 600, checkCollision: () => false };

      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');
      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');

      engine.getProjectiles()[0].x = 10000;
      engine.getProjectiles()[1].y = 10000;

      engine.updateProjectiles(0.1, 9.8, 0, terrainManager as unknown as TerrainManager);

      expect(engine.hasActiveProjectiles()).toBe(false);
      expect(engine.count).toBe(0);
    });

    it('should accurately report status when a projectile impacts terrain', () => {
      const terrainManager = {
        width: 800,
        height: 600,
        checkCollision: () => true,
        destroyTerrain: () => {}
      };

      engine.launchProjectile(0, 0, 45, 100, 'MISSILE');
      expect(engine.hasActiveProjectiles()).toBe(true);
      expect(engine.count).toBe(1);

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
      const finalX = projectiles[0].x;
      
      expect(finalX).toBeGreaterThan(800);
    });
  });
});
