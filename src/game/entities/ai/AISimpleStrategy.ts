/**
 * TankWars - AISimpleStrategy (V1 - "Stupid" AI)
 *
 * Phase 1 implementation as required by project guidelines.
 * Deliberately naive and predictable for testing purposes.
 */

import type { AIEngine } from './AIEngine';
import type { GameState } from '../../../types/game';
import type { Player } from '../../../types/player';

export class AISimpleStrategy implements AIEngine {
  async executeTurn(
    tankId: string,
    gameState: GameState,
    /* _terrainManager: TerrainManager */ // Not heavily used in V1
  ): Promise<{ angle: number; power: number }> {
    const currentPlayer = gameState.players.find((p) => p.tank.id === tankId);
    if (!currentPlayer) {
      return { angle: 45, power: 50 };
    }

    // Find living enemies
    const enemies = gameState.players.filter(
      (p) => p.id !== currentPlayer.id && !p.tank.isDead,
    );

    if (enemies.length === 0) {
      return { angle: 45, power: 50 };
    }

    // Prefer human players as target, otherwise pick random
    let target: Player | undefined = enemies.find((p) => p.isHuman);
    if (!target) {
      target = enemies[Math.floor(Math.random() * enemies.length)];
    }

    const myX = currentPlayer.tank.position.x;
    const targetX = target.tank.position.x;

    const isTargetToTheRight = targetX > myX;

    let angle: number;

    if (isTargetToTheRight) {
      angle = 30 + Math.random() * 30; // 30° → 60°
    } else {
      angle = 120 + Math.random() * 30; // 120° → 150°
    }

    const power = 35 + Math.random() * 40; // 35 → 75

    return {
      angle: Math.round(angle * 10) / 10,
      power: Math.round(power),
    };
  }

  /**
   * Fallback when the AI turn gets stuck.
   * SimpleStrategy just fires a completely random safe shot.
   */
  getResolutionFallback(): { angle: number; power: number } | null {
    const angle = 20 + Math.random() * 140; // anywhere between 20° and 160°
    const power = 40 + Math.random() * 35;  // 40-75
    return {
      angle: Math.round(angle),
      power: Math.round(power),
    };
  }
}
