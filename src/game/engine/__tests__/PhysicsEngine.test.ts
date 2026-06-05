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
  });
});
