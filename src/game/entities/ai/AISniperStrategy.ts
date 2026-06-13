import { secureRandom } from "../../../utils/random";
/**
 * TankWars - AISniperStrategy (v3 "Sniper" AI)
 *
 * A cold, efficient sniper that aims with surgical precision.
 * - Restricts itself to clean single-target kinetic weapons (Missile, Driller).
 * - "Never one-shot": The first shot at any target in a round will deliberately
 *   miss by a safe horizontal margin (e.g., 30px offset). This guarantees it takes
 *   exactly 2 to 3 shots to destroy a tank (never 1).
 * - Second shot onwards targets the tank directly with zero aiming noise.
 */

import type { AIEngine } from "./AIEngine";
import type { GameState } from "../../../types/game";
import type { Player } from "../../../types/player";
import type { TerrainManager } from "../../engine/Terrain";
import { type WeaponId } from "../../../types/weapon";
import { searchBallisticSolution } from "./BallisticsSimulator";

interface SniperMemory {
  currentTargetId?: string;
  /** Attempts per target player ID this round */
  targetAttempts: Record<string, number>;
  lastSelfHealth?: number;
}

export class AISniperStrategy implements AIEngine {
  private memories = new Map<string, SniperMemory>();

  private getMem(playerId: string): SniperMemory {
    if (!this.memories.has(playerId)) {
      this.memories.set(playerId, {
        targetAttempts: {},
      });
    }
    return this.memories.get(playerId)!;
  }

  private resetForNewRound(mem: SniperMemory): void {
    mem.currentTargetId = undefined;
    mem.targetAttempts = {};
  }

  /**
   * Logique d'achat exclusive au Sniper (à appeler durant la phase de boutique du jeu)
   * Seul le Sniper dépense 150$ pour cette arme secrète.
   */
  public shopDecision(player: Player): WeaponId[] {
    const purchases: WeaponId[] = [];
    let currentMoney = player.money ?? 0;
    const BULLET_COST = 150;

    // Le sniper achète autant de BULLET que ses finances le lui permettent
    while (currentMoney >= BULLET_COST) {
      purchases.push('BULLET');
      currentMoney -= BULLET_COST;
    }

    return purchases;
  }

  async executeTurn(
    tankId: string,
    gameState: GameState,
    terrainManager: TerrainManager,
  ): Promise<{ angle: number; power: number; weaponId?: WeaponId }> {
    const self = gameState.players.find((p) => p.tank.id === tankId);
    if (!self || self.tank.isDead) {
      return { angle: 45, power: 50, weaponId: "MISSILE" };
    }

    const mem = this.getMem(self.id);

    // Detect round respawn (health reset to full) and clear per-round memory
    if (
      mem.lastSelfHealth != null &&
      self.tank.health > mem.lastSelfHealth + 5
    ) {
      this.resetForNewRound(mem);
    }
    mem.lastSelfHealth = self.tank.health;

    // Find living enemies
    const enemies = gameState.players.filter(
      (p) => p.id !== self.id && !p.tank.isDead,
    );
    if (enemies.length === 0) {
      return { angle: 45, power: 50, weaponId: 'MISSILE' };
    }

    // Target selection
    let target: Player | undefined;
    let hasEnemies = false;
    let bestTarget: Player | undefined;
    let bestIsAi = false;

    // Single pass to find current target and best fallback target
    for (let i = 0; i < gameState.players.length; i++) {
      const p = gameState.players[i];
      if (p.id !== self.id && !p.tank.isDead) {
        hasEnemies = true;

        // 1. Maintain focus on current target if still alive
        if (mem.currentTargetId && p.id === mem.currentTargetId) {
          target = p;
          // Note: we don't break early here because we might need to know if there are enemies
          // but actually if we found the target, we don't need to do the rest of the loop!
          // We can break early if we just need the target. Wait, if target exists, we don't need bestTarget.
          // Let's break early to save time if target is found.
          break;
        }

        // 2. Otherwise pick the most dangerous AI (smartest/highest health), or nearest if only humans left
        // (Wait, original comment says "most dangerous AI", but code implements "Prefer weakest target"
        //  The code says: const h = a.tank.health - b.tank.health; which sorts ascending by health, picking weakest.)
        const pIsAi = !p.isHuman;
        if (!bestTarget) {
          bestTarget = p;
          bestIsAi = pIsAi;
        } else {
          // Tie-breaker: prefer AI over human
          if (pIsAi && !bestIsAi) {
            bestTarget = p;
            bestIsAi = pIsAi;
          }
          // If both are AI or both are Human, prefer lower health
          else if (pIsAi === bestIsAi) {
            if (p.tank.health < bestTarget.tank.health) {
              bestTarget = p;
            }
          }
        }
      }
    }

    if (!hasEnemies) {
      return { angle: 45, power: 50, weaponId: "MISSILE" };
    }

    if (!target) {
      const aiEnemies = enemies.filter((e) => !e.isHuman);
      const candidates = aiEnemies.length > 0 ? aiEnemies : enemies;

      const sorted = candidates.toSorted((a, b) => {
        const h = a.tank.health - b.tank.health;
        if (h !== 0) return h;
        const ha = a.isHuman ? 1 : 0;
        const hb = b.isHuman ? 1 : 0;
        return ha - hb;
      });
      target = sorted[0];
    }

    const isNewTarget = target!.id !== mem.currentTargetId;
    mem.currentTargetId = target!.id;
    if (isNewTarget) {
      console.log(
        `[AI TARGET] ${self.name} (Sniper V3) selected NEW target: ${target!.name}`,
      );
    }

    // 👈 Accumulation persistante des essais au sein de la même manche
    const attempts = (mem.targetAttempts[target!.id] || 0) + 1;
    mem.targetAttempts[target!.id] = attempts;

    let chosenWeapon: WeaponId = 'MISSILE';
    if ((self.inventory?.BULLET ?? 0) > 0) {
      chosenWeapon = 'BULLET';
    } else if ((self.inventory?.DRILLER ?? 0) > 0) {
      chosenWeapon = 'DRILLER';
    }
    self.tank.currentWeapon = chosenWeapon;

    // Compute the shot solution
    // If it is the first attempt on this target, deliberately miss by a safe horizontal margin.
    let targetX = target!.tank.position.x;
    if (attempts === 1) {
      const spaceToLeft = targetX;
      const spaceToRight = terrainManager.width - targetX;
      const offsetDir = spaceToLeft > spaceToRight ? -1 : 1;
      targetX += offsetDir * 36;
    }

    const { angle, power } = this.computePrecisionShot(
      self,
      targetX,
      target!.tank.position.y - 6,
      gameState.windForce,
      gameState.gravity,
      terrainManager,
    );

    return {
      angle: Math.round(angle * 10) / 10,
      power: Math.round(power),
      weaponId: chosenWeapon,
    };
  }

  private computePrecisionShot(
    self: Player,
    tx: number,
    ty: number,
    wind: number,
    gravity: number,
    terrain: TerrainManager,
  ): { angle: number; power: number } {
    const sx = self.tank.position.x;
    const sy = self.tank.position.y;
    const dx = tx - sx;
    const isRight = dx > 0;

    const aMin = isRight ? 15 : 95;
    const aMax = isRight ? 85 : 165;

    const best = searchBallisticSolution({
      sx,
      sy,
      tx,
      ty,
      wind,
      gravity,
      terrain,
      isRight,
      aMin,
      aMax,
      coarseStep: 5,
      fineStep: 1,
      fineWindow: 4,
      powerLo: 20,
      powerHi: 95,
      powerIterations: 10,
      obstaclePenaltyHigh: 10000,
      earlyExitError: 2,
    });

    return { angle: best.angle, power: best.power };
  }

  getResolutionFallback(): { angle: number; power: number } | null {
    const angle = 45 + secureRandom() * 90;
    const power = 55 + secureRandom() * 20;
    return { angle: Math.round(angle), power: Math.round(power) };
  }
}