/**
 * TankWars - TurnManager
 *
 * Gestionnaire des tours de jeu et des entrées clavier du joueur humain.
 * Respecte l'architecture : découplé de React, communication via callbacks.
 */

import type { Player } from '../../types/player';
import type { TankManager } from '../entities/TankManager';
import type { PhysicsEngine } from './PhysicsEngine';
import type { FireCommand, Color } from '../../types/game';
import type { AIEngine } from '../entities/ai/AIEngine';
import type { TerrainManager } from './Terrain';
import type { GameState } from '../../types/game';
import { type WeaponId, ALL_WEAPON_IDS } from '../../types/weapon';

export interface CurrentTurnInfo {
  playerName: string;
  playerId: string;
  isHuman: boolean;
  playerColor: Color;
  angle: number;
  power: number;
  currentWeapon: WeaponId;
  inventory: Partial<Record<WeaponId, number>>;
  round: number;
  isInputLocked: boolean;
}

export class TurnManager {
  private tankManager: TankManager;
  private terrainManager: TerrainManager;
  private fireCallback: (from: { x: number; y: number }, command: FireCommand, ownerId?: string) => void;
  private aiEngine?: AIEngine;

  private currentPlayerIndex = 0;
  private currentRound = 1;
  private isInputLocked = false;

  private listenersAttached = false;
  private isProcessingAI = false;

  // Auto-resolution safety net
  private resolutionTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private readonly AI_RESOLUTION_TIMEOUT_MS = 10000; // 10 seconds safety net

  // Safety net for "settlement did not advance the turn after AI shot" (4.5s after firing)
  private settlementSafetyTimeoutId: ReturnType<typeof setTimeout> | null = null;

  // General recovery watchdog: if the turn stays locked for too long with no activity,
  // force advance. This prevents hard "RESOLVING forever" when settlement events are missed
  // (physics edge cases, rapid chaining, etc.).
  private turnLockSafetyTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private readonly TURN_LOCK_SAFETY_MS = 3200; // ~3.2s recovery for human→AI handoff or general lockups

  // Used to abort async AI turns that were started in combat but whose promises
  // resolve after we have paused for SUMMARY / SHOP. Prevents "ghost" AI shots
  // and watchdog triggers during the shop phase.
  private aiTurnGeneration = 0;

  // Callbacks pour le HUD React
  public onHudUpdate?: (info: CurrentTurnInfo) => void;
  public onTurnChange?: (player: Player, round: number) => void;

  constructor(
    tankManager: TankManager,
    terrainManager: TerrainManager,
    fireCallback: (from: { x: number; y: number }, command: FireCommand, ownerId?: string) => void,
    aiEngine?: AIEngine,
  ) {
    this.tankManager = tankManager;
    this.terrainManager = terrainManager;
    this.fireCallback = fireCallback;
    this.aiEngine = aiEngine;
  }

  /** Gets the current round number */
  public getCurrentRound(): number {
    return this.currentRound;
  }

  /** Permet de changer la stratégie IA à chaud */
  public setAIEngine(aiEngine: AIEngine): void {
    this.aiEngine = aiEngine;
  }

  /** Connecte le TurnManager au système de physique pour détecter la fin des projectiles */
  public connectToPhysics(physicsEngine: PhysicsEngine): void {
    physicsEngine.onAllProjectilesSettled = () => {
      // On attend un petit délai pour que les dégâts et la chute des tanks soient appliqués
      setTimeout(() => {
        this.nextTurn();
      }, 120);
    };
  }

  /** Active les écouteurs clavier globaux */
  public setupInputListeners(): void {
    if (this.listenersAttached) return;

    window.addEventListener('keydown', this.handleKeyDown);
    this.listenersAttached = true;
  }

  /** Désactive les écouteurs clavier */
  public removeInputListeners(): void {
    if (!this.listenersAttached) return;
    window.removeEventListener('keydown', this.handleKeyDown);
    this.listenersAttached = false;
  }

  /** Pause input/AI for SUMMARY/SHOP phase (called from React layer).
   *  Also clears any pending AI safety timers so they don't fire during pause or interfere with the next manche.
   */
  public pauseForInterRound(): void {
    this.isInputLocked = true;
    this.isProcessingAI = false;
    this.clearResolutionTimeout();
    this.clearSettlementSafetyTimeout();
    this.clearTurnLockSafetyTimeout();
    this.removeInputListeners();

    // Invalidate any in-flight async AI turns so they abort before firing
    // or arming watchdogs during SUMMARY/SHOP.
    this.aiTurnGeneration++;
    // AI handling will see locked state and skip
  }

  /** Resume after returning from SHOP to COMBAT */
  public resumeForCombat(): void {
    this.isInputLocked = false;
    this.setupInputListeners();
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    const player = this.getCurrentPlayer();
    if (!player || player.tank.isDead) return;

    // Seul un humain peut contrôler via clavier
    if (!player.isHuman) return;
    if (this.isInputLocked) return;

    switch (event.key) {
      case 'ArrowLeft':
        this.adjustAngle(-1);
        event.preventDefault();
        break;

      case 'ArrowRight':
        this.adjustAngle(+1);
        event.preventDefault();
        break;

      case 'ArrowUp':
        this.adjustPower(+1);
        event.preventDefault();
        break;

      case 'ArrowDown':
        this.adjustPower(-1);
        event.preventDefault();
        break;

      case ' ':
      case 'Spacebar':
        this.fire();
        event.preventDefault();
        break;

      // Weapon cycling for human player (A = prev, E = next)
      case 'a':
      case 'A':
        this.cycleWeapon(-1);
        event.preventDefault();
        break;

      case 'e':
      case 'E':
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

  /** Déclenche le tir du joueur actuel */
  private fire(): void {
    const player = this.getCurrentPlayer();
    if (!player || this.isInputLocked) return;

    const tank = player.tank;

    const command: FireCommand = {
      angle: tank.angle,
      power: tank.power,
      weaponId: tank.currentWeapon,
    };

    this.fireCallback(tank.position, command, player.id);

    // Verrouille les inputs jusqu'à la fin de la résolution
    this.isInputLocked = true;
    this.notifyHudUpdate();

    // Arm recovery watchdog in case the settlement event is missed for any reason
    // (prevents permanent "RESOLVING..." after human shots, especially vs AI)
    this.armTurnLockSafetyWatchdog();
  }

  /** Sélectionne une arme pour le joueur humain courant (si munitions disponibles) */
  public selectWeapon(weaponId: WeaponId): boolean {
    const player = this.getCurrentPlayer();
    if (!player || !player.isHuman || this.isInputLocked) return false;

    const ammo = player.inventory[weaponId] ?? 0;
    if (ammo <= 0) return false;
    if (player.tank.currentWeapon === weaponId) return false;

    player.tank.currentWeapon = weaponId;
    this.notifyHudUpdate();
    return true;
  }

  /** Cycle l'arme active (delta = +1 ou -1). Filtre sur les armes avec munitions > 0. */
  public cycleWeapon(delta: 1 | -1): boolean {
    const player = this.getCurrentPlayer();
    if (!player || !player.isHuman || this.isInputLocked) return false;

    const available = ALL_WEAPON_IDS.filter((id) => (player.inventory[id] ?? 0) > 0);
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

  /** Passe au joueur suivant (saute les tanks morts).
   *
   * - Saute automatiquement les joueurs dont tank.isDead === true.
   * - Quand l'index repasse à 0, on incrémente currentRound (manche suivante).
   * - La décision d'aller en SUMMARY (fin de partie) est prise côté React
   *   UNIQUEMENT quand il reste 0 ou 1 joueur vivant.
   */
  public nextTurn(): void {
    const players = this.tankManager.getPlayers();
    if (players.length === 0) return;

    let attempts = 0;
    const maxAttempts = players.length * 2;

    do {
      this.currentPlayerIndex++;

      if (this.currentPlayerIndex >= players.length) {
        this.currentPlayerIndex = 0;
        this.currentRound++;
      }

      attempts++;
    } while (
      players[this.currentPlayerIndex]?.tank.isDead &&
      attempts < maxAttempts
    );

    // Déverrouille les entrées pour le nouveau joueur (sera potentiellement re-verrouillé par l'IA)
    this.isInputLocked = false;
    this.clearResolutionTimeout(); // Clear any pending AI resolution timeout
    this.clearSettlementSafetyTimeout();
    this.clearTurnLockSafetyTimeout();

    const newPlayer = this.getCurrentPlayer();

    if (newPlayer) {
      this.onTurnChange?.(newPlayer, this.currentRound);
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
      round: this.currentRound,
      isInputLocked: this.isInputLocked,
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
    this.currentPlayerIndex = 0;
    this.currentRound = 1;
    this.isInputLocked = false;

    // Saute les joueurs morts au cas où
    const players = this.tankManager.getPlayers();
    while (players[this.currentPlayerIndex]?.tank.isDead) {
      this.currentPlayerIndex++;
      if (this.currentPlayerIndex >= players.length) {
        this.currentPlayerIndex = 0;
        this.currentRound++;
      }
    }

    const firstPlayer = this.getCurrentPlayer();
    if (firstPlayer) {
      this.onTurnChange?.(firstPlayer, this.currentRound);
      this.notifyHudUpdate();

      // Si c'est une IA, on lance son tour de manière asynchrone
      this.handleAITurnIfNeeded(firstPlayer);
    }
  }

  /** Réinitialise complètement le gestionnaire de tours */
  public reset(): void {
    this.clearResolutionTimeout();
    this.clearSettlementSafetyTimeout();
    this.clearTurnLockSafetyTimeout();
    this.currentPlayerIndex = 0;
    this.currentRound = 1;
    this.isInputLocked = false;
    this.isProcessingAI = false;
    this.removeInputListeners();

    // Invalidate any pending async AI activity
    this.aiTurnGeneration++;
  }

  /**
   * Gère le tour d'une IA de façon asynchrone.
   * Ne bloque pas le rendu du Canvas grâce à l'utilisation de setTimeout + Promise.
   */
  private async handleAITurnIfNeeded(player: Player): Promise<void> {
    if (player.isHuman || this.isProcessingAI) return;
    if (!this.aiEngine) {
      console.warn(`[TurnManager] No AIEngine configured for AI player ${player.name}. Skipping turn.`);
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
        phase: 'COMBAT',
        players: [...this.tankManager.getPlayers()],
        currentPlayerIndex: this.currentPlayerIndex,
        turn: this.currentRound,
      };

      const decision = await this.aiEngine.executeTurn(
        player.tank.id,
        gameState,
        this.terrainManager,
      );

      // Abort if the game moved on (SUMMARY/SHOP) while we were awaiting the strategy.
      if (this.aiTurnGeneration !== turnGeneration) {
        this.isProcessingAI = false;
        return;
      }

      player.tank.angle = Math.max(0, Math.min(180, decision.angle));
      player.tank.power = Math.max(0, Math.min(100, decision.power));
      this.notifyHudUpdate();

      // Artificial thinking delay
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Abort before firing if we have been paused for inter-round in the meantime.
      if (this.aiTurnGeneration !== turnGeneration || !this.isInputLocked) {
        this.isProcessingAI = false;
        return;
      }

      const command: FireCommand = {
        angle: player.tank.angle,
        power: player.tank.power,
        weaponId: player.tank.currentWeapon,
      };

      this.fireCallback(player.tank.position, command, player.id);

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
      const safetyGeneration = this.aiTurnGeneration;
      this.settlementSafetyTimeoutId = setTimeout(() => {
        if (this.aiTurnGeneration !== safetyGeneration) return;
        const stillCurrent = this.getCurrentPlayer();
        if (stillCurrent?.id === player.id && this.isInputLocked) {
          console.warn(`[TurnManager] Settlement did not advance turn for AI ${player.name} — forcing nextTurn as safety net`);
          this.isInputLocked = false;
          this.clearResolutionTimeout();
          this.clearSettlementSafetyTimeout();
          this.nextTurn();
        }
      }, 4500);
    } catch (error) {
      console.error('[TurnManager] AI turn failed:', error);
      this.clearResolutionTimeout();
      this.clearSettlementSafetyTimeout();
      setTimeout(() => this.nextTurn(), 1000);
    } finally {
      this.isProcessingAI = false;
    }
  }

  /** Starts a safety timeout that will force resolution if the AI turn gets stuck */
  private startResolutionTimeout(player: Player): void {
    this.clearResolutionTimeout();

    this.resolutionTimeoutId = setTimeout(() => {
      // Double-check we're still on this AI player and still locked
      const current = this.getCurrentPlayer();
      if (current?.id === player.id && this.isInputLocked) {
        console.warn(`[TurnManager] AI resolution timeout for ${player.name}. Triggering fallback.`);

        let fallback: { angle: number; power: number } | null = null;

        if (this.aiEngine?.getResolutionFallback) {
          fallback = this.aiEngine.getResolutionFallback();
        }

        if (fallback) {
          // AI provided a fallback shot
          player.tank.angle = Math.max(0, Math.min(180, fallback.angle));
          player.tank.power = Math.max(0, Math.min(100, fallback.power));
          this.notifyHudUpdate();

          const command: FireCommand = {
            angle: player.tank.angle,
            power: player.tank.power,
            weaponId: player.tank.currentWeapon,
          };
          this.fireCallback(player.tank.position, command, player.id);
        } else {
          // No fallback → just skip the turn (forfeit)
          console.warn(`[TurnManager] ${player.name} forfeits its turn (no resolution fallback).`);
          this.isInputLocked = false;
          this.clearSettlementSafetyTimeout();
          this.nextTurn();
        }
      }
      this.resolutionTimeoutId = null;
    }, this.AI_RESOLUTION_TIMEOUT_MS);
  }

  private clearResolutionTimeout(): void {
    if (this.resolutionTimeoutId) {
      clearTimeout(this.resolutionTimeoutId);
      this.resolutionTimeoutId = null;
    }
    // Also clear the settlement safety one when clearing resolution timers (common call sites)
    this.clearSettlementSafetyTimeout();
  }

  /** Clears the post-AI-shot settlement safety timer (prevents stale forces during SUMMARY/SHOP pauses) */
  private clearSettlementSafetyTimeout(): void {
    if (this.settlementSafetyTimeoutId) {
      clearTimeout(this.settlementSafetyTimeoutId);
      this.settlementSafetyTimeoutId = null;
    }
  }

  /** Clears the general turn-lock recovery watchdog */
  private clearTurnLockSafetyTimeout(): void {
    if (this.turnLockSafetyTimeoutId) {
      clearTimeout(this.turnLockSafetyTimeoutId);
      this.turnLockSafetyTimeoutId = null;
    }
  }

  /**
   * Arms (or re-arms) a recovery timer that will force the turn to advance
   * if the lock stays on for too long. This protects against missed settlement
   * notifications (physics edge cases, rapid round transitions, etc.).
   * The timer is automatically cleared on successful nextTurn / unlock.
   */
  private armTurnLockSafetyWatchdog(): void {
    this.clearTurnLockSafetyTimeout();

    const currentPlayerAtArm = this.getCurrentPlayer();
    if (!currentPlayerAtArm) return;

    const generationAtArm = this.aiTurnGeneration;

    this.turnLockSafetyTimeoutId = setTimeout(() => {
      // If the turn generation changed since we armed (e.g. we paused for SUMMARY/SHOP),
      // this watchdog is stale → just clean up, do not force.
      if (this.aiTurnGeneration !== generationAtArm) {
        this.clearTurnLockSafetyTimeout();
        return;
      }

      // Only act if we are *still* on the same player and still locked
      const stillCurrent = this.getCurrentPlayer();
      if (
        stillCurrent?.id === currentPlayerAtArm.id &&
        this.isInputLocked
      ) {
        console.warn(
          `[TurnManager] Turn lock safety watchdog triggered for ${stillCurrent.name} — forcing nextTurn (missed settlement?)`
        );
        this.isInputLocked = false;
        this.clearResolutionTimeout();
        this.clearSettlementSafetyTimeout();
        this.clearTurnLockSafetyTimeout();
        this.aiTurnGeneration++; // invalidate any other stale AI timers associated with this turn
        this.nextTurn();
      } else {
        // Stale timer, just clean up
        this.clearTurnLockSafetyTimeout();
      }
    }, this.TURN_LOCK_SAFETY_MS);
  }
}
