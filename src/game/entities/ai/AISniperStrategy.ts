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
import { chooseSniperPhysicalShot, type SniperPhysicalChoice } from "./sniperPhysicalSelection";
import { maybeGaffe, signedImpactOffset } from "./fallibleAim";
import { consumeHitReaction, getHitReactionIntensity } from "./hitReaction";

type SniperMemory = AimMemory;
type TargetRule = "mémoire" | "ia la plus faible" | "humain le plus faible";

const FALLBACK_SHOT = { angle: 45, power: 50, weaponId: "MISSILE" as const };

function logSniperDecision(build: () => object): void {
  if (!import.meta.env.DEV) return;
  console.info("[AI SNIPER] Décision", JSON.stringify(build()));
}

function sniperDecisionPayload(
  self: Player,
  target: Player,
  targetRule: TargetRule,
  gameState: GameState,
  terrain: TerrainManager,
  attempts: number,
  offsetDirection: number,
  offset: number,
  choice: SniperPhysicalChoice,
  reactionIntensity: number,
  gaffeOccurred: boolean,
  finalCommand: { angle: number; power: number },
): object {
  return {
    choice: {
      weaponId: choice.weaponId,
      reason: choice.reason,
      certified: choice.certified,
      kind: choice.point.kind,
      variant: choice.variant,
      point: { x: choice.point.x, y: choice.point.y },
      aimedPoint: { x: choice.point.x + offset, y: choice.point.y },
      rawCommand: choice.rawCommand,
      predictedCommand: choice.command,
      reactionIntensity,
      gaffeOccurred,
      finalCommand,
    },
    selectionReason: choice.trace.selectionReason,
    runnerUp: choice.trace.runnerUp,
    shooterId: self.id,
    targetId: target.id,
    targetRule,
    round: gameState.roundNumber,
    turn: gameState.turn,
    windForce: gameState.windForce,
    gravity: gameState.gravity,
    attempts,
    offsetDirection,
    offset,
    material: terrain.getMaterialAt(target.tank.position.x),
    bulletStock: self.inventory.BULLET ?? 0,
    drillerStock: self.inventory.DRILLER ?? 0,
    admissible: choice.trace.admissible,
    refusals: choice.trace.refusals,
    searches: choice.trace.searches,
    forecasts: choice.trace.forecasts,
    cacheHits: choice.trace.cacheHits,
  };
}

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
      logSniperDecision(() => ({
        choice: { weaponId: "MISSILE", certified: false, finalCommand: { angle: 45, power: 50 } },
        finalReason: "tireur absent ou mort",
        shooterId: self?.id,
        round: gameState.roundNumber,
        turn: gameState.turn,
      }));
      return FALLBACK_SHOT;
    }

    const memory = this.getMem(self.id);
    resetAimMemoryForRound(memory, gameState.roundNumber);

    const enemies = gameState.players.filter(
      (player) => player.id !== self.id && !player.tank.isDead,
    );
    if (enemies.length === 0) {
      logSniperDecision(() => ({
        choice: { weaponId: "MISSILE", certified: false, finalCommand: { angle: 45, power: 50 } },
        finalReason: "aucun adversaire vivant",
        shooterId: self.id,
        round: gameState.roundNumber,
        turn: gameState.turn,
        windForce: gameState.windForce,
        gravity: gameState.gravity,
      }));
      return FALLBACK_SHOT;
    }

    const remembered = memory.currentTargetId
      ? enemies.find((enemy) => enemy.id === memory.currentTargetId)
      : undefined;
    let targetRule: TargetRule;
    let target: Player;
    if (remembered) {
      target = remembered;
      targetRule = "mémoire";
    } else {
      const aiEnemies = enemies.filter((enemy) => !enemy.isHuman);
      const candidates = aiEnemies.length > 0 ? aiEnemies : enemies;
      targetRule = aiEnemies.length > 0 ? "ia la plus faible" : "humain le plus faible";
      target = candidates.toSorted((left, right) => {
        const healthDifference = left.tank.health - right.tank.health;
        if (healthDifference !== 0) return healthDifference;
        return Number(left.isHuman) - Number(right.isHuman);
      })[0];
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
    const gaffeOccurred = maybeGaffe(gaffe.chance);
    if (gaffeOccurred) {
      command = applySignedCorruption(
        command,
        gaffe.angleAmplitude,
        gaffe.powerAmplitude,
      );
      perturbed = true;
    }

    consumeHitReaction(self.tank.hitReaction);
    const fired = perturbed ? finalizeAdvancedAim(command) : choice.command;
    logSniperDecision(() => sniperDecisionPayload(
      self, target, targetRule, gameState, terrainManager, attempts, offsetDirection, offset, choice,
      reactionIntensity, gaffeOccurred, fired,
    ));
    return { ...fired, weaponId };
  }

  getResolutionFallback(): { angle: number; power: number } | null {
    return {
      angle: Math.round(45 + secureRandom() * 90),
      power: Math.round(55 + secureRandom() * 20),
    };
  }
}
