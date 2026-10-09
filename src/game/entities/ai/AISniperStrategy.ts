import { secureRandom } from "../../../utils/random";
import type { GameState } from "../../../types/game";
import type { Player } from "../../../types/player";
import { type WeaponId } from "../../../types/weapon";
import type { TerrainManager } from "../../engine/Terrain";
import type { AIEngine } from "./AIEngine";
import {
  ADVANCED_GAFFES,
  applySignedCorruption,
  finalizeAdvancedAim,
} from "./aimCorruption";
import {
  type AimMemory,
  recordAimAttempt,
  resetAimMemoryForRound,
} from "./aimMemory";
import { solveSniperAim } from "./sniperAim";
import { chooseSniperPhysicalShot } from "./sniperPhysicalSelection";
import { maybeGaffe, signedImpactOffset } from "./fallibleAim";
import { consumeHitReaction, getHitReactionIntensity } from "./hitReaction";

type SniperMemory = AimMemory;

export class AISniperStrategy implements AIEngine {
  private memories = new Map<string, SniperMemory>();

  private getMem(playerId: string): SniperMemory {
    const existing = this.memories.get(playerId);
    if (existing) return existing;

    const memory: SniperMemory = { currentTargetAttempts: 0 };
    this.memories.set(playerId, memory);
    return memory;
  }

  async executeTurn(
    tankId: string,
    gameState: GameState,
    terrainManager: TerrainManager,
  ): Promise<{ angle: number; power: number; weaponId?: WeaponId }> {
    const self = gameState.players.find((player) => player.tank.id === tankId);
    if (!self || self.tank.isDead) {
      return { angle: 45, power: 50, weaponId: "MISSILE" };
    }

    const memory = this.getMem(self.id);
    resetAimMemoryForRound(memory, gameState.roundNumber);

    const enemies = gameState.players.filter(
      (player) => player.id !== self.id && !player.tank.isDead,
    );
    if (enemies.length === 0) {
      return { angle: 45, power: 50, weaponId: "MISSILE" };
    }

    let target: Player | undefined;
    if (memory.currentTargetId) {
      target = enemies.find((enemy) => enemy.id === memory.currentTargetId);
    }
    if (!target) {
      const aiEnemies = enemies.filter((enemy) => !enemy.isHuman);
      const candidates = aiEnemies.length > 0 ? aiEnemies : enemies;
      target = candidates.toSorted((left, right) => {
        const healthDifference = left.tank.health - right.tank.health;
        if (healthDifference !== 0) return healthDifference;
        return Number(left.isHuman) - Number(right.isHuman);
      })[0];
    }
    if (!target) {
      return { angle: 45, power: 50, weaponId: "MISSILE" };
    }

    const attempts = recordAimAttempt(memory, target.id);
    const targetX = target.tank.position.x;
    let offsetDirection = targetX > terrainManager.width - targetX ? -1 : 1;
    if (attempts === 2) {
      offsetDirection *= -1;
    }
    const offset = signedImpactOffset(
      attempts,
      "v3-sniper",
      gameState.roundNumber,
      offsetDirection,
    );
    const choice = chooseSniperPhysicalShot(
      self,
      target,
      gameState,
      terrainManager,
      offset,
      (point, weapon, variant) => solveSniperAim(
        self, point.x, point.y, gameState.windForce, gameState.gravity, terrainManager, weapon, variant,
      ),
    );
    const weaponId = choice.weaponId;
    self.tank.currentWeapon = weaponId;

    const gaffe = ADVANCED_GAFFES["v3-sniper"];
    const reactionIntensity = getHitReactionIntensity(
      self.aiProfile ?? "v3-sniper",
      self.tank.hitReaction,
    );
    let perturbed = false;
    let command = choice.rawCommand;
    if (reactionIntensity > 0) {
      command = applySignedCorruption(
        command,
        reactionIntensity * gaffe.angleAmplitude,
        reactionIntensity * gaffe.powerAmplitude,
      );
      perturbed = true;
    }
    if (maybeGaffe(gaffe.chance)) {
      command = applySignedCorruption(
        command,
        gaffe.angleAmplitude,
        gaffe.powerAmplitude,
      );
      perturbed = true;
    }

    consumeHitReaction(self.tank.hitReaction);
    const fired = perturbed ? finalizeAdvancedAim(command) : choice.command;
    return { ...fired, weaponId };
  }

  getResolutionFallback(): { angle: number; power: number } | null {
    return {
      angle: Math.round(45 + secureRandom() * 90),
      power: Math.round(55 + secureRandom() * 20),
    };
  }
}
