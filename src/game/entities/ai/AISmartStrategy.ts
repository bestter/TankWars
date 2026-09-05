import { secureRandom } from "../../../utils/random";
import type { GameState } from "../../../types/game";
import type { Player } from "../../../types/player";
import { WEAPON_REGISTRY, type WeaponId } from "../../../types/weapon";
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
import { searchBallisticSolution } from "./BallisticsSimulator";
import { maybeGaffe, signedImpactOffset } from "./fallibleAim";
import { consumeHitReaction, getHitReactionIntensity } from "./hitReaction";
import { shouldPickBulldozer } from "./bulldozerTactics";
import { adjustWeaponForMaterial } from "./terrainMaterialTactics";

type SmartMemory = AimMemory;

export class AISmartStrategy implements AIEngine {
  private memories = new Map<string, SmartMemory>();

  private getMem(playerId: string): SmartMemory {
    const existing = this.memories.get(playerId);
    if (existing) return existing;

    const memory: SmartMemory = { currentTargetAttempts: 0 };
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

    let finishOffAi: Player | undefined;
    let finishOffHuman: Player | undefined;
    let currentTarget: Player | undefined;
    let bestFallbackTarget: Player | undefined;
    let bestFallbackIsAi = false;

    for (const player of gameState.players) {
      if (player.id === self.id || player.tank.isDead) continue;

      const isAi = !player.isHuman;
      const healthTotal = player.tank.health + player.tank.shield;
      if (healthTotal <= 30) {
        if (isAi && !finishOffAi) finishOffAi = player;
        if (!isAi && !finishOffHuman) finishOffHuman = player;
      }
      if (memory.currentTargetId === player.id) {
        currentTarget = player;
      }

      if (!bestFallbackTarget) {
        bestFallbackTarget = player;
        bestFallbackIsAi = isAi;
      } else if (isAi && !bestFallbackIsAi) {
        bestFallbackTarget = player;
        bestFallbackIsAi = true;
      } else if (
        isAi === bestFallbackIsAi &&
        player.tank.health < bestFallbackTarget.tank.health
      ) {
        bestFallbackTarget = player;
      }
    }

    const livingAiEnemies = gameState.players.filter(
      (player) => player.id !== self.id && !player.tank.isDead && !player.isHuman,
    );
    let target: Player | undefined;
    if (finishOffAi) {
      target = finishOffAi;
    } else if (
      currentTarget &&
      !(currentTarget.isHuman && livingAiEnemies.length > 0)
    ) {
      target = currentTarget;
    } else if (finishOffHuman && livingAiEnemies.length === 0) {
      target = finishOffHuman;
    } else {
      target = bestFallbackTarget;
    }
    if (!target) {
      return { angle: 45, power: 50, weaponId: "MISSILE" };
    }

    const attempts = recordAimAttempt(memory, target.id);
    let weaponId = this.chooseTacticalWeapon(
      self,
      target,
      terrainManager,
      gameState,
    );
    weaponId = adjustWeaponForMaterial(
      weaponId,
      terrainManager.getMaterialAt(target.tank.position.x),
      (id) => (self.inventory[id] ?? 0) > 0,
    );
    self.tank.currentWeapon = weaponId;

    const aimX =
      target.tank.position.x +
      signedImpactOffset(attempts, "v4-smart", gameState.roundNumber);
    let command = this.computeSmartShot(
      self,
      aimX,
      target.tank.position.y - 6,
      gameState.windForce,
      gameState.gravity,
      terrainManager,
      weaponId,
    );

    const gaffe = ADVANCED_GAFFES["v4-smart"];
    const reactionIntensity = getHitReactionIntensity(
      self.aiProfile ?? "v4-smart",
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

  private chooseTacticalWeapon(
    self: Player,
    target: Player,
    terrain: TerrainManager,
    gameState: GameState,
  ): WeaponId {
    const has = (id: WeaponId) => (self.inventory[id] ?? 0) > 0;
    const sx = self.tank.position.x;
    const tx = target.tank.position.x;
    const distance = Math.abs(tx - sx);
    const startX = Math.min(sx, tx);
    const endX = Math.max(sx, tx);
    const step = (endX - startX) / 10;
    let maximumTerrainHeight = 0;
    for (let index = 1; index < 10; index += 1) {
      const height = terrain.getHeightAt(startX + index * step);
      maximumTerrainHeight = Math.max(maximumTerrainHeight, terrain.height - height);
    }
    const selfHeight = terrain.height - self.tank.position.y;
    const targetHeight = terrain.height - target.tank.position.y;
    const isHidden =
      maximumTerrainHeight > Math.max(selfHeight, targetHeight) + 35;
    const targetHealthTotal = target.tank.health + target.tank.shield;

    if (
      distance > 220 &&
      has("THERMONUCLEAR") &&
      targetHealthTotal >= 50 &&
      secureRandom() < 0.22
    ) {
      return "THERMONUCLEAR";
    }
    if (
      distance > 180 &&
      has("NUKE") &&
      targetHealthTotal >= 40 &&
      secureRandom() < 0.28
    ) {
      return "NUKE";
    }
    if (isHidden && has("GRENADE")) return "GRENADE";

    const neighbors = gameState.players.filter(
      (player) =>
        player.id !== self.id &&
        !player.tank.isDead &&
        Math.abs(player.tank.position.x - tx) < 80,
    ).length;
    if (neighbors >= 2 && has("CLUSTER")) return "CLUSTER";
    if (isHidden && has("DRILLER")) return "DRILLER";
    if (shouldPickBulldozer(self, target, terrain)) return "BULLDOZER";
    return "MISSILE";
  }

  private computeSmartShot(
    self: Player,
    targetX: number,
    targetY: number,
    wind: number,
    gravity: number,
    terrain: TerrainManager,
    weaponId: WeaponId,
  ): AimCommand {
    const sx = self.tank.position.x;
    const sy = self.tank.position.y;
    const isRight = targetX - sx > 0;
    const aMin = isRight ? 15 : 95;
    const aMax = isRight ? 85 : 165;
    const blastRadius = WEAPON_REGISTRY[weaponId]?.blastRadius ?? 28;

    const best = searchBallisticSolution({
      sx,
      sy,
      tx: targetX,
      ty: targetY,
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
      selfHarmPenalty: (landX, landY) =>
        Math.hypot(landX - sx, landY - sy) < blastRadius + 25 ? 50000 : 0,
    });

    return {
      angle: Math.max(6, Math.min(174, best.angle)),
      power: Math.max(25, Math.min(95, best.power)),
    };
  }

  getResolutionFallback(): { angle: number; power: number } | null {
    return {
      angle: Math.round(45 + secureRandom() * 90),
      power: Math.round(60 + secureRandom() * 20),
    };
  }
}
