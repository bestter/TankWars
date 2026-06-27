import { secureRandom } from "../../../utils/random";
/**
 * TankWars - AISimpleStrategy (V1 - "Stupid" AI)
 *
 * Phase 1 implementation as required by project guidelines.
 * Deliberately naive and predictable for testing purposes.
 */

import type { AIEngine } from "./AIEngine";
import type { GameState } from "../../../types/game";
import type { Player } from "../../../types/player";
import type { TerrainManager } from "../../engine/Terrain";
import type { WeaponId } from "../../../types/weapon";

export class AISimpleStrategy implements AIEngine {
  async executeTurn(
    tankId: string,
    gameState: GameState,
    _terrainManager: TerrainManager,
  ): Promise<{ angle: number; power: number; weaponId?: WeaponId }> {
    void _terrainManager;
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

    // Human privilege: Prioritize targeting other AIs, fallback to human only if no AIs left
    const aiEnemies = enemies.filter((e) => !e.isHuman);
    const candidates = aiEnemies.length > 0 ? aiEnemies : enemies;
    const target: Player =
      candidates[Math.floor(secureRandom() * candidates.length)];

    const myX = currentPlayer.tank.position.x;
    const targetX = target.tank.position.x;

    const isTargetToTheRight = targetX > myX;

    let angle: number;

    // Safer trajectories (higher arc, more power) to reduce risk of self-damage
    // while remaining simple/stupid as per Phase 1 requirements.
    if (isTargetToTheRight) {
      angle = 45 + secureRandom() * 30; // 45° → 75° (more upward)
    } else {
      angle = 105 + secureRandom() * 45; // 105° → 150° (more upward from the right side)
    }

    const power = 60 + secureRandom() * 30; // 60 → 90 (stronger shots for better range)

    const weaponId = currentPlayer.tank.currentWeapon || "MISSILE";
    return {
      angle: Math.round(angle * 10) / 10,
      power: Math.round(power),
      weaponId,
    };
  }

  /**
   * Fallback when the AI turn gets stuck.
   * SimpleStrategy just fires a completely random safe shot.
   */
  getResolutionFallback(): { angle: number; power: number } | null {
    const angle = 40 + secureRandom() * 100; // 40° → 140°
    const power = 55 + secureRandom() * 30; // 55-85 (safer)
    return {
      angle: Math.round(angle),
      power: Math.round(power),
    };
  }
}
