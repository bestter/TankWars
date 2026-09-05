/**
 * TankWars - Player & Tank domain types (src/types/player.ts)
 *
 * Tank holds orientation (angle) + power state used by both UI sliders
 * and the physics engine when firing.
 *
 * Players can be human or AI. AI uses pluggable strategy (see AIEngine).
 */

import type { Color, AngleDegrees, Power } from "./game";
import type { WeaponId } from "./weapon";

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
  /** Shield (absorbs damage before health). */
  shield: number;
  maxShield: number;
  /** True when the tank is destroyed. */
  isDead: boolean;
  /** Last player id (owner) whose shot/explosion damaged this tank (for AI revenge targeting).
   *  Set during damage application; cleared on round respawn via spawnTanks. */
  lastHitBy?: string;
  /** Last opposing shooter whose projectile directly hit this tank this round.
   *  Unlike hitReaction.wasDirectHit, this identity is not consumed by AI recovery logic. */
  lastDirectAttackerId?: PlayerId;
  /** Must be a value from VGA_PALETTE (enforced at construction). */
  color: Color;
  /** Weapon that will be used on next FireCommand. */
  currentWeapon: WeaponId;
  /** Reaction to being hit by a projectile and/or falling down (Issue 174). */
  hitReaction?: TankHitReaction;
}

export interface TankHitReaction {
  /** True when the tank was directly hit by a projectile collision since its last shot. */
  wasDirectHit: boolean;
  /** Accumulated downward fall distance (in pixels) since its last shot. */
  fallDistance: number;
}

/** Strategy identifier used by AIEngine when !isHuman. */
export type AiProfile = "v1-random" | "v2-heuristic" | "v3-sniper" | "v4-smart";

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
  /** Strategy identifier used by AIEngine when !isHuman. Phase 1 = 'v1-random' (simple), 'v2-heuristic' = smarter "OK" AI (see AIHeuristicStrategy). */
  aiProfile?: AiProfile;
}
