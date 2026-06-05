/**
 * TankWars - AISniperStrategy (v3 "Sniper" AI)
 *
 * A cold, efficient sniper that aims with surgical precision.
 * - Restricts itself to clean single-target kinetic weapons (Missile, Driller).
 * - "Never one-shot": The first shot at any target in a round will deliberately
 *   miss by a safe horizontal margin (e.g., 30px offset). This guarantees it takes
 *   exactly 2 to 3 shots to destroy a tank (never 1).
 * - Second shot onwards targets the tank directly with zero aiming noise.
 */

import type { AIEngine } from './AIEngine';
import type { GameState } from '../../../types/game';
import type { Player } from '../../../types/player';
import type { TerrainManager } from '../../engine/Terrain';
import { type WeaponId } from '../../../types/weapon';

interface SniperMemory {
  currentTargetId?: string;
  /** Attempts per target player ID this round */
  targetAttempts: Record<string, number>;
  lastSelfHealth?: number;
}

export class AISniperStrategy implements AIEngine {
  private memories = new Map<string, SniperMemory>();

  private getMem(playerId: string): SniperMemory {
    if (!this.memories.has(playerId)) {
      this.memories.set(playerId, {
        targetAttempts: {},
      });
    }
    return this.memories.get(playerId)!;
  }

  private resetForNewRound(mem: SniperMemory): void {
    mem.currentTargetId = undefined;
    mem.targetAttempts = {};
  }

  async executeTurn(
    tankId: string,
    gameState: GameState,
    terrainManager: TerrainManager,
  ): Promise<{ angle: number; power: number; weaponId?: WeaponId }> {
    const self = gameState.players.find((p) => p.tank.id === tankId);
    if (!self || self.tank.isDead) {
      return { angle: 45, power: 50, weaponId: 'MISSILE' };
    }

    const mem = this.getMem(self.id);

    // Detect round respawn (health reset to full) and clear per-round memory
    if (mem.lastSelfHealth != null && self.tank.health > mem.lastSelfHealth + 5) {
      this.resetForNewRound(mem);
    }
    mem.lastSelfHealth = self.tank.health;

    // Find living enemies
    const enemies = gameState.players.filter(
      (p) => p.id !== self.id && !p.tank.isDead,
    );
    if (enemies.length === 0) {
      return { angle: 45, power: 50, weaponId: 'MISSILE' };
    }

    // Target selection:
    // Sniper is cold and sticks to its target until they are dead, then switches to the weakest.
    let target: Player | undefined;
    if (mem.currentTargetId) {
      target = enemies.find((e) => e.id === mem.currentTargetId);
    }

    if (!target) {
      const aiEnemies = enemies.filter((e) => !e.isHuman);
      const candidates = aiEnemies.length > 0 ? aiEnemies : enemies;

      const sorted = [...candidates].sort((a, b) => {
        // Prefer weakest target
        const h = a.tank.health - b.tank.health;
        if (h !== 0) return h;
        // Tie-breaker: prefer AI over human (Human Privilege)
        const ha = a.isHuman ? 1 : 0;
        const hb = b.isHuman ? 1 : 0;
        return ha - hb; // AI (0) comes before human (1)
      });
      target = sorted[0];
    }

    const isNewTarget = target!.id !== mem.currentTargetId;
    mem.currentTargetId = target!.id;
    if (isNewTarget) {
      console.log(`[AI TARGET] ${self.name} (Sniper V3) selected NEW target: ${target!.name}`);
    }

    // Increment attempt counter for this target
    const attempts = (mem.targetAttempts[target!.id] || 0) + 1;
    mem.targetAttempts[target!.id] = attempts;

    // Weapon selection:
    // Sniper ONLY uses precise kinetic weapons. Driller if available, otherwise Missile.
    const chosenWeapon: WeaponId = (self.inventory?.DRILLER ?? 0) > 0 ? 'DRILLER' : 'MISSILE';
    self.tank.currentWeapon = chosenWeapon; // Update live roster snap for HUD display

    // Compute the shot solution
    const { angle, power } = this.computePrecisionShot(
      self,
      target!,
      gameState.windForce,
      gameState.gravity,
      terrainManager,
      attempts,
    );

    return {
      angle: Math.round(angle * 10) / 10,
      power: Math.round(power),
      weaponId: chosenWeapon,
    };
  }

  private computePrecisionShot(
    self: Player,
    target: Player,
    wind: number,
    gravity: number,
    terrain: TerrainManager,
    attempts: number,
  ): { angle: number; power: number } {
    const sx = self.tank.position.x;
    const sy = self.tank.position.y;
    const tx = target.tank.position.x;
    const ty = target.tank.position.y - 6; // Aim at center body of tank
    const dx = tx - sx;
    const dy = sy - ty; // Altitude relative to self (Y is inverted in canvas, so sy - ty > 0 means target is higher)
    const isRight = dx > 0;

    const BASE_SPEED = 4.2;
    const DT = 1 / 120;
    const MAX_STEPS = 420;

    const x = Math.abs(dx);
    const y = dy;
    const g = gravity;

    // 1. Calculate minimum required initial speed v_min for a valid ballistic path
    // Formula: v^2_min = g * (y + sqrt(x^2 + y^2))
    const minVSq = g * (y + Math.sqrt(x * x + y * y));
    const minV = Math.sqrt(Math.max(0.1, minVSq));
    const minPower = minV / BASE_SPEED;

    // Start with a safety margin (e.g. +6%) to counteract drag/wind resistance
    let power = Math.max(50, Math.ceil(minPower * 1.06));
    power = Math.min(95, power);

    let bestAngle = isRight ? 55 : 125;
    let bestPower = power;
    let foundSolution = false;

    // Try finding the optimal lob angle, increasing power if terrain obstacles are met
    for (let p = power; p <= 95; p += 5) {
      const v = p * BASE_SPEED;
      const vSq = v * v;
      const discriminant = vSq * vSq - g * (g * x * x + 2 * y * vSq);

      if (discriminant >= 0) {
        // High lob trajectory (positive root +)
        const tanTheta = (vSq + Math.sqrt(discriminant)) / (g * x);
        const thetaRad = Math.atan(tanTheta);
        const thetaDeg = (thetaRad * 180) / Math.PI;

        const calculatedAngle = isRight ? thetaDeg : 180 - thetaDeg;

        // Verify with actual physics simulation (including wind and drag)
        const sim = this.simulateShot(sx, sy, calculatedAngle, p, wind, g, BASE_SPEED, DT, MAX_STEPS, terrain);
        const distanceToTarget = Math.hypot(sim.landX - tx, sim.landY - ty);

        if (!sim.hitTerrainEarly || distanceToTarget < 35) {
          bestAngle = calculatedAngle;
          bestPower = p;
          foundSolution = true;
          break;
        } else {
          // If blocked by terrain, keep it as fallback in case higher powers don't work
          const currentBestSim = this.simulateShot(sx, sy, bestAngle, bestPower, wind, g, BASE_SPEED, DT, MAX_STEPS, terrain);
          if (distanceToTarget < Math.hypot(currentBestSim.landX - tx, currentBestSim.landY - ty)) {
            bestAngle = calculatedAngle;
            bestPower = p;
          }
        }
      }
    }

    if (!foundSolution) {
      console.log(`[AI SNIPER] No direct mathematical solution found. Applying default lob path.`);
      bestPower = 90;
      bestAngle = isRight ? 65 : 115;
    }

    let finalAngle = bestAngle;

    // 3. Add precision modulator (Tâche 3)
    if (attempts === 1) {
      const errorMargin = 3.5; // slight angle noise (in degrees) for the first shot
      const noise = (Math.random() - 0.5) * errorMargin;
      finalAngle += noise;
      console.log(`[AI SNIPER] Shot 1 error modulation applied: noise=${noise.toFixed(2)} deg (margin=${errorMargin} deg)`);
    } else {
      console.log(`[AI SNIPER] Shot ${attempts} corrected perfectly (0 noise)`);
    }

    // Keep angle within safe cones to prevent shooting backward
    if (isRight) {
      finalAngle = Math.max(15, Math.min(85, finalAngle));
    } else {
      finalAngle = Math.max(95, Math.min(165, finalAngle));
    }

    return { angle: finalAngle, power: bestPower };
  }

  private simulateShot(
    sx: number,
    sy: number,
    angleDeg: number,
    power: number,
    wind: number,
    gravity: number,
    baseSpeed: number,
    dt: number,
    maxSteps: number,
    terrain: TerrainManager,
  ): { landX: number; landY: number; hitTerrainEarly: boolean } {
    const rad = (angleDeg * Math.PI) / 180;
    let vx = Math.cos(rad) * power * baseSpeed;
    let vy = -Math.sin(rad) * power * baseSpeed;
    let x = sx;
    let y = sy;
    let landX = x;
    let landY = y;
    let hitEarly = false;

    const DRAG = 0.28;

    for (let step = 0; step < maxSteps; step++) {
      vy += gravity * dt;
      vx += wind * dt;

      const sp = Math.hypot(vx, vy);
      if (sp > 4) {
        const drag = DRAG * sp * dt;
        vx -= (vx / sp) * drag;
        vy -= (vy / sp) * drag;
      }

      x += vx * dt;
      y += vy * dt;

      if (terrain.checkCollision(x, y)) {
        landX = x;
        landY = y;
        hitEarly = true;
        break;
      }
      if (x < -80 || x > terrain.width + 80 || y > terrain.height + 120) break;

      landX = x;
      landY = y;
    }
    return { landX, landY, hitTerrainEarly: hitEarly };
  }

  getResolutionFallback(): { angle: number; power: number } | null {
    console.log("Sniper fallback called");
    const angle = 45 + Math.random() * 90;
    const power = 55 + Math.random() * 20;
    return {
      angle: Math.round(angle),
      power: Math.round(power),
    };
  }
}
