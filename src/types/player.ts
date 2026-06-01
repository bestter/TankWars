/**
 * TankWars - Player & Tank domain types (src/types/player.ts)
 *
 * Tank holds orientation (angle) + power state used by both UI sliders
 * and the physics engine when firing.
 *
 * Players can be human or AI. AI uses pluggable strategy (see AIEngine).
 */

import type { Color, AngleDegrees, Power } from './game';
import type { WeaponId } from './weapon';

export type PlayerId = string;

/** Physical tank instance belonging to a player.
 *  Position is authoritative in the canvas engine during COMBAT/RESOLUTION.
 *  React only reads it for overlay UI (health bars, names).
 */
export interface Tank {
  id: string;
  /** Canvas/world coordinates. y grows downward in 2D canvas by convention. */
  position: { x: number; y: number };
  /** Current turret angle (degrees). */
  angle: AngleDegrees;
  /** Current power setting (0-100). */
  power: Power;
  health: number;
  maxHealth: number;
  /** Must be a value from VGA_PALETTE (enforced at construction). */
  color: Color;
  /** Weapon that will be used on next FireCommand. */
  currentWeapon: WeaponId;
}

/** A participant in the match (human or AI). */
export interface Player {
  id: PlayerId;
  name: string;
  /** Determines input source and AI controller selection. */
  isHuman: boolean;
  tank: Tank;
  /** Spend in SHOP phase. Earned by surviving + dealing damage. */
  money: number;
  /** Ammo remaining per weapon type. Keys absent or <=0 mean unavailable. */
  inventory: Partial<Record<WeaponId, number>>;
  /** Strategy identifier used by AIEngine when !isHuman. Phase 1 = 'v1-random'. */
  aiProfile?: 'v1-random' | 'v2-heuristic';
}
