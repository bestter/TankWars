/**
 * GameRoom Durable Object (worker/src/game-room.ts)
 *
 * Responsibilities (online authority around a still-local physics simulation):
 * - Store room config (numPlayers, per-slot type human/ai + aiProfile)
 * - Generate per-slot join secrets/tokens
 * - Manage presence: human slots claim via WS with token
 * - Track "joined" humans vs AI (AI are always "ready")
 * - Auto-start when all human slots have joined
 * - On start: build authoritative Player[] roster, generate initial terrain heights + wind
 * - Accept FIRE commands only from the correct human slot on their turn
 * - Validate and consume each FIRE before persisting and broadcasting its SHOT
 * - Own transactional shop sessions, AI purchases and idempotent SHOP_FINISH
 * - Persist shot history, active coordination and reconnect catch-up state
 *
 * NOTE for MVP: The real headless GameEngine / SimulationCore + RNG seeding lives in the client
 * engine files (will be extended with headless flag). For now the DO validates intentions and
 * economy while each client replays the same persisted SHOT through its local Canvas physics.
 *
 * All random MUST go through a seeded RNG for determinism (injected later).
 */

import { DurableObject } from "cloudflare:workers";

import type { Player } from '../../src/types/player'; // share types from root (works in monorepo-style dev)
import type { Color } from '../../src/types/game';
import type { WeaponId } from '../../src/types/weapon';
import type { TerrainMaterial } from '../../src/types/terrain';
import { DEFAULT_INVENTORY } from '../../src/types/weapon';
import { nextLivingPlayerIndex } from '../../src/game/online/turnOrder';
import {
  decodeFireMessage,
  decodeShopBuySellMessage,
  decodeShopReadyMessage,
  isStrictOnlineMessage,
  type AuthorityChangedMessage,
  type FireRejectedMessage,
  type RequestGameStartMessage,
  type RoundEndMessage,
  type ShopFinishMessage,
  type ShopBuySellMessage,
  type ShopRejectedMessage,
  type ShopReadyMessage,
  type ShopStateMessage,
  type ShotEarningsAppliedMessage,
  type ShotEarningsMessage,
  type ShotCatchUpMessage,
  type ShotMessage,
  type ZeusAppointedMessage,
  type ZeusStateMessage,
  type ZeusStrikeAppliedMessage,
  type ZeusStrikeMessage,
} from '../../src/game/online/protocol';
import { autoBuyForAI } from '../../src/game/entities/ai/aiShopHelper';
import {
  applyShopTransaction,
  consumeWeaponForFire,
  normalizeRosterAtShopOpen,
  type ShopVisitCounters,
} from '../../src/game/shop/shopTransaction';
import {
  guardShopAction,
  guardShopEnter,
} from '../../src/game/shop/shopSessionGuard';
import {
  allocateZeusStrike,
  createZeusState,
  evaluateZeusDeadlock,
  resetZeusRound,
  selectZeusTarget,
  type ZeusState,
} from '../../src/game/zeus/zeusDomain';
import { calculateZeusStrikeReward } from '../../src/game/zeus/zeusRewards';

interface PersistedActiveShot extends Omit<ShotMessage, 'type'> {
  shooterSettled: boolean;
  earningsApplied: boolean;
  releaseAt: number | null;
}

interface PersistedEarningsResult extends ShotEarningsAppliedMessage {
  deadSlots: boolean[];
  authorityEpoch: number;
  directHitVictimIds: string[];
}

type PersistedShopActionResult =
  | ShopStateMessage
  | ShopRejectedMessage
  | ShopFinishMessage;

interface PersistedShopSession {
  shopEpoch: number;
  roundNumber: number;
  readySlots: number[];
  purchasesByPlayerId: ShopVisitCounters;
  aiShopApplied: boolean;
}

interface PersistedShopAction {
  slot: number;
  result: PersistedShopActionResult;
}

type PersistedFireResult = ShotMessage | FireRejectedMessage;

interface PersistedFireAction {
  slot: number;
  result: ShotMessage;
}

interface LegacyPersistedFireAction {
  slot: number;
  result: PersistedFireResult;
}

// Very small serializable state for MVP (will be enriched with real engine state later)
interface RoomState {
  roomId: string;
  numPlayers: number;
  slotConfigs: Array<{ type: 'human' | 'ai'; aiProfile?: string }>;
  // secrets per slot (the "token" part of the join URL)
  tokens: string[];
  joinedHumans: Record<number, { name: string; joinedAt: number; joinOrdinal: number }>;
  // When game has started
  started: boolean;
  startAt?: number;
  // Authoritative game state (MVP single round)
  players: Player[];
  heights: number[]; // full heightmap (server truth)
  materials: TerrainMaterial[]; // [] until headless terrain.generate is wired
  wind: number;
  currentPlayerIndex: number;
  roundEnded: boolean;
  authorityOrder: number[];
  earningsAuthoritySlot: number | null;
  authorityEpoch: number;
  nextJoinOrdinal: number;
  joinOrdinals: Record<number, number>;
  nextShotId: number;
  roundNumber: number;
  shotNumberInRound: number;
  activeShot: PersistedActiveShot | null;
  shotHistory: ShotMessage[];
  processedFireActionsBySlot: Record<number, Record<string, PersistedFireAction>>;
  /** Ancien index global, lu uniquement pour la migration des salles persistées. */
  processedFireActions?: Record<string, LegacyPersistedFireAction>;
  lastFireResultBySlot: Record<number, FireRejectedMessage>;
  lastAppliedEarnings: PersistedEarningsResult | null;
  shopEpoch: number;
  shopSession: PersistedShopSession | null;
  processedShopActions: Record<string, PersistedShopAction>;
  lastCompletedShop: ShopFinishMessage | null;
  zeusState: ZeusState;
  zeusRotationSlots: number[];
  lastDirectAttackerByPlayerId: Record<string, string>;
  zeusRngState: number;
  activeZeusStrike: ZeusStrikeMessage | null;
  lastAppliedZeusStrike: ZeusStrikeAppliedMessage | null;
}

// Helper: simple short token (not crypto secure for prod but fine for game invite links)
function makeToken(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 for readability
  let t = '';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < bytes.length; i++) {
    t += alphabet[bytes[i] % alphabet.length];
  }
  return t;
}

// Very lightweight seeded RNG (for future injection of real server sim determinism)
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromString(value: string): number {
  let seed = 0;
  for (let index = 0; index < value.length; index++) {
    seed = Math.imul(seed, 31) + value.charCodeAt(index);
    seed |= 0;
  }
  return seed >>> 0;
}

function makeShopActionKey(
  kind: 'BUY_SELL' | 'READY',
  slot: number,
  actionId: string,
): string {
  return `${kind}:${slot}:${actionId}`;
}

function isPersistedFireAction(value: unknown): value is LegacyPersistedFireAction {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.slot === 'number' &&
    Number.isSafeInteger(record.slot) &&
    record.slot >= 0 &&
    isStrictOnlineMessage(record.result) &&
    (record.result.type === 'SHOT' || record.result.type === 'FIRE_REJECTED')
  );
}

function migrateAcceptedFireActions(
  actionsBySlot: Record<number, Record<string, unknown>> | undefined,
  legacyActions: Record<string, unknown> | undefined,
): {
  actions: Record<number, Record<string, PersistedFireAction>>;
  changed: boolean;
} {
  const actions: Record<number, Record<string, PersistedFireAction>> = {};
  let sourceCount = 0;
  let acceptedCount = 0;

  const addAction = (actionId: string, value: unknown, expectedSlot?: number): void => {
    sourceCount++;
    if (!isPersistedFireAction(value) || value.result.type !== 'SHOT') return;
    const slot = expectedSlot ?? value.slot;
    if (value.slot !== slot || value.result.slot !== slot || value.result.actionId !== actionId) {
      return;
    }
    actions[slot] ??= {};
    actions[slot][actionId] = { slot, result: value.result };
    acceptedCount++;
  };

  for (const [slotKey, slotActions] of Object.entries(actionsBySlot ?? {})) {
    const slot = Number(slotKey);
    if (!Number.isSafeInteger(slot) || slot < 0) {
      sourceCount += Object.keys(slotActions).length;
      continue;
    }
    for (const [actionId, action] of Object.entries(slotActions)) {
      addAction(actionId, action, slot);
    }
  }
  for (const [actionId, action] of Object.entries(legacyActions ?? {})) {
    addAction(actionId, action);
  }

  return {
    actions,
    changed: legacyActions !== undefined || acceptedCount !== sourceCount,
  };
}

export class GameRoom extends DurableObject {
  private state: RoomState | null = null;
  private sockets: Map<number, WebSocket> = new Map(); // slot -> ws (only connected humans)
  private aiProfiles: Map<number, string> = new Map();
  private shotSettledTimeout: ReturnType<typeof setTimeout> | null = null;
  /** Slot whose human shot the server is waiting on (null = not awaiting settlement). */
  private awaitingShotFromSlot: number | null = null;
  /**
   * True from executeFire until advanceTurnAndNotify completes.
   * Prevents double FIRE and double turn advances (SHOT_SETTLED vs 8s timeout races).
   */
  private shotInFlight = false;
  /**
   * Monotonic epoch bumped on every new shot and every successful turn advance.
   * Settlement timeouts capture the epoch at arm time and no-op if it changed.
   */
  private shotEpoch = 0;
  /**
   * Last SHOT broadcast while a shot is in flight. Re-sent on combat WS reconnect so
   * observers who missed the original message still replay the projectile.
   */
  private lastShot: {
    slot: number;
    command: { angle: number; power: number; weaponId: WeaponId };
    ownerId?: string;
  } | null = null;

  // Load state from storage on cold start
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as Record<string, unknown>);
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<RoomState>("state");
      if (stored) {
        this.state = stored;
        let shouldPersistMigration = false;
        if (!this.state.materials) this.state.materials = [];
        this.state.authorityOrder ??= [];
        this.state.earningsAuthoritySlot ??= null;
        this.state.authorityEpoch ??= 0;
        this.state.nextJoinOrdinal ??= Object.keys(this.state.joinedHumans).length;
        this.state.joinOrdinals ??= Object.fromEntries(
          Object.entries(this.state.joinedHumans).map(([slot, info]) => [slot, info.joinOrdinal]),
        );
        this.state.nextShotId ??= 1;
        this.state.roundNumber ??= 1;
        this.state.shotNumberInRound ??= 0;
        this.state.activeShot ??= null;
        this.state.shotHistory ??= [];
        const legacyFireActions = this.state.processedFireActions;
        const migratedFireActions = migrateAcceptedFireActions(
          this.state.processedFireActionsBySlot,
          legacyFireActions,
        );
        this.state.processedFireActionsBySlot = migratedFireActions.actions;
        shouldPersistMigration ||= migratedFireActions.changed;
        if (legacyFireActions !== undefined) {
          delete this.state.processedFireActions;
        }
        const lastFireRejections: Record<number, FireRejectedMessage> = {};
        for (const [slotKey, result] of Object.entries(
          this.state.lastFireResultBySlot ?? {},
        )) {
          const slot = Number(slotKey);
          if (
            Number.isSafeInteger(slot) &&
            slot >= 0 &&
            isStrictOnlineMessage(result) &&
            result.type === 'FIRE_REJECTED'
          ) {
            lastFireRejections[slot] = result;
          } else {
            shouldPersistMigration = true;
          }
        }
        this.state.lastFireResultBySlot = lastFireRejections;
        this.state.lastAppliedEarnings ??= null;
        this.state.shopEpoch ??= 0;
        this.state.shopSession ??= null;
        this.state.processedShopActions ??= {};
        this.state.lastCompletedShop ??= null;
        if (this.state.lastAppliedEarnings) {
          this.state.lastAppliedEarnings.directHitVictimIds ??= [];
        }
        this.state.zeusState ??= createZeusState();
        this.state.zeusRotationSlots ??= [];
        this.state.lastDirectAttackerByPlayerId ??= {};
        this.state.zeusRngState ??= seedFromString(this.state.roomId);
        this.state.activeZeusStrike ??= null;
        this.state.lastAppliedZeusStrike ??= null;
        this.shotInFlight = this.state.activeShot !== null;
        this.awaitingShotFromSlot = this.state.activeShot?.slot ?? null;
        // Restore AI profiles in memory if reloaded
        if (this.state.slotConfigs) {
          this.state.slotConfigs.forEach((cfg, idx) => {
            if (cfg.type === 'ai' && cfg.aiProfile) this.aiProfiles.set(idx, cfg.aiProfile);
          });
        }
        if (this.state.activeZeusStrike) {
          this.scheduleZeusStrikeCompletion(this.state.activeZeusStrike);
        }
        if (shouldPersistMigration) {
          await ctx.storage.put("state", this.state);
        }
      }
    });
  }

  private async saveState(): Promise<void> {
    if (this.state) {
      await this.ctx.storage.put("state", this.state);
    }
  }

  private clearShotSettledTimeout(): void {
    if (this.shotSettledTimeout) {
      clearTimeout(this.shotSettledTimeout);
      this.shotSettledTimeout = null;
    }
  }

  /** Clears in-flight shot bookkeeping (timeouts, epoch, awaiting slot). */
  private resetShotCoordination(): void {
    this.clearShotSettledTimeout();
    this.awaitingShotFromSlot = null;
    this.shotInFlight = false;
    this.lastShot = null;
    if (this.state) this.state.activeShot = null;
    this.shotEpoch++;
  }

  /** Catch-up payload for a socket that (re)joins an in-progress match. */
  private sendCombatCatchUpToSocket(
    ws: WebSocket,
    slot: number,
    request: RequestGameStartMessage = {
      type: 'REQUEST_GAME_START',
      roundNumber: 0,
      lastSeenShotId: 0,
      lastAppliedShopEpoch: 0,
    },
  ): void {
    this.sendGameStartToSocket(ws);
    if (!this.state?.started) return;

    // Always push authoritative turn index (GAME_START already has it; belt-and-suspenders).
    try {
      ws.send(
        JSON.stringify({
          type: 'STATE_UPDATE',
          currentPlayerIndex: this.state.currentPlayerIndex,
          roundEnded: this.state.roundEnded,
          players: this.state.players,
        }),
      );
    } catch {
      // ignore stale
    }

    const authority: AuthorityChangedMessage = {
      type: 'AUTHORITY_CHANGED',
      authoritySlot: this.state.earningsAuthoritySlot,
      authorityEpoch: this.state.authorityEpoch,
    };
    try {
      ws.send(JSON.stringify(authority));
    } catch {
      // ignore stale
    }

    try {
      const catchUp: ShotCatchUpMessage = {
        type: 'SHOT_CATCH_UP',
        roundNumber: this.state.roundNumber,
        activeShotId: this.state.activeShot?.shotId ?? null,
        shots: this.state.shotHistory
          .filter(
            (shot) =>
              shot.shotId > request.lastSeenShotId ||
              shot.shotId === this.state?.activeShot?.shotId,
          )
          .sort((left, right) => left.shotId - right.shotId),
        lastFireResult: this.state.lastFireResultBySlot[slot] ?? null,
      };
      ws.send(JSON.stringify(catchUp));
      if (this.state.shopSession) {
        ws.send(JSON.stringify(this.buildShopStateMessage()));
      } else if (
        this.state.lastCompletedShop &&
        this.state.lastCompletedShop.shopEpoch > request.lastAppliedShopEpoch
      ) {
        ws.send(JSON.stringify(this.state.lastCompletedShop));
      }
      if (this.state.lastAppliedEarnings) {
        ws.send(JSON.stringify(this.state.lastAppliedEarnings));
      }
      ws.send(JSON.stringify(this.buildZeusStateMessage()));
      if (this.state.activeZeusStrike) {
        ws.send(JSON.stringify(this.state.activeZeusStrike));
      }
      if (this.state.lastAppliedZeusStrike) {
        ws.send(JSON.stringify(this.state.lastAppliedZeusStrike));
      }
      if (this.state.roundEnded) {
        const lastOutcome =
          this.state.lastAppliedZeusStrike?.roundOutcome ??
          this.state.lastAppliedEarnings?.roundOutcome;
        const roundEnd: RoundEndMessage = {
          type: 'ROUND_END',
          players: this.state.players,
          roundWinnerId: lastOutcome?.roundWinnerId ?? null,
          isDraw: lastOutcome?.isDraw ?? false,
          roundNumber: this.state.roundNumber,
        };
        ws.send(JSON.stringify(roundEnd));
      }
    } catch {
      // ignore stale
    }
  }

  private buildZeusStateMessage(): ZeusStateMessage {
    if (!this.state) {
      return {
        type: 'ZEUS_STATE',
        activeZeusId: null,
        currentPlayerIndex: 0,
        rotationSlots: [],
        deadSlots: [],
        activeStrike: null,
        lastAppliedStrikeId: 0,
      };
    }
    return {
      type: 'ZEUS_STATE',
      activeZeusId: this.state.zeusState.activeZeusId,
      currentPlayerIndex: this.state.currentPlayerIndex,
      rotationSlots: [...this.state.zeusRotationSlots],
      deadSlots: this.state.players.map((player) => player.tank.isDead),
      activeStrike: this.state.activeZeusStrike,
      lastAppliedStrikeId: this.state.lastAppliedZeusStrike?.strikeId ?? 0,
    };
  }


  // --- REST entry from the Worker (create room) ---
  async fetchCreate(request: Request): Promise<Response> {
    let body: Record<string, unknown> = {};
    try {
      const parsed = await request.json();
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // Failed to parse or body is empty
      body = {};
    }

    const roomId = typeof body.roomId === 'string' ? body.roomId : undefined;
    const numPlayers = typeof body.numPlayers === 'number' ? body.numPlayers : undefined;
    const slotConfigs = Array.isArray(body.slotConfigs) ? body.slotConfigs : undefined;

    if (!roomId || !numPlayers || !Number.isInteger(numPlayers) || !slotConfigs) {
      return new Response(JSON.stringify({ error: 'Invalid create payload' }), { status: 400 });
    }

    if (this.state) {
      return new Response(JSON.stringify({ error: 'Room already exists' }), { status: 409 });
    }

    const tokens: string[] = [];
    for (let s = 0; s < numPlayers; s++) {
      tokens.push(makeToken());
    }

    this.state = {
      roomId,
      numPlayers,
      slotConfigs,
      tokens,
      joinedHumans: {},
      started: false,
      players: [],
      heights: [],
      materials: [],
      wind: 0,
      currentPlayerIndex: 0,
      roundEnded: false,
      authorityOrder: [],
      earningsAuthoritySlot: null,
      authorityEpoch: 0,
      nextJoinOrdinal: 0,
      joinOrdinals: {},
      nextShotId: 1,
      roundNumber: 1,
      shotNumberInRound: 0,
      activeShot: null,
      shotHistory: [],
      processedFireActionsBySlot: {},
      lastFireResultBySlot: {},
      lastAppliedEarnings: null,
      shopEpoch: 0,
      shopSession: null,
      processedShopActions: {},
      lastCompletedShop: null,
      zeusState: createZeusState(),
      zeusRotationSlots: [],
      lastDirectAttackerByPlayerId: {},
      zeusRngState: seedFromString(roomId),
      activeZeusStrike: null,
      lastAppliedZeusStrike: null,
    };

    // Pre-register AI profiles for server-driven turns
    slotConfigs.forEach((cfg, idx) => {
      if (cfg.type === 'ai' && cfg.aiProfile) this.aiProfiles.set(idx, cfg.aiProfile);
    });

    // Use origin provided by client (for local dev it will be http://localhost:5173),
    // otherwise fall back to production. Validated to prevent XSS via malformed origin injection.
    let origin = 'https://tankwars.pages.dev';
    if (typeof body.origin === 'string') {
      const isAllowedOrigin =
        body.origin === 'https://tankwars.pages.dev' ||
        /^https:\/\/[a-zA-Z0-9-]+\.tankwars\.pages\.dev$/.test(body.origin) ||
        /^http:\/\/localhost:\d+$/.test(body.origin) ||
        /^http:\/\/127\.0\.0\.1:\d+$/.test(body.origin);
      if (isAllowedOrigin) {
        origin = body.origin;
      }
    }
    const slots = slotConfigs.map((cfg, idx) => ({
      slot: idx,
      type: cfg.type,
      aiProfile: cfg.aiProfile,
      // Full join URL for humans (host also gets one)
      url: cfg.type === 'human'
        ? `${origin}/?room=${roomId}&slot=${idx}&token=${tokens[idx]}`
        : null,
    }));

    await this.saveState();

    return new Response(
      JSON.stringify({
        ok: true,
        roomId,
        numPlayers,
        slots,
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  }

  // --- Main fetch (dispatches WS upgrade or internal create) ---
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/internal/create' || url.pathname.endsWith('/create')) {
      return this.fetchCreate(request);
    }

    // WebSocket upgrade path (the worker already added x- headers)
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader === 'websocket') {
      const roomId = request.headers.get('x-room-id') || url.searchParams.get('room') || '';
      const slot = Number(request.headers.get('x-slot') ?? url.searchParams.get('slot') ?? -1);
      const token = request.headers.get('x-token') || url.searchParams.get('token') || '';

      if (!this.state || this.state.roomId !== roomId) {
        return new Response('Room not found', { status: 404 });
      }
      if (!Number.isInteger(slot) || slot < 0 || slot >= this.state.numPlayers) {
        return new Response('Invalid slot', { status: 400 });
      }

      const cfg = this.state.slotConfigs[slot];
      if (cfg.type === 'ai') {
        return new Response('AI slots do not use WS connections', { status: 400 });
      }
      if (this.state.tokens[slot] !== token) {
        return new Response('Invalid token for slot', { status: 403 });
      }

      // Clean any previous connection for this slot (prevents ghost connections and multiple "lost" during lobby->game transition or re-joins)
      if (this.sockets.has(slot)) {
        const old = this.sockets.get(slot);
        this.sockets.delete(slot);
        try {
          old?.close(4001, 'replaced by new connection for same slot');
        } catch {}
      }

      try {
        // Accept the WebSocket and attach it to this slot
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];

        // Store the socket (we will send messages to it)
        this.sockets.set(slot, server);

        // Handle messages from this player
        server.accept();
        server.addEventListener('message', (evt) => {
          this.handleClientMessage(slot, evt.data).catch((err) => {
            const errorMessage = err instanceof Error ? err.message : String(err);
            console.error('[GameRoom] Error handling client message from slot=', slot, ':', errorMessage);
          });
        });
        server.addEventListener('close', () => {
          this.handleSocketDisconnect(slot, server).catch((err) => {
            const errorMessage = err instanceof Error ? err.message : String(err);
            console.error('[GameRoom] Error on socket disconnect for slot=', slot, ':', errorMessage);
          });
        });
        server.addEventListener('error', () => {
          this.handleSocketDisconnect(slot, server).catch((err) => {
            const errorMessage = err instanceof Error ? err.message : String(err);
            console.error('[GameRoom] Error on socket error for slot=', slot, ':', errorMessage);
          });
        });

        // Defer post-connection tasks (claiming the slot and sending game start) to the next tick.
        // This ensures we return the 101 Switching Protocols response first, letting the runtime
        // complete the WebSocket handshake before we try to perform any async database transactions
        // or send data down the socket. Prevents segment faults/unhandled errors in workerd.
        const nameFromQuery = url.searchParams.get('name');
        const name = (nameFromQuery || `Joueur-${slot + 1}`).trim().slice(0, 16);
        const postSetupPromise = new Promise<void>((resolve) => {
          setTimeout(() => {
            this.claimHumanSlot(slot, name)
              .then(() => {
                if (this.state?.started) {
                  // Catch-up: turn index + any in-flight SHOT the client may have missed
                  // (lobby→combat transition, Strict Mode remount, brief disconnect).
                  this.sendCombatCatchUpToSocket(server, slot);
                }
                resolve();
              })
              .catch((err) => {
                const errorMessage = err instanceof Error ? err.message : String(err);
                console.error('[GameRoom] Error in post-connection setup for slot=', slot, ':', errorMessage);
                resolve();
              });
          }, 0);
        });
        this.ctx.waitUntil(postSetupPromise);

        return new Response(null, { status: 101, webSocket: client });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error('[GameRoom] WebSocket upgrade failed:', errorMessage);
        return new Response('WebSocket upgrade failed', { status: 500 });
      }
    }

    // Simple REST join status (optional)
    if (url.pathname.endsWith('/join') && request.method === 'POST') {
      // In real flow join is via WS; this is a convenience
      return new Response(JSON.stringify({ ok: true, message: 'Use the WS URL from creation response' }));
    }

    return new Response('GameRoom: unsupported', { status: 400 });
  }

  // --- Client message handler (only FIRE for now in MVP) ---
  private async handleClientMessage(slot: number, raw: unknown): Promise<void> {
    // Enforce payload size limit to prevent memory exhaustion / DoS
    if (typeof raw === 'string' && raw.length > 8192) {
      console.warn(`[GameRoom] Dropping oversized payload from slot ${slot} (size: ${raw.length})`);
      return;
    }
    let msg: Record<string, unknown>;
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.warn(`[GameRoom] Invalid message format from slot ${slot}`);
        return;
      }
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    if (!this.state) return;
    const strictMessage = isStrictOnlineMessage(msg) ? msg : null;

    // Catch-up: client missed the GAME_START broadcast (e.g. host tab still in lobby)
    // or reconnected mid-shot and needs the in-flight SHOT replayed.
    if (
      msg?.type === 'REQUEST_GAME_START' &&
      strictMessage?.type === 'REQUEST_GAME_START' &&
      this.state.started
    ) {
      const wsConn = this.sockets.get(slot);
      if (wsConn) this.sendCombatCatchUpToSocket(wsConn, slot, strictMessage);
      return;
    }

    // Handle name identification / update (sent by client after WS open)
    if (msg && msg.type === 'IDENTIFY' && msg.name && typeof msg.name === 'string') {
      if (this.state.joinedHumans[slot]) {
        this.state.joinedHumans[slot].name = msg.name.trim().slice(0, 16) || `Joueur-${slot + 1}`;
        await this.saveState();
        this.sendRosterUpdate();
      }
      return;
    }

    if (!this.state.started) return;

    if (strictMessage?.type === 'SHOT_SETTLED') {
      console.log(
        `[GameRoom] Received SHOT_SETTLED from slot ${slot}. currentPlayerIndex=${this.state?.currentPlayerIndex}, awaitingShotFromSlot=${this.awaitingShotFromSlot}, shotInFlight=${this.shotInFlight}`,
      );
      if (
        this.shotInFlight &&
        strictMessage.shotId === this.state.activeShot?.shotId &&
        slot === this.state.currentPlayerIndex &&
        slot === this.awaitingShotFromSlot
      ) {
        console.log(`[GameRoom] SHOT_SETTLED accepted for active human shot.`);
        this.clearShotSettledTimeout();
        if (this.state.activeShot) this.state.activeShot.shooterSettled = true;
        await this.saveState();
        await this.maybeCompleteActiveShot();
      } else {
        console.warn(
          `[GameRoom] Ignoring SHOT_SETTLED from slot ${slot} (active=${this.state?.currentPlayerIndex}, awaiting=${this.awaitingShotFromSlot}, shotInFlight=${this.shotInFlight})`,
        );
      }
      return;
    }

    if (strictMessage?.type === 'SHOT_EARNINGS') {
      await this.applyAuthoritativeEarnings(slot, strictMessage);
      return;
    }

    if (msg?.type === 'SHOP_BUY_SELL') {
      const decoded = decodeShopBuySellMessage(msg);
      if (!decoded.ok) {
        await this.rejectShopAction(slot, decoded.rejection, 'BUY_SELL');
        return;
      }
      await this.handleShopBuySell(slot, decoded.message);
      return;
    }
    if (msg?.type === 'SHOP_ENTER') {
      if (strictMessage?.type !== 'SHOP_ENTER') {
        this.sendToSlot(slot, {
          type: 'SHOP_REJECTED',
          shopEpoch: this.state.shopSession?.shopEpoch ?? null,
          reason: 'MALFORMED',
        } satisfies ShopRejectedMessage);
        return;
      }
      await this.handleShopEnter(slot, strictMessage.roundNumber);
      return;
    }
    if (msg?.type === 'SHOP_READY') {
      const decoded = decodeShopReadyMessage(msg);
      if (!decoded.ok) {
        await this.rejectShopAction(slot, decoded.rejection, 'READY');
        return;
      }
      await this.handleShopReady(slot, decoded.message);
      return;
    }

    if (msg && msg.type === 'FIRE') {
      await this.handleFireIntent(slot, msg);
      return;
    }
  }

  // Broadcast helper (only to connected human sockets)
  private broadcast(obj: unknown) {
    const data = JSON.stringify(obj);
    for (const ws of this.sockets.values()) {
      try {
        ws.send(data);
      } catch {
        // ignore stale
      }
    }
  }

  private sendToSlot(slot: number, obj: unknown): void {
    const socket = this.sockets.get(slot);
    if (!socket) return;
    try {
      socket.send(JSON.stringify(obj));
    } catch {
      // ignore stale
    }
  }

  private sendRosterUpdate() {
    if (!this.state) return;
    const roster: Array<{ slot: number; name: string; type: 'human' | 'ai' }> = Object.entries(this.state.joinedHumans).map(([s, info]) => ({
      slot: Number(s),
      name: info.name,
      type: 'human' as const,
    }));
    // Add AI slots for UI display
    this.state.slotConfigs.forEach((c, i) => {
      if (c.type === 'ai' && !roster.find((r) => r.slot === i)) {
        roster.push({ slot: i, name: `IA ${c.aiProfile || ''}`.trim(), type: 'ai' as const });
      }
    });
    this.broadcast({
      type: 'ROSTER_UPDATE',
      roster,
      numPlayers: this.state.numPlayers,
      gameStarted: this.state.started,
    });
  }

  private async handleSocketDisconnect(slot: number, ws: WebSocket): Promise<void> {
    if (this.sockets.get(slot) !== ws) {
      try {
        ws.close(1000, 'connection closed');
      } catch {
        // ignore if already closed
      }
      return;
    }
    this.sockets.delete(slot);
    try {
      ws.close(1000, 'connection closed');
    } catch {
      // ignore if already closed
    }
    if (!this.state) return;
    if (this.state.started) {
      if (this.state.earningsAuthoritySlot === slot) {
        await this.electEarningsAuthority();
      }
      return;
    }
    if (this.state.slotConfigs[slot]?.type !== 'human') return;
    if (!this.state.joinedHumans[slot]) return;
    delete this.state.joinedHumans[slot];
    await this.saveState();
    this.sendRosterUpdate();
  }

  /** Include materials only when the server has a full parallel array (real generate). */
  private terrainWireFields(): { heights: number[]; materials?: TerrainMaterial[] } {
    const heights = this.state?.heights ?? [];
    const materials = this.state?.materials ?? [];
    if (materials.length === heights.length && heights.length > 0) {
      return { heights, materials };
    }
    return { heights };
  }

  private buildGameStartMessage() {
    if (!this.state?.started) return null;
    return {
      type: 'GAME_START' as const,
      players: this.state.players,
      ...this.terrainWireFields(),
      wind: this.state.wind,
      currentPlayerIndex: this.state.currentPlayerIndex,
    };
  }

  private sendGameStartToSocket(ws: WebSocket): void {
    const msg = this.buildGameStartMessage();
    if (!msg) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // ignore stale socket
    }
  }

  // Claim a human slot (called on WS connect for the slot)
  private async claimHumanSlot(slot: number, name: string): Promise<void> {
    if (!this.state) return;
    if (this.state.slotConfigs[slot]?.type !== 'human') return;
    const existing = this.state.joinedHumans[slot];
    const joinOrdinal = this.state.joinOrdinals[slot] ?? this.state.nextJoinOrdinal++;
    this.state.joinOrdinals[slot] = joinOrdinal;
    this.state.joinedHumans[slot] = {
      name: name.trim().slice(0, 16) || `Joueur-${slot + 1}`,
      joinedAt: existing?.joinedAt ?? Date.now(),
      joinOrdinal: existing?.joinOrdinal ?? joinOrdinal,
    };
    await this.saveState();
    if (this.state.started && this.state.earningsAuthoritySlot === null) {
      await this.electEarningsAuthority();
    }
    this.sendRosterUpdate();
    await this.maybeAutoStart();
  }

  // Auto-start when every human-configured slot has a joined human
  private async maybeAutoStart(): Promise<void> {
    if (!this.state || this.state.started) return;

    const humanSlots = this.getHumanSlots();

    // Require a live WebSocket for every human slot — prevents ghost entries in joinedHumans
    // from starting the match while the host tab is disconnected.
    const allHumansJoined = humanSlots.every(
      (s) => !!this.state!.joinedHumans[s] && this.sockets.has(s),
    );
    if (!allHumansJoined) return;

    // Build the initial authoritative roster (same shape the local MainMenu produces)
    const players: Player[] = this.state.slotConfigs.map((cfg, idx) => {
      const isHuman = cfg.type === 'human';
      const joinedName = this.state!.joinedHumans[idx]?.name || `Joueur-${idx + 1}`;
      const name = isHuman ? joinedName : `IA-${idx + 1}`;
      const color = this.assignColor(idx); // deterministic from slot for now (server truth)

      return {
        id: `player-${idx + 1}`,
        name,
        isHuman,
        aiProfile: isHuman ? undefined : (cfg.aiProfile as Player['aiProfile']),
        tank: {
          id: `tank-${idx + 1}`,
          position: { x: 80 + idx * 160, y: 280 }, // will be overwritten by spawn
          angle: idx < Math.ceil(this.state!.numPlayers / 2) ? -32 : 32,
          power: 50,
          health: 100,
          maxHealth: 100,
          shield: 40,
          maxShield: 40,
          isDead: false,
          color,
          currentWeapon: 'MISSILE' as WeaponId,
        },
        money: 250,
        inventory: { ...DEFAULT_INVENTORY },
      };
    });

    // TODO (next steps): call real headless terrain.generate + spawnTanks + roll wind
    // and persist materials alongside heights. Until then GAME_START omits materials.
    // For skeleton we emit placeholder heights (flat) — real work happens in client engine step 6/7
    const placeholderHeights = Array.from({ length: 800 }, (_, x) => 300 + Math.sin(x / 30) * 20);

    this.state.players = players;
    this.state.heights = placeholderHeights;
    this.state.materials = [];
    this.state.wind = 0; // real wind roll will be done when headless sim is wired
    this.state.currentPlayerIndex = 0;
    this.state.started = true;
    this.state.startAt = Date.now();
    this.state.authorityOrder = [...humanSlots].sort((left, right) => {
      const leftJoin = this.state!.joinedHumans[left]?.joinOrdinal ?? Number.MAX_SAFE_INTEGER;
      const rightJoin = this.state!.joinedHumans[right]?.joinOrdinal ?? Number.MAX_SAFE_INTEGER;
      return leftJoin - rightJoin;
    });
    this.state.earningsAuthoritySlot = this.state.authorityOrder[0] ?? null;
    this.state.authorityEpoch++;
    this.resetShotCoordination();

    await this.saveState();

    // Tell everyone the game is starting + give them the full initial snapshot
    const gameStart = this.buildGameStartMessage();
    if (gameStart) {
      this.broadcast(gameStart);
      this.broadcastAuthorityChanged();
      // Belt-and-suspenders: also send directly to each human socket (missed broadcast recovery)
      for (const humanSlot of humanSlots) {
        const wsConn = this.sockets.get(humanSlot);
        if (wsConn) this.sendGameStartToSocket(wsConn as WebSocket);
      }
    }

    // Notify lobby clients that the match is live (enables REQUEST_GAME_START catch-up).
    this.sendRosterUpdate();

    // If the very first player is an AI, the server immediately plays it (MVP)
    this.maybeRunAIServerTurn();
  }

  private broadcastAuthorityChanged(): void {
    if (!this.state) return;
    const message: AuthorityChangedMessage = {
      type: 'AUTHORITY_CHANGED',
      authoritySlot: this.state.earningsAuthoritySlot,
      authorityEpoch: this.state.authorityEpoch,
    };
    this.broadcast(message);
  }

  private async electEarningsAuthority(): Promise<void> {
    if (!this.state) return;
    const next = this.state.authorityOrder.find((slot) => this.sockets.has(slot)) ?? null;
    if (next === this.state.earningsAuthoritySlot) return;
    this.state.earningsAuthoritySlot = next;
    this.state.authorityEpoch++;
    await this.saveState();
    this.broadcastAuthorityChanged();
    if (next !== null && this.state.activeShot) {
      const socket = this.sockets.get(next);
      if (socket) this.sendCombatCatchUpToSocket(socket, next);
    }
  }

  // Very naive color assignment (stable, no collision). Real version can be richer.
  private assignColor(slot: number): Color {
    const palette: Color[] = [
      '#5555FF', '#FF5555', '#00F7FF', '#00FF7F', '#FF1A8C', '#D7FF00', '#FF8C00', '#B300FF',
    ];
    return palette[slot % palette.length];
  }

  private buildFireRejection(
    slot: number,
    reason: FireRejectedMessage['reason'],
    actionId?: string,
  ): FireRejectedMessage {
    const player = this.state?.players?.[slot];
    return {
      type: 'FIRE_REJECTED',
      ...(actionId ? { actionId } : {}),
      reason,
      inventory: { ...(player?.inventory ?? {}) },
      currentWeapon: player?.tank.currentWeapon ?? 'MISSILE',
    };
  }

  private async rejectFire(
    slot: number,
    reason: FireRejectedMessage['reason'],
    actionId?: string,
  ): Promise<void> {
    if (!this.state) return;
    const rejection = this.buildFireRejection(slot, reason, actionId);
    if (actionId) {
      this.state.lastFireResultBySlot[slot] = rejection;
      await this.saveState();
    }
    this.sendToSlot(slot, rejection);
  }

  private async handleFireIntent(slot: number, value: unknown): Promise<void> {
    if (!this.state) return;
    const decoded = decodeFireMessage(value);
    if (!decoded.ok) {
      await this.rejectFire(slot, 'MALFORMED', decoded.actionId);
      return;
    }

    const { actionId, command } = decoded.message;
    const previous = this.state.processedFireActionsBySlot[slot]?.[actionId];
    if (previous) {
      if (this.state.activeShot?.shotId === previous.result.shotId) {
        this.sendToSlot(slot, previous.result);
      }
      return;
    }
    const previousRejection = this.state.lastFireResultBySlot[slot];
    if (previousRejection?.actionId === actionId) {
      this.sendToSlot(slot, previousRejection);
      return;
    }

    const fromSlot = this.state.currentPlayerIndex;
    await this.executeFire(fromSlot, command, actionId, slot);
  }

  // Execute a fire (either from human WS or from server AI)
  private async executeFire(
    fromSlot: number,
    command: { angle: number; power: number; weaponId: WeaponId },
    actionId: string,
    requesterSlot?: number,
  ): Promise<void> {
    if (!this.state) return;

    const rejectRequester = async (
      reason: FireRejectedMessage['reason'],
    ): Promise<void> => {
      if (requesterSlot !== undefined) {
        await this.rejectFire(requesterSlot, reason, actionId);
      }
    };

    if (
      !Number.isFinite(command.power) ||
      command.power < 0 ||
      command.power > 100 ||
      !Number.isFinite(command.angle) ||
      command.angle < -360 ||
      command.angle > 360
    ) {
      await rejectRequester('MALFORMED');
      return;
    }
    if (this.state.roundEnded || this.state.shopSession) {
      await rejectRequester('ROUND_ENDED');
      return;
    }

    // Defense in depth: AI timer + human FIRE path both funnel here.
    if (this.shotInFlight || this.state.activeShot) {
      console.warn(
        `[GameRoom] executeFire ignored for slot ${fromSlot} — shot already in flight`,
      );
      await rejectRequester('SHOT_IN_FLIGHT');
      return;
    }

    const currentConfig = this.state.slotConfigs[fromSlot];
    const authorized = requesterSlot === undefined
      ? currentConfig?.type === 'ai'
      : currentConfig?.type === 'human' && requesterSlot === fromSlot;
    if (!authorized) {
      await rejectRequester('NOT_YOUR_TURN');
      return;
    }

    const currentPlayer = this.state.players[fromSlot];
    if (!currentPlayer) {
      await rejectRequester('MALFORMED');
      return;
    }
    const consumed = consumeWeaponForFire(currentPlayer, command.weaponId);
    if (!consumed.ok) {
      await rejectRequester(consumed.reason);
      return;
    }

    console.log('[GameRoom] executeFire: fromSlot=', fromSlot, ', command=', command);
    const ownerId = currentPlayer.id;

    // Toutes les validations sont terminées avant la première mutation autoritaire.
    this.state.players[fromSlot] = consumed.player;
    this.clearShotSettledTimeout();
    this.shotInFlight = true;
    this.shotEpoch++;
    const epoch = this.shotEpoch;
    const shotId = this.state.nextShotId++;
    this.state.shotNumberInRound++;
    this.lastShot = { slot: fromSlot, command, ownerId };
    this.state.activeShot = {
      shotId,
      roundNumber: this.state.roundNumber,
      shotNumberInRound: this.state.shotNumberInRound,
      isFirstShotOfRound: this.state.shotNumberInRound === 1,
      actionId,
      slot: fromSlot,
      command,
      ownerId,
      shooterSettled: false,
      earningsApplied: false,
      releaseAt: null,
    };
    const shotEvent: ShotMessage = {
      type: 'SHOT',
      actionId,
      shotId,
      roundNumber: this.state.roundNumber,
      shotNumberInRound: this.state.shotNumberInRound,
      isFirstShotOfRound: this.state.shotNumberInRound === 1,
      slot: fromSlot,
      command,
      ownerId,
    };
    this.state.shotHistory.push(shotEvent);
    this.state.processedFireActionsBySlot[fromSlot] ??= {};
    this.state.processedFireActionsBySlot[fromSlot][actionId] = {
      slot: fromSlot,
      result: shotEvent,
    };
    await this.saveState();
    this.broadcast(shotEvent);

    const cfg = this.state.slotConfigs[fromSlot];
    if (cfg && cfg.type === 'ai') {
      console.log(`[GameRoom] executeFire: active slot ${fromSlot} is AI. Arming 4.5s safety timer...`);
      const aiTimeoutPromise = new Promise<void>((resolve) => {
        this.shotSettledTimeout = setTimeout(() => {
          this.shotSettledTimeout = null;
          if (epoch !== this.shotEpoch || !this.shotInFlight) {
            console.log(`[GameRoom] AI turn advance timer ignored (stale epoch ${epoch} vs ${this.shotEpoch})`);
            resolve();
            return;
          }
          console.warn(`[GameRoom] AI safety timer elapsed; waiting for authoritative earnings.`);
          resolve();
        }, 4500);
      });
      this.ctx.waitUntil(aiTimeoutPromise);
    } else {
      this.awaitingShotFromSlot = fromSlot;
      console.log(`[GameRoom] executeFire: active slot ${fromSlot} is Human. Waiting for SHOT_SETTLED... (8s watchdog armed)`);
      // Pour un humain, on attend le message SHOT_SETTLED du client.
      // Par sécurité, on force le passage au tour suivant après 8 secondes.
      const humanTimeoutPromise = new Promise<void>((resolve) => {
        this.shotSettledTimeout = setTimeout(() => {
          this.shotSettledTimeout = null;
          if (epoch !== this.shotEpoch || !this.shotInFlight) {
            console.log(`[GameRoom] Human shot safety timeout ignored (stale epoch ${epoch} vs ${this.shotEpoch})`);
            resolve();
            return;
          }
          console.warn(`[GameRoom] Human settlement watchdog elapsed; marking physics settled only.`);
          if (this.state?.activeShot?.shotId === shotId) {
            this.state.activeShot.shooterSettled = true;
            this.saveState().then(() => this.maybeCompleteActiveShot()).then(resolve).catch(() => resolve());
          } else {
            resolve();
          }
        }, 8000);
      });
      this.ctx.waitUntil(humanTimeoutPromise);
    }
  }

  private async advanceTurnAndNotify(): Promise<void> {
    if (!this.state || this.state.roundEnded) return;

    // Idempotent: only one advance per in-flight shot (SHOT_SETTLED + timeout race).
    if (!this.shotInFlight) {
      console.warn('[GameRoom] advanceTurnAndNotify ignored — no shot in flight');
      return;
    }

    this.clearShotSettledTimeout();
    this.awaitingShotFromSlot = null;
    this.shotInFlight = false;
    this.lastShot = null;
    this.state.activeShot = null;
    // Invalidate any timeout still racing into this method.
    this.shotEpoch++;

    const prev = this.state.currentPlayerIndex;
    const players = this.state.players;
    const next = nextLivingPlayerIndex(
      this.state.currentPlayerIndex,
      this.state.numPlayers,
      (i) => !!players[i]?.tank?.isDead,
    );
    this.state.currentPlayerIndex = next;
    console.log(`[GameRoom] advanceTurnAndNotify: currentPlayerIndex changed from ${prev} to ${next}`);

    await this.saveState();

    // Turn coordination only — clients simulate shots locally until headless authoritative sim is wired.
    const update = {
      type: 'STATE_UPDATE',
      currentPlayerIndex: this.state.currentPlayerIndex,
      roundEnded: false,
    };
    this.broadcast(update);

    // If next is AI, let server drive it immediately (demo)
    this.maybeRunAIServerTurn();
  }

  private async applyAuthoritativeEarnings(
    slot: number,
    message: ShotEarningsMessage,
  ): Promise<void> {
    if (!this.state) return;
    const previous = this.state.lastAppliedEarnings;
    if (previous?.shotId === message.shotId) {
      const isIdentical =
        JSON.stringify(previous.awards) === JSON.stringify(message.awards) &&
        JSON.stringify(previous.deadSlots) === JSON.stringify(message.deadSlots) &&
        JSON.stringify(previous.roundOutcome) === JSON.stringify(message.roundOutcome) &&
        JSON.stringify(previous.directHitVictimIds) === JSON.stringify(message.directHitVictimIds);
      if (isIdentical) this.broadcast(previous);
      return;
    }
    if (
      slot !== this.state.earningsAuthoritySlot ||
      message.authorityEpoch !== this.state.authorityEpoch ||
      message.shotId !== this.state.activeShot?.shotId
    ) {
      console.warn(`[GameRoom] Rejected unauthorized or stale SHOT_EARNINGS from slot ${slot}`);
      return;
    }
    if (message.deadSlots.length !== this.state.numPlayers) return;

    const knownPlayers = new Map(this.state.players.map((player) => [player.id, player]));
    const seen = new Set<string>();
    for (const award of message.awards) {
      if (seen.has(award.playerId) || !knownPlayers.has(award.playerId)) return;
      if (!Number.isSafeInteger(award.amount) || award.amount < 0) return;
      seen.add(award.playerId);
    }

    const directVictims = new Set<string>();
    for (const victimId of message.directHitVictimIds) {
      if (directVictims.has(victimId) || !knownPlayers.has(victimId)) return;
      directVictims.add(victimId);
    }
    const activeShooterId = this.state.activeShot?.ownerId;
    const activeWeaponId = this.state.activeShot?.command.weaponId;
    if (activeWeaponId === 'BULLDOZER' && directVictims.size > 0) return;
    if (activeShooterId && directVictims.has(activeShooterId)) return;
    if (activeShooterId && activeWeaponId !== 'BULLDOZER') {
      for (const victimId of directVictims) {
        this.state.lastDirectAttackerByPlayerId[victimId] = activeShooterId;
        const victim = knownPlayers.get(victimId);
        if (victim) victim.tank.lastDirectAttackerId = activeShooterId;
      }
    }

    const balances = this.state.players.map((player) => {
      const delta = message.awards.find((award) => award.playerId === player.id)?.amount ?? 0;
      const money = player.money + delta;
      if (!Number.isSafeInteger(money) || money < 0) {
        throw new RangeError('Authoritative balance exceeds safe integer range.');
      }
      return { playerId: player.id, money };
    });
    for (const balance of balances) {
      const player = knownPlayers.get(balance.playerId);
      if (player) player.money = balance.money;
    }
    message.deadSlots.forEach((isDead, index) => {
      const tank = this.state?.players[index]?.tank;
      if (tank) tank.isDead = isDead;
    });

    const hasEarnings = message.awards.some((award) => award.amount > 0);
    const applied: PersistedEarningsResult = {
      type: 'SHOT_EARNINGS_APPLIED',
      shotId: message.shotId,
      awards: message.awards,
      balances,
      hasEarnings,
      blockDurationMs: 0,
      roundOutcome: message.roundOutcome,
      deadSlots: message.deadSlots,
      authorityEpoch: message.authorityEpoch,
      directHitVictimIds: [...message.directHitVictimIds],
    };
    this.state.lastAppliedEarnings = applied;
    if (this.state.activeShot) {
      this.state.activeShot.earningsApplied = true;
      this.state.activeShot.releaseAt = Date.now();
      if (this.state.slotConfigs[this.state.activeShot.slot]?.type === 'ai') {
        this.state.activeShot.shooterSettled = true;
      }
    }
    await this.saveState();
    this.broadcast(applied);
    await this.maybeCompleteActiveShot();
  }

  private async maybeCompleteActiveShot(): Promise<void> {
    if (!this.state?.activeShot || !this.state.lastAppliedEarnings) return;
    const active = this.state.activeShot;
    if (!active.shooterSettled || !active.earningsApplied) return;
    const remaining = Math.max(0, (active.releaseAt ?? 0) - Date.now());
    if (remaining > 0) {
      const shotId = active.shotId;
      const releasePromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          if (this.state?.activeShot?.shotId !== shotId) {
            resolve();
            return;
          }
          this.maybeCompleteActiveShot().then(resolve).catch(() => resolve());
        }, remaining);
      });
      this.ctx.waitUntil(releasePromise);
      return;
    }

    const outcome = this.state.lastAppliedEarnings.roundOutcome;
    const evaluation = evaluateZeusDeadlock(
      this.state.zeusState,
      this.state.players,
      this.state.lastAppliedEarnings.hasEarnings,
      () => this.nextZeusRandom(),
    );
    this.state.zeusState = evaluation.state;
    if (evaluation.zeusRevoked) this.state.zeusRotationSlots = [];
    if (outcome.isRoundEnd) {
      this.clearShotSettledTimeout();
      this.shotInFlight = false;
      this.awaitingShotFromSlot = null;
      this.lastShot = null;
      this.state.activeShot = null;
      this.state.roundEnded = true;
      this.resetZeusRoundState();
      await this.saveState();
      const roundEnd: RoundEndMessage = {
        type: 'ROUND_END',
        players: this.state.players,
        roundWinnerId: outcome.roundWinnerId,
        isDraw: outcome.isDraw,
        roundNumber: this.state.roundNumber,
      };
      this.broadcast(roundEnd);
      return;
    }
    if (evaluation.appointment) {
      await this.applyZeusAppointment(evaluation.appointment);
      return;
    }
    await this.advanceTurnAndNotify();
  }

  private nextZeusRandom(): number {
    if (!this.state) return 0;
    this.state.zeusRngState = (this.state.zeusRngState + 0x6d2b79f5) >>> 0;
    let value = this.state.zeusRngState;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  private async applyZeusAppointment(
    appointment: import('../../src/game/zeus/zeusDomain').ZeusAppointment,
  ): Promise<void> {
    if (!this.state) return;
    const zeusSlot = this.state.players.findIndex((player) => player.id === appointment.zeusId);
    if (zeusSlot < 0) return;

    this.clearShotSettledTimeout();
    this.awaitingShotFromSlot = null;
    this.shotInFlight = false;
    this.lastShot = null;
    this.state.activeShot = null;
    this.shotEpoch++;
    this.state.currentPlayerIndex = zeusSlot;
    const rotationSlots: number[] = [];
    for (const playerId of appointment.rotationPlayerIds) {
      const slot = this.state.players.findIndex((player) => player.id === playerId);
      if (slot >= 0) rotationSlots.push(slot);
    }
    this.state.zeusRotationSlots = rotationSlots;
    await this.saveState();

    const message: ZeusAppointedMessage = {
      type: 'ZEUS_APPOINTED',
      appointmentId: appointment.appointmentId,
      zeusId: appointment.zeusId,
      zeusSlot,
      rotationSlots: [...this.state.zeusRotationSlots],
    };
    this.broadcast(message);
    this.broadcast(this.buildZeusStateMessage());
    this.broadcast({
      type: 'STATE_UPDATE',
      currentPlayerIndex: zeusSlot,
      roundEnded: false,
    });
    this.maybeRunAIServerTurn();
  }

  private async beginZeusStrike(): Promise<void> {
    if (!this.state || this.state.roundEnded || this.state.activeZeusStrike) return;
    const zeusId = this.state.zeusState.activeZeusId;
    const current = this.state.players[this.state.currentPlayerIndex];
    if (!zeusId || current?.id !== zeusId || current.tank.isDead) return;
    const selection = selectZeusTarget(
      this.state.players,
      zeusId,
      () => this.nextZeusRandom(),
    );
    if (!selection) return;

    current.tank.lastDirectAttackerId = undefined;
    delete this.state.lastDirectAttackerByPlayerId[zeusId];
    const allocation = allocateZeusStrike(this.state.zeusState, zeusId, selection.targetId);
    this.state.zeusState = allocation.state;
    const strike: ZeusStrikeMessage = {
      type: 'ZEUS_STRIKE',
      ...allocation.strike,
      resolveAt: Date.now() + 700,
    };
    this.state.activeZeusStrike = strike;
    await this.saveState();
    this.broadcast(strike);
    this.scheduleZeusStrikeCompletion(strike);
  }

  private scheduleZeusStrikeCompletion(strike: ZeusStrikeMessage): void {
    const remaining = Math.max(0, strike.resolveAt - Date.now());
    const completion = new Promise<void>((resolve) => {
      setTimeout(() => {
        this.completeZeusStrike(strike.strikeId).then(resolve).catch((error: unknown) => {
          console.error('[GameRoom] Zeus strike completion failed:', String(error));
          resolve();
        });
      }, remaining);
    });
    this.ctx.waitUntil(completion);
  }

  private async completeZeusStrike(strikeId: number): Promise<void> {
    if (!this.state) return;
    if (this.state.lastAppliedZeusStrike?.strikeId === strikeId) {
      this.broadcast(this.state.lastAppliedZeusStrike);
      return;
    }
    const strike = this.state.activeZeusStrike;
    if (!strike || strike.strikeId !== strikeId) return;
    const target = this.state.players.find((player) => player.id === strike.targetId);
    const zeus = this.state.players.find((player) => player.id === strike.zeusId);
    if (!target || !zeus || target.tank.isDead || zeus.tank.isDead) {
      this.state.activeZeusStrike = null;
      await this.saveState();
      return;
    }

    target.tank.health = 0;
    target.tank.shield = 0;
    target.tank.isDead = true;
    const survivors = this.state.players.filter((player) => !player.tank.isDead);
    const reward = calculateZeusStrikeReward(
      zeus.id,
      this.state.numPlayers,
      survivors.map((player) => player.id),
    );
    const balances = this.state.players.map((player) => {
      const amount = player.id === reward.award.playerId ? reward.award.amount : 0;
      const money = player.money + amount;
      if (!Number.isSafeInteger(money)) throw new RangeError('Zeus balance overflow.');
      player.money = money;
      return { playerId: player.id, money };
    });
    const nextPlayerIndex = reward.roundOutcome.isRoundEnd
      ? null
      : nextLivingPlayerIndex(
          this.state.currentPlayerIndex,
          this.state.numPlayers,
          (index) => !!this.state?.players[index]?.tank.isDead,
        );
    const result: ZeusStrikeAppliedMessage = {
      type: 'ZEUS_STRIKE_APPLIED',
      strikeId,
      zeusId: strike.zeusId,
      targetId: strike.targetId,
      award: reward.award,
      balances,
      deadSlots: this.state.players.map((player) => player.tank.isDead),
      roundOutcome: reward.roundOutcome,
      nextPlayerIndex,
    };
    this.state.activeZeusStrike = null;
    this.state.lastAppliedZeusStrike = result;
    if (reward.roundOutcome.isRoundEnd) {
      this.state.roundEnded = true;
      this.resetZeusRoundState();
    } else if (nextPlayerIndex !== null) {
      this.state.currentPlayerIndex = nextPlayerIndex;
    }
    await this.saveState();
    this.broadcast(result);
    this.broadcast(this.buildZeusStateMessage());

    if (reward.roundOutcome.isRoundEnd) {
      const roundEnd: RoundEndMessage = {
        type: 'ROUND_END',
        players: this.state.players,
        roundWinnerId: reward.roundOutcome.roundWinnerId,
        isDraw: reward.roundOutcome.isDraw,
        roundNumber: this.state.roundNumber,
      };
      this.broadcast(roundEnd);
      return;
    }
    this.broadcast({
      type: 'STATE_UPDATE',
      currentPlayerIndex: this.state.currentPlayerIndex,
      roundEnded: false,
    });
    this.maybeRunAIServerTurn();
  }

  private resetZeusRoundState(): void {
    if (!this.state) return;
    this.state.zeusState = resetZeusRound(this.state.zeusState);
    this.state.zeusRotationSlots = [];
    this.state.lastDirectAttackerByPlayerId = {};
    this.state.activeZeusStrike = null;
    for (const player of this.state.players) player.tank.lastDirectAttackerId = undefined;
  }

  private maybeRunAIServerTurn() {
    if (!this.state || this.state.roundEnded) return;
    if (this.shotInFlight || this.state.activeZeusStrike) return;
    const idx = this.state.currentPlayerIndex;
    const cfg = this.state.slotConfigs[idx];
    if (cfg?.type !== 'ai') return;

    // Skip dead AI slots (authoritative roster may lag mid-combat; still safe).
    if (this.state.players[idx]?.tank?.isDead) {
      // Should not happen if nextLivingPlayerIndex worked; force another advance only if stuck.
      return;
    }

    if (this.state.players[idx]?.id === this.state.zeusState.activeZeusId) {
      const zeusTurnPromise = this.beginZeusStrike().catch((error: unknown) => {
        console.error('[GameRoom] Error starting Zeus strike:', String(error));
      });
      this.ctx.waitUntil(zeusTurnPromise);
      return;
    }

    // In later step we will call the real AI strategy here (headless) and then executeFire.
    // For skeleton: pick a safe-ish random shot so the round can progress in a multi-tab test.
    const fakeCommand = {
      angle: 30 + ((idx * 37) % 90),
      power: 55 + ((idx * 13) % 30),
      weaponId: 'MISSILE' as WeaponId,
    };
    // Small delay so clients see the turn change
    const epochAtSchedule = this.shotEpoch;
    const aiTurnPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        // Abort if a human already fired or turn advanced while we waited.
        if (epochAtSchedule !== this.shotEpoch || this.shotInFlight) {
          resolve();
          return;
        }
        if (this.state?.currentPlayerIndex !== idx) {
          resolve();
          return;
        }
        this.executeFire(
          idx,
          fakeCommand,
          `ai-${crypto.randomUUID()}`,
        )
          .then(resolve)
          .catch((err) => {
            const errorMessage = err instanceof Error ? err.message : String(err);
            console.error('[GameRoom] Error executing AI fire for slot=', idx, ':', errorMessage);
            resolve();
          });
      }, 1200);
    });
    this.ctx.waitUntil(aiTurnPromise);
  }

  private getHumanSlots(): number[] {
    if (!this.state) return [];
    const slots: number[] = [];
    this.state.slotConfigs.forEach((cfg, i) => {
      if (cfg.type === 'human') slots.push(i);
    });
    return slots;
  }

  private buildShopStateMessage(): ShopStateMessage {
    if (!this.state?.shopSession) {
      throw new Error('Aucune session boutique active.');
    }
    return {
      type: 'SHOP_STATE',
      shopEpoch: this.state.shopSession.shopEpoch,
      roundNumber: this.state.shopSession.roundNumber,
      readySlots: [...this.state.shopSession.readySlots],
      players: this.state.players,
      purchasesByPlayerId: this.state.shopSession.purchasesByPlayerId,
      aiShopApplied: this.state.shopSession.aiShopApplied,
    };
  }

  private async rejectShopAction(
    slot: number,
    rejection: ShopRejectedMessage,
    kind: 'BUY_SELL' | 'READY',
  ): Promise<void> {
    if (!this.state) return;
    if (rejection.actionId && rejection.reason !== 'MALFORMED') {
      const actionKey = makeShopActionKey(kind, slot, rejection.actionId);
      this.state.processedShopActions[actionKey] = {
        slot,
        result: rejection,
      };
      await this.saveState();
    }
    this.sendToSlot(slot, rejection);
  }

  /** Ouvre la boutique depuis le dernier ROUND_END; aucun snapshot client n'est lu. */
  private async handleShopEnter(
    slot: number,
    requestedRoundNumber: number,
  ): Promise<void> {
    if (!this.state) return;
    const guard = guardShopEnter({
      isHumanSlot: this.state.slotConfigs[slot]?.type === 'human',
      roundEnded: this.state.roundEnded,
      shotInFlight: this.shotInFlight || this.state.activeShot !== null,
      zeusStrikeActive: this.state.activeZeusStrike !== null,
      serverRoundNumber: this.state.roundNumber,
      requestedRoundNumber,
      session: this.state.shopSession
        ? {
            epoch: this.state.shopSession.shopEpoch,
            roundNumber: this.state.shopSession.roundNumber,
            readySlots: this.state.shopSession.readySlots,
          }
        : null,
    });
    if (!guard.ok) {
      this.sendToSlot(slot, {
        type: 'SHOP_REJECTED',
        shopEpoch: this.state.shopSession?.shopEpoch ?? null,
        reason: guard.reason,
      } satisfies ShopRejectedMessage);
      return;
    }
    if (guard.mode === 'RESUME') {
      this.sendToSlot(slot, this.buildShopStateMessage());
      return;
    }

    this.state.shopEpoch++;
    this.state.processedShopActions = {};
    let players = normalizeRosterAtShopOpen(this.state.players);
    let counters: ShopVisitCounters = {};
    for (let index = 0; index < players.length; index++) {
      const player = players[index];
      if (player.isHuman) continue;
      const autoBuy = autoBuyForAI(player, counters);
      players = players.map((candidate, playerIndex) =>
        playerIndex === index ? autoBuy.player : candidate,
      );
      counters = autoBuy.counters;
    }
    this.state.players = players;
    this.state.shopSession = {
      shopEpoch: this.state.shopEpoch,
      roundNumber: this.state.roundNumber,
      readySlots: [],
      purchasesByPlayerId: counters,
      aiShopApplied: true,
    };
    await this.saveState();
    this.broadcast(this.buildShopStateMessage());
  }

  private async handleShopBuySell(
    slot: number,
    message: ShopBuySellMessage,
  ): Promise<void> {
    if (!this.state) return;
    const actionKey = makeShopActionKey('BUY_SELL', slot, message.actionId);
    const previous = this.state.processedShopActions[actionKey];
    if (previous) {
      if (previous.slot === slot) {
        const result =
          !this.state.shopSession &&
          this.state.lastCompletedShop?.shopEpoch === message.shopEpoch
            ? this.state.lastCompletedShop
            : previous.result.type === 'SHOP_STATE' && this.state.shopSession
              ? this.buildShopStateMessage()
              : previous.result;
        this.sendToSlot(slot, result);
      }
      else {
        this.sendToSlot(slot, {
          type: 'SHOP_REJECTED',
          shopEpoch: this.state.shopSession?.shopEpoch ?? null,
          actionId: message.actionId,
          weaponId: message.weaponId,
          delta: message.delta,
          reason: 'MALFORMED',
        } satisfies ShopRejectedMessage);
      }
      return;
    }
    const session = this.state.shopSession;
    const guard = guardShopAction({
      isHumanSlot: this.state.slotConfigs[slot]?.type === 'human',
      slot,
      actionId: message.actionId,
      requestedEpoch: message.shopEpoch,
      session: session
        ? {
            epoch: session.shopEpoch,
            roundNumber: session.roundNumber,
            readySlots: session.readySlots,
          }
        : null,
    });
    if (!guard.ok || !session) {
      await this.rejectShopAction(slot, {
        type: 'SHOP_REJECTED',
        shopEpoch: session?.shopEpoch ?? null,
        actionId: message.actionId,
        weaponId: message.weaponId,
        delta: message.delta,
        reason: guard.ok ? 'SHOP_CLOSED' : guard.reason,
      }, 'BUY_SELL');
      return;
    }
    const player = this.state.players[slot];
    if (!player) {
      await this.rejectShopAction(slot, {
        type: 'SHOP_REJECTED',
        shopEpoch: session.shopEpoch,
        actionId: message.actionId,
        weaponId: message.weaponId,
        delta: message.delta,
        reason: 'MALFORMED',
      }, 'BUY_SELL');
      return;
    }
    const result = applyShopTransaction({
      player,
      counters: session.purchasesByPlayerId,
      weaponId: message.weaponId,
      delta: message.delta,
    });
    if (!result.ok) {
      await this.rejectShopAction(slot, {
        type: 'SHOP_REJECTED',
        shopEpoch: session.shopEpoch,
        actionId: message.actionId,
        weaponId: message.weaponId,
        delta: message.delta,
        reason: result.reason,
      }, 'BUY_SELL');
      return;
    }
    this.state.players = this.state.players.map((candidate, index) =>
      index === slot ? result.player : candidate,
    );
    session.purchasesByPlayerId = result.counters;
    const stateMessage = this.buildShopStateMessage();
    this.state.processedShopActions[actionKey] = {
      slot,
      result: stateMessage,
    };
    await this.saveState();
    this.broadcast(stateMessage);
  }

  private async handleShopReady(
    slot: number,
    message: ShopReadyMessage,
  ): Promise<void> {
    if (!this.state) return;
    const actionKey = makeShopActionKey('READY', slot, message.actionId);
    const previous = this.state.processedShopActions[actionKey];
    if (previous) {
      if (previous.slot === slot) {
        const result =
          !this.state.shopSession &&
          this.state.lastCompletedShop?.shopEpoch === message.shopEpoch
            ? this.state.lastCompletedShop
            : previous.result.type === 'SHOP_STATE' && this.state.shopSession
              ? this.buildShopStateMessage()
              : previous.result;
        this.sendToSlot(slot, result);
      }
      return;
    }
    const session = this.state.shopSession;
    const guard = guardShopAction({
      isHumanSlot: this.state.slotConfigs[slot]?.type === 'human',
      slot,
      actionId: message.actionId,
      requestedEpoch: message.shopEpoch,
      session: session
        ? {
            epoch: session.shopEpoch,
            roundNumber: session.roundNumber,
            readySlots: session.readySlots,
          }
        : null,
    });
    if (!guard.ok || !session) {
      await this.rejectShopAction(slot, {
        type: 'SHOP_REJECTED',
        shopEpoch: session?.shopEpoch ?? null,
        actionId: message.actionId,
        reason: guard.ok ? 'SHOP_CLOSED' : guard.reason,
      }, 'READY');
      return;
    }
    session.readySlots = [...session.readySlots, slot].sort(
      (left, right) => left - right,
    );
    const readySlots = new Set(session.readySlots);
    const allHumansReady = this.getHumanSlots().every((humanSlot) =>
      readySlots.has(humanSlot),
    );
    if (allHumansReady) {
      await this.completeShopPhase(slot, message.actionId);
      return;
    }
    const stateMessage = this.buildShopStateMessage();
    this.state.processedShopActions[actionKey] = {
      slot,
      result: stateMessage,
    };
    await this.saveState();
    this.broadcast(stateMessage);
  }

  private async completeShopPhase(
    fromSlot: number,
    actionId: string,
  ): Promise<void> {
    if (!this.state?.shopSession) return;
    const completedRoundNumber = this.state.shopSession.roundNumber;
    const shopEpoch = this.state.shopSession.shopEpoch;
    const nextRoundNumber = completedRoundNumber + 1;
    const nextPlayers = this.state.players.map((player) => ({
      ...player,
      tank: {
        ...player.tank,
        isDead: false,
        health: player.tank.maxHealth,
        shield: player.tank.maxShield,
        lastDirectAttackerId: undefined,
      },
    }));
    const finish: ShopFinishMessage = {
      type: 'SHOP_FINISH',
      shopEpoch,
      completedRoundNumber,
      nextRoundNumber,
      players: nextPlayers,
    };

    // Le résultat terminal existe dans l'état avant le nettoyage de session.
    this.state.lastCompletedShop = finish;
    const finishKey = makeShopActionKey('READY', fromSlot, actionId);
    this.state.processedShopActions[finishKey] = {
      slot: fromSlot,
      result: finish,
    };
    this.state.players = nextPlayers;
    this.state.shopSession = null;
    this.resetShotCoordination();
    this.state.roundEnded = false;
    this.state.roundNumber = nextRoundNumber;
    this.state.shotNumberInRound = 0;
    this.state.shotHistory = [];
    this.state.lastAppliedEarnings = null;
    this.state.lastAppliedZeusStrike = null;
    this.state.processedFireActionsBySlot = {};
    this.state.lastFireResultBySlot = {};
    this.resetZeusRoundState();
    this.state.currentPlayerIndex = 0;
    await this.saveState();

    this.broadcast(finish);
    this.broadcast({
      type: 'STATE_UPDATE',
      currentPlayerIndex: 0,
      roundEnded: false,
      players: this.state.players,
    });
    this.maybeRunAIServerTurn();
  }

  // Public helper if we later expose REST status
  getRoster() {
    return this.state;
  }
}
