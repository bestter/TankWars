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

import { DurableObject, DurableObjectState } from "cloudflare:workers";

import type { Player } from '../../src/types/player'; // share types from root (works in monorepo-style dev)
import type { WeaponId } from '../../src/types/weapon';
import { DEFAULT_INVENTORY } from '../../src/types/weapon';

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

  // In-memory only for MVP (DO will hibernate when idle)
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as Record<string, unknown>);
    // On cold start the DO may reload state from storage if we had persisted it.
    // For MVP we keep everything in memory (fast, simple). Real rooms are short-lived.
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
        server.addEventListener('message', (evt) => this.handleClientMessage(slot, evt.data));
        server.addEventListener('close', () => this.handleSocketDisconnect(slot));
        server.addEventListener('error', () => this.handleSocketDisconnect(slot));

        // Claim the slot immediately using name from query param (passed by client in WS URL)
        // This populates joinedHumans so roster count and auto-start work.
        const nameFromQuery = url.searchParams.get('name');
        const name = (nameFromQuery || `Joueur-${slot + 1}`).trim();
        this.claimHumanSlot(slot, name);

        // Late join / reconnect: if the match already started, send GAME_START to this socket only.
        if (this.state?.started) {
          this.sendGameStartToSocket(server as WebSocket);
        }

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
  private handleClientMessage(slot: number, raw: any) {
    let msg: any;
    try {
      msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return;
    }

    if (!this.state) return;

    // Catch-up: client missed the GAME_START broadcast (e.g. host tab still in lobby)
    if (msg?.type === 'REQUEST_GAME_START' && this.state.started) {
      const wsConn = this.sockets.get(slot);
      if (wsConn) this.sendGameStartToSocket(wsConn as WebSocket);
      return;
    }

    // Handle name identification / update (sent by client after WS open)
    if (msg && msg.type === 'IDENTIFY' && msg.name) {
      if (this.state.joinedHumans[slot]) {
        this.state.joinedHumans[slot].name = msg.name.trim() || `Joueur-${slot + 1}`;
        this.sendRosterUpdate();
      }
      return;
    }

    if (!this.state.started) return;

    if (msg?.type === 'ROUND_END' && Array.isArray(msg.players) && !this.state.roundEnded) {
      this.state.roundEnded = true;
      this.broadcast({
        type: 'ROUND_END',
        players: msg.players,
        roundWinnerId: msg.roundWinnerId ?? null,
        isDraw: !!msg.isDraw,
        slot: typeof msg.slot === 'number' ? msg.slot : slot,
      });
      return;
    }

    // Shop phase relay (turn order not required — clients coordinate sequential shopping)
    if (msg?.type === 'SHOP_BUY_SELL' && Array.isArray(msg.players)) {
      this.broadcast({ type: 'SHOP_BUY_SELL', players: msg.players, slot });
      return;
    }
    if (msg?.type === 'SHOP_ADVANCE' && typeof msg.nextIndex === 'number') {
      this.broadcast({ type: 'SHOP_ADVANCE', nextIndex: msg.nextIndex, slot });
      return;
    }
    if (msg?.type === 'SHOP_FINISH' && Array.isArray(msg.players)) {
      this.state.roundEnded = false;
      this.state.currentPlayerIndex = 0;
      this.state.players = msg.players;
      this.broadcast({ type: 'SHOP_FINISH', players: msg.players, slot });
      this.broadcast({
        type: 'STATE_UPDATE',
        currentPlayerIndex: 0,
        roundEnded: false,
      });
      this.maybeRunAIServerTurn();
      return;
    }

    if (this.state.roundEnded) return;

    const current = this.state.currentPlayerIndex;
    if (slot !== current) return; // not your turn

    const cfg = this.state.slotConfigs[slot];
    if (cfg.type !== 'human') return;

    if (msg && msg.type === 'FIRE' && msg.command) {
      console.log(`[GameRoom] Received FIRE from slot ${slot}, current=${this.state.currentPlayerIndex}, cmd=`, msg.command);
      const cmd = msg.command as { angle: number; power: number; weaponId: WeaponId };
      this.executeFire(slot, cmd);
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
    const roster = Object.entries(this.state.joinedHumans).map(([s, info]) => ({
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

  /** Remove stale lobby presence when a human disconnects before the match starts. */
  private handleSocketDisconnect(slot: number): void {
    this.sockets.delete(slot);
    if (!this.state || this.state.started) return;
    if (this.state.slotConfigs[slot]?.type !== 'human') return;
    if (!this.state.joinedHumans[slot]) return;
    delete this.state.joinedHumans[slot];
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
  private claimHumanSlot(slot: number, name: string) {
    if (!this.state) return;
    if (this.state.slotConfigs[slot]?.type !== 'human') return;
    this.state.joinedHumans[slot] = { name: name.trim() || `Joueur-${slot + 1}`, joinedAt: Date.now() };
    this.sendRosterUpdate();
    this.maybeAutoStart();
  }

  // Auto-start when every human-configured slot has a joined human
  private maybeAutoStart() {
    if (!this.state || this.state.started) return;

    const humanSlots = this.state.slotConfigs
      .map((c, i) => (c.type === 'human' ? i : -1))
      .filter((i) => i >= 0);

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

    // If the very first player is an AI, the server immediately plays it (MVP)
    this.maybeRunAIServerTurn();
  }

  // Very naive color assignment (stable, no collision). Real version can be richer.
  private assignColor(slot: number): string {
    const palette = [
      '#5555FF', '#FF5555', '#00F7FF', '#00FF7F', '#FF1A8C', '#D7FF00', '#FF8C00', '#B300FF',
    ];
    return palette[slot % palette.length];
  }

  // Execute a fire (either from human WS or from server AI)
  private executeFire(fromSlot: number, command: { angle: number; power: number; weaponId: WeaponId }) {
    if (!this.state || this.state.roundEnded) return;

    // In real impl: restore the headless simulator here, call fire + fastForwardUntilSettled,
    // compute real craters (heights mutation), damage, round end, etc.
    // Then produce the deltas and broadcast.

    // For the skeleton we just advance turn and echo the command so clients can at least see "something happened".
    const shotEvent = {
      type: 'SHOT',
      slot: fromSlot,
      command,
      ownerId: this.state.players[fromSlot]?.id,
    };
    this.broadcast(shotEvent);

    // Very fake "resolution" – in the real version the server would have mutated heights + players
    // For now just rotate to next alive player (demo purpose)
    const next = (fromSlot + 1) % this.state.numPlayers;
    this.state.currentPlayerIndex = next;

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
    const idx = this.state.currentPlayerIndex;
    const cfg = this.state.slotConfigs[idx];
    if (cfg?.type !== 'ai') return;

    // In later step we will call the real AI strategy here (headless) and then executeFire.
    // For skeleton: pick a safe-ish random shot so the round can progress in a multi-tab test.
    const fakeCommand = {
      angle: 30 + ((idx * 37) % 90),
      power: 55 + ((idx * 13) % 30),
      weaponId: 'MISSILE' as WeaponId,
    };
    // Small delay so clients see the turn change
    setTimeout(() => this.executeFire(idx, fakeCommand), 1200);
  }

  // Public helper if we later expose REST status
  getRoster() {
    return this.state;
  }
}
