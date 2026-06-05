/**
 * TankWars - Core game types (src/types/game.ts)
 *
 * State machine, shared primitives, and high-level GameState.
 * React owns this state (turns, phase, money, high-level player data).
 * Canvas engine owns: live physics bodies, projectiles, pixel terrain mutations.
 *
 * Strict TypeScript. Zero `any`. VGA 16-color palette for all rendering.
 */

import type { Player } from "./player";
import type { WeaponId } from "./weapon";

/** Classic 16-color VGA palette (high-contrast, suitable for tanks/explosions/UI).
 *  Extended with high-contrast arcade/neon colors for the tank visual redesign (Step 1).
 *  New colors are bright/saturated to pop on dark terrain and backgrounds.
 */
export const VGA_PALETTE = {
  BLACK: "#000000",
  DARK_BLUE: "#0000AA",
  DARK_GREEN: "#00AA00",
  DARK_CYAN: "#00AAAA",
  DARK_RED: "#AA0000",
  DARK_MAGENTA: "#AA00AA",
  BROWN: "#AA5500",
  GRAY: "#AAAAAA",
  DARK_GRAY: "#555555",
  BLUE: "#5555FF",
  GREEN: "#55FF55",
  CYAN: "#55FFFF",
  RED: "#FF5555",
  MAGENTA: "#FF55FF",
  YELLOW: "#FFFF55",
  WHITE: "#FFFFFF",

  // --- High-Contrast Arcade/Neon (tank redesign) ---
  ELECTRIC_CYAN: "#00F7FF",
  FLASH_GREEN: "#00FF7F",
  NEON_PINK: "#FF1A8C",
  CYBER_YELLOW: "#D7FF00",
  FLUO_ORANGE: "#FF8C00",
  VOLT_PURPLE: "#B300FF",
} as const;

export type Color = (typeof VGA_PALETTE)[keyof typeof VGA_PALETTE];

/** 2D vector used for positions, velocities (engine + UI). */
export interface Vector2 {
  x: number;
  y: number;
}

/** Barrel orientation in degrees.
 *  Convention: 0° = horizontal right, positive = counterclockwise (up),
 *  range typically [-90, 90] or [0, 180] depending on facing. Engine converts to radians for physics.
 */
export type AngleDegrees = number;

/** Firing power level (percentage). Engine maps to initial velocity. */
export type Power = number; // 0-100 inclusive

/** Main game state machine phases (React-driven). */
export type GamePhase =
  | "MENU" // Title / main menu
  | "SHOP" // Purchase weapons/ammo between rounds
  | "COMBAT" // Active player's turn: aim, power, weapon select, fire
  | "RESOLUTION" // Projectiles in flight, explosions, chain reactions, damage application, terrain destruction
  | "CELEBRATION" // Post-round fireworks from winning tank ( ~10s or SPACE to skip ) before SUMMARY
  | "SUMMARY" // End-of-round (fin de manche) score + earnings screen (before shop)
  | "GAME_OVER"; // Match finished, winner declared

/** Intent produced by human input or AI strategy for a shot. Passed to engine. */
export interface FireCommand {
  readonly angle: AngleDegrees;
  readonly power: Power;
  readonly weaponId: WeaponId;
}

/** Serializable snapshot of the entire match state.
 *  Keep this small; do NOT embed raw ImageData or live particle arrays here.
 */
export interface GameState {
  phase: GamePhase;
  players: Player[];
  /** Index into players[] for whose turn it is (only meaningful in COMBAT/RESOLUTION). */
  currentPlayerIndex: number;
  turn: number;
  /** Present only when phase === 'GAME_OVER' */
  winnerId?: Player["id"];
  /** Current wind (px/s² horizontal accel) + gravity for this combat round.
   *  Provided to AIEngine (for wind-aware / terrain-aware smarter AI aiming). */
  windForce: number;
  gravity: number;
}

/** Summary emitted after a RESOLUTION phase for logging / money rewards / UI. */
export interface RoundResult {
  /** playerId -> total damage points inflicted this resolution */
  damageDealt: Record<string, number>;
  /** Approximate "area" destroyed (pixels or heightmap deltas) */
  terrainDestroyed: number;
  /** Ids of players still alive with health > 0 */
  survivors: string[];
}
