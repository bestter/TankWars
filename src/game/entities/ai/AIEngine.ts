/**
 * TankWars - AIEngine Interface
 *
 * Unified interface for all AI strategies.
 * Allows swapping simple random AI with more advanced trajectory solvers later (v2-heuristic etc).
 * executeTurn may return optional weaponId to let AI pick ammo for the shot.
 */

import type { GameState } from "../../../types/game";
import type { TerrainManager } from "../../engine/Terrain";
import type { WeaponId } from "../../../types/weapon";

export interface AIEngine {
  /**
   * Executes one full turn for the given AI tank.
   * Must return the angle and power the AI decides to use.
   * weaponId optional: if provided, TurnManager will use it for the FireCommand (and update tank.currentWeapon for HUD).
   */
  executeTurn(
    tankId: string,
    gameState: GameState,
    terrainManager: TerrainManager,
  ): Promise<{ angle: number; power: number; weaponId?: WeaponId }>;

  /**
   * Auto-resolution fallback.
   * Called when the AI turn gets stuck (e.g. projectile never settled, timeout, etc.).
   *
   * The AI can decide how it wants to "bail out":
   * - Return a valid { angle, power } → it will fire one last time.
   * - Return null → the turn is simply skipped (forfeit / pass).
   *
   * This method must be synchronous and fast.
   */
  getResolutionFallback?(): { angle: number; power: number } | null;
}
