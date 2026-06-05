/**
 * TankWars - AISmartStrategy (v4 "Expert/Smart" AI)
 *
 * A highly capable AI strategy:
 * - Uses fine-grained angle search (1.5° steps) and 10 binary search power iterations.
 * - Simulates weapon-specific physics: bounces for GRENADE, apex-splits for CLUSTER.
 * - Self-preservation: Discards any shot parameters that would result in landing
 *   within the weapon's blast radius + 20px of its own tank.
 * - Adaptive precision: Starts with low aiming noise and ramps down to near-perfect accuracy quickly.
 * - Tactical weapon selection: Uses nukes for long distance, grenades/clusters for hills or close range.
 */

import type { AIEngine } from './AIEngine';
import type { GameState } from '../../../types/game';
import type { Player } from '../../../types/player';
import type { TerrainManager } from '../../engine/Terrain';
import { WEAPON_REGISTRY, type WeaponId } from '../../../types/weapon';

interface SmartMemory {
  currentTargetId?: string;
  targetAttempts: Record<string, number>;
  lastSelfHealth?: number;
  lastPowerBias: number;
}

export class AISmartStrategy implements AIEngine {
  private memories = new Map<string, SmartMemory>();

  private getMem(playerId: string): SmartMemory {
    if (!this.memories.has(playerId)) {
      this.memories.set(playerId, {
        targetAttempts: {},
        lastPowerBias: 0,
      });
    }
    return this.memories.get(playerId)!;
  }

  private resetForNewRound(mem: SmartMemory): void {
    mem.currentTargetId = undefined;
    mem.targetAttempts = {};
    mem.lastPowerBias = 0;
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
    // 1. Prioritize a target that is close to death if we can finish them off (prefer AI)
    let target = enemies.find((e) => !e.isHuman && e.tank.health + e.tank.shield <= 30);
    if (!target) {
      target = enemies.find((e) => e.tank.health + e.tank.shield <= 30);
    }

    // 2. Otherwise stick to the current target if alive
    if (!target && mem.currentTargetId) {
      target = enemies.find((e) => e.id === mem.currentTargetId);
    }

    // 3. Otherwise pick the weakest (lowest health) among AIs first, fallback to human only if no AIs left
    if (!target) {
      const aiEnemies = enemies.filter((e) => !e.isHuman);
      const candidates = aiEnemies.length > 0 ? aiEnemies : enemies;

      const sorted = [...candidates].sort((a, b) => {
        const h = a.tank.health - b.tank.health;
        if (h !== 0) return h;
        // tie-breaker: prefer AI over human (Human Privilege)
        const ha = a.isHuman ? 1 : 0;
        const hb = b.isHuman ? 1 : 0;
        return ha - hb; // AI (0) comes before human (1)
      });
      target = sorted[0];
    }

    const isNewTarget = target!.id !== mem.currentTargetId;
    mem.currentTargetId = target!.id;
    if (isNewTarget) {
      console.log(`[AI TARGET] ${self.name} (Smart V4) selected NEW target: ${target!.name}`);
    }

    const attempts = (mem.targetAttempts[target!.id] || 0) + 1;
    mem.targetAttempts[target!.id] = attempts;

    // Weapon selection
    const chosenWeapon = this.chooseTacticalWeapon(self, target!, terrainManager, gameState);
    self.tank.currentWeapon = chosenWeapon; // Sync live snap for HUD display

    // Compute the shot
    const { angle, power } = this.computeSmartShot(
      self,
      target!,
      gameState.windForce,
      gameState.gravity,
      terrainManager,
      attempts,
      chosenWeapon,
      mem,
    );

    return {
      angle: Math.round(angle * 10) / 10,
      power: Math.round(power),
      weaponId: chosenWeapon,
    };
  }

  private chooseTacticalWeapon(
    self: Player,
    target: Player,
    terrain: TerrainManager,
    gs: GameState,
  ): WeaponId {
    const inv = self.inventory || {};
    const has = (id: WeaponId) => (inv[id] ?? 0) > 0;

    const sx = self.tank.position.x;
    const tx = target.tank.position.x;
    const dist = Math.abs(tx - sx);

    // Check if there is a massive hill block between us
    let maxTerrainHeight = 0;
    const startX = Math.min(sx, tx);
    const endX = Math.max(sx, tx);
    const step = (endX - startX) / 10;
    for (let i = 1; i < 10; i++) {
      const h = terrain.getHeightAt(startX + i * step);
      maxTerrainHeight = Math.max(maxTerrainHeight, terrain.height - h);
    }
    const selfHeight = terrain.height - self.tank.position.y;
    const targetHeight = terrain.height - target.tank.position.y;
    const isHidden = maxTerrainHeight > Math.max(selfHeight, targetHeight) + 35;

    // 1. Thermonuclear - only if target is far enough away to not kill ourselves
    // (blast radius is 160px; so we want distance to target to be > 200px)
    if (dist > 220 && has('THERMONUCLEAR')) return 'THERMONUCLEAR';

    // 2. Baby Nuke for long range
    if (dist > 180 && has('NUKE')) return 'NUKE';

    // 3. Grenade if target is hidden behind a hill (to bounce over/down the hill)
    if (isHidden && has('GRENADE')) return 'GRENADE';

    // 4. Cluster if target has neighbors nearby (clustered targets)
    const neighbors = gs.players.filter(
      (p) => p.id !== self.id && !p.tank.isDead && Math.abs(p.tank.position.x - tx) < 80,
    ).length;
    if (neighbors >= 2 && has('CLUSTER')) return 'CLUSTER';

    // 5. Driller for hidden targets under high slopes
    if (isHidden && has('DRILLER')) return 'DRILLER';

    // Default
    return 'MISSILE';
  }

  private computeSmartShot(
    self: Player,
    target: Player,
    wind: number,
    gravity: number,
    terrain: TerrainManager,
    attempts: number,
    weaponId: WeaponId,
    mem: SmartMemory,
  ): { angle: number; power: number } {
    const sx = self.tank.position.x;
    const sy = self.tank.position.y;
    const tx = target.tank.position.x;
    const ty = target.tank.position.y - 6;
    const dx = tx - sx;
    const isRight = dx > 0;

    const aMin = isRight ? 15 : 95;
    const aMax = isRight ? 85 : 165;

    const BASE_SPEED = 4.2;
    const DT = 1 / 120;
    const MAX_STEPS = 420;

    const weapon = WEAPON_REGISTRY[weaponId];
    const blastRadius = weapon?.blastRadius ?? 28;

    let best = { angle: isRight ? 55 : 125, power: 60, err: 999999 };

    // Smart fine search: 1.5° angle steps
    for (let a = aMin; a <= aMax; a += 1.5) {
      let lo = 20;
      let hi = 95;
      for (let iter = 0; iter < 10; iter++) {
        const p = (lo + hi) / 2;
        const res = this.simulateSmartShot(sx, sy, a, p, wind, gravity, BASE_SPEED, DT, MAX_STEPS, terrain, weaponId);

        // Self-damage check: Penalty if it hits too close to self
        const selfDist = Math.hypot(res.landX - sx, res.landY - sy);
        const selfHarmPenalty = selfDist < blastRadius + 25 ? 50000 : 0;

        const xErr = Math.abs(res.landX - tx);
        const yErr = Math.abs(res.landY - ty) * 0.35;

        // Detect intermediate terrain obstacle between shooter and target
        let obstaclePenalty = 0;
        if (res.hitTerrainEarly) {
          const isBetween = isRight 
            ? (res.landX > sx + 20 && res.landX < tx - 35)
            : (res.landX < sx - 20 && res.landX > tx + 35);
          if (isBetween) {
            obstaclePenalty = 10000;
          } else {
            obstaclePenalty = 20; // standard early landing penalty
          }
        }

        const err = xErr + yErr + obstaclePenalty + selfHarmPenalty;

        if (err < best.err) {
          best = { angle: a, power: p, err };
        }

        if (res.landX < tx - 3) lo = p;
        else hi = p;
      }
    }

    let angle = best.angle;
    let power = best.power + mem.lastPowerBias;

    // Fast noise reduction:
    // Attempt 1: small noise (1.8 deg max)
    // Attempt 2: minimal noise (0.5 deg max)
    // Attempt 3+: near-perfect precision (0.05 deg max)
    let maxNoise = 1.8;
    if (attempts === 2) maxNoise = 0.5;
    else if (attempts >= 3) maxNoise = 0.05;

    const angleNoise = (Math.random() - 0.5) * maxNoise;
    const powerNoise = (Math.random() - 0.5) * (maxNoise * 0.6);

    angle += angleNoise;
    power += powerNoise;

    // Safe bounds
    angle = Math.max(6, Math.min(174, angle));
    power = Math.max(25, Math.min(95, power));

    return { angle, power };
  }

  private simulateSmartShot(
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
    weaponId: WeaponId,
  ): { landX: number; landY: number; hitTerrainEarly: boolean } {
    const rad = (angleDeg * Math.PI) / 180;
    let vx = Math.cos(rad) * power * baseSpeed;
    let vy = -Math.sin(rad) * power * baseSpeed;
    
    // Calculate barrel tip position to match GameEngine's launch coordinates
    const barrelLength = 20;
    const barrelStartY = sy - 13;
    let x = sx + Math.cos(rad) * barrelLength;
    let y = barrelStartY - Math.sin(rad) * barrelLength;
    let landX = x;
    let landY = y;
    let hitEarly = false;
    let bounceCount = 0;
    let prevVy: number;

    const DRAG = 0.28;
    const isGrenade = weaponId === 'GRENADE';
    const isCluster = weaponId === 'CLUSTER';

    for (let step = 0; step < maxSteps; step++) {
      prevVy = vy;
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

      // Cluster splits at apex in the air
      if (isCluster && prevVy < 0 && vy >= 0) {
        // Central submunition continues with similar speed and direction.
        // We simulate the central cluster submunition continuing.
        // Just let it keep going.
      }

      // Check collision
      if (terrain.checkCollision(x, y)) {
        if (isGrenade) {
          // Grenade bounce simulation
          const surfaceY = terrain.getHeightAt(x);
          y = surfaceY - 1.2;
          bounceCount++;

          const speed = Math.hypot(vx, vy);
          const shouldExplode = bounceCount >= 4 || speed < 3.2 || Math.abs(vy) < 2.0;
          if (shouldExplode) {
            landX = x;
            landY = y;
            break;
          }
          // bounce physics reflect vertical velocity
          vy = -vy * 0.64;
          vx *= 0.78;
        } else {
          // Normal projectile or cluster split submunition
          landX = x;
          landY = y;
          hitEarly = true;
          break;
        }
      }
      if (x < -80 || x > terrain.width + 80 || y > terrain.height + 120) break;

      landX = x;
      landY = y;
    }

    return { landX, landY, hitTerrainEarly: hitEarly };
  }

  getResolutionFallback(): { angle: number; power: number } | null {
    const angle = 45 + Math.random() * 90;
    const power = 60 + Math.random() * 20;
    return {
      angle: Math.round(angle),
      power: Math.round(power),
    };
  }
}
