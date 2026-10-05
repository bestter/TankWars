/** Largeur de la boîte de collision des tanks, en pixels. */
export const TANK_HITBOX_WIDTH = 24;

/** Hauteur de la boîte de collision des tanks, en pixels. */
export const TANK_HITBOX_HEIGHT = 15;

/** Same inclusive AABB for combat collisions and pure direct searches. */
export function insideTankHitbox(x: number, y: number, position: { x: number; y: number }): boolean {
  return x >= position.x - TANK_HITBOX_WIDTH / 2 &&
    x <= position.x + TANK_HITBOX_WIDTH / 2 &&
    y >= position.y - TANK_HITBOX_HEIGHT && y <= position.y;
}

/** Surface this close to the bottom provides no tank support. */
export const BOTTOM_SUPPORT_MARGIN = 14;

/** Rayon inclusif d'élimination instantanée THERMONUCLEAR. */
export const THERMONUCLEAR_INSTANT_KILL_RADIUS = 75;
