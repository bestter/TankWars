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
      // Fallback
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
      // Shoot towards the right (angles 0-90 are generally rightward)
      angle = 30 + Math.random() * 30; // 30° → 60°
    } else {
      // Shoot towards the left
      angle = 120 + Math.random() * 30; // 120° → 150°
    }

    // Random power in a safe middle range
    const power = 35 + Math.random() * 40; // 35 → 75

    return {
      angle: Math.round(angle * 10) / 10,
      power: Math.round(power),
    };
  }
}
