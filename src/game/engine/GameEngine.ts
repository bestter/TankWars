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
import { PhysicsEngine, type Projectile } from './PhysicsEngine';
import { TankManager } from '../entities/TankManager';
import {
  WEAPON_REGISTRY,
  type WeaponId,
} from '../../types/weapon';
import type { Player } from '../../types/player';
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
  private readonly physicsEngine: PhysicsEngine;
  private readonly tankManager: TankManager;
  private readonly config: GameConfig;

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
  public onPhysicsStep?: (projectiles: ReadonlyArray<Projectile>) => void;

  constructor(
    width: number,
    height: number,
    config: Partial<GameConfig> = {},
  ) {
    this.width = Math.floor(width);
    this.height = Math.floor(height);

    this.terrain = new TerrainManager(this.width, this.height);
    this.terrain.generate();

    this.physicsEngine = new PhysicsEngine();
    this.tankManager = new TankManager();

    // Forward hit events from PhysicsEngine
    this.physicsEngine.onProjectileHit = (hit) => {
      this.onProjectileHit?.({
        x: hit.x,
        y: hit.y,
        weaponId: hit.weaponId,
        ownerId: 'unknown', // TODO: track owner when launching
        blastRadius: WEAPON_REGISTRY[hit.weaponId]?.blastRadius ?? 28,
      });
    };

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

  public getTankManager(): TankManager {
    return this.tankManager;
  }

  /** Initialise les joueurs et place leurs tanks sur le terrain */
  public setPlayers(players: Player[]): void {
    this.tankManager.spawnTanks(players, this.terrain);

    // Synchronise aussi les tanks pour le système de collision (legacy)
    const tankRefs = players
      .filter((p) => !p.tank.isDead)
      .map((p) => ({
        id: p.tank.id,
        position: { ...p.tank.position },
        radius: 14,
      }));
    this.setTanks(tankRefs);
  }

  public getActiveProjectiles(): ReadonlyArray<Projectile> {
    return this.physicsEngine.getProjectiles();
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
    /* _ownerId: string */ // TODO: track owner for damage attribution later
  ): void {
    const weapon = WEAPON_REGISTRY[command.weaponId];
    if (!weapon) {
      console.warn(`Unknown weapon: ${command.weaponId}`);
      return;
    }

    // Délégation complète au PhysicsEngine (nouveau système)
    this.physicsEngine.launchProjectile(
      from.x,
      from.y,
      command.angle,
      command.power,
      command.weaponId,
    );
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
    this.onPhysicsStep?.(this.physicsEngine.getProjectiles());

    this.rafId = requestAnimationFrame(this.loop);
  };

  private update(dt: number): void {
    const gravity = this.config.gravity;
    const wind = this.windForce;

    // Délégation complète au nouveau PhysicsEngine + TankManager
    this.physicsEngine.updateProjectiles(dt, gravity, wind, this.terrain, this.tankManager);

    // Notification pour le layer React (interpolation, debug, etc.)
    this.onPhysicsStep?.(this.physicsEngine.getProjectiles());

    // Détection de fin de volée
    if (this.physicsEngine.count === 0) {
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

    // Projectiles (délégué au PhysicsEngine)
    this.physicsEngine.draw(ctx);

    // Tanks (avec canon, jauge de vie et couleurs VGA)
    this.tankManager.draw(ctx);

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
    this.physicsEngine.clear();
  }
}
