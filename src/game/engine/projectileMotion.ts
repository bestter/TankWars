/** Shared launch and fixed-step motion; no combat state or side effects. */
export const BALLISTICS_BASE_SPEED = 6;
export const BALLISTICS_DT = 1 / 120;
export const BALLISTICS_DRAG = 0.28;
export const BARREL_LENGTH = 20;
export const BARREL_START_Y_OFFSET = 13;

export interface BallisticMotion {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export function launchFromBarrel(sx: number, sy: number, angle: number, power = 1): BallisticMotion {
  const radians = angle * Math.PI / 180;
  const speed = power * BALLISTICS_BASE_SPEED;
  return {
    x: sx + Math.cos(radians) * BARREL_LENGTH,
    y: sy - BARREL_START_Y_OFFSET - Math.sin(radians) * BARREL_LENGTH,
    vx: Math.cos(radians) * speed,
    vy: -Math.sin(radians) * speed,
  };
}

export function advanceProjectile(p: BallisticMotion, dt: number, gravity: number, wind: number): void {
  p.vy += gravity * dt;
  p.vx += wind * dt;
  const speed = Math.hypot(p.vx, p.vy);
  if (speed > 4) {
    const drag = BALLISTICS_DRAG * speed * dt;
    p.vx -= (p.vx / speed) * drag;
    p.vy -= (p.vy / speed) * drag;
  }
  p.x += p.vx * dt;
  p.y += p.vy * dt;
}

export function projectileOutOfBounds(p: BallisticMotion, width: number, height: number): boolean {
  return p.x < -60 || p.x > width + 60 || p.y > height + 150;
}
