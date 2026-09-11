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
import { maybeGaffe, signedImpactOffset } from "./fallibleAim";
import { computeHeuristicShot } from "./heuristicShot";
import { consumeHitReaction, getHitReactionIntensity } from "./hitReaction";
import { shouldPickBulldozer } from "./bulldozerTactics";
import { adjustWeaponForMaterial } from "./terrainMaterialTactics";

export class AIHeuristicStrategy implements AIEngine {
  private memories = new Map<string, AimMemory>();

  private getMem(playerId: string): AimMemory {
    const existing = this.memories.get(playerId);
    if (existing) return existing;

    const memory: AimMemory = {
      currentTargetAttempts: 0,
    };
    this.memories.set(playerId, memory);
    return memory;
  }

  async executeTurn(
    tankId: string,
    gameState: GameState,
    terrainManager: TerrainManager,
  ): Promise<{ angle: number; power: number; weaponId?: WeaponId }> {
    const playerById = new Map<string, Player>();
    let self: Player | undefined;
    for (const player of gameState.players) {
      playerById.set(player.id, player);
      if (player.tank.id === tankId) self = player;
    }
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
    const revengeId = self.tank.lastHitBy;
    if (revengeId) {
      const revengeTarget = playerById.get(revengeId);
      if (
        revengeTarget &&
        revengeTarget.id !== self.id &&
        !revengeTarget.tank.isDead
      ) {
        target = revengeTarget;
      }
    }

    if (!target && memory.currentTargetId) {
      const currentTarget = playerById.get(memory.currentTargetId);
      if (
        currentTarget &&
        currentTarget.id !== self.id &&
        !currentTarget.tank.isDead
      ) {
        target = currentTarget;
      }
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
    let weaponId = this.chooseWeapon(self, target, terrainManager, gameState);
    weaponId = adjustWeaponForMaterial(
      weaponId,
      terrainManager.getMaterialAt(target.tank.position.x),
      (id) => (self.inventory[id] ?? 0) > 0,
    );
    self.tank.currentWeapon = weaponId;

    const aimX =
      target.tank.position.x +
      signedImpactOffset(
        attempts,
        "v2-heuristic",
        gameState.roundNumber,
      );
    let command = computeHeuristicShot(
      self,
      aimX,
      target.tank.position.y - 6,
      gameState.windForce,
      gameState.gravity,
      terrainManager,
    );

    const gaffe = ADVANCED_GAFFES["v2-heuristic"];
    const reactionIntensity = getHitReactionIntensity(
      self.aiProfile ?? "v2-heuristic",
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
    const finalized = finalizeAdvancedAim(command);
    return { ...finalized, weaponId };
  }

  private chooseWeapon(
    self: Player,
    target: Player,
    terrain: TerrainManager,
    gameState: GameState,
  ): WeaponId {
    const has = (id: WeaponId) => (self.inventory[id] ?? 0) > 0;
    let terrainVariance = 0;
    const steps = 6;
    const stepX = (target.tank.position.x - self.tank.position.x) / steps;
    let previousHeight = terrain.getHeightAt(self.tank.position.x);
    for (let step = 1; step <= steps; step += 1) {
      const height = terrain.getHeightAt(self.tank.position.x + stepX * step);
      terrainVariance = Math.max(
        terrainVariance,
        Math.abs(height - previousHeight),
      );
      previousHeight = height;
    }
    if (terrainVariance > 28 && has("GRENADE")) return "GRENADE";

    const nearby = gameState.players.filter(
      (player) =>
        player.id !== self.id &&
        !player.tank.isDead &&
        Math.abs(player.tank.position.x - target.tank.position.x) < 70,
    ).length;
    if (nearby >= 2 && has("CLUSTER")) return "CLUSTER";

    const targetHealthTotal = target.tank.health + target.tank.shield;
    if (
      Math.abs(target.tank.position.x - self.tank.position.x) > 380 &&
      has("NUKE") &&
      targetHealthTotal >= 40 &&
      secureRandom() < 0.2
    ) {
      return "NUKE";
    }

    if (shouldPickBulldozer(self, target, terrain)) return "BULLDOZER";
    return "MISSILE";
  }

  getResolutionFallback(): { angle: number; power: number } | null {
    return {
      angle: Math.round(30 + secureRandom() * 120),
      power: Math.round(48 + secureRandom() * 28),
    };
  }
}
