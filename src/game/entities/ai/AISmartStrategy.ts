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
import { solveExpertAim } from "./expertAim";
import { chooseExpertPlan, ordinaryExpertTarget, type ExpertDecisionTrace } from "./expertPlanner";
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

    let decisionTrace: ExpertDecisionTrace | undefined;
    const plan = chooseExpertPlan(self, gameState, terrainManager, undefined,
      import.meta.env.DEV ? (trace) => { decisionTrace = trace; } : undefined);
    const target = plan
      ? gameState.players.find((player) => player.id === plan.primaryTargetId)
      : ordinaryExpertTarget(self, gameState.players, memory);
    if (!target) {
      if (import.meta.env.DEV) {
        console.info("[AI EXPERT] Décision", JSON.stringify({
          shooterId: self.id, round: gameState.roundNumber, turn: gameState.turn,
          ...decisionTrace, finalReason: "aucun adversaire vivant",
        }));
      }
      return { angle: 45, power: 50, weaponId: "MISSILE" };
    }

    const weaponId = plan?.weaponId ?? adjustWeaponForMaterial(
      this.chooseTacticalWeapon(self, target, terrainManager, gameState),
      terrainManager.getMaterialAt(target.tank.position.x),
      (id) => (self.inventory[id] ?? 0) > 0,
    );
    const point = plan?.point ?? { x: target.tank.position.x, y: target.tank.position.y - 6 };
    const attempts = recordAimAttempt(memory, target.id);
    self.tank.currentWeapon = weaponId;

    const offset = signedImpactOffset(attempts, "v4-smart", gameState.roundNumber);
    const aimX = point.x + offset;
    const idealAim = solveExpertAim(
      self,
      aimX,
      point.y,
      gameState.windForce,
      gameState.gravity,
      terrainManager,
      weaponId,
    ).command;
    let command = idealAim;

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
    const gaffeOccurred = maybeGaffe(gaffe.chance);
    if (gaffeOccurred) {
      command = applySignedCorruption(
        command,
        gaffe.angleAmplitude,
        gaffe.powerAmplitude,
      );
    }

    const finalAim = finalizeAdvancedAim(command);
    if (import.meta.env.DEV) {
      console.info("[AI EXPERT] Décision", JSON.stringify({
        shooterId: self.id,
        round: gameState.roundNumber,
        turn: gameState.turn,
        currentPlayerIndex: gameState.currentPlayerIndex,
        windForce: gameState.windForce,
        gravity: gameState.gravity,
        isFirstShotOfRound: gameState.localShotContext?.isFirstShotOfRound,
        roster: gameState.players.map((player) => ({
          id: player.id,
          isHuman: player.isHuman,
          profile: player.aiProfile,
          health: player.tank.health,
          shield: player.tank.shield,
          position: { ...player.tank.position },
          isDead: player.tank.isDead,
          inventory: { ...player.inventory },
        })),
        ...decisionTrace,
        realAim: {
          weaponId,
          targetId: target.id,
          tacticalPoint: point,
          attemptsOnTarget: attempts,
          horizontalOffset: offset,
          aimedPoint: { x: aimX, y: point.y },
          solverCommand: idealAim,
          reactionIntensity,
          gaffeOccurred,
          finalCommand: finalAim,
        },
      }));
    }
    consumeHitReaction(self.tank.hitReaction);
    return { ...finalAim, weaponId };
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

  getResolutionFallback(): { angle: number; power: number } | null {
    return {
      angle: Math.round(45 + secureRandom() * 90),
      power: Math.round(60 + secureRandom() * 20),
    };
  }
}
