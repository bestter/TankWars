/**
 * TankWars - Core Game Engine (src/game/engine/GameEngine.ts)
 *
 * This class owns the high-frequency game loop (requestAnimationFrame),
 * all physics simulation, and live mutable state (projectiles, terrain mutations).
 *
 * ARCHITECTURE RULES (strictly followed):
 * - Completely decoupled from React. No React hooks, no state setters inside.
 * - Communication with React layer happens exclusively via callbacks
 *   (onProjectileHit, onAllProjectilesSettled, etc.).
 * - Canvas is only ever touched via the `render(ctx)` method called from outside.
 * - AI decisions are injected via the AIStrategy interface (see src/game/entities/ai/).
 */

import { TerrainManager } from './Terrain';
import {
  WEAPON_REGISTRY,
  type WeaponId,
} from '../../types/weapon';
import type { Vector2, FireCommand } from '../../types/game';
import type { AIStrategy } from '../entities/ai/AIStrategy';

export interface GameConfig {
  /** Vertical acceleration (pixels per second²). Higher = stronger gravity. */
  gravity: number;
  /** Horizontal wind acceleration (can be negative). */
  windForce: number;
  /** Base velocity multiplier for power (0-100). Tunable feel. */
  baseShotSpeed: number;
}

export interface ActiveProjectile {
  position: Vector2;
  velocity: Vector2;
  radius: number;
  weaponId: WeaponId;
  ownerId: string;
}

export interface TankRef {
  id: string;
  position: Vector2;
  radius: number; // collision radius
}

interface HitEvent {
  x: number;
  y: number;
  weaponId: WeaponId;
  ownerId: string;
  blastRadius: number;
}

export class GameEngine {
  public readonly width: number;
  public readonly height: number;

  private readonly terrain: TerrainManager;
  private readonly config: GameConfig;

  private projectiles: ActiveProjectile[] = [];
  private tanks: TankRef[] = [];

  private windForce: number;

  private rafId: number | null = null;
  private lastTimestamp = 0;
  private accumulator = 0;
  private readonly PHYSICS_DT = 1 / 120; // Fixed 120Hz physics for stability

  private isRunning = false;

  // === Callbacks for React layer decoupling ===
  public onProjectileHit?: (event: HitEvent) => void;
  public onAllProjectilesSettled?: () => void;
  public onPhysicsStep?: (projectiles: ReadonlyArray<ActiveProjectile>) => void;

  constructor(
    width: number,
    height: number,
    config: Partial<GameConfig> = {},
  ) {
    this.width = Math.floor(width);
    this.height = Math.floor(height);

    this.terrain = new TerrainManager(this.width, this.height);
    this.terrain.generate();

    this.config = {
      gravity: 220,
      windForce: 0,
      baseShotSpeed: 380,
      ...config,
    };

    this.windForce = this.config.windForce;
  }

  // === Public API ===

  public getTerrain(): TerrainManager {
    return this.terrain;
  }

  public getActiveProjectiles(): ReadonlyArray<ActiveProjectile> {
    return this.projectiles;
  }

  public setWindForce(force: number): void {
    this.windForce = force;
  }

  public setTanks(tanks: TankRef[]): void {
    this.tanks = tanks.map((t) => ({
      id: t.id,
      position: { ...t.position },
      radius: t.radius ?? 12,
    }));
  }

  /**
   * Fire a projectile. Called by human input or by AI strategy.
   * Angle in degrees (0 = right, positive = CCW / upward).
   */
  public fireProjectile(
    from: Vector2,
    command: FireCommand,
    ownerId: string,
  ): void {
    const weapon = WEAPON_REGISTRY[command.weaponId];
    if (!weapon) {
      console.warn(`Unknown weapon: ${command.weaponId}`);
      return;
    }

    const angleRad = (command.angle * Math.PI) / 180;
    const speed = (command.power / 100) * this.config.baseShotSpeed;

    const vx = Math.cos(angleRad) * speed;
    // Negative because canvas Y grows downward
    const vy = -Math.sin(angleRad) * speed;

    this.projectiles.push({
      position: { x: from.x, y: from.y },
      velocity: { x: vx, y: vy },
      radius: 2.5,
      weaponId: command.weaponId,
      ownerId,
    });
  }

  /**
   * Optional: Ask an AI strategy to decide and immediately fire.
   * This keeps AI completely outside the engine core.
   */
  public requestAIShot(
    aiStrategy: AIStrategy,
    self: import('../../types/player').Player,
    worldView: import('../entities/ai/AIStrategy').AIWorldView,
  ): boolean {
    const decision = aiStrategy.decideShot(self, worldView);
    if (!decision) return false;

    this.fireProjectile(self.tank.position, decision, self.id);
    return true;
  }

  // === Game Loop ===

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastTimestamp = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.loop);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private readonly loop = (timestamp: number): void => {
    if (!this.isRunning) return;

    const frameTime = Math.min((timestamp - this.lastTimestamp) / 1000, 0.1);
    this.lastTimestamp = timestamp;

    this.accumulator += frameTime;

    // Fixed timestep physics
    while (this.accumulator >= this.PHYSICS_DT) {
      this.update(this.PHYSICS_DT);
      this.accumulator -= this.PHYSICS_DT;
    }

    // Rendering is driven by the owner (GameCanvas calls render)
    // We still notify for possible interpolation/debug
    this.onPhysicsStep?.(this.projectiles);

    this.rafId = requestAnimationFrame(this.loop);
  };

  private update(dt: number): void {
    const gravity = this.config.gravity;
    const wind = this.windForce;

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];

      // Apply accelerations (wind horizontal, gravity vertical)
      p.velocity.x += wind * dt;
      p.velocity.y += gravity * dt;

      // Integrate position
      p.position.x += p.velocity.x * dt;
      p.position.y += p.velocity.y * dt;

      // === Terrain Collision ===
      const terrainY = this.terrain.getHeightAt(p.position.x);

      if (p.position.y >= terrainY - 1) {
        this.handleProjectileHit(i, p);
        continue;
      }

      // === Tank Collision (simple circle vs point for v1) ===
      for (const tank of this.tanks) {
        const dx = p.position.x - tank.position.x;
        const dy = p.position.y - tank.position.y;
        const distSq = dx * dx + dy * dy;
        const hitRadius = tank.radius + p.radius + 1;

        if (distSq <= hitRadius * hitRadius) {
          this.handleProjectileHit(i, p);
          break;
        }
      }

      // Optional: world bounds cleanup
      if (
        p.position.x < -50 ||
        p.position.x > this.width + 50 ||
        p.position.y > this.height + 200
      ) {
        this.projectiles.splice(i, 1);
      }
    }

    // Notify when last projectile has settled
    if (this.projectiles.length === 0) {
      // Only fire the callback once per volley
      // (caller is responsible for clearing flag if needed)
    }
  }

  private handleProjectileHit(
    index: number,
    p: ActiveProjectile,
    // hitTankId is reserved for future damage/score logic
  ): void {
    const weapon = WEAPON_REGISTRY[p.weaponId];
    const blastRadius = weapon?.blastRadius ?? 25;

    // Mutate terrain (core destructible feature)
    this.terrain.destroyTerrain(p.position.x, p.position.y, blastRadius);

    const hitEvent: HitEvent = {
      x: p.position.x,
      y: p.position.y,
      weaponId: p.weaponId,
      ownerId: p.ownerId,
      blastRadius,
    };

    this.onProjectileHit?.(hitEvent);

    // Remove the projectile
    this.projectiles.splice(index, 1);

    if (this.projectiles.length === 0) {
      this.onAllProjectilesSettled?.();
    }
  }

  // === Rendering (called by GameCanvas every frame) ===

  public render(ctx: CanvasRenderingContext2D): void {
    // Sky
    ctx.fillStyle = '#0000AA';
    ctx.fillRect(0, 0, this.width, this.height);

    // Terrain (délégué au TerrainManager qui utilise la palette VGA)
    this.terrain.draw(ctx);

    // Projectiles
    for (const p of this.projectiles) {
      const weapon = WEAPON_REGISTRY[p.weaponId];
      ctx.fillStyle = weapon?.color ?? '#FFFFFF';

      ctx.beginPath();
      ctx.arc(p.position.x, p.position.y, p.radius + 1, 0, Math.PI * 2);
      ctx.fill();

      // Small tracer / motion hint
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(p.position.x - 1, p.position.y - 1, 2, 2);
    }

    // Tanks (simple colored rectangles for now)
    for (const tank of this.tanks) {
      ctx.fillStyle = '#FF5555'; // TODO: use real tank color later
      ctx.fillRect(
        tank.position.x - tank.radius,
        tank.position.y - tank.radius * 0.6,
        tank.radius * 2,
        tank.radius * 1.1,
      );
    }
  }

  // Utility
  public clearProjectiles(): void {
    this.projectiles = [];
  }
}
