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
import { TurnManager } from './TurnManager';
import {
  WEAPON_REGISTRY,
  type WeaponId,
} from '../../types/weapon';
import type { Player } from '../../types/player';
import type { Vector2, FireCommand } from '../../types/game';
import type { AIStrategy } from '../entities/ai/AIStrategy';
import type { AIEngine } from '../entities/ai/AIEngine';

export interface GameConfig {
  /** Vertical acceleration (pixels per second²). Higher = stronger gravity. */
  gravity: number;
  /** Horizontal wind acceleration (can be negative). */
  windForce: number;
  /** Base velocity multiplier for power (0-100). Tunable feel. */
  baseShotSpeed: number;
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
  private readonly turnManager: TurnManager;
  private readonly config: GameConfig;

  private windForce: number;

  private rafId: number | null = null;
  private lastTimestamp = 0;
  private accumulator = 0;
  private readonly PHYSICS_DT = 1 / 120; // Fixed 120Hz physics for stability

  private isRunning = false;

  // Game over state
  private gameOver = false;
  private winner: import('../../types/player').Player | null = null;

  // Simple fireworks for winner celebration
  private fireworks: Array<{
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    color: string;
    size: number;
  }> = [];

  // === Callbacks for React layer decoupling ===
  public onProjectileHit?: (event: HitEvent) => void;
  public onAllProjectilesSettled?: () => void;
  public onPhysicsStep?: (projectiles: ReadonlyArray<Projectile>) => void;

  /** Callback pour le HUD React (angle, puissance, joueur actif, etc.) */
  public onTurnHudUpdate?: (info: import('./TurnManager').CurrentTurnInfo) => void;

  /** Called when only one player remains alive */
  public onGameOver?: (winner: import('../../types/player').Player) => void;

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

    // Crée le TurnManager avec un callback de tir
    this.turnManager = new TurnManager(
      this.tankManager,
      this.terrain,
      (from, command) => {
        this.fireProjectile(from, command);
      },
    );

    // Connecte le TurnManager au système de physique (fin de volée → nextTurn)
    this.turnManager.connectToPhysics(this.physicsEngine);

    // Transmet les mises à jour HUD du TurnManager vers l'extérieur (React)
    this.turnManager.onHudUpdate = (info) => {
      this.onTurnHudUpdate?.(info);
    };

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

  public getTurnManager(): TurnManager {
    return this.turnManager;
  }

  /** Permet d'injecter une stratégie d'IA (ex: AISimpleStrategy) */
  public setAIEngine(aiEngine: AIEngine): void {
    this.turnManager.setAIEngine(aiEngine);
  }

  /** Initialise les joueurs et place leurs tanks sur le terrain */
  public setPlayers(players: Player[]): void {
    this.tankManager.spawnTanks(players, this.terrain);

    // Initialise le système de tours
    this.turnManager.startFirstTurn();
    this.turnManager.setupInputListeners();
  }

  public getActiveProjectiles(): ReadonlyArray<Projectile> {
    return this.physicsEngine.getProjectiles();
  }

  public setWindForce(force: number): void {
    this.windForce = force;
  }

  // Legacy setTanks removed - use setPlayers + TankManager instead
  // public setTanks(...) { ... }

  /**
   * Fire a projectile. Called by human input or by AI strategy.
   * Angle in degrees (0 = right, positive = CCW / upward).
   */
  public fireProjectile(
    from: Vector2,
    command: FireCommand,
    _ownerId: string = 'unknown' // TODO: track owner for damage attribution later
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

    // Vérifie si des tanks sont enterrés (règle : si Y_tank > hauteur_planche → battu)
    this.tankManager.checkTankBurial(this.terrain);

    // Mise à jour des feux d'artifice (si partie terminée)
    this.updateFireworks();

    // Notification pour le layer React (interpolation, debug, etc.)
    this.onPhysicsStep?.(this.physicsEngine.getProjectiles());

    // Détection de fin de volée
    if (this.physicsEngine.count === 0) {
      this.onAllProjectilesSettled?.();
    }

    // === Game Over Check ===
    if (!this.gameOver) {
      const winner = this.tankManager.getWinner();
      if (winner) {
        this.gameOver = true;
        this.winner = winner;
        this.startFireworks(winner.tank.position.x, winner.tank.position.y - 30);
        this.onGameOver?.(winner);
      }
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

    // Feux d'artifice si la partie est terminée
    if (this.gameOver) {
      this.drawFireworks(ctx);

      // Petit message de victoire sur le canvas (le gros texte sera géré en HTML)
      if (this.winner) {
        ctx.fillStyle = this.winner.tank.color;
        ctx.font = 'bold 28px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${this.winner.name} WINS!`, this.width / 2, 80);
      }
    }
  }

  // Utility
  public clearProjectiles(): void {
    this.physicsEngine.clear();
  }

  /** Starts a fireworks celebration above the winner */
  private startFireworks(centerX: number, centerY: number): void {
    this.fireworks = [];
    this.playVictoryFanfare();

    // Create more initial big rockets for a joyful start
    for (let i = 0; i < 9; i++) {
      this.fireworks.push({
        x: centerX + (Math.random() - 0.5) * 90,
        y: centerY + Math.random() * 50,
        vx: (Math.random() - 0.5) * 2.8,
        vy: -4.2 - Math.random() * 2.2,
        life: 48 + Math.random() * 22,
        color: this.winner?.tank.color ?? '#FFFFFF',
        size: 3 + Math.random() * 1.5,
      });
    }
  }

  // Simple joyful victory fanfare using Web Audio API (chiptune style)
  private audioContext: AudioContext | null = null;
  private victoryOscillators: OscillatorNode[] = [];

  private playVictoryFanfare(): void {
    try {
      const win = window as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      const AudioContextClass = win.AudioContext || win.webkitAudioContext;

      if (!this.audioContext && AudioContextClass) {
        this.audioContext = new AudioContextClass();
      }
      if (!this.audioContext) return;

      const ctx = this.audioContext;
      const notes = [60, 64, 67, 72, 76, 79, 84]; // C major arpeggio (joyful)
      const noteDuration = 0.18;

      this.victoryOscillators.forEach(osc => {
        try { osc.stop(); } catch { /* ignore */ }
      });
      this.victoryOscillators = [];

      notes.forEach((midiNote, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();

        const frequency = 440 * Math.pow(2, (midiNote - 69) / 12);

        osc.type = 'sawtooth';
        osc.frequency.value = frequency;

        filter.type = 'lowpass';
        filter.frequency.value = 1800;

        gain.gain.value = 0.18;

        const now = ctx.currentTime + index * noteDuration * 0.85;
        gain.gain.setValueAtTime(0.18, now);
        gain.gain.linearRampToValueAtTime(0.001, now + noteDuration * 1.6);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + noteDuration * 2.2);

        this.victoryOscillators.push(osc);
      });

      // Add a bright final chord
      setTimeout(() => {
        if (!this.audioContext) return;
        const chordNotes = [72, 76, 79, 84];
        chordNotes.forEach((midiNote, i) => {
          const osc = this.audioContext!.createOscillator();
          const gain = this.audioContext!.createGain();
          const freq = 440 * Math.pow(2, (midiNote - 69) / 12);

          osc.type = i === 0 ? 'square' : 'sawtooth';
          osc.frequency.value = freq;

          gain.gain.value = 0.12;
          const start = this.audioContext!.currentTime;
          gain.gain.setValueAtTime(0.12, start);
          gain.gain.linearRampToValueAtTime(0.001, start + 1.8);

          osc.connect(gain);
          gain.connect(this.audioContext!.destination);
          osc.start();
          osc.stop(start + 2.2);
        });
      }, 1100);
    } catch {
      // Audio not available - silently ignore
    }
  }

  private stopVictoryMusic(): void {
    this.victoryOscillators.forEach(osc => {
      try { osc.stop(); } catch { /* ignore */ }
    });
    this.victoryOscillators = [];
  }

  private updateFireworks(): void {
    if (this.fireworks.length === 0) return;

    const newFireworks: typeof this.fireworks = [];

    for (const p of this.fireworks) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.10; // gravity
      p.life -= 1;

      if (p.life > 0) {
        // Big, joyful explosions
        if (p.life % 8 === 0 && Math.random() > 0.35) {
          const explosionCount = 22 + Math.floor(Math.random() * 14);
          for (let i = 0; i < explosionCount; i++) {
            const spread = 4.8 + Math.random() * 3.2;
            newFireworks.push({
              x: p.x,
              y: p.y,
              vx: (Math.random() - 0.5) * spread,
              vy: (Math.random() - 0.5) * spread - 0.8,
              life: 28 + Math.random() * 20,
              color: p.color,
              size: 2.4 + Math.random() * 2.2,
            });
          }
        }
        newFireworks.push(p);
      }
    }

    this.fireworks = newFireworks;

    // Keep spawning lots of big rockets while game is over
    if (this.gameOver && this.fireworks.length < 22 && Math.random() < 0.42) {
      const winnerX = this.winner?.tank.position.x ?? this.width / 2;
      this.fireworks.push({
        x: winnerX + (Math.random() - 0.5) * 130,
        y: 50 + Math.random() * 80,
        vx: (Math.random() - 0.5) * 2.6,
        vy: -4.5 - Math.random() * 2.8,
        life: 46 + Math.random() * 20,
        color: this.winner?.tank.color ?? '#FFFFFF',
        size: 4 + Math.random() * 2.5,
      });
    }
  }

  /** Draws celebration fireworks when game is over */
  private drawFireworks(ctx: CanvasRenderingContext2D): void {
    for (const p of this.fireworks) {
      const alpha = Math.max(0.15, p.life / 45);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = alpha;

      const s = p.size;
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);

      // Extra glow for bigger, happier look
      if (s > 3.5) {
        ctx.globalAlpha = alpha * 0.35;
        ctx.fillRect(p.x - s, p.y - s, s * 2, s * 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  public isGameOver(): boolean {
    return this.gameOver;
  }

  public getWinner(): import('../../types/player').Player | null {
    return this.winner;
  }

  /** Fully resets the game for a new match */
  public resetGame(): void {
    this.stopVictoryMusic();
    this.gameOver = false;
    this.winner = null;
    this.fireworks = [];
    this.physicsEngine.clear();
    this.turnManager.reset();

    // Regenerate terrain
    this.terrain.generate();

    // Note: Players should be re-set via setPlayers() after calling this
  }
}
