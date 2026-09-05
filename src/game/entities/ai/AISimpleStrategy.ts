import { secureRandom } from "../../../utils/random";
import type { GameState } from "../../../types/game";
import type { WeaponId } from "../../../types/weapon";
import type { TerrainManager } from "../../engine/Terrain";
import type { AIEngine } from "./AIEngine";
import {
  finalizeSimpleAim,
  interpolateAimCommands,
  randomIntegerInclusive,
  sampleSimpleGaffe,
} from "./aimCorruption";
import {
  type AimMemory,
  recordAimAttempt,
  resetAimMemoryForRound,
} from "./aimMemory";
import {
  maybeGaffe,
  normalizeAimRound,
  signedImpactOffset,
} from "./fallibleAim";
import { computeHeuristicShot } from "./heuristicShot";
import { consumeHitReaction, getHitReactionIntensity } from "./hitReaction";

type SimpleMemory = AimMemory;

export interface SimpleErrorChances {
  gaffe: number;
  direction: number;
  power: number;
}

const SIMPLE_ERROR_CHANCES: Record<number, SimpleErrorChances> = {
  1: { gaffe: 0.5, direction: 0.4, power: 0.5 },
  2: { gaffe: 0.4, direction: 0.35, power: 0.45 },
  3: { gaffe: 0.3, direction: 0.3, power: 0.4 },
  4: { gaffe: 0.25, direction: 0.25, power: 0.35 },
  5: { gaffe: 0.22, direction: 0.22, power: 0.3 },
  11: { gaffe: 0.2, direction: 0.2, power: 0.25 },
};

export function getSimpleErrorChances(
  roundNumber: number | undefined,
): SimpleErrorChances {
  const round = Math.floor(normalizeAimRound(roundNumber));
  if (round <= 4) return SIMPLE_ERROR_CHANCES[round];
  return round <= 10 ? SIMPLE_ERROR_CHANCES[5] : SIMPLE_ERROR_CHANCES[11];
}

export class AISimpleStrategy implements AIEngine {
  private memories = new Map<string, SimpleMemory>();

  private getMem(playerId: string): SimpleMemory {
    const existing = this.memories.get(playerId);
    if (existing) return existing;

    const memory: SimpleMemory = { currentTargetAttempts: 0 };
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

    let target = memory.currentTargetId
      ? enemies.find((enemy) => enemy.id === memory.currentTargetId)
      : undefined;
    if (!target) {
      const aiEnemies = enemies.filter((enemy) => !enemy.isHuman);
      const candidates = aiEnemies.length > 0 ? aiEnemies : enemies;
      target = candidates.toSorted(
        (left, right) => left.tank.health - right.tank.health,
      )[0];
    }
    if (!target) {
      return { angle: 45, power: 50, weaponId: "MISSILE" };
    }

    const attempts = recordAimAttempt(memory, target.id);
    const weaponId = self.tank.currentWeapon || "MISSILE";
    self.tank.currentWeapon = weaponId;
    const chances = getSimpleErrorChances(gameState.roundNumber);
    const reactionIntensity = getHitReactionIntensity(
      self.aiProfile ?? "v1-random",
      self.tank.hitReaction,
    );

    if (maybeGaffe(chances.gaffe)) {
      consumeHitReaction(self.tank.hitReaction);
      return { ...finalizeSimpleAim(sampleSimpleGaffe()), weaponId };
    }

    const aimX =
      target.tank.position.x +
      signedImpactOffset(attempts, "v1-random", gameState.roundNumber);
    let command = computeHeuristicShot(
      self,
      aimX,
      target.tank.position.y - 6,
      gameState.windForce,
      gameState.gravity,
      terrainManager,
    );

    if (maybeGaffe(chances.direction)) {
      command = { ...command, angle: secureRandom() * 180 };
    }
    if (maybeGaffe(chances.power)) {
      command = { ...command, power: randomIntegerInclusive(1, 99) };
    }
    if (reactionIntensity > 0) {
      command = interpolateAimCommands(
        command,
        sampleSimpleGaffe(),
        reactionIntensity,
      );
    }

    consumeHitReaction(self.tank.hitReaction);
    return { ...finalizeSimpleAim(command), weaponId };
  }

  getResolutionFallback(): { angle: number; power: number } | null {
    return {
      angle: Math.round(40 + secureRandom() * 100),
      power: Math.round(55 + secureRandom() * 30),
    };
  }
}
