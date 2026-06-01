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
}
