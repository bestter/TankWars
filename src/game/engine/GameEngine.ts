import { secureRandom } from "../../utils/random";
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

import { TerrainManager } from "./Terrain";
import { PhysicsEngine } from "./PhysicsEngine";
import { TankManager } from "../entities/TankManager";
import { TurnManager } from "./TurnManager";
import { WEAPON_REGISTRY, type WeaponId } from "../../types/weapon";
import type { Player } from "../../types/player";
import { VGA_PALETTE } from "../../types/game";
import type { Vector2, FireCommand, RoundResult } from "../../types/game";
import type { RoundEndPayload } from "../../types/round";
import type { AIStrategy } from "../entities/ai/AIStrategy";
import type { AIEngine } from "../entities/ai/AIEngine";
import i18n from "../../i18n";
import { rollRoundWind } from "../wind";
import {
  calculateShotRewards,
  type CombatDamageEvent,
  type CombatDestructionEvent,
  type ShotRewardResult,
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

type FireworkParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  type: "rocket" | "particle" | "confetti";
  trail?: Array<{ x: number; y: number; alpha: number }>;
  swaySpeed?: number;
  swayOffset?: number;
  swayWidth?: number;
  rotation?: number;
  rotationSpeed?: number;
};

const FESTIVE_COLORS: readonly string[] = [
  VGA_PALETTE.ELECTRIC_CYAN,
  VGA_PALETTE.FLASH_GREEN,
  VGA_PALETTE.NEON_PINK,
  VGA_PALETTE.CYBER_YELLOW,
  VGA_PALETTE.FLUO_ORANGE,
  VGA_PALETTE.VOLT_PURPLE,
  VGA_PALETTE.CYAN,
  VGA_PALETTE.MAGENTA,
  VGA_PALETTE.YELLOW,
  VGA_PALETTE.GREEN,
  VGA_PALETTE.BLUE,
  VGA_PALETTE.WHITE,
];

const FIREWORKS_TICK_DT = 1 / 60;
const MAX_FIREWORKS = 250;

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

  // For transition-based "projectiles just settled" detection (avoids calling onAllProjectilesSettled
  // every single frame while idle, which was causing log spam during SHOP/SUMMARY/idle periods).
  private previousProjectileCount = 0;

  // Game over state (entire match ended)
  private gameOver = false;
  private winner: import("../../types/player").Player | null = null;

  // For round-end (non-match) celebration fireworks (color/position when !gameOver)
  private celebrationCenterX: number = 0;
  private celebrationColor: string = "#FFFFFF";
  private celebrationWinnerTankId: string | null = null;
  private celebrationWinner: import("../../types/player").Player | null = null;
  private celebrationAngle: number = 90;
  private celebrationAngleDir: number = 1;

  /** True while tanks are fighting within a single combat round (until <= 1 alive: last man standing). */
  private roundCombatActive = true;

  /** Local hotseat / vs-AI. Online match sets this to false (humans keep sand spawns). */
  private localMatch = true;

  public setLocalMatch(local: boolean): void {
    this.localMatch = local;
  }

  public isRoundCombatActive(): boolean {
    return this.roundCombatActive;
  }

  /** SUMMARY / SHOP / CELEBRATION — combat simulation paused until next round. */
  public enterInterRoundPhase(): void {
    this.roundCombatActive = false;
    this.physicsEngine.clear(false);
    this.turnManager.pauseForInterRound();
    this.clearZeusVisuals();
  }

  // Enriched fireworks for winner celebration
  private fireworks: FireworkParticle[] = [];
  private readonly fireworkSpawnBuffer: FireworkParticle[] = [];
  private fireworksUpdateAccum = 0;

  // Impact explosion VFX for huge weapons (e.g. THERMONUCLEAR). Separate from celebration fireworks.
  // Particles use red/orange VGA tones + alpha for "red-orange" blast + flash.
  private impactExplosions: Array<{
    x: number;
    y: number;
    life: number;
    maxLife: number;
    size: number;
    color: string;
  }> = [];
  private thermoFlashLife = 0; // short full-screen red flash on thermonuclear impact for "huge" punch

  // === Registre économique de la manche et de la résolution active ===
  private roundDamageDealt: Record<string, number> = {};
  private roundEarningsByPlayer: Record<string, number> = {};
  private roundTerrainDestroyed = 0;
  private currentFirerId: string | null = null;
  private activeShotLedger: ActiveShotLedger | null = null;
  private pendingShotResult: ResolvedShotPreview | null = null;
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

  // Audio state for new SFX (throttling prevents slide scrape spam at 120 Hz)
  private lastSlideTimes: Map<string, number> = new Map();

  // === Callbacks for React layer decoupling ===
  public onProjectileHit?: (event: HitEvent) => void;
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

    this.terrain = new TerrainManager(this.width, this.height);
    this.terrain.generate();

    this.physicsEngine = new PhysicsEngine();
    this.tankManager = new TankManager();

    // Wire debug death recorder and audio. L'économie passe par les événements structurés séparés.
    this.tankManager.onPlayerDied = (playerId, cause, details) => {
      this.recordDeath(playerId, cause, details);
      if (cause === "explosion" || cause === "zeus") {
        this.playTankDestroyedByExplosionSound();
      } else if (cause === "burial") {
        this.playTankSadBurialSound();
      }
    };
    this.tankManager.onDamageApplied = (event) => {
      if (event.shotId !== this.activeShotLedger?.shotId) return;
      this.activeShotLedger.damageEvents.push(event);
    };
    this.tankManager.onTankDestroyed = (event) => {
      if (event.shotId !== this.activeShotLedger?.shotId) return;
      this.activeShotLedger.destructionEvents.push(event);
    };

    // Wire tank movement / pit SFX (consumed by applyGravity in TankManager)
    this.tankManager.onTankSliding = (playerId) =>
      this.playTankSlidingSound(playerId);
    this.tankManager.onTankTouchedFloor = () =>
      this.playTankTouchLowestFloorSound();

    // Crée le TurnManager avec un callback de tir
    this.turnManager = new TurnManager(
      this.tankManager,
      this.terrain,
      (from, command, ownerId, identity) => {
        this.fireProjectile(from, command, ownerId ?? "unknown", identity);
      },
    );

    // Connecte le TurnManager au système de physique (fin de volée → nextTurn)
    this.turnManager.connectToPhysics(this.physicsEngine);
    this.turnManager.setMatchEndedChecker(() => this.gameOver);
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
    this.turnManager.onResolvedRoundEnd = () => this.completeResolvedRound();
    this.turnManager.onSpecialTurn = (player) => this.beginLocalZeusTurn(player.id);

    // Transmet les mises à jour HUD du TurnManager vers l'extérieur (React)
    this.turnManager.onHudUpdate = (info) => {
      this.onTurnHudUpdate?.(info);
    };

    // Forward hit events from PhysicsEngine for VFX/audio.
    this.physicsEngine.onProjectileHit = (hit) => {
      const firer = this.currentFirerId ?? "unknown";
      const weapon = WEAPON_REGISTRY[hit.weaponId];

      this.onProjectileHit?.({
        x: hit.x,
        y: hit.y,
        weaponId: hit.weaponId,
        ownerId: firer,
        blastRadius: weapon?.blastRadius ?? 28,
      });

      // Distinct impact/explosion sound per projectile (called for every terrain/tank hit)
      this.playImpactSound(hit.weaponId);

      // Huge red-orange thermonuclear explosion VFX (flash + particles)
      if (hit.weaponId === "THERMONUCLEAR") {
        this.spawnThermonuclearExplosion(hit.x, hit.y);
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
  public setPlayers(players: Player[]): void {
    this.roundCombatActive = true;
    this.gameOver = false;
    this.winner = null;
    this.tankManager.spawnTanks(players, this.terrain, {
      localMode: this.localMatch,
    });
    this.lastSlideTimes.clear();
    this.randomizeWindForRound();
    this.turnManager.setEnvironment(this.windForce, this.config.gravity);
    this.turnManager.setRoundNumber(1);

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
    },
  ): void {
    const weapon = WEAPON_REGISTRY[command.weaponId];
    if (!weapon) {
      console.warn(`Unknown weapon: ${command.weaponId}`);
      return;
    }
    if (this.activeShotLedger !== null) {
      console.warn("[GameEngine] Refus d'un second tir avant la finalisation du tir actif.");
      return;
    }

    this.currentFirerId = ownerId;
    this.shotNumberInRound++;
    const shotId = identity?.shotId ?? this.nextShotId++;
    const isFirstShotOfRound = identity?.isFirstShotOfRound ?? this.shotNumberInRound === 1;
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
    this.playFireSound(command.weaponId);

    // Calculate barrel tip position so the projectile starts at the end of the barrel
    // instead of the bottom-center of the tank (which is on the ground and causes self-explosions/missed settlements).
    const barrelLength = 20;
    const angleRad = (command.angle * Math.PI) / 180;
    const barrelStartY = from.y - 13;
    const launchX = from.x + Math.cos(angleRad) * barrelLength;
    const launchY = barrelStartY - Math.sin(angleRad) * barrelLength; // moving up = subtracting Y

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

  /**
   * Optional: Ask an AI strategy to decide and immediately fire.
   * This keeps AI completely outside the engine core.
   */
  public requestAIShot(
    aiStrategy: AIStrategy,
    self: import("../../types/player").Player,
    worldView: import("../entities/ai/AIStrategy").AIWorldView,
  ): boolean {
    const decision = aiStrategy.decideShot(self, worldView);
    if (!decision) return false;

    this.fireProjectile(self.tank.position, decision, self.id);
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
    const reward = calculateShotRewards({
      ...ledger,
      playerCountAtMatchStart: this.tankManager.getPlayers().length,
      survivorsAfterShot: this.tankManager.getAlivePlayers().map((player) => player.id),
    });
    for (const [playerId, damageMilli] of Object.entries(reward.damageDealtMilliByPlayer)) {
      this.roundDamageDealt[playerId] =
        (this.roundDamageDealt[playerId] ?? 0) + damageMilli / 1_000;
    }

    const balances = this.tankManager.getPlayers().map((player) => ({
      playerId: player.id,
      money:
        player.money +
        (reward.awards.find((award) => award.playerId === player.id)?.amount ?? 0),
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
      this.applyResolvedEarnings(preview.shotId, balances);
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
        this.playZeusAppointmentSound();
        this.onZeusAppointed?.(evaluation.appointment);
      }
    }
    this.onShotResolved?.(preview);
    return preview;
  }

  public applyResolvedEarnings(
    shotId: number,
    balances: ReadonlyArray<{ playerId: string; money: number }>,
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
    this.playZeusAppointmentSound();
    this.onZeusAppointed?.(appointment);
  }

  public syncRemoteZeusState(activeZeusId: string | null): void {
    this.zeusState = { ...this.zeusState, activeZeusId, shotsWithoutEarnings: 0 };
    if (activeZeusId === null) this.clearZeusVisuals();
  }

  public startRemoteZeusStrike(strike: ZeusStrike, resolveAt = Date.now() + 700): void {
    if (strike.strikeId <= this.lastAppliedZeusStrikeId) return;
    if (this.activeZeusVisual?.strike.strikeId === strike.strikeId) return;
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
    this.playZeusStrikeSound();
    if (target && !target.tank.isDead) {
      this.tankManager.applyZeusStrike(result.zeusId, result.targetId);
    }
    this.applyZeusBalances(result.balances);
    this.lastAppliedZeusStrikeId = result.strikeId;
    this.zeusFlashLife = 8;
    if (this.activeZeusVisual?.strike.strikeId === result.strikeId) {
      this.activeZeusVisual.impactApplied = true;
      this.activeZeusVisual.result = result;
    }
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
      this.playZeusStrikeSound();
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
        this.applyZeusBalances(balances);
        visual.result = { ...visual.strike, ...reward, balances };
        this.lastAppliedZeusStrikeId = visual.strike.strikeId;
        this.pendingSpecialRoundOutcome = reward.roundOutcome;
        this.zeusFlashLife = 8;
        this.onZeusStrikeApplied?.(visual.result);
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
    const c = roundWinner ? roundWinner.tank.color : undefined;
    if (roundWinner) {
      this.celebrationWinnerTankId = roundWinner.tank.id;
      this.celebrationWinner = roundWinner;
      this.celebrationAngle = 78.5;
      this.celebrationAngleDir = 1;
    }
    this.startFireworks(cx, cy, c);
    // Fanfare sting will play (reuses private audio logic)
  }

  /** Clear round celebration fireworks when entering SUMMARY (prevents ongoing spawns in SUMMARY/SHOP) */
  public clearRoundCelebration(): void {
    this.fireworks = [];
    this.impactExplosions = [];
    this.thermoFlashLife = 0;
    this.celebrationCenterX = 0;
    this.celebrationColor = "#FFFFFF";
    this.celebrationWinnerTankId = null;
    this.celebrationWinner = null;
    this.celebrationAngle = 90;
    this.celebrationAngleDir = 1;
    this.tankManager.clearRecoil(); // ensure no stale kick visible in non-combat phases
  }

  /** Declare match winner (e.g. when round wraps with one survivor before engine detected it). */
  public declareMatchWinner(winner: Player): void {
    if (this.gameOver) return;
    this.gameOver = true;
    this.winner = winner;
    this.celebrationWinnerTankId = winner.tank.id;
    this.celebrationWinner = winner;
    this.celebrationAngle = 78.5;
    this.celebrationAngleDir = 1;
    this.startFireworks(winner.tank.position.x, winner.tank.position.y - 30);
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
  public startNextRound(): boolean {
    const roster = [...this.tankManager.getPlayers()];
    if (roster.length < 2) {
      console.warn(
        `[GameEngine] startNextRound skipped: need at least 2 players in roster (have ${roster.length})`,
      );
      return false;
    }

    // New combat round — everyone in the match respawns (deaths only end the manche, not the campaign)
    this.gameOver = false;
    this.winner = null;
    this.roundCombatActive = true;

    this.stopVictoryMusic();
    this.physicsEngine.clear(false);
    this.fireworks = [];
    this.impactExplosions = [];
    this.thermoFlashLife = 0;
    this.celebrationWinnerTankId = null;
    this.celebrationWinner = null;
    this.celebrationAngle = 90;
    this.celebrationAngleDir = 1;
    this.resetZeusForRound();

    this.terrain.generate();
    this.tankManager.spawnTanks(roster, this.terrain, {
      localMode: this.localMatch,
    });
    this.lastSlideTimes.clear(); // fresh per round for throttle maps
    this.randomizeWindForRound();
    this.turnManager.setEnvironment(this.windForce, this.config.gravity);

    // Prepare turn system for the next round (keeps overall round counter semantics via TurnManager)
    this.turnManager.reset(); // this sets internal round=1; caller in React can treat displayRound separately
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
    this.isRunning = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.clearZeusVisuals();
    this.stopVictoryMusic();
    const audioContext = this.audioContext;
    this.audioContext = null;
    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => {
        // Audio teardown is best-effort during React unmount.
      });
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
    // SUMMARY / SHOP: freeze combat simulation (tanks were dying during boutique → false draws)
    if (this.turnManager.isInterRoundPaused()) {
      this.updateFireworks(dt);
      this.updateImpactExplosions();
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
    this.updateFireworks(dt);
    this.updateImpactExplosions();

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
    let restoredAngle: number | undefined;
    if (this.celebrationWinner != null && this.celebrationAngle != null) {
      restoredAngle = this.celebrationWinner.tank.angle;
      this.celebrationWinner.tank.angle = this.celebrationAngle;
    }

    this.tankManager.draw(ctx, showPlayerNames, this.terrain);
    this.drawZeusEffects(ctx);

    // restore
    if (this.celebrationWinner != null && restoredAngle !== undefined) {
      this.celebrationWinner.tank.angle = restoredAngle;
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
    if (this.fireworks.length > 0) {
      this.drawFireworks(ctx);
    }

    // Huge impact explosions (THERMONUCLEAR etc.) + brief flash overlay
    if (this.thermoFlashLife > 0) {
      ctx.globalAlpha = 0.24;
      ctx.fillStyle = VGA_PALETTE.RED;
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.globalAlpha = 1;
      this.thermoFlashLife--;
    }

    if (this.zeusFlashLife > 0) {
      ctx.globalAlpha = Math.min(0.65, this.zeusFlashLife / 10);
      ctx.fillStyle = VGA_PALETTE.WHITE;
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.globalAlpha = 1;
      this.zeusFlashLife--;
    }

    if (this.impactExplosions.length > 0) {
      this.drawImpactExplosions(ctx);
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

  /** Starts a fireworks celebration above the winner (or round winner) */
  private startFireworks(
    centerX: number,
    centerY: number,
    color?: string,
  ): void {
    this.fireworks = [];
    this.celebrationCenterX = centerX;
    this.celebrationColor = color ?? this.winner?.tank.color ?? "#FFFFFF";
    this.playVictoryFanfare();

    const festiveColors = [
      VGA_PALETTE.ELECTRIC_CYAN,
      VGA_PALETTE.FLASH_GREEN,
      VGA_PALETTE.NEON_PINK,
      VGA_PALETTE.CYBER_YELLOW,
      VGA_PALETTE.FLUO_ORANGE,
      VGA_PALETTE.VOLT_PURPLE,
      VGA_PALETTE.CYAN,
      VGA_PALETTE.MAGENTA,
      VGA_PALETTE.YELLOW,
    ];

    // Create initial big rockets (multicolored!) launching from the bottom
    for (let i = 0; i < 9; i++) {
      const rocketColor =
        secureRandom() < 0.4
          ? this.celebrationColor
          : festiveColors[i % festiveColors.length];
      this.fireworks.push({
        type: "rocket",
        x: centerX + (secureRandom() - 0.5) * 180,
        y: this.height - 20,
        vx: (secureRandom() - 0.5) * 2.5,
        vy: -5.8 - secureRandom() * 3.2,
        life: 42 + secureRandom() * 26,
        maxLife: 68,
        color: rocketColor,
        size: 3.5 + secureRandom() * 2.0,
        trail: [],
      });
    }

    // Add some initial floating confetti for instant festivity
    for (let i = 0; i < 32; i++) {
      this.fireworks.push({
        type: "confetti",
        x: secureRandom() * this.width,
        y: secureRandom() * Math.max(80, centerY),
        vx: (secureRandom() - 0.5) * 1.2,
        vy: 0.2 + secureRandom() * 0.6,
        life: 120 + secureRandom() * 100,
        maxLife: 220,
        color: festiveColors[i % festiveColors.length],
        size: 4.0 + secureRandom() * 4.0,
        swaySpeed: 0.03 + secureRandom() * 0.04,
        swayOffset: secureRandom() * Math.PI * 2,
        swayWidth: 1.2 + secureRandom() * 1.8,
        rotation: secureRandom() * Math.PI * 2,
        rotationSpeed: (secureRandom() - 0.5) * 0.12,
      });
    }
  }

  // Simple joyful victory fanfare using Web Audio API (chiptune style)
  private audioContext: AudioContext | null = null;
  private victoryOscillators: OscillatorNode[] = [];

  /** Lazily creates (or returns) the shared AudioContext (handles webkit prefix + suspended contexts). */
  private ensureAudioContext(): AudioContext | null {
    if (this.audioContext) return this.audioContext;
    try {
      const win = window as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      const AudioContextClass = win.AudioContext || win.webkitAudioContext;
      if (AudioContextClass) {
        this.audioContext = new AudioContextClass();
        return this.audioContext;
      }
    } catch {
      /* no audio */
    }
    return null;
  }

  private playVictoryFanfare(): void {
    const ctx = this.ensureAudioContext();
    if (!ctx) return;

    try {
      const notes = [60, 64, 67, 72, 76, 79, 84]; // C major arpeggio (joyful)
      const noteDuration = 0.18;

      this.victoryOscillators.forEach((osc) => {
        try {
          osc.stop();
        } catch {
          /* ignore */
        }
      });
      this.victoryOscillators = [];

      notes.forEach((midiNote, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();

        const frequency = 440 * 2 ** ((midiNote - 69) / 12);

        osc.type = "sawtooth";
        osc.frequency.value = frequency;

        filter.type = "lowpass";
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
        const c2 = this.ensureAudioContext();
        if (!c2) return;
        const chordNotes = [72, 76, 79, 84];
        chordNotes.forEach((midiNote, i) => {
          const osc = c2.createOscillator();
          const gain = c2.createGain();
          const freq = 440 * 2 ** ((midiNote - 69) / 12);

          osc.type = i === 0 ? "square" : "sawtooth";
          osc.frequency.value = freq;

          gain.gain.value = 0.12;
          const start = c2.currentTime;
          gain.gain.setValueAtTime(0.12, start);
          gain.gain.linearRampToValueAtTime(0.001, start + 1.8);

          osc.connect(gain);
          gain.connect(c2.destination);
          osc.start();
          osc.stop(start + 2.2);
        });
      }, 1100);
    } catch {
      // Audio not available - silently ignore
    }
  }

  private stopVictoryMusic(): void {
    this.victoryOscillators.forEach((osc) => {
      try {
        osc.stop();
      } catch {
        /* ignore */
      }
    });
    this.victoryOscillators = [];
  }

  /** Plays a short chiptune firework explosion pop sound, spatialized left-to-right based on x position. */
  private playFireworkPop(x: number): void {
    const ctx = this.ensureAudioContext();
    if (!ctx) return;

    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      let panner: StereoPannerNode | null = null;
      if (typeof ctx.createStereoPanner === "function") {
        panner = ctx.createStereoPanner();
        const panValue = Math.max(-1, Math.min(1, (x / this.width) * 2 - 1));
        panner.pan.value = panValue;
      }

      // Base explosion thud using a triangle wave with rapid pitch decay
      osc.type = "triangle";
      const baseFreq = 120 + secureRandom() * 50;
      osc.frequency.setValueAtTime(baseFreq, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(25, ctx.currentTime + 0.12);

      filter.type = "lowpass";
      filter.frequency.setValueAtTime(350, ctx.currentTime);

      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);

      osc.connect(filter);
      if (panner) {
        filter.connect(panner);
        panner.connect(gain);
      } else {
        filter.connect(gain);
      }
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + 0.16);

      // Micro crackle pop (high pitch white-noise simulation with sawtooth) for sparkle feel
      if (secureRandom() < 0.38) {
        const crackleOsc = ctx.createOscillator();
        const crackleGain = ctx.createGain();

        crackleOsc.type = "sawtooth";
        crackleOsc.frequency.setValueAtTime(
          900 + secureRandom() * 1100,
          ctx.currentTime,
        );
        crackleGain.gain.setValueAtTime(0.015, ctx.currentTime);
        crackleGain.gain.linearRampToValueAtTime(0.001, ctx.currentTime + 0.04);

        if (panner) {
          crackleOsc.connect(panner);
        } else {
          crackleOsc.connect(crackleGain);
        }
        crackleGain.connect(ctx.destination);

        crackleOsc.start();
        crackleOsc.stop(ctx.currentTime + 0.05);
      }
    } catch {
      // Audio failed or blocked - silently ignore
    }
  }

  private queueFireworkSpawn(p: FireworkParticle): void {
    if (
      this.fireworks.length + this.fireworkSpawnBuffer.length <
      MAX_FIREWORKS
    ) {
      this.fireworkSpawnBuffer.push(p);
    }
  }

  private flushFireworkSpawns(): void {
    for (const spawn of this.fireworkSpawnBuffer) {
      if (this.fireworks.length >= MAX_FIREWORKS) break;
      this.fireworks.push(spawn);
    }
    this.fireworkSpawnBuffer.length = 0;
  }

  private updateFireworks(dt: number): void {
    this.fireworksUpdateAccum += dt;
    if (this.fireworksUpdateAccum < FIREWORKS_TICK_DT) return;
    this.fireworksUpdateAccum -= FIREWORKS_TICK_DT;

    this.tickFireworks();
  }

  private tickFireworks(): void {
    if (this.celebrationWinnerTankId) {
      // Animate the winning tank's cannon sweeping back and forth during celebration
      // and "shooting" fireworks from the barrel tip (so fireworks blow up from the tank).
      const angleStep = 1.0; // deg per update tick (~120Hz) for visible cannon sweep + frequent shots
      this.celebrationAngle += this.celebrationAngleDir * angleStep;
      if (this.celebrationAngle > 112.5) {
        this.celebrationAngle = 112.5;
        this.celebrationAngleDir = -1;
      } else if (this.celebrationAngle < 78.5) {
        this.celebrationAngle = 78.5;
        this.celebrationAngleDir = 1;
      }

      // Shoot a firework rocket from the cannon tip at the current angle (with some spread)
      if (secureRandom() < 0.18) {
        const winnerP = this.celebrationWinner;
        if (winnerP) {
          const tank = winnerP.tank;
          const barrelLength = 20;
          const rad = (this.celebrationAngle * Math.PI) / 180;
          const barrelStartY = tank.position.y - 13;
          const tipX = tank.position.x + Math.cos(rad) * barrelLength;
          const tipY = barrelStartY + Math.sin(rad) * barrelLength * -1;
          const speed = 4.2 + secureRandom() * 2.8;
          const spread = (secureRandom() - 0.5) * 0.8;
          this.queueFireworkSpawn({
            type: "rocket",
            x: tipX,
            y: tipY,
            vx: Math.cos(rad) * speed + spread,
            vy: -Math.sin(rad) * speed - 0.8 + spread * 0.4,
            life: 35 + secureRandom() * 20,
            maxLife: 55,
            color: this.celebrationColor,
            size: 2.5 + secureRandom() * 1.5,
            trail: [],
          });
        }
      }
    }

    if (this.fireworks.length === 0 && this.fireworkSpawnBuffer.length === 0) {
      return;
    }

    let write = 0;

    for (let read = 0; read < this.fireworks.length; read++) {
      const p = this.fireworks[read];
      p.x += p.vx;
      p.y += p.vy;

      if (p.type === "rocket") {
        p.vy += 0.045; // gravity for rockets (flatter arc)
        p.life -= 1;

        // Maintain trail
        if (!p.trail) p.trail = [];
        p.trail.push({ x: p.x, y: p.y, alpha: 1.0 });
        if (p.trail.length > 7) p.trail.shift();
        for (const pt of p.trail) {
          pt.alpha -= 0.12;
        }

        // Rocket spark trails
        if (secureRandom() < 0.22) {
          this.queueFireworkSpawn({
            type: "particle",
            x: p.x - p.vx * 0.5,
            y: p.y - p.vy * 0.5,
            vx: (secureRandom() - 0.5) * 0.5,
            vy: 0.2 + secureRandom() * 0.6,
            life: 8 + secureRandom() * 8,
            maxLife: 16,
            color:
              secureRandom() < 0.5
                ? VGA_PALETTE.CYBER_YELLOW
                : VGA_PALETTE.WHITE,
            size: 1.2 + secureRandom() * 0.8,
            trail: [],
          });
        }

        // Explode when life ends
        if (p.life <= 0) {
          this.playFireworkPop(p.x);

          const explosionPattern = Math.floor(secureRandom() * 4);

          if (explosionPattern === 0) {
            // Ring Burst
            const count = 22 + Math.floor(secureRandom() * 10);
            const baseSpeed = 2.4 + secureRandom() * 1.6;
            const burstColor =
              secureRandom() < 0.4
                ? FESTIVE_COLORS[
                    Math.floor(secureRandom() * FESTIVE_COLORS.length)
                  ]
                : p.color;
            for (let i = 0; i < count; i++) {
              const angle = (i * 2 * Math.PI) / count;
              this.queueFireworkSpawn({
                type: "particle",
                x: p.x,
                y: p.y,
                vx: Math.cos(angle) * baseSpeed + (secureRandom() - 0.5) * 0.3,
                vy: Math.sin(angle) * baseSpeed + (secureRandom() - 0.5) * 0.3,
                life: 25 + secureRandom() * 18,
                maxLife: 43,
                color: burstColor,
                size: 2.0 + secureRandom() * 1.8,
                trail: [],
              });
            }
          } else if (explosionPattern === 1) {
            // Rainbow Star Burst
            const count = 28 + Math.floor(secureRandom() * 12);
            for (let i = 0; i < count; i++) {
              const angle = secureRandom() * Math.PI * 2;
              const speed = 1.0 + secureRandom() * 3.8;
              this.queueFireworkSpawn({
                type: "particle",
                x: p.x,
                y: p.y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 20 + secureRandom() * 22,
                maxLife: 42,
                color:
                  FESTIVE_COLORS[
                    Math.floor(secureRandom() * FESTIVE_COLORS.length)
                  ],
                size: 1.8 + secureRandom() * 2.2,
                trail: [],
              });
            }
          } else if (explosionPattern === 2) {
            // Fountain Cascade
            const count = 18 + Math.floor(secureRandom() * 10);
            const burstColor =
              secureRandom() < 0.3 ? VGA_PALETTE.CYBER_YELLOW : p.color;
            for (let i = 0; i < count; i++) {
              this.queueFireworkSpawn({
                type: "particle",
                x: p.x,
                y: p.y,
                vx: (secureRandom() - 0.5) * 2.2,
                vy: -2.0 - secureRandom() * 3.5,
                life: 30 + secureRandom() * 25,
                maxLife: 55,
                color: burstColor,
                size: 1.5 + secureRandom() * 1.5,
                trail: [],
              });
            }
          } else {
            // Crackling Willow
            const count = 24 + Math.floor(secureRandom() * 8);
            for (let i = 0; i < count; i++) {
              const angle = secureRandom() * Math.PI * 2;
              const speed = 1.8 + secureRandom() * 2.8;
              this.queueFireworkSpawn({
                type: "particle",
                x: p.x,
                y: p.y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 0.4,
                life: 28 + secureRandom() * 22,
                maxLife: 50,
                color:
                  secureRandom() < 0.5
                    ? VGA_PALETTE.CYBER_YELLOW
                    : VGA_PALETTE.WHITE,
                size: 1.5 + secureRandom() * 1.0,
                trail: [],
              });
            }
          }

          // Spawn a burst of falling confetti at each rocket explosion
          const confettiCount = 6 + Math.floor(secureRandom() * 6);
          for (let i = 0; i < confettiCount; i++) {
            this.queueFireworkSpawn({
              type: "confetti",
              x: p.x,
              y: p.y,
              vx: (secureRandom() - 0.5) * 3.5,
              vy: -1.0 - secureRandom() * 2.0,
              life: 110 + secureRandom() * 80,
              maxLife: 190,
              color:
                FESTIVE_COLORS[
                  Math.floor(secureRandom() * FESTIVE_COLORS.length)
                ],
              size: 4 + secureRandom() * 4,
              swaySpeed: 0.04 + secureRandom() * 0.05,
              swayOffset: secureRandom() * Math.PI * 2,
              swayWidth: 1.2 + secureRandom() * 1.8,
              rotation: secureRandom() * Math.PI * 2,
              rotationSpeed: (secureRandom() - 0.5) * 0.15,
            });
          }
        } else {
          this.fireworks[write++] = p;
        }
      } else if (p.type === "particle") {
        p.vy += 0.075; // gravity for explosion particles
        p.vx *= 0.95; // air resistance
        p.vy *= 0.95;
        p.life -= 1;

        // Particle trail
        if (!p.trail) p.trail = [];
        p.trail.push({ x: p.x, y: p.y, alpha: 1.0 });
        if (p.trail.length > 3) p.trail.shift();

        // Shrink particle when near end of life
        if (p.life < 8) {
          p.size *= 0.82;
        }

        if (p.life > 0) {
          this.fireworks[write++] = p;
        }
      } else if (p.type === "confetti") {
        // Slow descent confetti physics
        p.vy = Math.min(1.0, p.vy + 0.025); // cap vertical speed
        p.vx = Math.sin(p.life * p.swaySpeed! + p.swayOffset!) * p.swayWidth!;
        p.rotation! += p.rotationSpeed!;
        p.life -= 1;

        // Check ground height to avoid drawing confetti underground
        const groundY = this.terrain.getHeightAt(
          Math.max(0, Math.min(this.width - 1, Math.floor(p.x))),
        );

        if (p.life > 0 && p.y < groundY) {
          this.fireworks[write++] = p;
        }
      }
    }

    this.fireworks.length = write;
    this.flushFireworkSpawns();

    let activeRockets = 0;
    let activeConfetti = 0;
    for (const f of this.fireworks) {
      if (f.type === "rocket") activeRockets++;
      else if (f.type === "confetti") activeConfetti++;
    }

    // Keep spawning lots of big rockets from the bottom of the screen while celebrating
    if (activeRockets < 5 && secureRandom() < 0.07) {
      const spawnX = Math.max(
        40,
        Math.min(
          this.width - 40,
          this.celebrationCenterX + (secureRandom() - 0.5) * 260,
        ),
      );
      const spawnColor =
        FESTIVE_COLORS[Math.floor(secureRandom() * FESTIVE_COLORS.length)];
      this.queueFireworkSpawn({
        type: "rocket",
        x: spawnX,
        y: this.height - 15,
        vx: (secureRandom() - 0.5) * 1.8,
        vy: -5.5 - secureRandom() * 3.0,
        life: 45 + secureRandom() * 22,
        maxLife: 67,
        color: spawnColor,
        size: 3.5 + secureRandom() * 2.0,
        trail: [],
      });
    }

    // Add extra random confetti rain during high celebration
    if (activeConfetti < 40 && secureRandom() < 0.15) {
      this.queueFireworkSpawn({
        type: "confetti",
        x: secureRandom() * this.width,
        y: -10,
        vx: (secureRandom() - 0.5) * 1.0,
        vy: 0.3 + secureRandom() * 0.5,
        life: 130 + secureRandom() * 90,
        maxLife: 220,
        color:
          FESTIVE_COLORS[Math.floor(secureRandom() * FESTIVE_COLORS.length)],
        size: 4 + secureRandom() * 3.5,
        swaySpeed: 0.03 + secureRandom() * 0.04,
        swayOffset: secureRandom() * Math.PI * 2,
        swayWidth: 1.0 + secureRandom() * 1.8,
        rotation: secureRandom() * Math.PI * 2,
        rotationSpeed: (secureRandom() - 0.5) * 0.1,
      });
    }

    this.flushFireworkSpawns();
  }

  /** Draws celebration fireworks (game over match win or pre-SUMMARY round winner celebration) */
  private drawFireworks(ctx: CanvasRenderingContext2D): void {
    for (const p of this.fireworks) {
      const alpha = Math.max(0.1, p.life / p.maxLife);
      ctx.globalAlpha = alpha;

      // Draw trails if any (for rockets and explosion particles)
      if (p.trail && p.trail.length > 0) {
        for (const pt of p.trail) {
          ctx.fillStyle = p.color;
          ctx.globalAlpha = pt.alpha * alpha * 0.38;
          ctx.fillRect(
            pt.x - p.size / 3,
            pt.y - p.size / 3,
            p.size / 1.5,
            p.size / 1.5,
          );
        }
      }

      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;

      if (p.type === "confetti") {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation || 0);
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      } else {
        const s = p.size;
        ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);

        // Extra glow halo for bigger particles or rockets
        if (s > 3.0) {
          ctx.globalAlpha = alpha * 0.28;
          ctx.fillRect(p.x - s, p.y - s, s * 2, s * 2);
        }
      }
    }
    ctx.globalAlpha = 1.0;
  }

  /**
   * Spawn red-orange thermonuclear impact explosion VFX + flash.
   * Called from onProjectileHit for THERMONUCLEAR only.
   * Uses blocky rects + alpha (retro feel, same technique as fireworks).
   */
  private spawnThermonuclearExplosion(x: number, y: number): void {
    this.thermoFlashLife = 13; // frames of full-ish red flash overlay
    const colors = [
      VGA_PALETTE.RED,
      VGA_PALETTE.YELLOW,
      VGA_PALETTE.DARK_RED,
      VGA_PALETTE.BROWN,
    ];
    for (let i = 0; i < 42; i++) {
      const spread = 38 + secureRandom() * 18;
      this.impactExplosions.push({
        x: x + (secureRandom() - 0.5) * spread,
        y: y + (secureRandom() - 0.5) * (spread * 0.7),
        life: 42 + secureRandom() * 28,
        maxLife: 70,
        size: 2.5 + secureRandom() * 8.5,
        color: colors[i % colors.length],
      });
    }
  }

  private updateImpactExplosions(): void {
    const next: typeof this.impactExplosions = [];
    for (const p of this.impactExplosions) {
      p.life -= 1;
      if (p.life > 0) {
        // subtle expansion on the way out for "blast wave" feel (first half of life)
        if (p.life > p.maxLife * 0.5) {
          p.size = p.size * 1.012 + 0.04;
        }
        next.push(p);
      }
    }
    this.impactExplosions = next;
  }

  private drawImpactExplosions(ctx: CanvasRenderingContext2D): void {
    for (const p of this.impactExplosions) {
      const a = Math.max(0.08, p.life / p.maxLife);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      const s = p.size;
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);

      // glow / ring layers for "huge" red-orange explosion
      if (s > 4) {
        ctx.globalAlpha = a * 0.32;
        ctx.fillRect(p.x - s * 0.9, p.y - s * 0.9, s * 1.8, s * 1.8);
      }
      if (s > 7) {
        ctx.globalAlpha = a * 0.15;
        ctx.fillRect(p.x - s * 1.35, p.y - s * 1.35, s * 2.7, s * 2.7);
      }
    }
    ctx.globalAlpha = 1;
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

  /** Fully resets the game for a new match */
  public resetGame(): void {
    this.stopVictoryMusic();
    this.gameOver = false;
    this.winner = null;
    this.roundCombatActive = true;
    this.fireworks = [];
    this.impactExplosions = [];
    this.thermoFlashLife = 0;
    this.celebrationWinnerTankId = null;
    this.celebrationWinner = null;
    this.celebrationAngle = 90;
    this.celebrationAngleDir = 1;
    this.physicsEngine.clear(false);
    this.turnManager.reset();

    // Regenerate terrain
    this.terrain.generate();

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
    this.lastSlideTimes.clear();
    this.tankManager.clearVelocities();

    // Note: Players should be re-set via setPlayers() after calling this
  }

  // ============================================================
  // Sound synthesis (Web Audio, chiptune/retro style, no assets)
  // All methods are silent on failure and never throw to the loop.
  // ============================================================

  private playZeusAppointmentSound(): void {
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    try {
      this.playNoiseBurst(0.24, 0.3, 1100, 90);
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "square";
      oscillator.frequency.setValueAtTime(92, ctx.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(42, ctx.currentTime + 0.28);
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + 0.31);
    } catch {
      // Audio is optional and must never interrupt combat.
    }
  }

  private playZeusStrikeSound(): void {
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    try {
      this.playNoiseBurst(0.18, 0.45, 3200, 120);
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sawtooth";
      oscillator.frequency.setValueAtTime(180, ctx.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(48, ctx.currentTime + 0.22);
      gain.gain.setValueAtTime(0.22, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.24);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + 0.25);
    } catch {
      // Audio is optional and must never interrupt combat.
    }
  }

  private playFireSound(weaponId: WeaponId): void {
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;

      // Goal: move away from clean PONG-style square/saw beeps toward short, noisy, percussive
      // "launch reports" in the spirit of old TankWars / Scorched Earth on NES/ATARI-era hardware.
      // Heavy use of noise (LFSR) + a little low tone for body. Short, gritty, not melodic.

      switch (weaponId) {
        case "MISSILE": {
          // Classic rocket launch: mid noise whoosh + quick low "thump" body
          this.playNoiseBurst(0.09, 0.22, 1800, 420);
          // subtle low end "report"
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "triangle"; // more "NES triangle channel" feel than sine
          osc.frequency.value = 95;
          gain.gain.value = 0.18;
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          gain.gain.setValueAtTime(0.18, now);
          gain.gain.linearRampToValueAtTime(0.0005, now + 0.07);
          osc.stop(now + 0.09);
          break;
        }
        case "GRENADE": {
          // Lobbed: shorter, slightly higher noise "pop" with a little tail
          this.playNoiseBurst(0.07, 0.26, 2400, 650);
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "square";
          osc.frequency.value = 140;
          gain.gain.value = 0.15;
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          gain.gain.setValueAtTime(0.15, now);
          gain.gain.linearRampToValueAtTime(0.0004, now + 0.09);
          osc.stop(now + 0.11);
          break;
        }
        case "CLUSTER": {
          // Multiple small noisy "submunition release" pops — not clean chirps
          for (let k = 0; k < 4; k++) {
            this.playNoiseBurst(0.045, 0.15, 2600 + k * 120, 900);
          }
          break;
        }
        case "NUKE": {
          // Deep heavy launch rumble
          this.playNoiseBurst(0.28, 0.28, 650, 140);
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "triangle";
          osc.frequency.value = 55;
          gain.gain.value = 0.35;
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          gain.gain.setValueAtTime(0.35, now);
          gain.gain.linearRampToValueAtTime(0.0003, now + 0.26);
          osc.stop(now + 0.32);
          break;
        }
        case "THERMONUCLEAR": {
          // Massive thermonuclear launch — deeper/longer than nuke
          this.playNoiseBurst(0.36, 0.33, 520, 85);
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "triangle";
          osc.frequency.value = 38;
          gain.gain.value = 0.38;
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          gain.gain.setValueAtTime(0.38, now);
          gain.gain.linearRampToValueAtTime(0.0002, now + 0.38);
          osc.stop(now + 0.42);
          break;
        }
        case "DRILLER": {
          // Rapid noisy "drilling / boring" texture — series of gritty ticks
          for (let k = 0; k < 5; k++) {
            this.playNoiseBurst(0.028, 0.18, 3200 - k * 180, 1100);
          }
          // low "motor" hum underneath
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sawtooth";
          osc.frequency.value = 85;
          gain.gain.value = 0.12;
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          osc.frequency.setValueAtTime(85, now);
          osc.frequency.linearRampToValueAtTime(72, now + 0.12);
          gain.gain.setValueAtTime(0.12, now);
          gain.gain.linearRampToValueAtTime(0.0004, now + 0.13);
          osc.stop(now + 0.15);
          break;
        }
      }
    } catch {
      /* silent */
    }
  }

  private playImpactSound(weaponId: WeaponId): void {
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;

      // Make impacts feel like real old-school artillery hits: the noise is the star.
      // Use LFSR noise + downward filter sweep (bright crackle → low rumble).
      // Only a little low triangle body for the "oomph", not a clean pongy tone.

      const isNuke = weaponId === "NUKE";
      const isCluster = weaponId === "CLUSTER";
      const isThermo = weaponId === "THERMONUCLEAR";

      if (isThermo) {
        // HUGE bomb sound: long multi-layer nuclear rumble + aftershocks (deeper + longer than nuke)
        this.playNoiseBurst(0.82, 0.39, 1750, 48);
        this.playNoiseBurst(0.62, 0.28, 880, 35, 0.18);
        // deep body layers
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = "triangle";
        osc1.frequency.value = 32;
        gain1.gain.value = 0.46;
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.start(now);
        gain1.gain.setValueAtTime(0.46, now);
        gain1.gain.linearRampToValueAtTime(0.00015, now + 0.85);
        osc1.stop(now + 0.92);

        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = "sawtooth";
        osc2.frequency.value = 28;
        gain2.gain.value = 0.22;
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start(now + 0.12);
        osc2.frequency.setValueAtTime(28, now + 0.12);
        osc2.frequency.linearRampToValueAtTime(22, now + 0.75);
        gain2.gain.setValueAtTime(0.22, now + 0.12);
        gain2.gain.linearRampToValueAtTime(0.0001, now + 0.95);
        osc2.stop(now + 1.0);
      } else if (isNuke) {
        // Huge dirty explosion
        this.playNoiseBurst(0.55, 0.32, 2100, 95);
        // very low body
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.value = 42;
        gain.gain.value = 0.42;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        gain.gain.setValueAtTime(0.42, now);
        gain.gain.linearRampToValueAtTime(0.0002, now + 0.6);
        osc.stop(now + 0.7);
      } else if (isCluster) {
        // Several small noisy secondary blasts
        for (let k = 0; k < 3; k++) {
          this.playNoiseBurst(0.13, 0.18, 2800, 420);
        }
      } else {
        // Standard missile/grenade/driller hit
        const startCut = weaponId === "DRILLER" ? 3200 : 1950;
        const endCut = weaponId === "GRENADE" ? 380 : 160;
        this.playNoiseBurst(0.22, 0.26, startCut, endCut);

        // light low body
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.value = 78;
        gain.gain.value = 0.17;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        gain.gain.setValueAtTime(0.17, now);
        gain.gain.linearRampToValueAtTime(0.0003, now + 0.18);
        osc.stop(now + 0.22);
      }
    } catch {
      /* silent */
    }
  }

  private playTankDestroyedByExplosionSound(): void {
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;

      // Tank vaporized by direct/splash hit — big noisy boom + debris crackle
      // Primary is a longer LFSR noise with strong downward sweep
      this.playNoiseBurst(0.38, 0.29, 2400, 180);

      // Low dirty body (triangle for that old console bass thump)
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = 58;
      gain.gain.value = 0.32;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      gain.gain.setValueAtTime(0.32, now);
      gain.gain.linearRampToValueAtTime(0.0003, now + 0.42);
      osc.stop(now + 0.48);
    } catch {
      /* silent */
    }
  }

  private playTankSadBurialSound(): void {
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;

      // Burial / falling off the bottom: slow noisy "whoosh of falling into the pit"
      // + final wet/muffled splat. Much less musical, more "realistic old game" dirt sound.
      // Long filtered noise sweep down (air + dirt falling)
      this.playNoiseBurst(0.65, 0.22, 1450, 95);

      // Final low "splat into the abyss" — reuse the floor thump character but softer/sadder
      const t2 = now + 0.48;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = 48;
      gain.gain.value = 0.21;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t2);
      gain.gain.setValueAtTime(0.21, t2);
      gain.gain.linearRampToValueAtTime(0.0002, t2 + 0.38);
      osc.stop(t2 + 0.45);

      // Extra low muffled tail for the "sinking" finality (scheduled via offset)
      this.playNoiseBurst(0.32, 0.14, 260, 80, 0.52);
    } catch {
      /* silent */
    }
  }

  private playTankSlidingSound(playerId: string): void {
    const now = performance.now();
    const last = this.lastSlideTimes.get(playerId) ?? 0;
    if (now - last < 82) return; // throttle ~12 per sec max per tank
    this.lastSlideTimes.set(playerId, now);

    // Short gritty scrape (noise works great for dirt/rock slide)
    this.playNoiseBurst(0.032, 0.075, 1950);
  }

  private playTankTouchLowestFloorSound(): void {
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      // Heavy low thump — keep the character the user liked, but use triangle + swept LFSR noise
      // for a bit more "dirt" while staying percussive and satisfying.
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = 48;
      gain.gain.value = 0.36;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      gain.gain.setValueAtTime(0.36, now);
      gain.gain.linearRampToValueAtTime(0.0003, now + 0.38);
      osc.stop(now + 0.45);

      // Muffled impact noise with a little sweep
      this.playNoiseBurst(0.26, 0.19, 380, 110);
    } catch {
      /* silent */
    }
  }

  /**
   * Noise burst helper — now with retro LFSR-style noise (more NES/ATARI grit than pure white)
   * and optional filter sweep (start high for crackle, sweep low for body rumble).
   * This is the key to moving away from "PONG" clean beeps toward thumpy, crackly old-school explosions.
   */
  private playNoiseBurst(
    duration: number,
    volume: number,
    cutoff: number,
    sweepTo?: number,
    startOffset = 0,
  ): void {
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    try {
      const len = Math.max(1, Math.floor(ctx.sampleRate * duration));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);

      // Simple 16-bit LFSR for grittier, more "console noise channel" character (periodicity + buzz)
      // instead of modern white noise. This helps the "NES/ATARI but realistic" feel.
      let lfsr = 0xace1 >>> 0;
      for (let i = 0; i < len; i++) {
        // 16-bit LFSR with common taps (0, 2, 3, 5) for decent length sequence
        const bit = ((lfsr >> 0) ^ (lfsr >> 2) ^ (lfsr >> 3) ^ (lfsr >> 5)) & 1;
        lfsr = ((lfsr >>> 1) | (bit << 15)) >>> 0;
        data[i] = lfsr & 1 ? 0.9 : -0.9; // slightly less than full scale for headroom when layered
      }

      const src = ctx.createBufferSource();
      src.buffer = buf;

      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = cutoff;

      const gain = ctx.createGain();
      gain.gain.value = volume;

      const t = ctx.currentTime + Math.max(0, startOffset);
      gain.gain.setValueAtTime(volume, t);
      gain.gain.linearRampToValueAtTime(0.0004, t + duration);

      // Optional downward sweep on the filter for that classic "explosion blooming then settling" feel
      if (sweepTo !== undefined && sweepTo > 0) {
        filter.frequency.setValueAtTime(cutoff, t);
        filter.frequency.linearRampToValueAtTime(sweepTo, t + duration * 0.9);
      }

      src.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      src.start(t);
    } catch {
      /* silent */
    }
  }
}
