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

    // Target selection
    let target: Player | undefined;
    if (mem.currentTargetId) {
      target = enemies.find((e) => e.id === mem.currentTargetId);
    }

    if (!target) {
      const aiEnemies = enemies.filter((e) => !e.isHuman);
      const candidates = aiEnemies.length > 0 ? aiEnemies : enemies;

      const sorted = [...candidates].sort((a, b) => {
        const h = a.tank.health - b.tank.health;
        if (h !== 0) return h;
        const ha = a.isHuman ? 1 : 0;
        const hb = b.isHuman ? 1 : 0;
        return ha - hb;
      });
      target = sorted[0];
    }

    mem.currentTargetId = target!.id;

    // 👈 Accumulation persistante des essais au sein de la même manche
    const attempts = (mem.targetAttempts[target!.id] || 0) + 1;
    mem.targetAttempts[target!.id] = attempts;

    const chosenWeapon: WeaponId = (self.inventory?.DRILLER ?? 0) > 0 ? 'DRILLER' : 'MISSILE';
    self.tank.currentWeapon = chosenWeapon;

    // Compute the shot solution
    // If it is the first attempt on this target, deliberately miss by a safe horizontal margin.
    let targetX = target!.tank.position.x;
    if (attempts === 1) {
      const spaceToLeft = targetX;
      const spaceToRight = terrainManager.width - targetX;
      const offsetDir = spaceToLeft > spaceToRight ? -1 : 1;
      targetX += offsetDir * 36;
    }

    const { angle, power } = this.computePrecisionShot(
      self,
      targetX,
      target!.tank.position.y - 6,
      gameState.windForce,
      gameState.gravity,
      terrainManager,
    );

    return {
      angle: Math.round(angle * 10) / 10,
      power: Math.round(power),
      weaponId: chosenWeapon,
    };
  }

  private computePrecisionShot(
    self: Player,
    tx: number,
    ty: number,
    wind: number,
    gravity: number,
    terrain: TerrainManager,
  ): { angle: number; power: number } {
    const sx = self.tank.position.x;
    const sy = self.tank.position.y;
    const dx = tx - sx;
    const isRight = dx > 0;

    const aMin = isRight ? 15 : 95;
    const aMax = isRight ? 85 : 165;

    const BASE_SPEED = 4.2;
    const DT = 1 / 120;
    const MAX_STEPS = 420;

    let best = { angle: isRight ? 55 : 125, power: 60, err: 999999 };

    for (let a = aMin; a <= aMax; a += 1.0) {
      let lo = 20;
      let hi = 95;
      for (let iter = 0; iter < 10; iter++) {
        const p = (lo + hi) / 2;
        const res = this.simulateShot(sx, sy, a, p, wind, gravity, BASE_SPEED, DT, MAX_STEPS, terrain);

        const xErr = Math.abs(res.landX - tx);
        const yErr = Math.abs(res.landY - ty) * 0.35;
        const err = xErr + yErr;

        if (err < best.err) {
          best = { angle: a, power: p, err };
        }

        if (res.landX < tx) {
          if (isRight) lo = p;
          else hi = p;
        } else {
          if (isRight) hi = p;
          else lo = p;
        }
      }
    }

    return { angle: best.angle, power: best.power };
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
    const angle = 45 + Math.random() * 90;
    const power = 55 + Math.random() * 20;
    return { angle: Math.round(angle), power: Math.round(power) };
  }
}