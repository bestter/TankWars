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
import { createExpertForecastCache, chooseExpertFallback } from "./expertShotEvaluator";
import { chooseExpertPlan, ordinaryExpertTarget, type ExpertDecisionTrace } from "./expertPlanner";
import { createExpertDecisionAim } from "./expertDecisionAim";
import { maybeGaffe } from "./fallibleAim";
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
    const cache = createExpertForecastCache();
    const aim = createExpertDecisionAim(memory, gameState.roundNumber);
    const plan = chooseExpertPlan(self, gameState, terrainManager, undefined,
      import.meta.env.DEV ? (trace) => { decisionTrace = trace; } : undefined, cache, aim);
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

    const fallback = plan ? undefined : chooseExpertFallback(
      gameState, terrainManager, self, target, adjustWeaponForMaterial(
        this.chooseTacticalWeapon(self, target, terrainManager, gameState),
        terrainManager.getMaterialAt(target.tank.position.x),
        (id) => (self.inventory[id] ?? 0) > 0,
      ), cache, aim.forTarget(target.id),
    );
    const choice = plan ?? fallback;
    if (!choice) {
      console.error("[AI EXPERT] Aucun choix de tir", { shooterId: self.id,
        round: gameState.roundNumber, turn: gameState.turn });
      return { angle: 45, power: 50, weaponId: "MISSILE" };
    }
    const { weaponId, point } = choice;
    const policy = choice.policy;
    const attempts = recordAimAttempt(memory, target.id);
    self.tank.currentWeapon = weaponId;

    let command = choice.rawCommand;

    const gaffe = ADVANCED_GAFFES["v4-smart"];
    const reactionIntensity = getHitReactionIntensity(
      self.aiProfile ?? "v4-smart",
      self.tank.hitReaction,
    );
    let reactionCommand: typeof command | undefined;
    if (reactionIntensity > 0) {
      command = applySignedCorruption(
        command,
        reactionIntensity * gaffe.angleAmplitude,
        reactionIntensity * gaffe.powerAmplitude,
      );
      if (import.meta.env.DEV) reactionCommand = command;
    }
    const gaffeOccurred = maybeGaffe(gaffe.chance);
    if (gaffeOccurred) {
      command = applySignedCorruption(
        command,
        gaffe.angleAmplitude,
        gaffe.powerAmplitude,
      );
    }

    const finalAim = reactionIntensity > 0 || gaffeOccurred
      ? finalizeAdvancedAim(command) : choice.command;
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
          choiceKind: choice.kind,
          targetId: target.id,
          tacticalPoint: point,
          policy,
          materialFallback: fallback && { useful: fallback.useful, profit: fallback.forecast?.profit },
          searches: cache.search.size, physicalForecasts: cache.physics.size, ...cache.diagnostics,
          pointOrigin: "origin" in point ? point.origin : "historical",
          predictedImpactMaterials: decisionTrace?.selected?.predictedImpacts?.map((hit) => ({
            x: hit.x, material: terrainManager.getMaterialAt(hit.x),
          })),
          fallbackImpactMaterials: fallback?.forecast?.hits.map((hit) => ({
            x: hit.x, material: terrainManager.getMaterialAt(hit.x),
          })),
          supportMaterials: gameState.players.map((player) => ({ id: player.id,
            material: terrainManager.getMaterialAt(player.tank.position.x) })),
          attemptsOnTarget: attempts,
          horizontalOffset: choice.offset,
          aimedPoint: choice.requestedPoint,
          predictedCommand: choice.kind === "evaluated" ? choice.command : undefined,
          ordinaryCommand: choice.kind === "ordinary" ? choice.command : undefined,
          ordinarySearchComplete: choice.kind === "ordinary" ? choice.searchComplete : undefined,
          solverCommand: choice.rawCommand,
          reactionIntensity,
          reactionCommand,
          gaffeOccurred,
          gaffeCommand: gaffeOccurred ? command : undefined,
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
