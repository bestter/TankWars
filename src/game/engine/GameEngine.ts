import { prepareRound, isRoundMap, hasValidSpawnRoster, type RoundMap, type PreparedRound } from "../round/prepareRound";
import type { DiagnosticInput, DiagnosticState } from "../diagnostics/types";
import { secureRandom } from "../../utils/random";
import { CombatAudio } from "./audio/CombatAudio";
import { CelebrationFireworks } from "./vfx/celebrationFireworks";
import { ImpactExplosions, type ImpactExplosion } from "./vfx/impactExplosions";
import {
  TerrainImpactParticles,
  type TerrainImpactParticle,
} from "./vfx/terrainImpactParticles";

export type { TerrainImpactParticle };
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
 * - AI decisions are handled externally via TurnManager and AIEngine implementations.
 */

import { TerrainManager } from "./Terrain";
import { PhysicsEngine } from "./PhysicsEngine";
import { launchFromBarrel } from "./projectileMotion";
import { TankManager } from "../entities/TankManager";
import { TurnManager } from "./TurnManager";
import { WEAPON_REGISTRY, type WeaponId } from "../../types/weapon";
import type { CombatObserver } from "../endurance/types";
import type { Player } from "../../types/player";
import { VGA_PALETTE } from "../../types/game";
import type { Vector2, FireCommand, RoundResult, GamePhase } from "../../types/game";
import type { RoundEndPayload } from "../../types/round";
import type { AIEngine } from "../entities/ai/AIEngine";
import i18n from "../../i18n";
import { rollRoundWind } from "../wind";
import {
  calculateShotRewards,
  type CombatDamageEvent,
  type CombatDestructionEvent,
  type ShotRewardResult,
  type PlayerShotReward,
} from "../economy/shotRewards";
import {
  allocateZeusStrike,
  createZeusState,
  evaluateZeusDeadlock,
  resetZeusRound,
  selectZeusTarget,
  type ZeusAppointment,
  type ZeusState,
  type ZeusStrike,
  type ZeusStrikeResult,
} from "../zeus/zeusDomain";
import { calculateZeusStrikeReward } from "../zeus/zeusRewards";

export interface GameConfig {
  /** Vertical acceleration (pixels per second²). Higher = stronger gravity. */
  gravity: number;
  /** Horizontal wind acceleration (can be negative). */
  windForce: number;
  /** Base velocity multiplier for power (0-100). Tunable feel. */
  baseShotSpeed: number;
  /** When true the engine runs without rAF, audio, input listeners or VFX. Used for authoritative server simulation. */
  headless?: boolean;
}

interface HitEvent {
  x: number;
  y: number;
  weaponId: WeaponId;
  ownerId: string;
  blastRadius: number;
}

interface ActiveShotLedger {
  shotId: number;
  shooterId: string;
  weaponId: WeaponId;
  isFirstShotOfRound: boolean;
  suppressEconomyReport: boolean;
  aliveBeforeShot: string[];
  damageEvents: CombatDamageEvent[];
  destructionEvents: CombatDestructionEvent[];
}

export interface ResolvedShotPreview extends ShotRewardResult {
  balances: ReadonlyArray<{ playerId: string; money: number }>;
  directHitVictimIds: string[];
}

interface ActiveZeusVisual {
  strike: ZeusStrike;
  elapsedSeconds: number;
  impactApplied: boolean;
  localAuthoritative: boolean;
  result: ZeusStrikeResult | null;
}

export class GameEngine {
  public diagnosticSink?: (input: DiagnosticInput) => void;
  public diagnosticPhase?: () => GamePhase;
  public diagnosticFreeWeapons = false;
  private diagnosticStep = 0;
  public captureDiagnosticState(): DiagnosticState {
    const state = this.turnManager.captureDiagnosticContext();
    state.phase = this.diagnosticPhase?.() ?? state.phase;
    return { state, motion: this.tankManager.capturePhysicsState(),
      width: this.terrain.width, height: this.terrain.height,
      heights: [...this.terrain.getHeightmap()], materials: [...this.terrain.getMaterials()],
      localMatch: this.localMatch, freeWeapons: this.diagnosticFreeWeapons,
      initialPlayerCount: this.tankManager.getPlayers().length,
      projectiles: structuredClone([...this.physicsEngine.getProjectiles()]), step: this.diagnosticStep,
      inProgress: this.physicsEngine.hasActiveProjectiles() || this.tankManager.anyTankIsFalling() };
  }
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

  // For transition-based "projectiles just settled" detection (avoids calling onAllProjectilesSettled
  // every single frame while idle, which was causing log spam during SHOP/SUMMARY/idle periods).
  private previousProjectileCount = 0;

  // Game over state (entire match ended)
  private gameOver = false;
  private winner: import("../../types/player").Player | null = null;

  /** True while tanks are fighting within a single combat round (until <= 1 alive: last man standing). */
  private roundCombatActive = true;

  /** Local hotseat / vs-AI. Online match sets this to false (humans keep sand spawns). */
  private localMatch = true;

  public setLocalMatch(local: boolean): void {
    this.localMatch = local;
    this.physicsEngine.setLocalMatch(local);
  }

  public isRoundCombatActive(): boolean {
    return this.roundCombatActive;
  }

  /** SUMMARY / SHOP / CELEBRATION — combat simulation paused until next round. */
  public enterInterRoundPhase(): void {
    this.roundCombatActive = false;
    this.physicsEngine.clear(false);
    this.turnManager.pauseForInterRound();
    this.terrainImpactParticles.clear();
    this.clearZeusVisuals();
  }

  // === Registre économique de la manche et de la résolution active ===
  private roundDamageDealt: Record<string, number> = {};
  private roundEarningsByPlayer: Record<string, number> = {};
  private roundTerrainDestroyed = 0;
  private currentFirerId: string | null = null;
  private activeShotLedger: ActiveShotLedger | null = null;
  private pendingShotResult: ResolvedShotPreview | null = null;
  private lastConfirmedOnlineShotId = 0;
  private lastCountedOnlineShotId = 0;
  private nextShotId = 1;
  private shotNumberInRound = 0;
  private lastAppliedShotId = 0;
  private zeusState: ZeusState = createZeusState();
  private pendingZeusAppointment: ZeusAppointment | null = null;
  private activeZeusVisual: ActiveZeusVisual | null = null;
  private pendingSpecialRoundOutcome: ShotRewardResult["roundOutcome"] | null = null;
  private lastAppliedZeusStrikeId = 0;
  private zeusFlashLife = 0;

  // Debug: accumulate death reasons to produce a clear summary at game end (especially for "partie nulle")
  private deathReasons: Record<
    string,
    Array<{ cause: string; info?: string; round?: number }>
  > = {};

  private readonly audio: CombatAudio;
  private readonly celebrationFireworks: CelebrationFireworks;
  private readonly impactExplosions: ImpactExplosions;
  private readonly terrainImpactParticles: TerrainImpactParticles;

  // === Callbacks for React layer decoupling ===
  public onProjectileHit?: (event: HitEvent) => void;
  public combatObserver?: CombatObserver;
  public onAllProjectilesSettled?: () => void;
  /** Fired when a new combat round rolls wind (React HUD). */
  public onWindChange?: (force: number) => void;
  public onPhysicsStep?: (projectiles: ReadonlyArray<import("./PhysicsEngine").Projectile>) => void;

  /** Callback pour le HUD React (angle, puissance, joueur actif, etc.) */
  public onTurnHudUpdate?: (
    info: import("./TurnManager").CurrentTurnInfo,
  ) => void;

  /** Called when only one player remains alive (entire match). */
  public onGameOver?: (winner: import("../../types/player").Player) => void;

  /** Called when all players are dead (match draw). */
  public onDraw?: () => void;

  /**
   * Called once when a combat round ends (last man standing: 0 or 1 tanks alive).
   * React shows SUMMARY → SHOP if the match continues, or GAME_OVER if not.
   */
  public onRoundEnded?: (payload: RoundEndPayload) => void;
  public onShotResolved?: (preview: ResolvedShotPreview) => void;
  public onZeusAppointed?: (appointment: ZeusAppointment) => void;
  public onZeusStrikeApplied?: (result: ZeusStrikeResult) => void;

  constructor(width: number, height: number, config: Partial<GameConfig> = {}) {
    this.width = Math.floor(width);
    this.height = Math.floor(height);
    this.audio = new CombatAudio({ getWidth: () => this.width });
    this.celebrationFireworks = new CelebrationFireworks({
      width: this.width,
      height: this.height,
      getGroundHeight: (x) => this.terrain.getHeightAt(x),
      onBurst: (x) => this.audio.playFireworkPop(x),
    });
    this.impactExplosions = new ImpactExplosions({
      width: this.width,
      height: this.height,
    });
    this.terrainImpactParticles = new TerrainImpactParticles();

    this.terrain = new TerrainManager(this.width, this.height);

    this.physicsEngine = new PhysicsEngine();
    this.physicsEngine.setLocalMatch(this.localMatch);
    this.tankManager = new TankManager();

    // Wire debug death recorder and audio. L'économie passe par les événements structurés séparés.
    this.tankManager.onPlayerDied = (playerId, cause, details) => {
      this.combatObserver?.emit({ kind: "death", playerId, cause });
      this.recordDeath(playerId, cause, details);
      if (cause === "explosion" || cause === "zeus") {
        this.audio.playTankDestroyedByExplosion();
      } else if (cause === "burial") {
        this.audio.playTankSadBurial();
      }
    };
    this.tankManager.onDamageApplied = (event) => {
      this.combatObserver?.emit({ kind: "damage", event });
      if (event.shotId !== this.activeShotLedger?.shotId) return;
      this.activeShotLedger.damageEvents.push(event);
    };
    this.tankManager.onTankDestroyed = (event) => {
      this.combatObserver?.emit({ kind: "destruction", event });
      if (event.shotId !== this.activeShotLedger?.shotId) return;
      this.activeShotLedger.destructionEvents.push(event);
    };

    // Wire tank movement / pit SFX (consumed by applyGravity in TankManager)
    this.tankManager.onTankSliding = (playerId) =>
      this.audio.playTankSliding(playerId);
    this.tankManager.onTankTouchedFloor = () =>
      this.audio.playTankTouchLowestFloor();

    // Crée le TurnManager avec un callback de tir
    this.turnManager = new TurnManager(
      this.tankManager,
      this.terrain,
      (from, command, ownerId, identity) => {
        return this.fireProjectile(from, command, ownerId ?? "unknown", identity);
      },
    );

    // Connecte le TurnManager au système de physique (fin de volée → nextTurn)
    this.turnManager.connectToPhysics(this.physicsEngine);
    this.turnManager.setMatchEndedChecker(() => this.gameOver);
    this.turnManager.setLocalShotContextProvider(() => ({
      playerCountAtMatchStart: this.tankManager.getPlayers().length,
      isFirstShotOfRound: this.shotNumberInRound === 0,
    }));
    this.turnManager.onShotResolutionReady = () => {
      const preview = this.finalizeActiveShot();
      const appointment = this.pendingZeusAppointment;
      this.pendingZeusAppointment = null;
      return {
        hasEarnings: preview?.hasEarnings ?? false,
        isRoundEnd: preview?.roundOutcome.isRoundEnd ?? false,
        nextPlayerId: appointment?.zeusId,
      };
    };
    this.turnManager.onResolvedRoundEnd = () => { if (this.localMatch) this.completeResolvedRound(); };
    this.turnManager.onSpecialTurn = (player) => this.beginLocalZeusTurn(player.id);

    // Transmet les mises à jour HUD du TurnManager vers l'extérieur (React)
    this.turnManager.onHudUpdate = (info) => {
      this.onTurnHudUpdate?.(info);
    };

    // Forward hit events from PhysicsEngine for VFX/audio.
    this.physicsEngine.onProjectileHit = (hit) => {
      this.diagnosticSink?.({ kind: "impact", hit: structuredClone(hit), step: this.diagnosticStep, material: this.terrain.getMaterialAt(hit.x) });
      const firer = this.currentFirerId ?? "unknown";
      const weapon = WEAPON_REGISTRY[hit.weaponId];
      const blastRadius = weapon?.blastRadius ?? 28;

      this.onProjectileHit?.({
        x: hit.x,
        y: hit.y,
        weaponId: hit.weaponId,
        ownerId: firer,
        blastRadius,
      });

      // Distinct impact/explosion sound per projectile (called for every terrain/tank hit)
      this.audio.playImpact(hit.weaponId);

      // Huge red-orange thermonuclear explosion VFX (flash + particles)
      if (hit.weaponId === "THERMONUCLEAR") {
        this.impactExplosions.spawnThermonuclear(hit.x, hit.y);
      } else if (
        !this.config.headless &&
        hit.weaponId !== "BULLDOZER" &&
        (hit.weaponId === "DRILLER" || blastRadius > 0)
      ) {
        this.terrainImpactParticles.spawn(
          hit.x,
          hit.y,
          this.physicsEngine.getLastImpactMaterial(),
        );
      }
    };

    this.config = {
      gravity: 220,
      windForce: 0,
      baseShotSpeed: 380,
      ...config,
    };

    this.windForce = this.config.windForce;
    this.turnManager.setEnvironment(this.windForce, this.config.gravity);
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

  public getPhysicsEngine(): PhysicsEngine { return this.physicsEngine; }

  /** Permet d'injecter une stratégie d'IA (ex: AISimpleStrategy or AIByProfileStrategy for mixed v1/v2). */
  public setAIEngine(aiEngine: AIEngine): void {
    this.turnManager.setAIEngine(aiEngine);
  }

  public setRoundNumber(roundNumber: number): void {
    this.turnManager.setRoundNumber(roundNumber);
  }

  /** For online multiplayer: tells the engine which player id is controlled by this client.
   *  Used by TurnManager to lock input for other players' turns. */
  public setLocalPlayerId(playerId: string | undefined): void {
    this.turnManager.setLocalPlayerId(playerId);
  }

  /** Initialise les joueurs et place leurs tanks sur le terrain */
  public setPlayers(players: Player[], map?: RoundMap): void {
    const prepared = this.prepareCombatRound(players, 1, map);
    this.applyPreparedRound(prepared);
    this.roundCombatActive = true;
    this.gameOver = false;
    this.winner = null;
    this.audio.resetSlideThrottle();
    this.turnManager.setEnvironment(this.windForce, this.config.gravity);
    this.turnManager.setRoundNumber(map?.roundNumber ?? 1);

    // Initialise le système de tours
    this.turnManager.startFirstTurn();
    this.turnManager.setupInputListeners();
  }

  public getActiveProjectiles(): ReadonlyArray<import("./PhysicsEngine").Projectile> {
    return this.physicsEngine.getProjectiles();
  }

  public getWindForce(): number {
    return this.windForce;
  }

  public setWindForce(force: number): void {
    this.windForce = force;
    this.onWindChange?.(this.windForce);
    this.turnManager.setEnvironment(this.windForce, this.config.gravity);
  }

  /** New random wind for a combat round; notifies React via onWindChange. */
  public randomizeWindForRound(): void {
    this.setWindForce(rollRoundWind());
    console.log(`[WIND] New round wind: ${this.windForce.toFixed(1)} px/s²`);
  }


  /**
   * Fire a projectile. Called by human input or by AI strategy.
   * Angle in degrees (0 = right, positive = CCW / upward).
   * ownerId is used for structured damage and destruction attribution.
   */
  public fireProjectile(
    from: Vector2,
    command: FireCommand,
    ownerId: string = "unknown",
    identity?: {
      shotId: number;
      isFirstShotOfRound: boolean;
      suppressEconomyReport?: boolean;
      physicsSeed?: number;
    },
  ): boolean {
    const weapon = WEAPON_REGISTRY[command.weaponId];
    if (!weapon) {
      this.combatObserver?.emit({ kind: "shot-refused", playerId: ownerId, command: { ...command }, reason: "unknown-weapon" });
      console.warn(`Unknown weapon: ${command.weaponId}`);
      return false;
    }
    if (this.activeShotLedger !== null) {
      this.combatObserver?.emit({ kind: "shot-refused", playerId: ownerId, command: { ...command }, reason: "active-shot" });
      console.warn("[GameEngine] Refus d'un second tir avant la finalisation du tir actif.");
      return false;
    }

    this.physicsEngine.setShotSeed(identity?.physicsSeed);
    this.currentFirerId = ownerId;
    this.shotNumberInRound++;
    const shotId = identity?.shotId ?? this.nextShotId++;
    if (this.combatObserver?.emit({ kind: "shot", shotId, playerId: ownerId, command: { ...command } }) === false) {
      this.diagnosticSink?.({ kind: "combat", event: { kind: "shot-refused", playerId: ownerId, command: { ...command }, reason: "observer" } });
      return false;
    }
    const isFirstShotOfRound = identity?.isFirstShotOfRound ?? this.shotNumberInRound === 1;
    this.diagnosticSink?.({ kind: "pre-shot", snapshot: this.captureDiagnosticState(),
      shot: { shotId, playerId: ownerId, command: { ...command }, origin: { ...from }, isFirstShotOfRound } });
    const aliveBeforeShot = this.tankManager.getAlivePlayers().map((player) => player.id);
    this.activeShotLedger = {
      shotId,
      shooterId: ownerId,
      weaponId: command.weaponId,
      isFirstShotOfRound,
      suppressEconomyReport: identity?.suppressEconomyReport === true,
      aliveBeforeShot,
      damageEvents: [],
      destructionEvents: [],
    };
    this.pendingShotResult = null;
    this.tankManager.beginShotAttribution(shotId, ownerId, command.weaponId);

    // Per-weapon fire sound (distinct for each projectile type)
    this.audio.playFire(command.weaponId);

    // Calculate barrel tip position so the projectile starts at the end of the barrel
    // instead of the bottom-center of the tank (which is on the ground and causes self-explosions/missed settlements).
    const { x: launchX, y: launchY } = launchFromBarrel(from.x, from.y, command.angle);

    console.log(
      `[SHOT] weapon=${command.weaponId} angle=${command.angle} power=${command.power} (owner and coordinates redacted)`,
    );

    // Lookup firer color for projectile harmonization + recoil trigger (Step 4 polish)
    const firerPlayer = this.tankManager.getPlayerById(ownerId);
    const ownerColor = firerPlayer?.tank.color;

    // Micro recoil on chassis at fire instant (opposite barrel dir)
    if (firerPlayer) {
      this.tankManager.triggerRecoil(firerPlayer.tank.id, command.angle);
    }

    // Délégation complète au PhysicsEngine (nouveau système) — now with owner + color for attribution + visuals
    this.physicsEngine.launchProjectile(
      launchX,
      launchY,
      command.angle,
      command.power,
      command.weaponId,
      ownerId,
      ownerColor,
      { shotId, munitionId: 0 },
    );
    if (this.diagnosticSink) {
      const projectile = this.physicsEngine.getProjectiles().find(p => p.shotId === shotId && p.munitionId === 0);
      if (projectile) this.diagnosticSink({ kind: "projectile-launched", projectile: structuredClone(projectile), step: this.diagnosticStep });
    }
    this.combatObserver?.emit({ kind: "shot-launched", shotId, playerId: ownerId, command: { ...command },
      position: { ...from }, launch: { x: launchX, y: launchY } });
    return true;
  }

  /** Associe l'identifiant serveur au tir optimiste encore actif. */
  public associateActiveShotId(shotId: number, isFirstShotOfRound: boolean): boolean {
    if (!Number.isSafeInteger(shotId) || shotId < 0 || !this.activeShotLedger) return false;
    const previousShotId = this.activeShotLedger.shotId;
    this.activeShotLedger.shotId = shotId;
    this.activeShotLedger.isFirstShotOfRound = isFirstShotOfRound;
    for (const event of this.activeShotLedger.damageEvents) event.shotId = shotId;
    for (const event of this.activeShotLedger.destructionEvents) event.shotId = shotId;
    this.tankManager.reassignShotAttribution(previousShotId, shotId);
    this.physicsEngine.reassignShotId(previousShotId, shotId);
    return true;
  }

  // === Gains par résolution et résumé de manche ===

  public buildRoundResult(): RoundResult {
    return {
      damageDealt: { ...this.roundDamageDealt },
      earningsByPlayer: { ...this.roundEarningsByPlayer },
      terrainDestroyed: this.roundTerrainDestroyed,
      survivors: this.tankManager.getAlivePlayers().map((player) => player.id),
    };
  }

  public getPendingShotResult(): ResolvedShotPreview | null {
    return this.pendingShotResult;
  }

  public confirmOnlineShotDamage(shotId: number): void {
    this.lastConfirmedOnlineShotId = Math.max(this.lastConfirmedOnlineShotId, shotId);
    if (this.pendingShotResult) this.countConfirmedOnlineShotDamage(this.pendingShotResult);
  }

  private countConfirmedOnlineShotDamage(preview: ResolvedShotPreview): void {
    if (preview.shotId > this.lastConfirmedOnlineShotId || preview.shotId <= this.lastCountedOnlineShotId) return;
    this.lastCountedOnlineShotId = preview.shotId;
    this.addRoundDamage(preview);
  }

  private addRoundDamage(shot: ShotRewardResult): void {
    for (const [playerId, damageMilli] of Object.entries(shot.damageDealtMilliByPlayer)) {
      this.roundDamageDealt[playerId] =
        (this.roundDamageDealt[playerId] ?? 0) + damageMilli / 1_000;
    }
  }

  public getRoundEarningsByPlayer(): Record<string, number> {
    return { ...this.roundEarningsByPlayer };
  }

  public restoreRoundEarningsByPlayer(earnings: Readonly<Record<string, number>>): void {
    const restored: Record<string, number> = {};
    for (const [playerId, amount] of Object.entries(earnings)) {
      if (!this.tankManager.getPlayerById(playerId)) continue;
      if (!Number.isSafeInteger(amount) || amount < 0) {
        throw new RangeError("Un gain de manche restauré doit être un entier sûr positif ou nul.");
      }
      restored[playerId] = amount;
    }
    this.roundEarningsByPlayer = restored;
  }

  private finalizeActiveShot(): ResolvedShotPreview | null {
    if (!this.activeShotLedger) return this.pendingShotResult;
    const ledger = this.activeShotLedger;
    if (ledger.suppressEconomyReport) {
      this.activeShotLedger = null;
      this.pendingShotResult = null;
      this.tankManager.clearShotAttribution();
      return null;
    }
    const survivorsAfterShot = this.tankManager.getAlivePlayers().map((player) => player.id);
    if (this.combatObserver?.emit({ kind: "resolved", shotId: ledger.shotId }) === false) return null;
    const reward = calculateShotRewards({
      ...ledger,
      playerCountAtMatchStart: this.tankManager.getPlayers().length,
      survivorsAfterShot,
    });
    if (import.meta.env.DEV && this.localMatch) {
      const shooter = this.tankManager.getPlayerById(ledger.shooterId);
      if (shooter && !shooter.isHuman) {
        console.info("[AI] Résultat réel du tir", JSON.stringify({
          shotId: ledger.shotId,
          shooterId: ledger.shooterId,
          profile: shooter.aiProfile,
          weaponId: ledger.weaponId,
          isFirstShotOfRound: ledger.isFirstShotOfRound,
          aliveBeforeShot: [...ledger.aliveBeforeShot],
          survivorsAfterShot,
          damage: ledger.damageEvents.map((event) => ({
            victimId: event.victimId,
            source: event.source,
            classification: event.classification,
            shield: event.shieldAbsorbedMilli / 1_000,
            shieldAbsorbed: event.shieldAbsorbedMilli / 1_000,
            shieldLost: event.shieldLostMilli / 1_000,
            health: event.healthDamageMilli / 1_000,
          })),
          destructions: ledger.destructionEvents.map((event) => ({
            victimId: event.victimId,
            cause: event.cause,
          })),
          awards: reward.awards.map((award) => ({
            playerId: award.playerId,
            amount: award.amount,
          })),
        }));
      }
    }
    const awardMap = new Map<string, number>();
    for (const award of reward.awards) {
      awardMap.set(award.playerId, award.amount);
    }
    const balances = this.tankManager.getPlayers().map((player) => ({
      playerId: player.id,
      money: player.money + (awardMap.get(player.id) ?? 0),
    }));
    if (balances.some((balance) => !Number.isSafeInteger(balance.money))) {
      throw new RangeError("Un solde calculé dépasse la plage des entiers sûrs.");
    }
    const directHitVictims = new Set<string>();
    for (const event of ledger.damageEvents) {
      if (
        event.classification === "direct" &&
        event.weaponId !== "BULLDOZER" &&
        event.shooterId !== event.victimId
      ) {
        directHitVictims.add(event.victimId);
      }
    }
    const directHitVictimIds = [...directHitVictims];
    const preview: ResolvedShotPreview = { ...reward, balances, directHitVictimIds };
    this.pendingShotResult = preview;
    this.activeShotLedger = null;
    this.tankManager.clearShotAttribution();

    if (this.localMatch) {
      this.addRoundDamage(preview);
      this.applyResolvedEarnings(preview.shotId, balances, preview.awards);
      this.combatObserver?.emit({ kind: "shot-result", shotId: preview.shotId, awards: structuredClone(preview.awards) });
      this.diagnosticSink?.({ kind: "settled", snapshot: this.captureDiagnosticState() });
      const evaluation = evaluateZeusDeadlock(
        this.zeusState,
        this.tankManager.getPlayers(),
        preview.hasEarnings,
        secureRandom,
      );
      this.zeusState = evaluation.state;
      if (evaluation.zeusRevoked) this.clearZeusVisuals();
      if (evaluation.appointment) {
        this.pendingZeusAppointment = evaluation.appointment;
        this.audio.playZeusAppointment();
        this.onZeusAppointed?.(evaluation.appointment);
      }
    } else {
      this.countConfirmedOnlineShotDamage(preview);
    }
    this.onShotResolved?.(preview);
    return preview;
  }

  public applyResolvedEarnings(
    shotId: number,
    balances: ReadonlyArray<{ playerId: string; money: number }>,
    awards: readonly PlayerShotReward[] = [],
  ): void {
    if (!Number.isSafeInteger(shotId) || shotId <= this.lastAppliedShotId) return;
    const seen = new Set<string>();
    const updates: Array<{ player: Player; money: number; delta: number }> = [];
    for (const balance of balances) {
      if (seen.has(balance.playerId)) throw new RangeError("Solde reçu en double pour un joueur.");
      seen.add(balance.playerId);
      if (!Number.isSafeInteger(balance.money) || balance.money < 0) {
        throw new RangeError("Le solde autoritaire doit être un entier sûr positif ou nul.");
      }
      const player = this.tankManager.getPlayerById(balance.playerId);
      if (!player) throw new RangeError("Le solde autoritaire vise un joueur inconnu.");
      updates.push({ player, money: balance.money, delta: balance.money - player.money });
    }
    for (const update of updates) {
      update.player.money = update.money;
      if (update.delta > 0) {
        this.roundEarningsByPlayer[update.player.id] =
          (this.roundEarningsByPlayer[update.player.id] ?? 0) + update.delta;
      }
    }
    this.lastAppliedShotId = shotId;
    const componentsByPlayer = new Map(awards.map(award => [award.playerId, award.components]));
    for (const update of updates) if (update.delta > 0) this.combatObserver?.emit({ kind: "credit", credit: {
      source: "shot", causalId: shotId, playerId: update.player.id, amount: update.delta,
      before: update.money - update.delta, after: update.money,
      components: structuredClone(componentsByPlayer.get(update.player.id) ?? []) } });
  }

  public syncAuthoritativeBalances(
    balances: ReadonlyArray<{ playerId: string; money: number }>,
  ): void {
    const updates = balances.map((balance) => {
      if (!Number.isSafeInteger(balance.money) || balance.money < 0) {
        throw new RangeError("Le solde autoritaire doit être un entier sûr positif ou nul.");
      }
      const player = this.tankManager.getPlayerById(balance.playerId);
      if (!player) throw new RangeError("Le solde autoritaire vise un joueur inconnu.");
      return { player, money: balance.money };
    });
    for (const update of updates) update.player.money = update.money;
  }

  public getActiveZeusId(): string | null {
    return this.zeusState.activeZeusId;
  }

  public applyRemoteZeusAppointment(appointment: ZeusAppointment): void {
    if (appointment.appointmentId < this.zeusState.nextAppointmentId) return;
    this.zeusState = {
      ...this.zeusState,
      shotsWithoutEarnings: 0,
      activeZeusId: appointment.zeusId,
      appointedPlayerIds: this.zeusState.appointedPlayerIds.includes(appointment.zeusId)
        ? this.zeusState.appointedPlayerIds
        : [...this.zeusState.appointedPlayerIds, appointment.zeusId],
      nextAppointmentId: appointment.appointmentId + 1,
    };
    this.turnManager.lockSpecialTurn();
    this.audio.playZeusAppointment();
    this.onZeusAppointed?.(appointment);
  }

  public syncRemoteZeusState(activeZeusId: string | null): void {
    this.zeusState = { ...this.zeusState, activeZeusId, shotsWithoutEarnings: 0 };
    if (activeZeusId === null) this.clearZeusVisuals();
  }

  public startRemoteZeusStrike(strike: ZeusStrike, resolveAt = Date.now() + 700): void {
    if (strike.strikeId <= this.lastAppliedZeusStrikeId) return;
    if (this.activeZeusVisual?.strike.strikeId === strike.strikeId) return;
    this.turnManager.lockSpecialTurn();
    this.activeZeusVisual = {
      strike,
      elapsedSeconds: Math.max(0, (Date.now() - (resolveAt - 700)) / 1_000),
      impactApplied: false,
      localAuthoritative: false,
      result: null,
    };
  }

  public applyRemoteZeusStrikeResult(result: ZeusStrikeResult): boolean {
    if (result.strikeId <= this.lastAppliedZeusStrikeId) return false;
    const target = this.tankManager.getPlayerById(result.targetId);
    this.audio.playZeusStrike();
    if (target && !target.tank.isDead) {
      this.tankManager.applyZeusStrike(result.zeusId, result.targetId);
    }
    if (this.localMatch) this.applyZeusBalances(result.balances);
    this.lastAppliedZeusStrikeId = result.strikeId;
    this.zeusFlashLife = 8;
    if (this.activeZeusVisual?.strike.strikeId === result.strikeId) {
      this.activeZeusVisual.impactApplied = true;
      this.activeZeusVisual.result = result;
    }
    this.turnManager.releaseSpecialTurn();
    this.onZeusStrikeApplied?.(result);
    if (result.roundOutcome.isRoundEnd) this.pendingSpecialRoundOutcome = result.roundOutcome;
    return true;
  }

  private applyZeusBalances(
    balances: ReadonlyArray<{ playerId: string; money: number }>,
  ): void {
    const updates = balances.map((balance) => {
      if (!Number.isSafeInteger(balance.money) || balance.money < 0) {
        throw new RangeError("Le solde Zeus doit être un entier sûr positif ou nul.");
      }
      const player = this.tankManager.getPlayerById(balance.playerId);
      if (!player) throw new RangeError("Le solde Zeus vise un joueur inconnu.");
      return { player, money: balance.money, delta: balance.money - player.money };
    });
    for (const update of updates) {
      update.player.money = update.money;
      if (update.delta > 0) {
        this.roundEarningsByPlayer[update.player.id] =
          (this.roundEarningsByPlayer[update.player.id] ?? 0) + update.delta;
      }
    }
  }

  private beginLocalZeusTurn(playerId: string): boolean {
    if (!this.localMatch || this.zeusState.activeZeusId !== playerId) return false;
    if (this.activeZeusVisual !== null) return true;
    const selection = selectZeusTarget(
      this.tankManager.getPlayers(),
      playerId,
      secureRandom,
    );
    if (!selection) return false;
    const zeus = this.tankManager.getPlayerById(playerId);
    if (zeus) zeus.tank.lastDirectAttackerId = undefined;
    const allocation = allocateZeusStrike(this.zeusState, playerId, selection.targetId);
    this.zeusState = allocation.state;
    this.activeZeusVisual = {
      strike: allocation.strike,
      elapsedSeconds: 0,
      impactApplied: false,
      localAuthoritative: true,
      result: null,
    };
    return true;
  }

  private updateZeusStrike(dt: number): void {
    const visual = this.activeZeusVisual;
    if (!visual) return;
    visual.elapsedSeconds += dt;

    if (
      visual.localAuthoritative &&
      !visual.impactApplied &&
      visual.elapsedSeconds >= 0.7
    ) {
      visual.impactApplied = true;
      this.audio.playZeusStrike();
      if (this.tankManager.applyZeusStrike(visual.strike.zeusId, visual.strike.targetId)) {
        const reward = calculateZeusStrikeReward(
          visual.strike.zeusId,
          this.tankManager.getPlayers().length,
          this.tankManager.getAlivePlayers().map((player) => player.id),
        );
        const balances = this.tankManager.getPlayers().map((player) => ({
          playerId: player.id,
          money:
            player.money +
            (player.id === reward.award.playerId ? reward.award.amount : 0),
        }));
        const before = this.tankManager.getPlayerById(reward.award.playerId)!.money;
        this.applyZeusBalances(balances);
        if (reward.award.amount > 0) this.combatObserver?.emit({ kind: "credit", credit: { source: "zeus", causalId: visual.strike.strikeId,
          playerId: reward.award.playerId, amount: reward.award.amount, before,
          after: this.tankManager.getPlayerById(reward.award.playerId)!.money, components: [] } });
        visual.result = { ...visual.strike, ...reward, balances };
        this.lastAppliedZeusStrikeId = visual.strike.strikeId;
        this.pendingSpecialRoundOutcome = reward.roundOutcome;
        this.zeusFlashLife = 8;
        this.onZeusStrikeApplied?.(visual.result);
        this.combatObserver?.emit({ kind: "zeus", result: visual.result });
      }
    }

    if (visual.localAuthoritative && visual.elapsedSeconds >= 0.8) {
      const isRoundEnd = visual.result?.roundOutcome.isRoundEnd ?? false;
      this.activeZeusVisual = null;
      this.turnManager.completeSpecialTurn(isRoundEnd);
    } else if (!visual.localAuthoritative && visual.elapsedSeconds >= 0.85) {
      this.activeZeusVisual = null;
    }
  }

  private resetZeusForRound(): void {
    this.zeusState = resetZeusRound(this.zeusState);
    this.pendingZeusAppointment = null;
    this.pendingSpecialRoundOutcome = null;
    this.clearZeusVisuals();
    for (const player of this.tankManager.getPlayers()) {
      player.tank.lastDirectAttackerId = undefined;
    }
  }

  private clearZeusVisuals(): void {
    this.activeZeusVisual = null;
    this.zeusFlashLife = 0;
  }

  private completeResolvedRound(): void {
    const outcome = this.pendingSpecialRoundOutcome ?? this.pendingShotResult?.roundOutcome;
    if (!outcome?.isRoundEnd || !this.roundCombatActive || this.gameOver) return;
    this.pendingSpecialRoundOutcome = null;
    this.roundCombatActive = false;
    const survivors = this.tankManager.getAlivePlayers();
    const roundWinner = outcome.roundWinnerId
      ? this.tankManager.getPlayerById(outcome.roundWinnerId) ?? null
      : null;
    if (outcome.isDraw) this.logDeathSummary();
    this.resetZeusForRound();
    this.onRoundEnded?.({ survivors, isDraw: outcome.isDraw, roundWinner });
  }

  /** Lightweight celebration reuse for SUMMARY (does NOT set gameOver or winner). Keeps existing final-win paths untouched. */
  public triggerRoundCelebration(
    roundWinner?: import("../../types/player").Player,
  ): void {
    if (this.gameOver) return;
    const cx = roundWinner
      ? roundWinner.tank.position.x
      : (this.tankManager.getAlivePlayers()[0]?.tank.position.x ??
        this.width / 2);
    const cy = roundWinner ? roundWinner.tank.position.y - 30 : 60;
    const color = roundWinner
      ? roundWinner.tank.color
      : (this.winner?.tank.color ?? "#FFFFFF");
    this.audio.playVictoryFanfare();
    this.celebrationFireworks.start(cx, cy, color, roundWinner ?? null);
    // Fanfare sting will play (reuses private audio logic)
  }

  /** Clear round celebration fireworks when entering SUMMARY (prevents ongoing spawns in SUMMARY/SHOP) */
  public clearRoundCelebration(): void {
    this.celebrationFireworks.clear();
    this.impactExplosions.clear();
    this.terrainImpactParticles.clear();
    this.tankManager.clearRecoil(); // ensure no stale kick visible in non-combat phases
  }

  /** Declare match winner (e.g. when round wraps with one survivor before engine detected it). */
  public declareMatchWinner(winner: Player): void {
    if (this.gameOver) return;
    this.gameOver = true;
    this.winner = winner;
    this.audio.playVictoryFanfare();
    this.celebrationFireworks.start(
      winner.tank.position.x,
      winner.tank.position.y - 30,
      winner.tank.color,
      winner,
    );
    console.log(`[GAME OVER] WINNER: (redacted)`);
    this.onGameOver?.(winner);
  }

  /** Declare draw when all players are eliminated. */
  public declareMatchDraw(): void {
    if (this.gameOver) return;
    this.gameOver = true;
    this.winner = null;
    console.log("[GAME OVER] DRAW (partie nulle)");
    this.onDraw?.();
  }

  /**
   * Prepare a brand new round (preserve money/inventory, reset health/terrain/turn state). Called after SHOP.
   * Safe to call while inter-round pause is active (spawns before combat resumes).
   */
  public startNextRound(map?: RoundMap, players?: Player[], roundNumber = 1): boolean {
    const roster = players ?? [...this.tankManager.getPlayers()];
    if (roster.length < 2) return false;
    const prepared = this.prepareCombatRound(roster, map?.roundNumber ?? roundNumber, map);

    // New combat round — everyone in the match respawns (deaths only end the manche, not the campaign)
    this.gameOver = false;
    this.winner = null;
    this.roundCombatActive = true;

    this.audio.stopVictoryMusic();
    this.physicsEngine.clear(false);
    this.celebrationFireworks.clear();
    this.impactExplosions.clear();
    this.terrainImpactParticles.clear();
    this.resetZeusForRound();

    this.applyPreparedRound(prepared);
    this.audio.resetSlideThrottle();
    this.turnManager.setEnvironment(this.windForce, this.config.gravity);

    // Prepare turn system for the next round (keeps overall round counter semantics via TurnManager)
    this.turnManager.reset(); // this sets internal round=1; caller in React can treat displayRound separately
    this.turnManager.setRoundNumber(prepared.map.roundNumber);
    this.turnManager.startFirstTurn();
    this.turnManager.setupInputListeners();

    // Clear any round accumulators
    this.roundDamageDealt = {};
    this.roundEarningsByPlayer = {};
    this.roundTerrainDestroyed = 0;
    this.currentFirerId = null;
    this.activeShotLedger = null;
    this.pendingShotResult = null;
    this.shotNumberInRound = 0;

    // Reset projectile settlement tracker (physics.clear() was just called)
    this.previousProjectileCount = 0;
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
    this.turnManager.pauseForInterRound();
    this.isRunning = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.clearZeusVisuals();
    this.audio.dispose();
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
    this.diagnosticStep++;
    // SUMMARY / SHOP: freeze combat simulation (tanks were dying during boutique → false draws)
    if (this.turnManager.isInterRoundPaused()) {
      this.celebrationFireworks.update(dt);
      this.impactExplosions.update();
      this.tankManager.clearRecoil(); // ensure chassis is un-shifted for summary/shop renders
      return;
    }

    this.updateZeusStrike(dt);

    const gravity = this.config.gravity;
    const wind = this.windForce;

    // Délégation complète au nouveau PhysicsEngine + TankManager
    this.physicsEngine.updateProjectiles(
      dt,
      gravity,
      wind,
      this.terrain,
      this.tankManager,
    );

    // Continuous tank gravity (post-crater drops, pit falls). Produces slide/floor callbacks.
    this.tankManager.applyGravity(dt, this.terrain);

    // Decay transient visual recoil (micro arcade feedback on fire)
    this.tankManager.decayRecoil();

    // Vérifie si des tanks sont enterrés (règle : si Y_tank > hauteur_planche → battu)
    this.tankManager.checkTankBurial(this.terrain);

    // Met à jour les timers de sécurité du TurnManager
    this.turnManager.update(dt);

    // Mise à jour des feux d'artifice (si partie terminée)
    this.celebrationFireworks.update(dt);
    this.impactExplosions.update();

    // Notification pour le layer React (interpolation, debug, etc.)
    this.onPhysicsStep?.(this.physicsEngine.getProjectiles());

    // Détection de fin de volée (transition only: previous > 0 → current === 0).
    // This prevents spamming the callback (and any attached handlers) 120 times per second
    // during idle periods (SHOP, SUMMARY, between turns, etc.).
    const currentCount = this.physicsEngine.count;
    if (this.previousProjectileCount > 0 && currentCount === 0) {
      this.onAllProjectilesSettled?.();
    }
    this.previousProjectileCount = currentCount;

  }

  /**
   * Online multiplayer: apply round end from the peer that detected last-man-standing first.
   * Keeps both clients in the same phase when local death counts diverge slightly.
   */
  public syncRoundEndFromRemote(
    players: import("../../types/player").Player[],
    roundWinnerId: string | null,
    isDraw: boolean,
  ): void {
    if (!this.roundCombatActive || this.gameOver) return;

    this.tankManager.setPlayers(players);
    this.roundCombatActive = false;
    this.physicsEngine.clear(false);
    this.turnManager.pauseForInterRound();
    this.resetZeusForRound();

    const survivors = this.tankManager.getAlivePlayers();
    const roundWinner = isDraw
      ? null
      : roundWinnerId
        ? this.tankManager.getPlayers().find((p) => p.id === roundWinnerId) ?? null
        : null;

    this.onRoundEnded?.({
      survivors,
      isDraw,
      roundWinner,
    });
  }

  private logDeathSummary(): void {
    console.log("=== RÉSUMÉ DES CAUSES DE MORT ===");
    const playerList = this.tankManager.getPlayers();
    for (let i = 0; i < playerList.length; i++) {
      const p = playerList[i];
      const reasons = this.deathReasons[p.id] || [];
      if (reasons.length === 0) {
        console.log(`  - Player ${i + 1}: aucune mort enregistrée`);
        continue;
      }
      console.log(`  - Player ${i + 1}:`);
      for (const r of reasons) {
        const turnInfo = r.round ? ` (turn ~${r.round})` : "";
        console.log(`      • ${r.cause}${turnInfo}: (info redacted)`);
      }
    }
    console.log("==================================");
  }

  // === Rendering (called by GameCanvas every frame) ===

  public render(ctx: CanvasRenderingContext2D): void {
    // Sky
    ctx.fillStyle = "#0000AA";
    ctx.fillRect(0, 0, this.width, this.height);

    // Terrain (délégué au TerrainManager qui utilise la palette VGA)
    this.terrain.draw(ctx);

    // Projectiles (délégué au PhysicsEngine)
    this.physicsEngine.draw(ctx);

    // Tanks (avec canon, jauge de vie et couleurs VGA)
    // Noms masqués dynamiquement si un projectile est en vol (phase de tir/résolution)
    const showPlayerNames = !this.physicsEngine.hasActiveProjectiles();

    // Override the winning tank's cannon angle during celebration so it sweeps 78.5°-112.5°
    // and visually "shoots" the fireworks (we restore immediately after draw).
    const cannonOverride = this.celebrationFireworks.getCannonOverride();
    let restoredAngle: number | undefined;
    if (cannonOverride !== null) {
      restoredAngle = cannonOverride.player.tank.angle;
      cannonOverride.player.tank.angle = cannonOverride.angle;
    }
    try {
      this.tankManager.draw(ctx, showPlayerNames, this.terrain);
      this.drawZeusEffects(ctx);
    } finally {
      if (cannonOverride !== null && restoredAngle !== undefined) {
        cannonOverride.player.tank.angle = restoredAngle;
      }
    }

    // === Active Player Indicator (Step 4 polish) ===
    // Small inverted triangle (down-pointing arrow) floating above the current turn's tank.
    // Uses sine on real timestamp for bob (as specified), player primary color for instant ID.
    // Drawn after tanks so it sits on top; cheap math only (no allocs in 120 Hz path).
    const activePlayer = this.turnManager.getCurrentPlayer();
    if (
      activePlayer &&
      !activePlayer.tank.isDead &&
      !this.turnManager.isInterRoundPaused()
    ) {
      const tx = activePlayer.tank.position.x;
      const ty = activePlayer.tank.position.y;
      const color = activePlayer.tank.color;

      const bob = Math.sin(Date.now() / 200) * 5;
      const indicatorBaseY = ty - 42; // above health bar (~y-24) and name (~y-34)
      const indicatorY = indicatorBaseY - bob;

      const size = 5.5;
      ctx.fillStyle = color;
      ctx.strokeStyle = VGA_PALETTE.DARK_GRAY;
      ctx.lineWidth = 1;
      ctx.beginPath();
      // Inverted triangle (point down) = flèche pointing at the active tank
      ctx.moveTo(tx - size, indicatorY - size * 0.55);
      ctx.lineTo(tx + size, indicatorY - size * 0.55);
      ctx.lineTo(tx, indicatorY + size * 0.75);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // Feux d'artifice pour célébration (fin de manche avec gagnant de round, ou fin de match)
    if (this.celebrationFireworks.hasParticles) {
      this.celebrationFireworks.draw(ctx);
    }

    if (this.zeusFlashLife > 0) {
      ctx.globalAlpha = Math.min(0.65, this.zeusFlashLife / 10);
      ctx.fillStyle = VGA_PALETTE.WHITE;
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.globalAlpha = 1;
      this.zeusFlashLife--;
    }

    // Huge impact explosions (THERMONUCLEAR etc.) + brief flash overlay
    if (this.impactExplosions.hasActiveVisuals) {
      this.impactExplosions.draw(ctx);
    }

    if (this.terrainImpactParticles.hasParticles) {
      this.terrainImpactParticles.drawAndAdvance(ctx);
    }

    // Petit message de victoire sur le canvas seulement pour fin de match
    if (this.gameOver && this.winner) {
      ctx.fillStyle = this.winner.tank.color;
      ctx.font = "bold 28px monospace";
      ctx.textAlign = "center";
      ctx.fillText(
        i18n.t("winner_wins", { name: this.winner.name }),
        this.width / 2,
        80,
      );
    }
  }

  private drawZeusEffects(ctx: CanvasRenderingContext2D): void {
    const activeZeusId = this.zeusState.activeZeusId;
    const zeus = activeZeusId ? this.tankManager.getPlayerById(activeZeusId) : undefined;
    if (zeus && !zeus.tank.isDead) {
      const pulse = 1 + Math.sin(Date.now() / 90) * 0.12;
      ctx.save();
      ctx.strokeStyle = VGA_PALETTE.CYAN;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.arc(
        zeus.tank.position.x,
        zeus.tank.position.y - 8,
        20 * pulse,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    const visual = this.activeZeusVisual;
    if (!visual || visual.elapsedSeconds > 0.72) return;
    const target = this.tankManager.getPlayerById(visual.strike.targetId);
    if (!target) return;
    const targetX = target.tank.position.x;
    const targetY = target.tank.position.y - 8;
    const segments = 9;
    const seed = visual.strike.strikeId * 1103515245;
    ctx.save();
    ctx.strokeStyle = VGA_PALETTE.WHITE;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(targetX, 0);
    for (let segment = 1; segment <= segments; segment++) {
      const y = (targetY * segment) / segments;
      const hash = (seed + segment * 2654435761) >>> 0;
      const offset = segment === segments ? 0 : ((hash % 23) - 11);
      ctx.lineTo(targetX + offset, y);
    }
    ctx.stroke();
    ctx.lineWidth = 2;
    for (let branch = 0; branch < 3; branch++) {
      const segment = 3 + branch * 2;
      const y = (targetY * segment) / segments;
      const hash = (seed + (branch + 17) * 2246822519) >>> 0;
      const direction = (hash & 1) === 0 ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(targetX + (((seed + segment * 2654435761) >>> 0) % 23) - 11, y);
      ctx.lineTo(
        targetX + direction * (18 + (hash % 14)),
        y + 12 + (hash % 9),
      );
      ctx.stroke();
    }
    ctx.strokeStyle = VGA_PALETTE.CYAN;
    ctx.lineWidth = 1;
    ctx.stroke();
    if (visual.elapsedSeconds >= 0.68) {
      ctx.fillStyle = VGA_PALETTE.WHITE;
      for (let shard = 0; shard < 8; shard++) {
        const angle = (Math.PI * 2 * shard) / 8;
        const distance = 8 + ((seed + shard * 97) >>> 0) % 15;
        ctx.fillRect(
          targetX + Math.cos(angle) * distance - 2,
          targetY + Math.sin(angle) * distance - 2,
          4,
          4,
        );
      }
    }
    ctx.restore();
  }

  // Utility
  public clearProjectiles(): void {
    this.physicsEngine.clear();
    this.previousProjectileCount = 0;
  }

  public getTerrainImpactParticles(): ReadonlyArray<TerrainImpactParticle> {
    return this.terrainImpactParticles.getParticles();
  }

  /**
   * Retourne une vue en lecture seule sur le tampon interne des explosions d'impact.
   * La référence du tableau est mutée sur place (in-place compaction) lors des mises à jour
   * et n'est réinitialisée qu'aux transitions de manche.
   */
  public getImpactExplosions(): ReadonlyArray<ImpactExplosion> {
    return this.impactExplosions.getExplosions();
  }

  public isGameOver(): boolean {
    return this.gameOver;
  }

  public getWinner(): import("../../types/player").Player | null {
    return this.winner;
  }

  /** Record why a player died (used for end-of-game summary, especially for "partie nulle") */
  public recordDeath(playerId: string, cause: string, info?: string): void {
    if (!this.deathReasons[playerId]) {
      this.deathReasons[playerId] = [];
    }
    this.deathReasons[playerId].push({
      cause,
      info,
      round: this.turnManager.getCurrentTurnNumber(),
    });
  }

  private prepareCombatRound(players: Player[], roundNumber: number, map?: RoundMap): Extract<PreparedRound, { ok: true }> {
    if (map) {
      if (!isRoundMap(map) || map.width !== this.width || map.height !== this.height || !hasValidSpawnRoster(map, players)) {
        throw new Error("INVALID_ROUND_MAP");
      }
      return { ok: true, map, players };
    }
    const result = prepareRound(players, this.width, this.height, roundNumber, this.localMatch, secureRandom);
    if (!result.ok) {
      this.enterInterRoundPhase();
      throw new Error(result.reason);
    }
    return result;
  }

  private initialRoundMap: RoundMap | null = null;

  public getInitialRoundMap(): RoundMap | null { return this.initialRoundMap; }

  public invalidateCombatSimulation(): void {
    this.turnManager.reset();
    this.physicsEngine.clear(false);
    this.activeShotLedger = null; this.pendingShotResult = null;
    this.pendingZeusAppointment = null; this.pendingSpecialRoundOutcome = null;
    this.clearZeusVisuals();
    this.turnManager.lockForCatchUp();
  }

  /** Discard transient simulation and callbacks; retain economic acknowledgements. */
  public reconstructCombat(map: RoundMap, initialPlayers: readonly Player[]): void {
    this.invalidateCombatSimulation();
    this.activeShotLedger = null; this.pendingShotResult = null;
    this.currentFirerId = null; this.pendingSpecialRoundOutcome = null;
    this.pendingZeusAppointment = null;
    this.zeusState = createZeusState(); this.lastAppliedZeusStrikeId = 0;
    this.clearZeusVisuals(); this.clearRoundCelebration();
    this.gameOver = false; this.winner = null; this.roundCombatActive = true;
    this.shotNumberInRound = 0; this.previousProjectileCount = 0;
    this.audio.resetSlideThrottle();
    this.tankManager.setPlayers(structuredClone([...initialPlayers]));
    this.restoreRoundTerrain(map);
    this.turnManager.setRoundNumber(map.roundNumber);
    this.turnManager.lockForCatchUp();
    this.turnManager.setupInputListeners();
  }

  /** Combat recovery keeps damaged terrain and existing positions; it never spawns. */
  public restoreRoundTerrain(map: RoundMap, initialMap: RoundMap = map): void {
    if (!isRoundMap(map)) throw new Error("INVALID_ROUND_MAP");
    this.terrain.loadHeights(map.heights, map.materials);
    this.initialRoundMap = initialMap;
    this.setWindForce(map.wind);
  }

  public getCombatMap(roundNumber: number): RoundMap {
    return { width: this.width, height: this.height, roundNumber, wind: this.windForce,
      heights: [...this.terrain.getHeightmap()], materials: [...this.terrain.getMaterials()] };
  }

  private applyPreparedRound(prepared: Extract<PreparedRound, { ok: true }>): void {
    this.initialRoundMap = prepared.map;
    this.terrain.loadHeights(prepared.map.heights, prepared.map.materials);
    this.tankManager.setPlayers(prepared.players);
    this.setWindForce(prepared.map.wind);
  }

  /** Fully resets the game for a new match */
  public resetGame(players?: Player[]): void {
    const prepared = players ? this.prepareCombatRound(players, 1) : null;
    this.audio.stopVictoryMusic();
    this.gameOver = false;
    this.winner = null;
    this.roundCombatActive = true;
    this.celebrationFireworks.clear();
    this.impactExplosions.clear();
    this.terrainImpactParticles.clear();
    this.physicsEngine.clear(false);
    this.turnManager.reset();

    // Clear round accumulators / celebration state
    this.roundDamageDealt = {};
    this.roundEarningsByPlayer = {};
    this.roundTerrainDestroyed = 0;
    this.currentFirerId = null;
    this.activeShotLedger = null;
    this.pendingShotResult = null;
    this.shotNumberInRound = 0;
    this.nextShotId = 1;
    this.lastAppliedShotId = 0;
    this.lastConfirmedOnlineShotId = 0;
    this.lastCountedOnlineShotId = 0;
    this.zeusState = createZeusState();
    this.pendingZeusAppointment = null;
    this.pendingSpecialRoundOutcome = null;
    this.lastAppliedZeusStrikeId = 0;
    this.clearZeusVisuals();

    // Reset projectile settlement tracker
    this.previousProjectileCount = 0;

    // Clear death reasons for new match
    this.deathReasons = {};

    // Reset audio throttling + tank velocities for clean next match
    this.audio.resetSlideThrottle();
    this.tankManager.clearVelocities();

    if (prepared) this.setPlayers(prepared.players, prepared.map);
  }
}
