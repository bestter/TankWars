/**
 * TankWars - AI Strategy Interface (src/game/entities/ai/AIStrategy.ts)
 *
 * CRITICAL ARCHITECTURE RULE (from project guidelines):
 * All AI controllers MUST implement this interface.
 * This keeps the Tank / GameEngine completely decoupled from any specific AI logic.
 *
 * Phase 1 requirement: Implementations must be "simple/stupid" (random trajectory injector).
 * More advanced aiming / prediction engines can be swapped in later without touching the core.
 */

import type { Player } from '../../../types/player';
import type { FireCommand } from '../../../types/game';
import type { TerrainManager } from '../../engine/Terrain';

/**
 * Snapshot of the world passed to AI.
 * Keep this lightweight and serializable. Never give live mutable references to projectiles.
 */
export interface AIWorldView {
  readonly terrain: TerrainManager;    // read-only access via methods
  readonly players: ReadonlyArray<Player>;
  readonly currentPlayerId: string;
  readonly windForce: number;
  readonly gravity: number;
}

/**
 * Unified AI Strategy contract.
 * The GameEngine (or a TurnManager) calls this when it's an AI player's turn.
 */
export interface AIStrategy {
  /**
   * Decide the next shot parameters.
   * Must return a valid FireCommand or null (to pass / do nothing).
   *
   * Implementations in Phase 1 should be deliberately naive (random within safe ranges).
   */
  decideShot(
    self: Player,
    world: AIWorldView
  ): FireCommand | null;

  /** Optional: name for debugging / UI */
  readonly name: string;
}
