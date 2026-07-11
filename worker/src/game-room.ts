/**
 * GameRoom Durable Object (worker/src/game-room.ts)
 *
 * Responsibilities (MVP - 1 round combat only):
 * - Store room config (numPlayers, per-slot type human/ai + aiProfile)
 * - Generate per-slot join secrets/tokens
 * - Manage presence: human slots claim via WS with token
 * - Track "joined" humans vs AI (AI are always "ready")
 * - Auto-start when all human slots have joined
 * - On start: build authoritative Player[] roster, generate initial terrain heights + wind
 * - Accept FIRE commands only from the correct human slot on their turn
 * - For AI turns: use existing AIByProfileStrategy (headless) to decide + fire
 * - Run full authoritative simulation (headless fast-forward) for every shot
 * - Broadcast SHOT (for client-side visual replay) + STATE_UPDATE (authoritative patches)
 * - Hold the full game state for the single round (Terrain heights, players, turn, etc.)
 *
 * NOTE for MVP: The real headless GameEngine / SimulationCore + RNG seeding lives in the client
 * engine files (will be extended with headless flag). For now the DO keeps a minimal pure-TS
 * simulation stub that will be replaced by importing/calling the real core once the client
 * side headless work is done. The structure (state, broadcast, turn order) is already correct.
 *
 * All random MUST go through a seeded RNG for determinism (injected later).
 */

import { DurableObject } from "cloudflare:workers";

import type { Player } from '../../src/types/player'; // share types from root (works in monorepo-style dev)
import type { Color } from '../../src/types/game';
import type { WeaponId } from '../../src/types/weapon';
import { DEFAULT_INVENTORY } from '../../src/types/weapon';
import { nextLivingPlayerIndex } from '../../src/game/online/turnOrder';

// Very small serializable state for MVP (will be enriched with real engine state later)
interface RoomState {
  roomId: string;
  numPlayers: number;
  slotConfigs: Array<{ type: 'human' | 'ai'; aiProfile?: string }>;
  // secrets per slot (the "token" part of the join URL)
  tokens: string[];
  joinedHumans: Record<number, { name: string; joinedAt: number }>; // only humans use tokens
  // When game has started
  started: boolean;
  startAt?: number;
  // Authoritative game state (MVP single round)
  players: Player[];
  heights: number[]; // full heightmap (server truth)
  wind: number;
  currentPlayerIndex: number;
  roundEnded: boolean;
  // For future: round number, but MVP = 1 round only
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
  /**
   * Authoritative parallel boutique session (in-memory).
   * Every human slot shops independently and sends SHOP_READY; the DO finishes when all humans are ready.
   * Dead tanks still shop (they respawn next round) — never skip isDead slots.
   */
  private shopSession: { active: boolean; readySlots: number[] } | null = null;

  // Load state from storage on cold start
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as Record<string, unknown>);
    ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<RoomState>("state");
      if (stored) {
        this.state = stored;
        // Restore AI profiles in memory if reloaded
        if (this.state.slotConfigs) {
          this.state.slotConfigs.forEach((cfg, idx) => {
            if (cfg.type === 'ai' && cfg.aiProfile) this.aiProfiles.set(idx, cfg.aiProfile);
          });
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
    this.shotEpoch++;
  }

  /** Catch-up payload for a socket that (re)joins an in-progress match. */
  private sendCombatCatchUpToSocket(ws: WebSocket): void {
    this.sendGameStartToSocket(ws);
    if (!this.state?.started) return;

    // Always push authoritative turn index (GAME_START already has it; belt-and-suspenders).
    try {
      ws.send(
        JSON.stringify({
          type: 'STATE_UPDATE',
          currentPlayerIndex: this.state.currentPlayerIndex,
          roundEnded: this.state.roundEnded,
        }),
      );
    } catch {
      // ignore stale
    }

    // Re-broadcast the in-flight SHOT so a late/reconnected observer can still see it.
    if (this.shotInFlight && this.lastShot) {
      try {
        ws.send(
          JSON.stringify({
            type: 'SHOT',
            slot: this.lastShot.slot,
            command: this.lastShot.command,
            ownerId: this.lastShot.ownerId,
          }),
        );
      } catch {
        // ignore stale
      }
    }
  }


  // --- REST entry from the Worker (create room) ---
  async fetchCreate(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      roomId?: string;
      numPlayers?: number;
      slotConfigs?: Array<{ type: 'human' | 'ai'; aiProfile?: string }>;
      origin?: string;
    };

    const roomId = body.roomId;
    const numPlayers = body.numPlayers;
    const slotConfigs = body.slotConfigs;

    if (!roomId || !numPlayers || !slotConfigs) {
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
      wind: 0,
      currentPlayerIndex: 0,
      roundEnded: false,
    };

    // Pre-register AI profiles for server-driven turns
    slotConfigs.forEach((cfg, idx) => {
      if (cfg.type === 'ai' && cfg.aiProfile) this.aiProfiles.set(idx, cfg.aiProfile);
    });

    // Use origin provided by client (for local dev it will be http://localhost:5173),
    // otherwise fall back to production.
    const origin = body.origin || 'https://tankwars.pages.dev';
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
      if (slot < 0 || slot >= this.state.numPlayers) {
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
        try {
          (old as any).close(1000, 'replaced by new connection for same slot');
        } catch {}
        this.sockets.delete(slot);
      }

      try {
        // Accept the WebSocket and attach it to this slot
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];

        // Store the socket (we will send messages to it)
        this.sockets.set(slot, server as any);

        // Handle messages from this player
        server.accept();
        server.addEventListener('message', (evt) => {
          this.handleClientMessage(slot, evt.data).catch((err) => {
            console.error('[GameRoom] Error handling client message from slot=', slot, ':', err);
          });
        });
        server.addEventListener('close', () => {
          this.handleSocketDisconnect(slot, server as any).catch((err) => {
            console.error('[GameRoom] Error on socket disconnect for slot=', slot, ':', err);
          });
        });
        server.addEventListener('error', () => {
          this.handleSocketDisconnect(slot, server as any).catch((err) => {
            console.error('[GameRoom] Error on socket error for slot=', slot, ':', err);
          });
        });

        // Defer post-connection tasks (claiming the slot and sending game start) to the next tick.
        // This ensures we return the 101 Switching Protocols response first, letting the runtime
        // complete the WebSocket handshake before we try to perform any async database transactions
        // or send data down the socket. Prevents segment faults/unhandled errors in workerd.
        const nameFromQuery = url.searchParams.get('name');
        const name = (nameFromQuery || `Joueur-${slot + 1}`).trim();
        const postSetupPromise = new Promise<void>((resolve) => {
          setTimeout(() => {
            this.claimHumanSlot(slot, name)
              .then(() => {
                if (this.state?.started) {
                  // Catch-up: turn index + any in-flight SHOT the client may have missed
                  // (lobby→combat transition, Strict Mode remount, brief disconnect).
                  this.sendCombatCatchUpToSocket(server as WebSocket);
                }
                resolve();
              })
              .catch((err) => {
                console.error('[GameRoom] Error in post-connection setup for slot=', slot, ':', err);
                resolve();
              });
          }, 0);
        });
        this.ctx.waitUntil(postSetupPromise);

        return new Response(null, { status: 101, webSocket: client });
      } catch (err) {
        console.error('[GameRoom] WebSocket upgrade failed:', err);
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
    let msg: any;
    try {
      msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return;
    }

    if (!this.state) return;

    // Catch-up: client missed the GAME_START broadcast (e.g. host tab still in lobby)
    // or reconnected mid-shot and needs the in-flight SHOT replayed.
    if (msg?.type === 'REQUEST_GAME_START' && this.state.started) {
      const wsConn = this.sockets.get(slot);
      if (wsConn) this.sendCombatCatchUpToSocket(wsConn as WebSocket);
      return;
    }

    // Handle name identification / update (sent by client after WS open)
    if (msg && msg.type === 'IDENTIFY' && msg.name) {
      if (this.state.joinedHumans[slot]) {
        this.state.joinedHumans[slot].name = msg.name.trim() || `Joueur-${slot + 1}`;
        await this.saveState();
        this.sendRosterUpdate();
      }
      return;
    }

    if (!this.state.started) return;

    if (msg?.type === 'SHOT_SETTLED') {
      console.log(
        `[GameRoom] Received SHOT_SETTLED from slot ${slot}. currentPlayerIndex=${this.state?.currentPlayerIndex}, awaitingShotFromSlot=${this.awaitingShotFromSlot}, shotInFlight=${this.shotInFlight}`,
      );
      if (
        this.shotInFlight &&
        slot === this.state.currentPlayerIndex &&
        slot === this.awaitingShotFromSlot
      ) {
        console.log(`[GameRoom] SHOT_SETTLED accepted for active human shot. Advancing turn...`);
        this.clearShotSettledTimeout();
        await this.advanceTurnAndNotify();
      } else {
        console.warn(
          `[GameRoom] Ignoring SHOT_SETTLED from slot ${slot} (active=${this.state?.currentPlayerIndex}, awaiting=${this.awaitingShotFromSlot}, shotInFlight=${this.shotInFlight})`,
        );
      }
      return;
    }

    if (msg?.type === 'ROUND_END' && Array.isArray(msg.players) && !this.state.roundEnded) {
      this.resetShotCoordination();
      this.shopSession = null;
      this.state.roundEnded = true;
      this.state.players = msg.players;
      await this.saveState();
      this.broadcast({
        type: 'ROUND_END',
        players: msg.players,
        roundWinnerId: msg.roundWinnerId ?? null,
        isDraw: !!msg.isDraw,
        slot: typeof msg.slot === 'number' ? msg.slot : slot,
      });
      return;
    }

    // Shop inventory relay — merge only the sender's player so parallel buys don't clobber each other.
    if (msg?.type === 'SHOP_BUY_SELL') {
      const updated = this.mergeShopPlayerUpdate(slot, msg);
      if (updated) {
        await this.saveState();
        this.broadcast({ type: 'SHOP_BUY_SELL', players: this.state.players, slot });
      }
      return;
    }
    if (msg?.type === 'SHOP_ENTER') {
      await this.handleShopEnter(
        slot,
        Array.isArray(msg.players) ? (msg.players as Player[]) : undefined,
      );
      return;
    }
    if (msg?.type === 'SHOP_READY') {
      await this.handleShopReady(slot, Array.isArray(msg.players) ? (msg.players as Player[]) : undefined);
      return;
    }
    // Legacy client relay (pre-authoritative shop). Prefer SHOP_READY; keep for mid-deploy compat.
    if (msg?.type === 'SHOP_ADVANCE' && typeof msg.nextIndex === 'number') {
      console.warn(`[GameRoom] Legacy SHOP_ADVANCE from slot ${slot} — treating as SHOP_READY`);
      await this.handleShopReady(slot, Array.isArray(msg.players) ? (msg.players as Player[]) : undefined);
      return;
    }
    if (msg?.type === 'SHOP_FINISH' && Array.isArray(msg.players)) {
      // Legacy: only accept if shop session already completed or absent (belt-and-suspenders).
      await this.completeShopPhase(msg.players as Player[], slot);
      return;
    }

    if (this.state.roundEnded) return;

    const current = this.state.currentPlayerIndex;
    if (slot !== current) return; // not your turn

    const cfg = this.state.slotConfigs[slot];
    if (cfg.type !== 'human') return;

    if (msg && msg.type === 'FIRE' && msg.command) {
      // One shot in flight at a time — blocks double-fire on the same turn (client unlock races).
      if (this.shotInFlight || this.awaitingShotFromSlot != null) {
        console.warn(
          `[GameRoom] Ignoring FIRE from slot ${slot} — shot already in flight (awaiting=${this.awaitingShotFromSlot}, shotInFlight=${this.shotInFlight})`,
        );
        return;
      }
      console.log(
        '[GameRoom] Received FIRE from slot=',
        slot,
        ', current=',
        this.state.currentPlayerIndex,
        ', cmd=',
        msg.command,
      );
      const cmd = msg.command as { angle: number; power: number; weaponId: WeaponId };
      await this.executeFire(slot, cmd);
    }
  }

  // Broadcast helper (only to connected human sockets)
  private broadcast(obj: unknown) {
    const data = JSON.stringify(obj);
    for (const ws of this.sockets.values()) {
      try {
        (ws as any).send(data);
      } catch {
        // ignore stale
      }
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
    if (this.sockets.get(slot) === ws) {
      this.sockets.delete(slot);
    }
    try {
      ws.close(1000, 'connection closed');
    } catch {
      // ignore if already closed
    }
    if (!this.state || this.state.started) return;
    if (this.state.slotConfigs[slot]?.type !== 'human') return;
    if (!this.state.joinedHumans[slot]) return;
    delete this.state.joinedHumans[slot];
    await this.saveState();
    this.sendRosterUpdate();
  }

  private buildGameStartMessage() {
    if (!this.state?.started) return null;
    return {
      type: 'GAME_START' as const,
      players: this.state.players,
      heights: this.state.heights,
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
    this.state.joinedHumans[slot] = { name: name.trim() || `Joueur-${slot + 1}`, joinedAt: Date.now() };
    await this.saveState();
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
        aiProfile: isHuman ? undefined : (cfg.aiProfile as any),
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
    // For skeleton we emit placeholder heights (flat) — real work happens in client engine step 6/7
    const placeholderHeights = Array.from({ length: 800 }, (_, x) => 300 + Math.sin(x / 30) * 20);

    this.state.players = players;
    this.state.heights = placeholderHeights;
    this.state.wind = 0; // real wind roll will be done when headless sim is wired
    this.state.currentPlayerIndex = 0;
    this.state.started = true;
    this.state.startAt = Date.now();
    this.resetShotCoordination();

    await this.saveState();

    // Tell everyone the game is starting + give them the full initial snapshot
    const gameStart = this.buildGameStartMessage();
    if (gameStart) {
      this.broadcast(gameStart);
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

  // Very naive color assignment (stable, no collision). Real version can be richer.
  private assignColor(slot: number): Color {
    const palette: Color[] = [
      '#5555FF', '#FF5555', '#00F7FF', '#00FF7F', '#FF1A8C', '#D7FF00', '#FF8C00', '#B300FF',
    ];
    return palette[slot % palette.length];
  }

  // Execute a fire (either from human WS or from server AI)
  private async executeFire(fromSlot: number, command: { angle: number; power: number; weaponId: WeaponId }): Promise<void> {
    if (!this.state || this.state.roundEnded) return;

    // Defense in depth: AI timer + human FIRE path both funnel here.
    if (this.shotInFlight) {
      console.warn(
        `[GameRoom] executeFire ignored for slot ${fromSlot} — shot already in flight`,
      );
      return;
    }

    console.log('[GameRoom] executeFire: fromSlot=', fromSlot, ', command=', command);
    this.clearShotSettledTimeout();
    this.shotInFlight = true;
    this.shotEpoch++;
    const epoch = this.shotEpoch;

    const ownerId = this.state.players[fromSlot]?.id;
    this.lastShot = { slot: fromSlot, command, ownerId };
    const shotEvent = {
      type: 'SHOT',
      slot: fromSlot,
      command,
      ownerId,
    };
    this.broadcast(shotEvent);

    const cfg = this.state.slotConfigs[fromSlot];
    if (cfg && cfg.type === 'ai') {
      console.log(`[GameRoom] executeFire: active slot ${fromSlot} is AI. Arming 4.5s turn advance timer...`);
      // Pour une IA, le serveur attend un délai réaliste (par exemple 4.5s) avant d'avancer le tour
      const aiTimeoutPromise = new Promise<void>((resolve) => {
        this.shotSettledTimeout = setTimeout(() => {
          this.shotSettledTimeout = null;
          if (epoch !== this.shotEpoch || !this.shotInFlight) {
            console.log(`[GameRoom] AI turn advance timer ignored (stale epoch ${epoch} vs ${this.shotEpoch})`);
            resolve();
            return;
          }
          console.log(`[GameRoom] AI turn advance timer fired. Advancing turn...`);
          this.advanceTurnAndNotify()
            .then(resolve)
            .catch((err) => {
              console.error('[GameRoom] Error advancing turn for AI shot:', err);
              resolve();
            });
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
          console.warn(`[GameRoom] Security timeout triggered: forcing turn advance after slot ${fromSlot} shot`);
          this.advanceTurnAndNotify()
            .then(resolve)
            .catch((err) => {
              console.error('[GameRoom] Error in human shot safety timeout:', err);
              resolve();
            });
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

  private maybeRunAIServerTurn() {
    if (!this.state || this.state.roundEnded) return;
    if (this.shotInFlight) return;
    const idx = this.state.currentPlayerIndex;
    const cfg = this.state.slotConfigs[idx];
    if (cfg?.type !== 'ai') return;

    // Skip dead AI slots (authoritative roster may lag mid-combat; still safe).
    if (this.state.players[idx]?.tank?.isDead) {
      // Should not happen if nextLivingPlayerIndex worked; force another advance only if stuck.
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
        this.executeFire(idx, fakeCommand)
          .then(resolve)
          .catch((err) => {
            console.error('[GameRoom] Error executing AI fire for slot=', idx, ':', err);
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

  /**
   * Apply only the purchasing slot's player to the authoritative roster.
   * Accepts either `{ player }` (preferred) or full `{ players[] }` (legacy).
   */
  private mergeShopPlayerUpdate(slot: number, msg: { player?: Player; players?: Player[] }): boolean {
    if (!this.state) return false;
    if (this.state.slotConfigs[slot]?.type !== 'human') return false;

    let patch: Player | undefined;
    if (msg.player && typeof msg.player === 'object' && typeof msg.player.id === 'string') {
      patch = msg.player;
    } else if (Array.isArray(msg.players) && msg.players[slot]) {
      patch = msg.players[slot];
    }
    if (!patch) return false;

    // Prefer index === slot (canonical). Fall back to id match.
    let idx = slot;
    if (!this.state.players[idx] || this.state.players[idx].id !== patch.id) {
      const byId = this.state.players.findIndex((p) => p.id === patch!.id);
      if (byId >= 0) idx = byId;
    }
    if (idx < 0 || idx >= this.state.numPlayers) return false;

    const next = [...this.state.players];
    // Ensure array length if server roster was still empty.
    while (next.length < this.state.numPlayers) {
      next.push(patch);
    }
    next[idx] = patch;
    this.state.players = next;
    return true;
  }

  /** Client entered the boutique — init parallel session and re-sync ready set. */
  private async handleShopEnter(slot: number, players?: Player[]): Promise<void> {
    if (!this.state) return;

    if (!this.shopSession?.active) {
      this.shopSession = { active: true, readySlots: [] };
      console.log(`[GameRoom] Parallel shop session started by slot ${slot}`);
    }

    // Host often sends post-AI-buy roster on enter; accept first full snapshot.
    if (players && players.length === this.state.numPlayers) {
      this.state.players = players;
      await this.saveState();
    }

    this.broadcast({
      type: 'SHOP_STATE',
      mode: 'parallel',
      readySlots: [...this.shopSession.readySlots],
      done: false,
      players: this.state.players.length > 0 ? this.state.players : undefined,
    });
  }

  /**
   * A human finished their own shopping. When every human slot has readied, end boutique.
   * AI purchases are applied client-side (host) before SHOP_ENTER / via BUY_SELL — not via ready gate.
   */
  private async handleShopReady(slot: number, players?: Player[]): Promise<void> {
    if (!this.state) return;

    if (!this.shopSession?.active) {
      this.shopSession = { active: true, readySlots: [] };
    }

    const cfg = this.state.slotConfigs[slot];
    if (!cfg || cfg.type !== 'human') {
      console.warn(`[GameRoom] SHOP_READY ignored from non-human slot ${slot}`);
      return;
    }

    // Merge only this human's final snapshot — do not replace the whole roster from one client.
    if (players && players.length === this.state.numPlayers && players[slot]) {
      this.mergeShopPlayerUpdate(slot, { player: players[slot], players });
      await this.saveState();
    }

    if (!this.shopSession.readySlots.includes(slot)) {
      this.shopSession.readySlots.push(slot);
    }

    const humans = this.getHumanSlots();
    const ready = this.shopSession.readySlots;
    const readySet = new Set(ready);
    console.log(
      `[GameRoom] SHOP_READY slot ${slot} — ready=[${ready.join(',')}] humans=[${humans.join(',')}]`,
    );

    this.broadcast({
      type: 'SHOP_STATE',
      mode: 'parallel',
      readySlots: [...ready],
      done: false,
      players: this.state.players,
    });

    const allHumansReady =
      humans.length > 0 && humans.every((h) => readySet.has(h));
    if (allHumansReady) {
      console.log(`[GameRoom] All humans ready — completing shop`);
      await this.completeShopPhase(this.state.players, slot);
    }
  }

  private async completeShopPhase(players: Player[], fromSlot: number): Promise<void> {
    if (!this.state) return;

    this.shopSession = null;
    this.resetShotCoordination();
    this.state.roundEnded = false;
    this.state.currentPlayerIndex = 0;
    if (players.length > 0) {
      this.state.players = players;
    }
    await this.saveState();

    // Single completion signal — clients must apply players only inside finishShopPhase
    // (before startNextRound). A follow-up setPlayers after spawn re-applied isDead and desynced turns.
    this.broadcast({
      type: 'SHOP_FINISH',
      players: this.state.players,
      slot: fromSlot,
    });
    this.broadcast({
      type: 'STATE_UPDATE',
      currentPlayerIndex: 0,
      roundEnded: false,
    });
    this.maybeRunAIServerTurn();
  }

  // Public helper if we later expose REST status
  getRoster() {
    return this.state;
  }
}
