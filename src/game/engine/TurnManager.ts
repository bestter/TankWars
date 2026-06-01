/**
 * TankWars - TurnManager
 *
 * Gestionnaire des tours de jeu et des entrées clavier du joueur humain.
 * Respecte l'architecture : découplé de React, communication via callbacks.
 */

import type { Player } from '../../types/player';
import type { TankManager } from '../entities/TankManager';
import type { PhysicsEngine } from './PhysicsEngine';
import type { FireCommand } from '../../types/game';
import type { AIEngine } from '../entities/ai/AIEngine';
import type { TerrainManager } from './Terrain';
import type { GameState } from '../../types/game';

export interface CurrentTurnInfo {
  playerName: string;
  playerId: string;
  isHuman: boolean;
  angle: number;
  power: number;
  currentWeapon: string;
  round: number;
  isInputLocked: boolean;
}

export class TurnManager {
  private tankManager: TankManager;
  private terrainManager: TerrainManager;
  private fireCallback: (from: { x: number; y: number }, command: FireCommand) => void;
  private aiEngine?: AIEngine;

  private currentPlayerIndex = 0;
  private currentRound = 1;
  private isInputLocked = false;

  private listenersAttached = false;
  private isProcessingAI = false;

  // Callbacks pour le HUD React
  public onHudUpdate?: (info: CurrentTurnInfo) => void;
  public onTurnChange?: (player: Player, round: number) => void;

  constructor(
    tankManager: TankManager,
    terrainManager: TerrainManager,
    fireCallback: (from: { x: number; y: number }, command: FireCommand) => void,
    aiEngine?: AIEngine,
  ) {
    this.tankManager = tankManager;
    this.terrainManager = terrainManager;
    this.fireCallback = fireCallback;
    this.aiEngine = aiEngine;
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

    this.fireCallback(tank.position, command);

    // Verrouille les inputs jusqu'à la fin de la résolution
    this.isInputLocked = true;
    this.notifyHudUpdate();
  }

  /** Passe au joueur suivant (saute les tanks morts) */
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
      angle: Math.round(player.tank.angle),
      power: Math.round(player.tank.power),
      currentWeapon: player.tank.currentWeapon,
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
    this.currentPlayerIndex = 0;
    this.currentRound = 1;
    this.isInputLocked = false;
    this.isProcessingAI = false;
    this.removeInputListeners();
  }

  /**
   * Gère le tour d'une IA de façon asynchrone.
   * Ne bloque pas le rendu du Canvas grâce à l'utilisation de setTimeout + Promise.
   */
  private async handleAITurnIfNeeded(player: Player): Promise<void> {
    if (player.isHuman || this.isProcessingAI) return;
    if (!this.aiEngine) {
      // Pas de moteur IA configuré → on passe le tour automatiquement
      console.warn(`[TurnManager] No AIEngine configured for AI player ${player.name}. Skipping turn.`);
      setTimeout(() => this.nextTurn(), 800);
      return;
    }

    this.isProcessingAI = true;
    this.isInputLocked = true;
    this.notifyHudUpdate();

    try {
      // Construire un GameState minimal pour l'IA
      const gameState: GameState = {
        phase: 'COMBAT',
        players: [...this.tankManager.getPlayers()], // copy to mutable array
        currentPlayerIndex: this.currentPlayerIndex,
        turn: this.currentRound,
      };

      // Appel de la stratégie IA
      const decision = await this.aiEngine.executeTurn(
        player.tank.id,
        gameState,
        this.terrainManager,
      );

      // Applique les valeurs sur le tank (visible dans le HUD)
      player.tank.angle = Math.max(0, Math.min(180, decision.angle));
      player.tank.power = Math.max(0, Math.min(100, decision.power));
      this.notifyHudUpdate();

      // Délai artificiel pour simuler la "réflexion" de l'IA (1.5s)
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Déclenche le tir automatiquement
      const command: FireCommand = {
        angle: player.tank.angle,
        power: player.tank.power,
        weaponId: player.tank.currentWeapon,
      };

      this.fireCallback(player.tank.position, command);

      // Les inputs restent verrouillés jusqu'à la fin de la résolution (géré par PhysicsEngine)
    } catch (error) {
      console.error('[TurnManager] AI turn failed:', error);
      // En cas d'erreur, on passe quand même au tour suivant après un délai
      setTimeout(() => this.nextTurn(), 1000);
    } finally {
      this.isProcessingAI = false;
    }
  }
}
