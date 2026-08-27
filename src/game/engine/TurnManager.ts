/**
 * TankWars - TurnManager
 *
 * Gestionnaire des tours de jeu et des entrées clavier du joueur humain.
 * Respecte l'architecture : découplé de React, communication via callbacks.
 */

import type { Player } from "../../types/player";
import type { TankManager } from "../entities/TankManager";
import type { PhysicsEngine } from "./PhysicsEngine";
import type { FireCommand, Color } from "../../types/game";
import type { AIEngine } from "../entities/ai/AIEngine";
import type { TerrainManager } from "./Terrain";
import type { GameState } from "../../types/game";
import { type WeaponId, ALL_WEAPON_IDS } from "../../types/weapon";
import { consumeWeaponForFire } from "../shop/shopTransaction";

export type AuthoritativeReplayMode =
  | "LIVE_LOCAL"
  | "LIVE_REMOTE"
  | "CATCH_UP";

export interface AuthoritativeShotIdentity {
  shotId: number;
  isFirstShotOfRound: boolean;
  suppressEconomyReport?: boolean;
}

export interface CurrentTurnInfo {
  playerName: string;
  playerId: string;
  isHuman: boolean;
  playerColor: Color;
  angle: number;
  power: number;
  currentWeapon: WeaponId;
  inventory: Partial<Record<WeaponId, number>>;
  /** Turn index within the current combat round (increments each time play passes to the next tank). */
  turn: number;
  isInputLocked: boolean;
  /** True while any alive tank is currently falling (vy > 0) or we are waiting for stabilization after a shot. */
  tanksAreFalling: boolean;
}

export interface ShotResolutionGate {
  hasEarnings: boolean;
  isRoundEnd: boolean;
  nextPlayerId?: string;
}

export class TurnManager {
  private tankManager: TankManager;
  private terrainManager: TerrainManager;
  private fireCallback: (
    from: { x: number; y: number },
    command: FireCommand,
    ownerId?: string,
    identity?: AuthoritativeShotIdentity,
  ) => void;
  private aiEngine?: AIEngine;

  /** When in online mode, this client only controls this specific player id. */
  private localPlayerId?: string;

  private currentPlayerIndex = 0;
  /** Monotonic turn counter within the current combat round (not a match "manche"). */
  private turnNumber = 1;
  private isInputLocked = false;

  private listenersAttached = false;
  private isProcessingAI = false;

  /** True during SUMMARY/SHOP — blocks nextTurn from projectile clear / stale settlement callbacks */
  private interRoundPaused = false;

  /** Environment snapshot for AI (wind/gravity change per round or config; passed via GameState to AIEngine). */
  private currentWindForce = 0;
  private currentGravity = 260;
  /** 1-based match round (manche). Independent of intra-combat turnNumber. */
  private currentRoundNumber = 1;

  public isInterRoundPaused(): boolean {
    return this.interRoundPaused;
  }

  // 1. General recovery watchdog (12s): forces turn to advance if turn stays locked
  private turnLockAccumulatedTime = 0;
  private readonly TURN_LOCK_SAFETY_LIMIT = 12; // 12 seconds in game time
  private isTurnLockWatchdogArmed = false;

  // 2. AI resolution safety net (10s): fallback if AI takes too long to decide
  private resolutionAccumulatedTime = 0;
  private readonly RESOLUTION_SAFETY_LIMIT = 10; // 10 seconds in game time
  private isResolutionSafetyArmed = false;
  private resolutionPlayer: Player | null = null;

  // 3. AI shot settlement safety net (4.5s): forces nextTurn if physics settlement doesn't notify
  private settlementAccumulatedTime = 0;
  private readonly SETTLEMENT_SAFETY_LIMIT = 4.5; // 4.5 seconds in game time
  private isSettlementSafetyArmed = false;
  private settlementPlayerId: string | null = null;
  private settlementGeneration = 0;

  // Used to abort async AI turns that were started in combat but whose promises
  // resolve after we have paused for SUMMARY / SHOP. Prevents "ghost" AI shots
  // and watchdog triggers during the shop phase.
  private aiTurnGeneration = 0;

  // Settlement timeout (120ms physics delay for tank falling and damage logic)
  // Driven by real-time setTimeout because it is a very short rendering transition delay
  private physicsSettlementTimeoutId: ReturnType<typeof setTimeout> | null =
    null;

  /**
   * When true after projectiles settle, we defer nextTurn() until !tankManager.anyTankIsFalling().
   * This makes the game wait (keeping input locked, no shooting possible) until all tanks have stopped falling.
   */
  private awaitingTankStabilization = false;

  /**
   * True from the moment a shot is launched until finishShotResolution consumes it.
   * Prevents a late onAllProjectilesSettled from advancing a second time after the
   * AI settlement safety net already forced the turn (long-bounce GRENADE).
   */
  private hasUnresolvedShot = false;

  private isAwaitingEarningsRelease = false;
  private resolvedShotEndsRound = false;
  private resolvedNextPlayerId: string | null = null;

  /** Physics engine used to detect in-flight projectiles (set via connectToPhysics). */
  private physicsEngine: PhysicsEngine | null = null;

  private wasFallingForHud = false;

  /** Throttle angle/power HUD dispatches to ~15 Hz while keeping engine state immediate. */
  private static readonly HUD_THROTTLE_MS = 66;
  private lastHudNotifyMs = 0;
  private hudThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHudPlayerId: string | null = null;
  private lastHudWeapon: WeaponId | null = null;
  private lastHudLocked = false;
  private lastHudFalling = false;
  private lastHudTurn = 0;

  // Callbacks pour le HUD React
  public onHudUpdate?: (info: CurrentTurnInfo) => void;
  public onTurnChange?: (player: Player, round: number) => void;

  /** When true, nextTurn / AI turns are suppressed (match ended). Wired from GameEngine.gameOver. */
  private isMatchEnded: () => boolean = () => false;

  /** Callback optionnel appelé lorsque la simulation physique d'un tir est complètement stabilisée sur le client. */
  public onShotSettled?: () => void;
  public onAuthoritativeShotSettled?: (
    shotId: number,
    mode: AuthoritativeReplayMode,
  ) => void;
  public onShotResolutionReady?: () => ShotResolutionGate;
  public onResolvedRoundEnd?: () => void;
  /** Returns true when a domain action replaces the AI projectile turn. */
  public onSpecialTurn?: (player: Player) => boolean;

  /**
   * True when the shot currently resolving was fired locally (tryFire).
   * Remote replays (executeRemoteFire) must not emit SHOT_SETTLED — otherwise a late
   * STATE_UPDATE can advance currentPlayerIndex before the replay settles and the
   * observer client would notify the server with the wrong slot.
   */
  private settlingShotWasLocal = false;
  private settlingAuthoritativeShot: {
    shotId: number;
    mode: AuthoritativeReplayMode;
  } | null = null;

  /** Online: validates and locks a local fire without launching it before the server echo. */
  private fireIntentHandler: ((command: FireCommand) => void) | null = null;
  private isAwaitingFireAuthority = false;

  /**
   * Online only: after a local shot settles we stay locked until the server moves the
   * turn index away from us. Prevents GAME_START catch-up / reconnect from re-unlocking
   * the same turn (double fire on player 1).
   */
  private awaitingServerTurnAfterLocalShot = false;

  /** Last command actually launched by tryFire/fire (captured before ammo consume). */
  private lastLocalFireCommand: FireCommand | null = null;

  public setMatchEndedChecker(checker: () => boolean): void {
    this.isMatchEnded = checker;
  }

  /** Update current wind/gravity so they can be included in GameState snapshots for AIEngine (heuristic aiming etc). */
  public setEnvironment(windForce: number, gravity: number): void {
    this.currentWindForce = windForce;
    this.currentGravity = gravity;
  }

  public setRoundNumber(roundNumber: number): void {
    this.currentRoundNumber =
      Number.isFinite(roundNumber) && roundNumber >= 1
        ? Math.floor(roundNumber)
        : 1;
  }

  constructor(
    tankManager: TankManager,
    terrainManager: TerrainManager,
    fireCallback: (
      from: { x: number; y: number },
      command: FireCommand,
      ownerId?: string,
      identity?: AuthoritativeShotIdentity,
    ) => void,
    aiEngine?: AIEngine,
  ) {
    this.tankManager = tankManager;
    this.terrainManager = terrainManager;
    this.fireCallback = fireCallback;
    this.aiEngine = aiEngine;
  }

  /** Current turn number within the active combat round. */
  public getCurrentTurnNumber(): number {
    return this.turnNumber;
  }

  /** Permet de changer la stratégie IA à chaud */
  public setAIEngine(aiEngine: AIEngine): void {
    this.aiEngine = aiEngine;
  }

  public setLocalPlayerId(playerId: string | undefined): void {
    this.localPlayerId = playerId;
    if (!this.interRoundPaused) {
      this.isInputLocked = !this.isLocalHumanTurn();
      this.notifyHudUpdate();
    }
  }

  public setFireIntentHandler(
    handler: ((command: FireCommand) => void) | null,
  ): void {
    this.fireIntentHandler = handler;
  }

  /**
   * Met à jour les timers de sécurité basés sur le temps de simulation physique (dt).
   * Cela évite que les watchdogs ne se déclenchent lorsque l'onglet est en veille
   * ou que requestAnimationFrame est suspendu.
   */
  public update(dt: number): void {
    // 1. Watchdog général du verrouillage du tour
    if (
      this.isTurnLockWatchdogArmed &&
      this.isInputLocked &&
      !this.isAwaitingFireAuthority &&
      !this.awaitingTankStabilization &&
      !this.tankManager.anyTankIsFalling()
    ) {
      this.turnLockAccumulatedTime += dt;
      if (this.turnLockAccumulatedTime >= this.TURN_LOCK_SAFETY_LIMIT) {
        console.warn(
          `[TurnManager] Turn lock safety watchdog triggered for (player redacted) — forcing shot resolution (missed settlement?)`,
        );
        this.clearAwaitingStabilization();
        this.clearResolutionTimeout();
        this.clearSettlementSafetyTimeout();
        this.clearTurnLockSafetyTimeout();
        this.aiTurnGeneration++;
        if (this.hasUnresolvedShot) {
          this.finishShotResolution();
        } else {
          this.nextTurn();
        }
      }
    }

    // 2. Sécurité de résolution de l'IA (si l'IA prend trop de temps à décider)
    if (
      this.isResolutionSafetyArmed &&
      this.isInputLocked &&
      this.resolutionPlayer &&
      !this.awaitingTankStabilization &&
      !this.tankManager.anyTankIsFalling()
    ) {
      this.resolutionAccumulatedTime += dt;
      if (this.resolutionAccumulatedTime >= this.RESOLUTION_SAFETY_LIMIT) {
        const player = this.resolutionPlayer;
        console.warn(
          `[TurnManager] AI resolution timeout for (player redacted). Triggering fallback.`,
        );

        let fallback: { angle: number; power: number } | null = null;

        if (this.aiEngine?.getResolutionFallback) {
          fallback = this.aiEngine.getResolutionFallback();
        }

        if (fallback) {
          player.tank.angle = Math.max(0, Math.min(180, fallback.angle));
          player.tank.power = Math.max(0, Math.min(100, fallback.power));
          this.notifyHudUpdate();

          const command: FireCommand = {
            angle: player.tank.angle,
            power: player.tank.power,
            weaponId: player.tank.currentWeapon,
          };
          if (this.fireIntentHandler) {
            this.isAwaitingFireAuthority = true;
            this.lastLocalFireCommand = { ...command };
            this.fireIntentHandler(command);
          } else {
            this.hasUnresolvedShot = true;
            this.fireCallback(player.tank.position, command, player.id);
            this.consumeAmmo(player, player.tank.currentWeapon);
          }
        } else {
          console.warn(
            `[TurnManager] (player redacted) forfeits its turn (no resolution fallback).`,
          );
          this.clearAwaitingStabilization();
          this.clearResolutionTimeout();
          this.clearSettlementSafetyTimeout();
          this.clearTurnLockSafetyTimeout();
          this.nextTurn();
        }
      }
    }

    // 3. Sécurité de stabilisation du tir de l'IA
    // Do not force-resolve while a shell is still in flight (GRENADE bounces easily
    // exceed SETTLEMENT_SAFETY_LIMIT). The real settlement callback will advance
    // the turn; firing now would let the later callback skip the next player.
    if (
      this.isSettlementSafetyArmed &&
      this.isInputLocked &&
      this.settlementPlayerId &&
      !this.awaitingTankStabilization &&
      !this.tankManager.anyTankIsFalling() &&
      !this.hasActiveProjectiles()
    ) {
      this.settlementAccumulatedTime += dt;
      if (this.settlementAccumulatedTime >= this.SETTLEMENT_SAFETY_LIMIT) {
        if (this.aiTurnGeneration === this.settlementGeneration) {
          const stillCurrent = this.getCurrentPlayer();
          if (
            stillCurrent?.id === this.settlementPlayerId &&
            this.isInputLocked
          ) {
            console.warn(
              `[TurnManager] Settlement did not advance turn for AI (player redacted) — forcing shot resolution as safety net`,
            );
            this.clearAwaitingStabilization();
            this.clearResolutionTimeout();
            this.clearSettlementSafetyTimeout();
            this.clearTurnLockSafetyTimeout();
            this.finishShotResolution();
          }
        } else {
          this.clearSettlementSafetyTimeout();
        }
      }
    }

    // 4. Wait for any tanks that are still falling (post-crater gravity) before advancing the turn.
    // While this is true, isInputLocked remains set from the shot, preventing any new shots (human or AI).
    // We poll here (called at 120 Hz from GameEngine) so we advance exactly when stable.
    if (this.awaitingTankStabilization) {
      if (!this.tankManager.anyTankIsFalling()) {
        this.clearAwaitingStabilization();
        this.clearSettlementSafetyTimeout();
        this.clearTurnLockSafetyTimeout();
        this.finishShotResolution();
      }
      // While legitimately waiting for stabilization, suppress safety timer accumulation
      // so a long fall (deep pit) doesn't trigger false "missed settlement" forces.
      return;
    }

    // Detect falling state changes to refresh HUD indicator (e.g. craters during resolution)
    const isFallingNow =
      this.tankManager.anyTankIsFalling() || this.awaitingTankStabilization;
    if (isFallingNow !== this.wasFallingForHud) {
      this.wasFallingForHud = isFallingNow;
      this.notifyHudUpdate();
    }
  }

  /** Connecte le TurnManager au système de physique pour détecter la fin des projectiles */
  public connectToPhysics(physicsEngine: PhysicsEngine): void {
    this.physicsEngine = physicsEngine;
    physicsEngine.onAllProjectilesSettled = () => {
      this.clearPhysicsSettlementTimeout();
      // Do not advance immediately. Set flag so update() will wait until no tanks are falling
      // (per requirement: game waits, no shooting possible while any tank is falling).
      // This also gives time for post-impact fall damage to be applied.
      this.awaitingTankStabilization = true;
      this.notifyHudUpdate(); // refresh HUD so [TANKS FALLING] indicator appears
      // The previous fixed 120ms was a rough approximation for fall/damage; we now poll properly.
    };
  }

  /** Active les écouteurs clavier globaux */
  public setupInputListeners(): void {
    if (this.listenersAttached) return;

    window.addEventListener("keydown", this.handleKeyDown);
    this.listenersAttached = true;
  }

  /** Désactive les écouteurs clavier */
  public removeInputListeners(): void {
    this.clearHudThrottleTimer();
    if (!this.listenersAttached) return;
    window.removeEventListener("keydown", this.handleKeyDown);
    this.listenersAttached = false;
  }

  /** Pause input/AI for SUMMARY/SHOP phase (called from React layer).
   *  Also clears any pending AI safety timers so they don't fire during pause or interfere with the next manche.
   */
  public pauseForInterRound(): void {
    this.interRoundPaused = true;
    this.isInputLocked = true;
    this.isProcessingAI = false;
    this.settlingShotWasLocal = false;
    this.settlingAuthoritativeShot = null;
    this.isAwaitingFireAuthority = false;
    this.awaitingServerTurnAfterLocalShot = false;
    this.hasUnresolvedShot = false;
    this.clearEarningsRelease();
    this.clearPhysicsSettlementTimeout();
    this.clearResolutionTimeout();
    this.clearSettlementSafetyTimeout();
    this.clearTurnLockSafetyTimeout();
    this.clearAwaitingStabilization();
    this.removeInputListeners();

    // Invalidate any in-flight async AI turns so they abort before firing
    // or arming watchdogs during SUMMARY/SHOP.
    this.aiTurnGeneration++;
    // AI handling will see locked state and skip
  }

  /** Resume after returning from SHOP to COMBAT */
  public resumeForCombat(): void {
    this.interRoundPaused = false;
    const player = this.getCurrentPlayer();
    // In online mode we only unlock if it's the local human's turn
    const localTurn = this.isLocalHumanTurn();
    this.isInputLocked = player ? (!player.isHuman || !localTurn) : false;
    console.log(
      `[TurnManager] resumeForCombat: player=(player redacted), isInputLocked=${this.isInputLocked}`,
    );
    this.clearAwaitingStabilization();
    this.setupInputListeners();
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    const player = this.getCurrentPlayer();
    if (!player || player.tank.isDead) return;

    // Seul un humain peut contrôler via clavier
    if (!player.isHuman) return;
    if (this.isInputLocked || this.tankManager.anyTankIsFalling()) return;

    switch (event.key) {
      case "ArrowLeft":
        this.adjustAngle(-1);
        event.preventDefault();
        break;

      case "ArrowRight":
        this.adjustAngle(+1);
        event.preventDefault();
        break;

      case "ArrowUp":
        this.adjustPower(+1);
        event.preventDefault();
        break;

      case "ArrowDown":
        this.adjustPower(-1);
        event.preventDefault();
        break;

      case " ":
      case "Spacebar":
        this.tryFire();
        event.preventDefault();
        break;

      // Weapon cycling for human player (A = prev, E = next)
      case "a":
      case "A":
        this.cycleWeapon(-1);
        event.preventDefault();
        break;

      case "e":
      case "E":
        this.cycleWeapon(1);
        event.preventDefault();
        break;
    }
  };

  /** Modifie l'angle du canon du joueur actuel */
  public adjustAngle(delta: number): void {
    if (!this.isLocalHumanTurn()) return;
    const player = this.getCurrentPlayer();
    if (!player) return;

    let newAngle = player.tank.angle + delta;

    // Borne entre 0° et 180°
    newAngle = Math.max(0, Math.min(180, newAngle));

    player.tank.angle = newAngle;
    this.notifyHudUpdate();
  }

  /** Modifie la puissance du tir */
  public adjustPower(delta: number): void {
    if (!this.isLocalHumanTurn()) return;
    const player = this.getCurrentPlayer();
    if (!player) return;

    let newPower = player.tank.power + delta;

    // Borne entre 0 et 100
    newPower = Math.max(0, Math.min(100, newPower));

    player.tank.power = newPower;
    this.notifyHudUpdate();
  }

  /**
   * Fire the current human player's shot (same as Spacebar).
   * No-op during AI turns, resolution lock, or inter-round pause.
   */
  public tryFire(): boolean {
    console.log(`[TurnManager] tryFire: localPlayerId=${this.localPlayerId}, isInputLocked=${this.isInputLocked}, interRoundPaused=${this.interRoundPaused}, anyTankIsFalling=${this.tankManager.anyTankIsFalling()}`);
    if (!this.isLocalHumanTurn()) {
      console.warn(`[TurnManager] tryFire: Not local human turn! localPlayerId=${this.localPlayerId}, currentPlayerIndex=${this.currentPlayerIndex}`);
      return false;
    }
    const player = this.getCurrentPlayer();
    if (!player || player.tank.isDead) return false;
    if (!player.isHuman) return false;
    if (
      this.isInputLocked ||
      this.interRoundPaused ||
      this.tankManager.anyTankIsFalling()
    )
      return false;
    if (this.fireIntentHandler) {
      const command: FireCommand = {
        angle: player.tank.angle,
        power: player.tank.power,
        weaponId: player.tank.currentWeapon,
      };
      this.lastLocalFireCommand = { ...command };
      this.isAwaitingFireAuthority = true;
      this.isInputLocked = true;
      this.notifyHudUpdate();
      this.fireIntentHandler(command);
    } else {
      this.fire();
    }
    return true;
  }

  /** For online: replay a fire command from another client so terrain, damage and effects stay in sync. */
  public executeRemoteFire(
    command: FireCommand,
    opts?: {
      fromSlot?: number;
      ownerId?: string;
      identity?: AuthoritativeShotIdentity;
      mode?: AuthoritativeReplayMode;
    },
  ): void {
    const players = this.tankManager.getPlayers();
    let player: Player | null = null;

    if (opts?.fromSlot != null && players[opts.fromSlot]) {
      this.currentPlayerIndex = opts.fromSlot;
      player = players[opts.fromSlot];
    } else if (opts?.ownerId) {
      const idx = players.findIndex((p) => p.id === opts.ownerId);
      if (idx >= 0) {
        this.currentPlayerIndex = idx;
        player = players[idx];
      }
    } else {
      player = this.getCurrentPlayer();
    }

    if (!player || player.tank.isDead) return;
    if (!ALL_WEAPON_IDS.includes(command.weaponId)) {
      console.warn("[TurnManager] Ignoring remote fire with invalid weaponId", command.weaponId);
      return;
    }

    // A new authoritative shot supersedes any stale local settlement wait.
    this.isAwaitingFireAuthority = false;
    this.clearAwaitingStabilization();
    this.clearPhysicsSettlementTimeout();
    this.clearResolutionTimeout();
    this.clearSettlementSafetyTimeout();
    this.clearTurnLockSafetyTimeout();

    player.tank.angle = command.angle;
    player.tank.power = command.power;
    player.tank.currentWeapon = command.weaponId;

    this.fireRemote(
      player,
      command,
      opts?.identity,
      opts?.mode ?? "LIVE_REMOTE",
    );
    this.notifyHudUpdate();
  }

  /** Launch a replayed remote shot — bypasses local turn lock and falling-tank guards. */
  private fireRemote(
    player: Player,
    command: FireCommand,
    identity: AuthoritativeShotIdentity | undefined,
    mode: AuthoritativeReplayMode,
  ): void {
    this.settlingShotWasLocal = mode === "LIVE_LOCAL";
    this.settlingAuthoritativeShot = identity
      ? { shotId: identity.shotId, mode }
      : null;
    this.hasUnresolvedShot = true;
    this.fireCallback(
      player.tank.position,
      command,
      player.id,
      identity
        ? {
            ...identity,
            suppressEconomyReport: mode === "CATCH_UP",
          }
        : undefined,
    );
    if (mode !== "CATCH_UP") this.consumeAmmo(player, command.weaponId);
    this.isInputLocked = true;
    this.armTurnLockSafetyWatchdog();
  }

  /** Libère une intention FIRE refusée sans toucher à la simulation ni à l'inventaire. */
  public rejectPendingFireIntent(): void {
    if (this.hasUnresolvedShot || this.interRoundPaused) return;
    this.isAwaitingFireAuthority = false;
    this.awaitingServerTurnAfterLocalShot = false;
    this.isInputLocked = !this.isLocalHumanTurn();
    this.notifyHudUpdate();
  }

  /** Maintient le combat verrouillé pendant le rejeu séquentiel de rattrapage. */
  public lockForCatchUp(): void {
    this.isInputLocked = true;
    this.notifyHudUpdate();
  }

  /** Réévalue le verrou lorsque le rattrapage ne contient plus de tir actif. */
  public unlockAfterCatchUp(): void {
    if (this.hasUnresolvedShot || this.interRoundPaused) return;
    this.isInputLocked = this.awaitingServerTurnAfterLocalShot
      ? true
      : !this.isLocalHumanTurn();
    this.notifyHudUpdate();
  }

  /**
   * Command used for the most recent successful local tryFire (pre-ammo-consume).
   * Online clients should send this exact payload as FIRE so observers replay the same shot.
   */
  public getLastLocalFireCommand(): FireCommand | null {
    return this.lastLocalFireCommand;
  }

  /** True after a local online shot settled, until the server advances the turn index. */
  public isAwaitingServerTurnAfterLocalShot(): boolean {
    return this.awaitingServerTurnAfterLocalShot;
  }

  /** Déclenche le tir du joueur actuel (après validation tryFire). */
  private fire(): void {
    const player = this.getCurrentPlayer();
    if (!player || this.isInputLocked || this.tankManager.anyTankIsFalling())
      return;

    const tank = player.tank;

    const command: FireCommand = {
      angle: tank.angle,
      power: tank.power,
      weaponId: tank.currentWeapon,
    };

    // Capture before consumeAmmo (which may auto-switch currentWeapon when stock hits 0).
    this.lastLocalFireCommand = { ...command };

    this.settlingShotWasLocal = true;
    this.hasUnresolvedShot = true;
    this.fireCallback(tank.position, command, player.id);

    // Consume 1 from inventory for limited weapons (MISSILE is unlimited).
    // Do this before locking so the HUD snapshot for the resolving turn reflects the spent round.
    this.consumeAmmo(player, tank.currentWeapon);

    // Verrouille les inputs jusqu'à la fin de la résolution
    this.isInputLocked = true;
    this.notifyHudUpdate();

    // Arm recovery watchdog in case the settlement event is missed for any reason
    // (prevents permanent "RESOLVING..." after human shots, especially vs AI)
    this.armTurnLockSafetyWatchdog();
  }

  /** Sélectionne une arme pour le joueur humain courant (si munitions disponibles; MISSILE always selectable). */
  public selectWeapon(weaponId: WeaponId): boolean {
    if (!this.isLocalHumanTurn()) return false;
    const player = this.getCurrentPlayer();
    if (!player || !player.isHuman || this.isInputLocked) return false;

    const ammo = player.inventory[weaponId] ?? 0;
    if (weaponId !== "MISSILE" && ammo <= 0) return false;
    if (player.tank.currentWeapon === weaponId) return false;

    player.tank.currentWeapon = weaponId;
    this.notifyHudUpdate();
    return true;
  }

  /** Cycle l'arme active (delta = +1 ou -1). Filtre sur les armes avec munitions > 0 (MISSILE always available as it is unlimited). */
  public cycleWeapon(delta: 1 | -1): boolean {
    if (!this.isLocalHumanTurn()) return false;
    const player = this.getCurrentPlayer();
    if (!player || !player.isHuman || this.isInputLocked) return false;

    const available = ALL_WEAPON_IDS.filter(
      (id) => id === "MISSILE" || (player.inventory[id] ?? 0) > 0,
    );
    if (available.length === 0) return false;

    const current = player.tank.currentWeapon;
    let idx = available.indexOf(current);
    if (idx === -1) idx = 0;

    const nextIdx = (idx + delta + available.length) % available.length;
    const nextWeapon = available[nextIdx];
    if (nextWeapon === current) return false;

    player.tank.currentWeapon = nextWeapon;
    this.notifyHudUpdate();
    return true;
  }

  /**
   * Decrements inventory for limited weapons after a shot (human or AI).
   * MISSILE is unlimited: never decremented, always treated as available.
   * If the just-fired limited weapon reaches 0 and was current, auto-switch
   * currentWeapon to the first still-available (MISSILE is guaranteed).
   * Mutates the live player (consistent with shop mutations) and notifies HUD.
   */
  private consumeAmmo(player: Player, weaponId: WeaponId): void {
    const consumed = consumeWeaponForFire(player, weaponId);
    if (!consumed.ok) return;
    player.inventory = consumed.player.inventory;
    player.tank.currentWeapon = consumed.player.tank.currentWeapon;
    this.notifyHudUpdate();
  }

  /** Passe au joueur suivant (saute les tanks morts).
   *
   * - Saute automatiquement les joueurs dont tank.isDead === true.
   * - Combat rounds end only on last man standing (<=1 alive), not on index wrap.
   * - turnNumber increments each time a new tank becomes active.
   */
  public nextTurn(): void {
    if (this.interRoundPaused) return;
    if (this.isMatchEnded()) return;
    if (this.isAwaitingEarningsRelease) return;

    this.clearAwaitingStabilization();

    const players = this.tankManager.getPlayers();
    if (players.length === 0) return;

    let attempts = 0;
    const maxAttempts = players.length * 2;

    do {
      this.currentPlayerIndex++;

      if (this.currentPlayerIndex >= players.length) {
        this.currentPlayerIndex = 0;
      }

      attempts++;
    } while (
      players[this.currentPlayerIndex]?.tank.isDead &&
      attempts < maxAttempts
    );

    this.turnNumber++;

    // Déverrouille les entrées seulement si c'est le tour du joueur local (en mode online)
    this.isInputLocked = !this.isLocalHumanTurn();
    this.isProcessingAI = false; // Reset processing flag so next turn is never skipped due to race conditions
    this.clearPhysicsSettlementTimeout();
    this.clearResolutionTimeout(); // Clear any pending AI resolution timeout
    this.clearSettlementSafetyTimeout();
    this.clearTurnLockSafetyTimeout();

    const newPlayer = this.getCurrentPlayer();

    if (newPlayer) {
      this.onTurnChange?.(newPlayer, this.turnNumber);
      this.notifyHudUpdate();

      // Si c'est une IA, on lance son tour de manière asynchrone (sans bloquer le rendu)
      this.handleAITurnIfNeeded(newPlayer);
    }
  }

  /** Starts the next turn at a specific living player (used by Zeus re-anchoring). */
  public beginTurnAt(playerId: string): boolean {
    if (this.interRoundPaused || this.isMatchEnded()) return false;
    const players = this.tankManager.getPlayers();
    const index = players.findIndex(
      (player) => player.id === playerId && !player.tank.isDead && player.tank.health > 0,
    );
    if (index < 0) return false;

    this.aiTurnGeneration++;
    this.currentPlayerIndex = index;
    this.turnNumber++;
    this.isInputLocked = true;
    this.isProcessingAI = false;
    this.clearAwaitingStabilization();
    this.clearPhysicsSettlementTimeout();
    this.clearResolutionTimeout();
    this.clearSettlementSafetyTimeout();
    this.clearTurnLockSafetyTimeout();
    this.onTurnChange?.(players[index], this.turnNumber);
    this.notifyHudUpdate(true);
    this.handleAITurnIfNeeded(players[index]);
    return true;
  }

  /** Completes a non-projectile domain action while preserving normal round/turn semantics. */
  public completeSpecialTurn(isRoundEnd: boolean): void {
    this.isProcessingAI = false;
    this.aiTurnGeneration++;
    this.clearResolutionTimeout();
    this.clearSettlementSafetyTimeout();
    this.clearTurnLockSafetyTimeout();
    if (isRoundEnd) this.onResolvedRoundEnd?.();
    else this.nextTurn();
  }

  /** Retourne le joueur dont c'est actuellement le tour */
  public getCurrentPlayer(): Player | null {
    const players = this.tankManager.getPlayers();
    return players[this.currentPlayerIndex] ?? null;
  }

  /** Sync the current turn index from server authoritative state. */
  public syncTurn(currentPlayerIndex: number): void {
    this.aiTurnGeneration++;
    this.isProcessingAI = false;
    this.currentPlayerIndex = currentPlayerIndex;

    if (this.awaitingServerTurnAfterLocalShot) {
      if (!this.isLocalHumanTurn()) {
        // Server advanced to someone else — local shot fully acknowledged.
        this.awaitingServerTurnAfterLocalShot = false;
        this.isInputLocked = true;
      } else {
        // Still our index after we already fired (stale GAME_START / no advance yet).
        // Stay locked so we cannot FIRE twice on the same server turn.
        this.isInputLocked = true;
      }
    } else {
      this.isInputLocked = !this.isLocalHumanTurn();
    }

    this.clearAwaitingStabilization();
    this.clearPhysicsSettlementTimeout();
    this.clearResolutionTimeout();
    this.clearSettlementSafetyTimeout();
    this.clearTurnLockSafetyTimeout();
    this.notifyHudUpdate();
  }

  /**
   * After a shot resolves locally. In local/hotseat mode we advance the turn index.
   * In online mode the server is authoritative — only refresh the input lock for the current index.
   */
  private finishShotResolution(): void {
    if (!this.hasUnresolvedShot) {
      this.clearAwaitingStabilization();
      return;
    }
    this.hasUnresolvedShot = false;

    const gate = this.onShotResolutionReady?.() ?? {
      hasEarnings: false,
      isRoundEnd: false,
    };

    const wasLocalShot = this.settlingShotWasLocal;
    this.settlingShotWasLocal = false;
    const authoritativeShot = this.settlingAuthoritativeShot;
    this.settlingAuthoritativeShot = null;

    console.log(
      `[TurnManager] finishShotResolution: localPlayerId=${this.localPlayerId}, currentPlayerIndex=${this.currentPlayerIndex}, wasLocalShot=${wasLocalShot}`,
    );
    if (this.localPlayerId) {
      if (authoritativeShot?.mode === "CATCH_UP") {
        this.isInputLocked = true;
        this.notifyHudUpdate();
        this.onAuthoritativeShotSettled?.(
          authoritativeShot.shotId,
          authoritativeShot.mode,
        );
        return;
      }
      if (wasLocalShot) {
        // Firer's client: stay locked until the server broadcasts the next turn.
        this.awaitingServerTurnAfterLocalShot = true;
        this.isInputLocked = true;
        console.log(`[TurnManager] finishShotResolution: calling onShotSettled callback...`);
        this.onShotSettled?.();
      } else {
        // Observer replay settled (possibly after syncTurn already advanced): refresh lock only.
        // Do not clear awaitingServerTurnAfterLocalShot here — that is only for local fires.
        this.isInputLocked = this.awaitingServerTurnAfterLocalShot
          ? true
          : !this.isLocalHumanTurn();
      }
      this.notifyHudUpdate();
      if (authoritativeShot) {
        this.onAuthoritativeShotSettled?.(
          authoritativeShot.shotId,
          authoritativeShot.mode,
        );
      }
      return;
    }
    this.isAwaitingEarningsRelease = true;
    this.resolvedShotEndsRound = gate.isRoundEnd;
    this.resolvedNextPlayerId = gate.nextPlayerId ?? null;
    this.releaseResolvedShot();
  }

  /** Termine une résolution locale; demeure idempotent pour les appels tardifs. */
  public releaseResolvedShot(): void {
    if (!this.isAwaitingEarningsRelease) return;
    this.isAwaitingEarningsRelease = false;
    const endsRound = this.resolvedShotEndsRound;
    const nextPlayerId = this.resolvedNextPlayerId;
    this.resolvedShotEndsRound = false;
    this.resolvedNextPlayerId = null;
    if (endsRound) {
      this.onResolvedRoundEnd?.();
    } else if (nextPlayerId) {
      if (!this.beginTurnAt(nextPlayerId)) this.nextTurn();
    } else {
      this.nextTurn();
    }
  }

  public isWaitingForEarningsRelease(): boolean {
    return this.isAwaitingEarningsRelease;
  }

  private isLocalHumanTurn(): boolean {
    if (!this.localPlayerId) return true; // local hotseat mode: everyone can input on their turn
    const player = this.getCurrentPlayer();
    return !!player && player.isHuman && player.id === this.localPlayerId;
  }

  /** Retourne les informations nécessaires pour le HUD React */
  public getCurrentTurnInfo(): CurrentTurnInfo | null {
    const player = this.getCurrentPlayer();
    if (!player) return null;

    return {
      playerName: player.name,
      playerId: player.id,
      isHuman: player.isHuman,
      playerColor: player.tank.color,
      angle: Math.round(player.tank.angle),
      power: Math.round(player.tank.power),
      currentWeapon: player.tank.currentWeapon,
      inventory: { ...player.inventory },
      turn: this.turnNumber,
      isInputLocked: this.isInputLocked,
      tanksAreFalling:
        this.tankManager.anyTankIsFalling() || this.awaitingTankStabilization,
    };
  }

  private isStructuralHudChange(info: CurrentTurnInfo): boolean {
    return (
      this.lastHudPlayerId !== info.playerId ||
      this.lastHudWeapon !== info.currentWeapon ||
      this.lastHudLocked !== info.isInputLocked ||
      this.lastHudFalling !== info.tanksAreFalling ||
      this.lastHudTurn !== info.turn
    );
  }

  private flushHudUpdate(info: CurrentTurnInfo): void {
    this.lastHudPlayerId = info.playerId;
    this.lastHudWeapon = info.currentWeapon;
    this.lastHudLocked = info.isInputLocked;
    this.lastHudFalling = info.tanksAreFalling;
    this.lastHudTurn = info.turn;
    this.lastHudNotifyMs = performance.now();
    this.onHudUpdate?.(info);
  }

  private clearHudThrottleTimer(): void {
    if (this.hudThrottleTimer !== null) {
      clearTimeout(this.hudThrottleTimer);
      this.hudThrottleTimer = null;
    }
  }

  private notifyHudUpdate(immediate = false): void {
    const info = this.getCurrentTurnInfo();
    if (!info) return;

    const structural = this.isStructuralHudChange(info);
    if (immediate || structural) {
      this.clearHudThrottleTimer();
      this.flushHudUpdate(info);
      return;
    }

    const now = performance.now();
    if (now - this.lastHudNotifyMs >= TurnManager.HUD_THROTTLE_MS) {
      this.flushHudUpdate(info);
      return;
    }

    if (this.hudThrottleTimer !== null) return;

    const delay = TurnManager.HUD_THROTTLE_MS - (now - this.lastHudNotifyMs);
    this.hudThrottleTimer = setTimeout(() => {
      this.hudThrottleTimer = null;
      const latest = this.getCurrentTurnInfo();
      if (latest) this.flushHudUpdate(latest);
    }, delay);
  }

  /** Démarre le premier tour (appelé après setPlayers) */
  public startFirstTurn(): void {
    console.log('[TurnManager] startFirstTurn: entering');
    this.currentPlayerIndex = 0;
    this.turnNumber = 1;
    this.settlingShotWasLocal = false;
    this.settlingAuthoritativeShot = null;
    this.isAwaitingFireAuthority = false;
    this.awaitingServerTurnAfterLocalShot = false;
    this.hasUnresolvedShot = false;
    this.clearEarningsRelease();
    this.isInputLocked = !this.isLocalHumanTurn();

    const players = this.tankManager.getPlayers();
    if (players.length === 0) {
      console.warn("[TurnManager] startFirstTurn: no players");
      return;
    }

    // Saute les joueurs morts (borné — évite boucle infinie)
    let attempts = 0;
    const maxAttempts = Math.max(players.length * 2, 1);
    while (
      players[this.currentPlayerIndex]?.tank.isDead &&
      attempts < maxAttempts
    ) {
      this.currentPlayerIndex++;
      if (this.currentPlayerIndex >= players.length) {
        this.currentPlayerIndex = 0;
      }
      attempts++;
    }

    const firstPlayer = this.getCurrentPlayer();
    if (!firstPlayer || firstPlayer.tank.isDead) {
      console.warn(
        `[TurnManager] startFirstTurn: no living player (turn=${this.turnNumber}, attempts=${attempts})`,
      );
      return;
    }

    console.log('[TurnManager] startFirstTurn: firstPlayer=(player redacted)');
    this.onTurnChange?.(firstPlayer, this.turnNumber);
    this.notifyHudUpdate();
    this.handleAITurnIfNeeded(firstPlayer);
  }

  /** Réinitialise complètement le gestionnaire de tours */
  public reset(): void {
    this.clearPhysicsSettlementTimeout();
    this.clearResolutionTimeout();
    this.clearSettlementSafetyTimeout();
    this.clearTurnLockSafetyTimeout();
    this.clearAwaitingStabilization();
    this.currentPlayerIndex = 0;
    this.turnNumber = 1;
    this.settlingShotWasLocal = false;
    this.settlingAuthoritativeShot = null;
    this.isAwaitingFireAuthority = false;
    this.awaitingServerTurnAfterLocalShot = false;
    this.hasUnresolvedShot = false;
    this.clearEarningsRelease();
    this.isInputLocked = !this.isLocalHumanTurn();
    this.isProcessingAI = false;
    this.interRoundPaused = false;
    this.removeInputListeners();

    // Invalidate any pending async AI activity
    this.aiTurnGeneration++;
  }

  private clearEarningsRelease(): void {
    this.isAwaitingEarningsRelease = false;
    this.resolvedShotEndsRound = false;
    this.resolvedNextPlayerId = null;
  }

  /**
   * Gère le tour d'une IA de façon asynchrone.
   * Ne bloque pas le rendu du Canvas grâce à l'utilisation de setTimeout + Promise.
   */
  private async handleAITurnIfNeeded(player: Player): Promise<void> {
    console.log('[TurnManager] handleAITurnIfNeeded: player=(player redacted), isHuman=' + player.isHuman + ', isProcessingAI=' + this.isProcessingAI + ', isMatchEnded=' + this.isMatchEnded());
    if (player.isHuman || this.isProcessingAI || this.isMatchEnded()) return;
    if (this.localPlayerId) {
      // En ligne, l'IA est déclenchée par GameRoom; les clients attendent le SHOT.
      this.isInputLocked = true;
      this.notifyHudUpdate(true);
      return;
    }
    if (this.onSpecialTurn?.(player)) {
      this.isProcessingAI = true;
      this.isInputLocked = true;
      this.notifyHudUpdate(true);
      return;
    }
    if (!this.aiEngine) {
      console.warn(
        `[TurnManager] No AIEngine configured for AI player (player redacted). Skipping turn.`,
      );
      setTimeout(() => this.nextTurn(), 800);
      return;
    }

    this.isProcessingAI = true;
    this.isInputLocked = true;
    this.notifyHudUpdate();

    // Capture generation so we can detect if the turn was aborted (e.g. round ended
    // and we went to SUMMARY/SHOP while this async function was awaiting).
    const turnGeneration = this.aiTurnGeneration;

    // Arm general recovery watchdog (in addition to AI-specific ones)
    this.armTurnLockSafetyWatchdog();

    // Start safety timeout for auto-resolution
    this.startResolutionTimeout(player);

    try {
      const gameState: GameState = {
        phase: "COMBAT",
        players: [...this.tankManager.getPlayers()],
        currentPlayerIndex: this.currentPlayerIndex,
        turn: this.turnNumber,
        windForce: this.currentWindForce,
        gravity: this.currentGravity,
        roundNumber: this.currentRoundNumber,
      };

      console.log('[TurnManager] handleAITurnIfNeeded: executing AI strategy...');
      const decision = await this.aiEngine.executeTurn(
        player.tank.id,
        gameState,
        this.terrainManager,
      );
      console.log('[TurnManager] handleAITurnIfNeeded: AI strategy decided:', decision);

      // Abort if the game moved on (SUMMARY/SHOP) while we were awaiting the strategy.
      if (this.aiTurnGeneration !== turnGeneration) {
        console.log('[TurnManager] handleAITurnIfNeeded: aborted after executeTurn due to generation mismatch');
        this.isProcessingAI = false;
        return;
      }

      if (decision.weaponId) {
        player.tank.currentWeapon = decision.weaponId;
      }
      player.tank.angle = Math.max(0, Math.min(180, decision.angle));
      player.tank.power = Math.max(0, Math.min(100, decision.power));
      this.notifyHudUpdate();

      // Artificial thinking delay
      console.log('[TurnManager] handleAITurnIfNeeded: starting thinking delay...');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      console.log('[TurnManager] handleAITurnIfNeeded: thinking delay done');

      // Abort before firing if we have been paused for inter-round in the meantime.
      if (this.aiTurnGeneration !== turnGeneration || !this.isInputLocked) {
        console.log('[TurnManager] handleAITurnIfNeeded: aborted before firing (gen mismatch or input unlocked)');
        this.isProcessingAI = false;
        return;
      }

      console.log('[TurnManager] handleAITurnIfNeeded: firing projectile!');
      const command: FireCommand = {
        angle: player.tank.angle,
        power: player.tank.power,
        weaponId: player.tank.currentWeapon,
      };

      const launchedLocally = this.fireIntentHandler === null;
      if (this.fireIntentHandler) {
        this.isAwaitingFireAuthority = true;
        this.lastLocalFireCommand = { ...command };
        this.fireIntentHandler(command);
      } else {
        this.hasUnresolvedShot = true;
        this.fireCallback(player.tank.position, command, player.id);
        this.consumeAmmo(player, player.tank.currentWeapon);
      }

      // If everything goes well, the normal onAllProjectilesSettled → nextTurn() will happen.
      // The resolution timeout acts as a safety net.

      // Extra safety net for settlement detection edge cases (e.g. unusual trajectories after terrain destruction):
      // After a successful AI shot, if we are still the current locked player after a few seconds,
      // force the turn to advance so the human gets their turns reliably.
      // Store the ID so we can cancel it cleanly on pause/reset (prevents stale forces during SUMMARY/SHOP).
      // Also guard with generation so a stale safety timer from an aborted turn doesn't fire.
      if (this.aiTurnGeneration !== turnGeneration) {
        this.isProcessingAI = false;
        return;
      }

      if (launchedLocally) {
        this.clearSettlementSafetyTimeout();
        this.settlementPlayerId = player.id;
        this.settlementGeneration = this.aiTurnGeneration;
        this.isSettlementSafetyArmed = true;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[TurnManager] AI turn failed:", errorMessage);
      this.clearResolutionTimeout();
      this.clearSettlementSafetyTimeout();
      setTimeout(() => this.nextTurn(), 1000);
    } finally {
      this.isProcessingAI = false;
    }
  }

  /** Starts a safety timer that will force resolution if the AI turn gets stuck */
  private startResolutionTimeout(player: Player): void {
    this.clearResolutionTimeout();
    this.resolutionPlayer = player;
    this.isResolutionSafetyArmed = true;
  }

  private clearPhysicsSettlementTimeout(): void {
    if (this.physicsSettlementTimeoutId) {
      clearTimeout(this.physicsSettlementTimeoutId);
      this.physicsSettlementTimeoutId = null;
    }
  }

  private clearAwaitingStabilization(): void {
    this.awaitingTankStabilization = false;
    this.wasFallingForHud = false;
  }

  private clearResolutionTimeout(): void {
    this.isResolutionSafetyArmed = false;
    this.resolutionAccumulatedTime = 0;
    this.resolutionPlayer = null;
    this.clearSettlementSafetyTimeout();
  }

  /** Clears the post-AI-shot settlement safety timer */
  private clearSettlementSafetyTimeout(): void {
    this.isSettlementSafetyArmed = false;
    this.settlementAccumulatedTime = 0;
    this.settlementPlayerId = null;
  }

  /** Clears the general turn-lock recovery watchdog */
  private clearTurnLockSafetyTimeout(): void {
    this.isTurnLockWatchdogArmed = false;
    this.turnLockAccumulatedTime = 0;
  }

  private hasActiveProjectiles(): boolean {
    return this.physicsEngine?.hasActiveProjectiles() ?? false;
  }

  /**
   * Arms (or re-arms) a recovery timer that will force the turn to advance
   * if the lock stays on for too long. Driven by physical delta updates (dt).
   */
  private armTurnLockSafetyWatchdog(): void {
    this.clearTurnLockSafetyTimeout();

    const currentPlayerAtArm = this.getCurrentPlayer();
    if (!currentPlayerAtArm) return;

    this.turnLockAccumulatedTime = 0;
    this.isTurnLockWatchdogArmed = true;
  }
}
