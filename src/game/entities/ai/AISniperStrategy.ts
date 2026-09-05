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
import { searchBallisticSolution } from "./BallisticsSimulator";
import { maybeGaffe, signedImpactOffset } from "./fallibleAim";
import { consumeHitReaction, getHitReactionIntensity } from "./hitReaction";
import { adjustWeaponForMaterial } from "./terrainMaterialTactics";

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

  public shopDecision(player: Player): WeaponId[] {
    const purchases: WeaponId[] = [];
    let currentMoney = player.money;
    const bulletCost = 150;
    const alreadyOwned = player.inventory.BULLET ?? 0;

    while (
      currentMoney >= bulletCost &&
      alreadyOwned + purchases.length < 2
    ) {
      purchases.push("BULLET");
      currentMoney -= bulletCost;
    }
    return purchases;
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
    let weaponId = this.chooseSniperWeapon(self, attempts);
    if (attempts > 1) {
      weaponId = adjustWeaponForMaterial(
        weaponId,
        terrainManager.getMaterialAt(target.tank.position.x),
        (id) => (self.inventory[id] ?? 0) > 0,
      );
    }
    self.tank.currentWeapon = weaponId;

    const targetX = target.tank.position.x;
    let offsetDirection =
      targetX > terrainManager.width - targetX ? -1 : 1;
    if (attempts === 2) {
      offsetDirection *= -1;
    }
    const aimX =
      targetX +
      signedImpactOffset(
        attempts,
        "v3-sniper",
        gameState.roundNumber,
        offsetDirection,
      );
    let command = this.computePrecisionShot(
      self,
      aimX,
      target.tank.position.y - 6,
      gameState.windForce,
      gameState.gravity,
      terrainManager,
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
  ): AimCommand {
    const sx = self.tank.position.x;
    const sy = self.tank.position.y;
    const isRight = targetX - sx > 0;
    const aMin = isRight ? 15 : 95;
    const aMax = isRight ? 85 : 165;
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
    return {
      angle: Math.round(45 + secureRandom() * 90),
      power: Math.round(55 + secureRandom() * 20),
    };
  }
}
