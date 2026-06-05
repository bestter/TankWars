/**
 * TankWars - AIHeuristicStrategy (v2 "OK" / heuristic AI)
 *
 * Phase 2 "smarter but not sniper" AI per project guidelines + user spec.
 * - Implements AIEngine (new strategy class, no entanglement in core engine/tank).
 * - Can kill tanks (typically requires several shots; deliberately fallible).
 * - Revenge: if self.lastHitBy (set on damage), switch target to the attacker.
 * - Otherwise stick to last target for the round.
 * - New target selection: prefer weakest (lowest health), with slight human bias.
 * - Per-turn: increases precision (reduces noise) on the current target.
 * - Per-round memory: tracks attempts/success (health drop after my shot)/fails; used for adjustments + logged.
 * - Uses wind + gravity (from GameState) + terrain sampling for LOS/roughness.
 * - Chooses weapons opportunistically (GRENADE for hills, CLUSTER for groups, etc).
 * - Additional behaviors: self-damage avoidance in search, basic terrain arc bias, tunable non-sniper noise.
 *
 * Registered via AIByProfileStrategy (based on player.aiProfile) in GameCanvas.
 * Memory lives in the strategy instance (one per match; fresh on new game).
 */

import type { AIEngine } from "./AIEngine";
import type { GameState } from "../../../types/game";
import type { Player } from "../../../types/player";
import type { TerrainManager } from "../../engine/Terrain";
import { type WeaponId } from "../../../types/weapon";

interface AIMemory {
  currentTargetId?: string;
  /** attempts per target id this round */
  targetAttempts: Record<string, number>;
  /** last known healths (to detect post-shot success) */
  lastKnownHealth: Record<string, number>;
  lastSelfHealth?: number;
  roundSuccesses: number;
  roundFails: number;
  /** small persistent power bias learned from recent misses */
  lastPowerBias: number;
}

export class AIHeuristicStrategy implements AIEngine {
  /** Per-AI-tank memory (keyed by player.id). Survives across the AI's turns in a match. */
  private memories = new Map<string, AIMemory>();

  private getMem(playerId: string): AIMemory {
    if (!this.memories.has(playerId)) {
      this.memories.set(playerId, {
        targetAttempts: {},
        lastKnownHealth: {},
        roundSuccesses: 0,
        roundFails: 0,
        lastPowerBias: 0,
      });
    }
    return this.memories.get(playerId)!;
  }

  private resetForNewRound(mem: AIMemory): void {
    mem.currentTargetId = undefined;
    mem.targetAttempts = {};
    mem.roundSuccesses = 0;
    mem.roundFails = 0;
    mem.lastPowerBias = 0;
    // lastKnownHealth will be refreshed from current state
  }

  async executeTurn(
    tankId: string,
    gameState: GameState,
    terrainManager: TerrainManager,
  ): Promise<{ angle: number; power: number; weaponId?: WeaponId }> {
    const self = gameState.players.find((p) => p.tank.id === tankId);
    if (!self || self.tank.isDead) {
      return { angle: 45, power: 50, weaponId: "MISSILE" };
    }

    const mem = this.getMem(self.id);

    // Detect round respawn (health reset to full) and clear per-round memory
    if (
      mem.lastSelfHealth != null &&
      self.tank.health > mem.lastSelfHealth + 5
    ) {
      this.resetForNewRound(mem);
    }
    mem.lastSelfHealth = self.tank.health;

    const enemies = gameState.players.filter(
      (p) => p.id !== self.id && !p.tank.isDead,
    );
    if (enemies.length === 0) {
      return { angle: 45, power: 50, weaponId: "MISSILE" };
    }

    // === Update memory from previous shot on the PREVIOUS target ===
    if (mem.currentTargetId) {
      const prevTarget = gameState.players.find(
        (p) => p.id === mem.currentTargetId,
      );
      if (prevTarget) {
        const wasAlive = (mem.lastKnownHealth[prevTarget.id] ?? 0) > 0;
        const isDeadNow = prevTarget.tank.isDead || prevTarget.tank.health <= 0;

        if (wasAlive && isDeadNow) {
          // Success! Target was killed (by us or someone else, we successfully resolved this threat)
          mem.roundSuccesses += 1;
          console.log(
            `[AI MEMORY] ${self.name} detects target ${prevTarget.name} has been KILLED.`,
          );
        } else if (!isDeadNow) {
          // Still alive: compare health to check for a hit
          const prevHealth =
            mem.lastKnownHealth[prevTarget.id] ?? prevTarget.tank.health + 20;
          if (prevTarget.tank.health < prevHealth - 0.1) {
            mem.roundSuccesses += 1;
            console.log(
              `[AI MEMORY] ${self.name} detects HIT on ${prevTarget.name} (health: ${prevHealth.toFixed(1)} -> ${prevTarget.tank.health.toFixed(1)}).`,
            );
          } else {
            // Miss!
            mem.roundFails += 1;
            mem.lastPowerBias += (Math.random() - 0.5) * 1.2;
            console.log(
              `[AI MEMORY] ${self.name} detects MISS on ${prevTarget.name}. Adjusting power bias.`,
            );
          }
        }
      }
    }

    // === Target selection per spec ===
    let target: Player | undefined;

    // 1. Revenge: if someone just tried to kill us, prioritize them
    const revengeId = self.tank.lastHitBy;
    if (revengeId) {
      target = enemies.find((e) => e.id === revengeId);
    }

    // 2. Stick to previous target if still alive
    if (!target && mem.currentTargetId) {
      target = enemies.find((e) => e.id === mem.currentTargetId);
    }

    // 3. New target: weakest (lowest health) among AIs first, fallback to human only if no AIs left
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
      console.log(
        `[AI TARGET] ${self.name} (Heuristic V2) selected NEW target: ${target!.name}`,
      );
    }

    // Record current known healths of all alive enemies for next comparison
    mem.lastKnownHealth = {};
    for (const e of enemies) {
      mem.lastKnownHealth[e.id] = e.tank.health;
    }

    const attempts = (mem.targetAttempts[target!.id] || 0) + 1;
    mem.targetAttempts[target!.id] = attempts;

    // === Choose weapon (OK AI opportunism) + compute improved shot ===
    const chosenWeapon = this.chooseWeapon(
      self,
      target!,
      terrainManager,
      gameState,
    );
    // set on live tank so HUD reflects during AI turn (and for fire if no return weapon)
    self.tank.currentWeapon = chosenWeapon; // live ref from gameState snapshot of roster

    const { angle, power } = this.computeImprovedShot(
      self,
      target!,
      gameState.windForce,
      gameState.gravity,
      terrainManager,
      attempts,
      mem,
    );

    return {
      angle: Math.round(angle * 10) / 10,
      power: Math.round(power),
      weaponId: chosenWeapon,
    };
  }

  /**
   * Pick weapon based on situation. Keeps it "OK" not god-mode (saves big guns, uses bounce on rough).
   */
  private chooseWeapon(
    self: Player,
    target: Player,
    terrain: TerrainManager,
    gs: GameState,
  ): WeaponId {
    const inv = self.inventory || {};
    const has = (id: WeaponId) => (inv[id] ?? 0) > 0;

    // Rough/hilly terrain between? -> grenade bounces useful
    let terrainVariance = 0;
    const steps = 6;
    const stepX = (target.tank.position.x - self.tank.position.x) / steps;
    let prev = terrain.getHeightAt(self.tank.position.x);
    for (let i = 1; i <= steps; i++) {
      const h = terrain.getHeightAt(self.tank.position.x + stepX * i);
      terrainVariance = Math.max(terrainVariance, Math.abs(h - prev));
      prev = h;
    }
    if (terrainVariance > 28 && has("GRENADE")) return "GRENADE";

    // Enemies clustered? cluster value
    const nearby = gs.players.filter(
      (p) =>
        p.id !== self.id &&
        !p.tank.isDead &&
        Math.abs(p.tank.position.x - target.tank.position.x) < 70,
    ).length;
    if (nearby >= 1 && has("CLUSTER")) return "CLUSTER";

    if (
      Math.abs(target.tank.position.x - self.tank.position.x) > 380 &&
      has("NUKE")
    )
      return "NUKE";

    // default unlimited
    return "MISSILE";
  }

  /**
   * Core aiming: search angles + power to find "good enough" ballistic solution.
   * Adds decreasing noise (more precise each turn on target) + memory bias.
   * Not a closed-form sniper.
   */
  private computeImprovedShot(
    self: Player,
    target: Player,
    wind: number,
    gravity: number,
    terrain: TerrainManager,
    attempts: number,
    mem: AIMemory,
  ): { angle: number; power: number } {
    const sx = self.tank.position.x;
    const sy = self.tank.position.y;
    const tx = target.tank.position.x;
    const ty = target.tank.position.y - 6; // aim slightly high on tank body
    const dx = tx - sx;
    const isRight = dx > 0;

    // Safe angle cones (higher arcs for safety on varying terrain)
    const aMin = isRight ? 22 : 98;
    const aMax = isRight ? 82 : 158;

    const BASE_SPEED = 4.2;
    const DT = 1 / 120;
    const MAX_STEPS = 420;

    let best = { angle: isRight ? 55 : 125, power: 60, err: 99999 };

    // Coarse angle search + inner power binary search (fast enough, called ~1x per second per AI)
    for (let a = aMin; a <= aMax; a += 3.5) {
      let lo = 26;
      let hi = 90;
      for (let iter = 0; iter < 7; iter++) {
        const p = (lo + hi) / 2;
        const res = this.simulateShot(
          sx,
          sy,
          a,
          p,
          wind,
          gravity,
          BASE_SPEED,
          DT,
          MAX_STEPS,
          terrain,
        );
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
            obstaclePenalty = 30; // standard early landing penalty
          }
        }

        const err = xErr + yErr + obstaclePenalty;
        if (err < best.err) {
          best = { angle: a, power: p, err };
        }
        if (res.landX < tx - 4) lo = p;
        else hi = p;
      }
    }

    let angle = best.angle;
    let power = best.power + (mem.lastPowerBias || 0);

    // "Always more precise": noise shrinks with attempts on this target
    const precision = Math.min(0.88, attempts * 0.13);
    const noise = (1 - precision) * (7.5 + Math.random() * 5.5);

    angle += (Math.random() - 0.5) * noise;
    power += (Math.random() - 0.5) * (noise * 0.65);

    // clamps (never suicidal extremes)
    angle = Math.max(8, Math.min(172, angle));
    power = Math.max(30, Math.min(90, power));

    return { angle, power };
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
    
    // Calculate barrel tip position to match GameEngine's launch coordinates
    const barrelLength = 20;
    const barrelStartY = sy - 13;
    let x = sx + Math.cos(rad) * barrelLength;
    let y = barrelStartY - Math.sin(rad) * barrelLength;
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

  /**
   * Sync bailout. Uses simple safe random (could be enhanced with last target from mem).
   */
  getResolutionFallback(): { angle: number; power: number } | null {
    const angle = 30 + Math.random() * 120;
    const power = 48 + Math.random() * 28;
    return {
      angle: Math.round(angle),
      power: Math.round(power),
    };
  }
}
