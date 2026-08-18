import { secureRandom } from "../../../utils/random";
/**
 * TankWars - AISmartStrategy (v4 "Expert/Smart" AI)
 *
 * A highly capable AI strategy:
 * - Uses fine-grained angle search (1.5° steps) and 10 binary search power iterations.
 * - Simulates weapon-specific physics: bounces for GRENADE, apex-splits for CLUSTER.
 * - Self-preservation: Discards any shot parameters that would result in landing
 *   within the weapon's blast radius + 20px of its own tank.
 * - Adaptive precision: Starts with low aiming noise and ramps down to near-perfect accuracy quickly.
 * - Tactical weapon selection: Uses nukes for long distance, grenades/clusters for hills or close range.
 */

import type { AIEngine } from "./AIEngine";
import type { GameState } from "../../../types/game";
import type { Player } from "../../../types/player";
import type { TerrainManager } from "../../engine/Terrain";
import { WEAPON_REGISTRY, type WeaponId } from "../../../types/weapon";
import { searchBallisticSolution } from "./BallisticsSimulator";

interface SmartMemory {
  currentTargetId?: string;
  targetAttempts: Record<string, number>;
  lastSelfHealth?: number;
  lastPowerBias: number;
}

export class AISmartStrategy implements AIEngine {
  private memories = new Map<string, SmartMemory>();

  private getMem(playerId: string): SmartMemory {
    if (!this.memories.has(playerId)) {
      this.memories.set(playerId, {
        targetAttempts: {},
        lastPowerBias: 0,
      });
    }
    return this.memories.get(playerId)!;
  }

  private resetForNewRound(mem: SmartMemory): void {
    mem.currentTargetId = undefined;
    mem.targetAttempts = {};
    mem.lastPowerBias = 0;
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

    // Target selection:
    let target: Player | undefined;
    let hasEnemies = false;

    // Single pass tracking for different priorities
    let finishOffAi: Player | undefined;
    let finishOffHuman: Player | undefined;
    let currentTarget: Player | undefined;

    let bestFallbackTarget: Player | undefined;
    let bestFallbackIsAi = false;

    for (let i = 0; i < gameState.players.length; i++) {
      const p = gameState.players[i];
      if (p.id !== self.id && !p.tank.isDead) {
        hasEnemies = true;
        const pIsAi = !p.isHuman;
        const healthTotal = p.tank.health + p.tank.shield;

        // 1. Close to death targets
        if (healthTotal <= 30) {
          if (pIsAi && !finishOffAi) finishOffAi = p;
          else if (!pIsAi && !finishOffHuman) finishOffHuman = p;
        }

        // 2. Current target tracking
        if (mem.currentTargetId === p.id) {
          currentTarget = p;
        }

        // 3. General fallback (weakest AI, then weakest human)
        if (!bestFallbackTarget) {
          bestFallbackTarget = p;
          bestFallbackIsAi = pIsAi;
        } else {
          if (pIsAi && !bestFallbackIsAi) {
            bestFallbackTarget = p;
            bestFallbackIsAi = pIsAi;
          } else if (pIsAi === bestFallbackIsAi) {
            if (p.tank.health < bestFallbackTarget.tank.health) {
              bestFallbackTarget = p;
            }
          }
        }
      }
    }

    if (!hasEnemies) {
      return { angle: 45, power: 50, weaponId: "MISSILE" };
    }

    // Resolution in priority order
    if (finishOffAi) {
      target = finishOffAi;
    } else if (finishOffHuman) {
      target = finishOffHuman;
    } else if (currentTarget) {
      target = currentTarget;
    } else {
      target = bestFallbackTarget;
    }

    const isNewTarget = target!.id !== mem.currentTargetId;
    mem.currentTargetId = target!.id;
    if (isNewTarget && import.meta.env.DEV) {
      console.log(
        `[AI TARGET] ${self.name} (Smart V4) selected NEW target: ${target!.name}`,
      );
    }

    const attempts = (mem.targetAttempts[target!.id] || 0) + 1;
    mem.targetAttempts[target!.id] = attempts;

    // Weapon selection
    const chosenWeapon = this.chooseTacticalWeapon(
      self,
      target!,
      terrainManager,
      gameState,
    );
    self.tank.currentWeapon = chosenWeapon; // Sync live snap for HUD display

    // Compute the shot
    const { angle, power } = this.computeSmartShot(
      self,
      target!,
      gameState.windForce,
      gameState.gravity,
      terrainManager,
      attempts,
      chosenWeapon,
      mem,
    );

    return {
      angle: Math.round(angle * 10) / 10,
      power: Math.round(power),
      weaponId: chosenWeapon,
    };
  }

  private chooseTacticalWeapon(
    self: Player,
    target: Player,
    terrain: TerrainManager,
    gs: GameState,
  ): WeaponId {
    const inv = self.inventory || {};
    const has = (id: WeaponId) => (inv[id] ?? 0) > 0;

    const sx = self.tank.position.x;
    const tx = target.tank.position.x;
    const dist = Math.abs(tx - sx);

    // Check if there is a massive hill block between us
    let maxTerrainHeight = 0;
    const startX = Math.min(sx, tx);
    const endX = Math.max(sx, tx);
    const step = (endX - startX) / 10;
    for (let i = 1; i < 10; i++) {
      const h = terrain.getHeightAt(startX + i * step);
      maxTerrainHeight = Math.max(maxTerrainHeight, terrain.height - h);
    }
    const selfHeight = terrain.height - self.tank.position.y;
    const targetHeight = terrain.height - target.tank.position.y;
    const isHidden = maxTerrainHeight > Math.max(selfHeight, targetHeight) + 35;

    const targetHealthTotal = target.tank.health + target.tank.shield;

    // 1. Thermonuclear - only if target is far enough away to not kill ourselves,
    // target has significant health, and passes a probability check (30%)
    if (dist > 220 && has("THERMONUCLEAR") && targetHealthTotal >= 50 && secureRandom() < 0.30) {
      return "THERMONUCLEAR";
    }

    // 2. Baby Nuke for long range - only if target has enough health and passes a probability check (35%)
    if (dist > 180 && has("NUKE") && targetHealthTotal >= 40 && secureRandom() < 0.35) {
      return "NUKE";
    }

    // 3. Grenade if target is hidden behind a hill (to bounce over/down the hill)
    if (isHidden && has("GRENADE")) return "GRENADE";

    // 4. Cluster if target has neighbors nearby (clustered targets)
    const neighbors = gs.players.filter(
      (p) =>
        p.id !== self.id &&
        !p.tank.isDead &&
        Math.abs(p.tank.position.x - tx) < 80,
    ).length;
    if (neighbors >= 2 && has("CLUSTER")) return "CLUSTER";

    // 5. Driller for hidden targets under high slopes
    if (isHidden && has("DRILLER")) return "DRILLER";

    // Default
    return "MISSILE";
  }

  private computeSmartShot(
    self: Player,
    target: Player,
    wind: number,
    gravity: number,
    terrain: TerrainManager,
    attempts: number,
    weaponId: WeaponId,
    mem: SmartMemory,
  ): { angle: number; power: number } {
    const sx = self.tank.position.x;
    const sy = self.tank.position.y;
    const tx = target.tank.position.x;
    const ty = target.tank.position.y - 6;
    const dx = tx - sx;
    const isRight = dx > 0;

    const aMin = isRight ? 15 : 95;
    const aMax = isRight ? 85 : 165;

    const weapon = WEAPON_REGISTRY[weaponId];
    const blastRadius = weapon?.blastRadius ?? 28;

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
      fineStep: 1.5,
      fineWindow: 4,
      powerLo: 20,
      powerHi: 95,
      powerIterations: 10,
      obstaclePenaltyHigh: 10000,
      obstaclePenaltyLow: 20,
      weaponId,
      earlyExitError: 4,
      selfHarmPenalty: (landX, landY) => {
        const selfDist = Math.hypot(landX - sx, landY - sy);
        return selfDist < blastRadius + 25 ? 50000 : 0;
      },
    });

    let angle = best.angle;
    let power = best.power + mem.lastPowerBias;

    // Fast noise reduction:
    // Attempt 1: small noise (1.8 deg max)
    // Attempt 2: minimal noise (0.5 deg max)
    // Attempt 3+: near-perfect precision (0.05 deg max)
    let maxNoise = 1.8;
    if (attempts === 2) maxNoise = 0.5;
    else if (attempts >= 3) maxNoise = 0.05;

    const angleNoise = (secureRandom() - 0.5) * maxNoise;
    const powerNoise = (secureRandom() - 0.5) * (maxNoise * 0.6);

    angle += angleNoise;
    power += powerNoise;

    // Safe bounds
    angle = Math.max(6, Math.min(174, angle));
    power = Math.max(25, Math.min(95, power));

    return { angle, power };
  }

  getResolutionFallback(): { angle: number; power: number } | null {
    const angle = 45 + secureRandom() * 90;
    const power = 60 + secureRandom() * 20;
    return {
      angle: Math.round(angle),
      power: Math.round(power),
    };
  }
}
