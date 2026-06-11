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

export class TurnManager {
  private tankManager: TankManager;
  private terrainManager: TerrainManager;
  private fireCallback: (
    from: { x: number; y: number },
    command: FireCommand,
    ownerId?: string,
  ) => void;
  private aiEngine?: AIEngine;

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

  private wasFallingForHud = false;

  // Callbacks pour le HUD React
  public onHudUpdate?: (info: CurrentTurnInfo) => void;
  public onTurnChange?: (player: Player, round: number) => void;

  /** When true, nextTurn / AI turns are suppressed (match ended). Wired from GameEngine.gameOver. */
  private isMatchEnded: () => boolean = () => false;

  public setMatchEndedChecker(checker: () => boolean): void {
    this.isMatchEnded = checker;
  }

  /** Update current wind/gravity so they can be included in GameState snapshots for AIEngine (heuristic aiming etc). */
  public setEnvironment(windForce: number, gravity: number): void {
    this.currentWindForce = windForce;
    this.currentGravity = gravity;
  }

  constructor(
    tankManager: TankManager,
    terrainManager: TerrainManager,
    fireCallback: (
      from: { x: number; y: number },
      command: FireCommand,
      ownerId?: string,
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
      !this.awaitingTankStabilization &&
      !this.tankManager.anyTankIsFalling()
    ) {
      this.turnLockAccumulatedTime += dt;
      if (this.turnLockAccumulatedTime >= this.TURN_LOCK_SAFETY_LIMIT) {
        const stillCurrent = this.getCurrentPlayer();
        console.warn(
          `[TurnManager] Turn lock safety watchdog triggered for ${stillCurrent?.name ?? "unknown"} — forcing nextTurn (missed settlement?)`,
        );
        this.isInputLocked = false;
        this.clearAwaitingStabilization();
        this.clearResolutionTimeout();
        this.clearSettlementSafetyTimeout();
        this.clearTurnLockSafetyTimeout();
        this.aiTurnGeneration++;
        this.nextTurn();
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
          `[TurnManager] AI resolution timeout for ${player.name}. Triggering fallback.`,
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
          this.fireCallback(player.tank.position, command, player.id);
          this.consumeAmmo(player, player.tank.currentWeapon);
        } else {
          console.warn(
            `[TurnManager] ${player.name} forfeits its turn (no resolution fallback).`,
          );
          this.isInputLocked = false;
          this.clearAwaitingStabilization();
          this.clearResolutionTimeout();
          this.clearSettlementSafetyTimeout();
          this.clearTurnLockSafetyTimeout();
          this.nextTurn();
        }
      }
    }

    // 3. Sécurité de stabilisation du tir de l'IA
    if (
      this.isSettlementSafetyArmed &&
      this.isInputLocked &&
      this.settlementPlayerId &&
      !this.awaitingTankStabilization &&
      !this.tankManager.anyTankIsFalling()
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
              `[TurnManager] Settlement did not advance turn for AI ${stillCurrent.name} — forcing nextTurn as safety net`,
            );
            this.isInputLocked = false;
            this.clearAwaitingStabilization();
            this.clearResolutionTimeout();
            this.clearSettlementSafetyTimeout();
            this.clearTurnLockSafetyTimeout();
            this.nextTurn();
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
        this.nextTurn();
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
    this.isInputLocked = player ? !player.isHuman : false;
    console.log('[TurnManager] resumeForCombat: player=' + player?.name + ', isInputLocked=' + this.isInputLocked);
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
  private adjustAngle(delta: number): void {
    const player = this.getCurrentPlayer();
    if (!player) return;

    let newAngle = player.tank.angle + delta;

    // Borne entre 0° et 180°
    newAngle = Math.max(0, Math.min(180, newAngle));

    player.tank.angle = newAngle;
    this.notifyHudUpdate();
  }

  /** Modifie la puissance du tir */
  private adjustPower(delta: number): void {
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
    const player = this.getCurrentPlayer();
    if (!player || player.tank.isDead) return false;
    if (!player.isHuman) return false;
    if (
      this.isInputLocked ||
      this.interRoundPaused ||
      this.tankManager.anyTankIsFalling()
    )
      return false;
    this.fire();
    return true;
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
    if (weaponId === "MISSILE") return;
    const cur = player.inventory[weaponId] ?? 0;
    if (cur <= 0) return;
    const next = cur - 1;
    player.inventory = { ...player.inventory, [weaponId]: next };
    if (next === 0 && player.tank.currentWeapon === weaponId) {
      const available = ALL_WEAPON_IDS.filter(
        (id) => id === "MISSILE" || (player.inventory[id] ?? 0) > 0,
      );
      if (available.length > 0) {
        player.tank.currentWeapon = available[0];
      }
    }
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

    // Déverrouille les entrées pour le nouveau joueur (sera potentiellement re-verrouillé par l'IA)
    this.isInputLocked = false;
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

  /** Retourne le joueur dont c'est actuellement le tour */
  public getCurrentPlayer(): Player | null {
    const players = this.tankManager.getPlayers();
    return players[this.currentPlayerIndex] ?? null;
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

  private notifyHudUpdate(): void {
    const info = this.getCurrentTurnInfo();
    if (info) {
      this.onHudUpdate?.(info);
    }
  }

  /** Démarre le premier tour (appelé après setPlayers) */
  public startFirstTurn(): void {
    console.log('[TurnManager] startFirstTurn: entering');
    this.currentPlayerIndex = 0;
    this.turnNumber = 1;
    this.isInputLocked = false;

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

    console.log('[TurnManager] startFirstTurn: firstPlayer=' + firstPlayer.name);
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
    this.isInputLocked = false;
    this.isProcessingAI = false;
    this.interRoundPaused = false;
    this.removeInputListeners();

    // Invalidate any pending async AI activity
    this.aiTurnGeneration++;
  }

  /**
   * Gère le tour d'une IA de façon asynchrone.
   * Ne bloque pas le rendu du Canvas grâce à l'utilisation de setTimeout + Promise.
   */
  private async handleAITurnIfNeeded(player: Player): Promise<void> {
    console.log('[TurnManager] handleAITurnIfNeeded: player=' + player.name + ', isHuman=' + player.isHuman + ', isProcessingAI=' + this.isProcessingAI + ', isMatchEnded=' + this.isMatchEnded());
    if (player.isHuman || this.isProcessingAI || this.isMatchEnded()) return;
    if (!this.aiEngine) {
      console.warn(
        `[TurnManager] No AIEngine configured for AI player ${player.name}. Skipping turn.`,
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

      this.fireCallback(player.tank.position, command, player.id);
      this.consumeAmmo(player, player.tank.currentWeapon);

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

      this.clearSettlementSafetyTimeout();
      this.settlementPlayerId = player.id;
      this.settlementGeneration = this.aiTurnGeneration;
      this.isSettlementSafetyArmed = true;
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
