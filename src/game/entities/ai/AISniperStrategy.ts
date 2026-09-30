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
  type AimCommand,
} from "./aimCorruption";
import {
  type AimMemory,
  recordAimAttempt,
  resetAimMemoryForRound,
} from "./aimMemory";
import { solveSniperAim } from "./sniperAim";
import type { AimVariant } from "./aimSearch";
import { chooseLocalMaterialShot } from "./localMaterialPlanner";
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

    const virtualAttempts = memory.currentTargetId === target.id ? memory.currentTargetAttempts + 1 : 1;
    const ordinaryWeapon = this.chooseSniperWeapon(self, virtualAttempts);
    const choice = chooseLocalMaterialShot("v3-sniper", self, target, gameState, terrainManager,
      ordinaryWeapon, virtualAttempts, (point, weapon, variant) => solveSniperAim(
        self, point.x, point.y, gameState.windForce, gameState.gravity, terrainManager, weapon, variant,
      ));
    const attempts = recordAimAttempt(memory, target.id);
    const weaponId = choice.weaponId;
    self.tank.currentWeapon = weaponId;

    const targetX = target.tank.position.x;
    let offsetDirection =
      targetX > terrainManager.width - targetX ? -1 : 1;
    if (attempts === 2) {
      offsetDirection *= -1;
    }
    const aimX =
      choice.point.x +
      signedImpactOffset(
        attempts,
        "v3-sniper",
        gameState.roundNumber,
        offsetDirection,
      );
    let command = this.computePrecisionShot(
      self,
      aimX,
      choice.point.y,
      gameState.windForce,
      gameState.gravity,
      terrainManager,
      weaponId,
      choice.variant,
    );

    const gaffe = ADVANCED_GAFFES["v3-sniper"];
    const reactionIntensity = getHitReactionIntensity(
      self.aiProfile ?? "v3-sniper",
      self.tank.hitReaction,
    );
    if (reactionIntensity > 0) {
      command = applySignedCorruption(
        command,
        reactionIntensity * gaffe.angleAmplitude,
        reactionIntensity * gaffe.powerAmplitude,
      );
    }
    if (maybeGaffe(gaffe.chance)) {
      command = applySignedCorruption(
        command,
        gaffe.angleAmplitude,
        gaffe.powerAmplitude,
      );
    }

    consumeHitReaction(self.tank.hitReaction);
    return { ...finalizeAdvancedAim(command), weaponId };
  }

  private chooseSniperWeapon(self: Player, attempts: number): WeaponId {
    const hasBullet = (self.inventory.BULLET ?? 0) > 0;
    const hasDriller = (self.inventory.DRILLER ?? 0) > 0;
    if (attempts === 1) return "MISSILE";
    if (hasBullet && secureRandom() < 0.5) return "BULLET";
    if (hasDriller) return "DRILLER";
    return "MISSILE";
  }

  private computePrecisionShot(
    self: Player,
    targetX: number,
    targetY: number,
    wind: number,
    gravity: number,
    terrain: TerrainManager,
    weaponId?: WeaponId,
    variant: AimVariant = "full",
  ): AimCommand {
    return solveSniperAim(self, targetX, targetY, wind, gravity, terrain, weaponId, variant).command;
  }

  getResolutionFallback(): { angle: number; power: number } | null {
    return {
      angle: Math.round(45 + secureRandom() * 90),
      power: Math.round(55 + secureRandom() * 20),
    };
  }
}
