import { describe, it, expect } from 'vitest';
import {
  launchFromBarrel,
  advanceProjectile,
  projectileOutOfBounds,
  BALLISTICS_BASE_SPEED,
  BARREL_LENGTH,
  BARREL_START_Y_OFFSET
} from '../projectileMotion';

describe('projectileMotion', () => {
  describe('launchFromBarrel', () => {
    it('launches horizontally at 0 degrees', () => {
      const motion = launchFromBarrel(100, 100, 0, 1);

      // cos(0) = 1, sin(0) = 0
      expect(motion.x).toBeCloseTo(100 + BARREL_LENGTH);
      expect(motion.y).toBeCloseTo(100 - BARREL_START_Y_OFFSET);
      expect(motion.vx).toBeCloseTo(BALLISTICS_BASE_SPEED);
      expect(motion.vy).toBeCloseTo(0);
    });

    it('launches vertically at 90 degrees', () => {
      const motion = launchFromBarrel(100, 100, 90, 1);

      // cos(90) = 0, sin(90) = 1
      expect(motion.x).toBeCloseTo(100);
      expect(motion.y).toBeCloseTo(100 - BARREL_START_Y_OFFSET - BARREL_LENGTH);
      expect(motion.vx).toBeCloseTo(0);
      expect(motion.vy).toBeCloseTo(-BALLISTICS_BASE_SPEED);
    });

    it('launches in opposite direction at 180 degrees', () => {
      const motion = launchFromBarrel(100, 100, 180, 1);

      // cos(180) = -1, sin(180) = 0
      expect(motion.x).toBeCloseTo(100 - BARREL_LENGTH);
      expect(motion.y).toBeCloseTo(100 - BARREL_START_Y_OFFSET);
      expect(motion.vx).toBeCloseTo(-BALLISTICS_BASE_SPEED);
      expect(motion.vy).toBeCloseTo(0);
    });

    it('scales speed based on power', () => {
      const motion = launchFromBarrel(100, 100, 0, 2);

      expect(motion.vx).toBeCloseTo(BALLISTICS_BASE_SPEED * 2);
    });
  });

  describe('advanceProjectile', () => {
    it('applies gravity and wind correctly', () => {
      const p = { x: 0, y: 0, vx: 0, vy: 0 };
      const dt = 1;
      const gravity = 2;
      const wind = 3;

      advanceProjectile(p, dt, gravity, wind);

      // p.vy += gravity * dt -> 2
      // p.vx += wind * dt -> 3
      // speed = hypot(3, 2) = sqrt(9 + 4) = sqrt(13) = 3.60555
      // 3.60555 <= 4, so no drag

      expect(p.vx).toBe(3);
      expect(p.vy).toBe(2);
      expect(p.x).toBe(3);
      expect(p.y).toBe(2);
    });

    it('does not apply drag if speed <= 4', () => {
      const p = { x: 0, y: 0, vx: 3, vy: 0 };
      const dt = 1;

      advanceProjectile(p, dt, 0, 0); // no gravity or wind

      // Speed is 3, which is <= 4, so no drag.
      expect(p.vx).toBe(3); // unchanged velocity
      expect(p.vy).toBe(0);
      expect(p.x).toBe(3); // x += vx * dt
      expect(p.y).toBe(0);
    });

    it('applies drag if speed > 4', () => {
      const p = { x: 0, y: 0, vx: 5, vy: 0 };
      const dt = 1;

      advanceProjectile(p, dt, 0, 0); // no gravity or wind

      // Speed is 5, which is > 4, so drag is applied.
      // drag = BALLISTICS_DRAG * speed * dt = 0.28 * 5 * 1 = 1.4
      // vx -= (vx / speed) * drag = (5 / 5) * 1.4 = 1.4
      // vx = 5 - 1.4 = 3.6
      expect(p.vx).toBeCloseTo(3.6);
      expect(p.vy).toBe(0);
      expect(p.x).toBeCloseTo(3.6);
      expect(p.y).toBe(0);
    });

    it('applies drag correctly with both vx and vy when speed > 4', () => {
      const p = { x: 0, y: 0, vx: 3, vy: 4 }; // speed = 5 before drag
      const dt = 1;

      advanceProjectile(p, dt, 0, 0);

      // drag = BALLISTICS_DRAG * 5 * 1 = 1.4
      // vx -= (3 / 5) * 1.4 = 0.6 * 1.4 = 0.84 -> 3 - 0.84 = 2.16
      // vy -= (4 / 5) * 1.4 = 0.8 * 1.4 = 1.12 -> 4 - 1.12 = 2.88
      expect(p.vx).toBeCloseTo(2.16);
      expect(p.vy).toBeCloseTo(2.88);
      expect(p.x).toBeCloseTo(2.16);
      expect(p.y).toBeCloseTo(2.88);
    });
  });

  describe('projectileOutOfBounds', () => {
    it('returns false when inside bounds', () => {
      expect(projectileOutOfBounds({ x: 100, y: 100, vx: 0, vy: 0 }, 800, 600)).toBe(false);
      expect(projectileOutOfBounds({ x: -60, y: 0, vx: 0, vy: 0 }, 800, 600)).toBe(false); // Exactly on the edge -60
      expect(projectileOutOfBounds({ x: 860, y: 600, vx: 0, vy: 0 }, 800, 600)).toBe(false); // Exactly on the edge width+60
    });

    it('returns true when outside left bound', () => {
      expect(projectileOutOfBounds({ x: -61, y: 100, vx: 0, vy: 0 }, 800, 600)).toBe(true);
    });

    it('returns true when outside right bound', () => {
      expect(projectileOutOfBounds({ x: 861, y: 100, vx: 0, vy: 0 }, 800, 600)).toBe(true);
    });

    it('returns true when outside bottom bound', () => {
      expect(projectileOutOfBounds({ x: 100, y: 751, vx: 0, vy: 0 }, 800, 600)).toBe(true);
    });

    it('does not return true when above top bound', () => {
      // Y is positive downwards, so negative Y is above the screen
      expect(projectileOutOfBounds({ x: 100, y: -1000, vx: 0, vy: 0 }, 800, 600)).toBe(false);
    });
  });
});
