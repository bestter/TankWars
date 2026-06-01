/**
 * TankWars - AIEngine Interface
 *
 * Unified interface for all AI strategies.
 * Allows swapping simple random AI with more advanced trajectory solvers later.
 */

import type { GameState } from '../../../types/game';
import type { TerrainManager } from '../../engine/Terrain';

export interface AIEngine {
  /**
   * Executes one full turn for the given AI tank.
   * Must return the angle and power the AI decides to use.
   */
  executeTurn(
    tankId: string,
    gameState: GameState,
    terrainManager: TerrainManager,
  ): Promise<{ angle: number; power: number }>;

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
