import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GameRoom } from '../game-room';
import type { WeaponId } from '../../../src/types/weapon';
import type { Player } from '../../../src/types/player';
import type { ShotMessage } from '../../../src/game/online/protocol';
import { autoBuyForAI } from '../../../src/game/entities/ai/aiShopHelper';
import { normalizeInventoryAtShopOpen } from '../../../src/game/shop/shopTransaction';

class MockWebSocket {
  public sent: string[] = [];
  public readyState = 1; // WebSocket.OPEN
  public closeCode: number | undefined;
  public send(data: string): void {
    this.sent.push(data);
  }
  public close(code?: number, _reason?: string): void {
    this.closeCode = code;
    this.readyState = 3; // WebSocket.CLOSED
  }
  public getLastMessage<T>(): T | null {
    if (this.sent.length === 0) return null;
    return JSON.parse(this.sent[this.sent.length - 1]) as T;
  }
  public getAllMessages<T>(): T[] {
    return this.sent.map((s) => JSON.parse(s) as T);
  }
}

interface MockStorageState {
  storageData: Map<string, unknown>;
}

function createMockCtx(): { ctx: unknown; mockStorage: MockStorageState } {
  const storageData = new Map<string, unknown>();
  const mockStorage: MockStorageState = { storageData };

  const ctx = {
    blockConcurrencyWhile: vi.fn(async (cb: () => Promise<void>) => {
      await cb();
    }),
    waitUntil: vi.fn(),
    storage: {
      get: vi.fn(async (key: string) => storageData.get(key) ?? undefined),
      put: vi.fn(async (key: string, value: unknown) => {
        storageData.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        storageData.delete(key);
      }),
    },
  };

  return { ctx, mockStorage };
}

describe('GameRoom Durable Object', () => {
  let room: GameRoom;
  let mockCtx: ReturnType<typeof createMockCtx>['ctx'];

  beforeEach(() => {
    const setup = createMockCtx();
    mockCtx = setup.ctx;
    // Instantiate GameRoom and ensure ctx is attached
    room = new GameRoom(mockCtx as DurableObjectState, {});
    Object.defineProperty(room, 'ctx', { value: mockCtx, writable: true });
  });

  describe('fetchCreate', () => {
    it('creates a new room with tokens and returns room invitation URLs', async () => {
      const payload = {
        roomId: 'room-123',
        numPlayers: 2,
        slotConfigs: [
          { type: 'human' },
          { type: 'human' },
        ],
        origin: 'http://localhost:5173',
      };

      const req = new Request('http://localhost/api/room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const res = await room.fetchCreate(req);
      expect(res.status).toBe(200);

      const json = (await res.json()) as {
        roomId: string;
        numPlayers: number;
        slots: Array<{ slot: number; type: string; url: string }>;
      };

      expect(json.roomId).toBe('room-123');
      expect(json.numPlayers).toBe(2);
      expect(json.slots.length).toBe(2);
      expect(json.slots[0].url).toContain('room=room-123&slot=0&token=');
      expect(json.slots[1].url).toContain('room=room-123&slot=1&token=');
    });

    it('URL-encodes room IDs in invitation links', async () => {
      const roomId = 'room&admin=true#fragment';
      const req = new Request('http://localhost/api/room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId,
          numPlayers: 2,
          slotConfigs: [{ type: 'human' }, { type: 'human' }],
          origin: 'http://localhost:5173',
        }),
      });

      const res = await room.fetchCreate(req);
      expect(res.status).toBe(200);

      const json = (await res.json()) as {
        slots: Array<{ url: string }>;
      };
      const invitationUrl = new URL(json.slots[0].url);

      expect(invitationUrl.searchParams.get('room')).toBe(roomId);
      expect(invitationUrl.searchParams.get('slot')).toBe('0');
      expect(invitationUrl.searchParams.has('token')).toBe(true);
      expect(invitationUrl.searchParams.has('admin')).toBe(false);
      expect(invitationUrl.hash).toBe('');
    });

    it('rejects invalid creation payload with 400', async () => {
      const req = new Request('http://localhost/api/room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: 'missing-slots' }),
      });

      const res = await room.fetchCreate(req);
      expect(res.status).toBe(400);
    });

    it('rejects duplicate creation with 409 if room already exists', async () => {
      const payload = {
        roomId: 'room-dup',
        numPlayers: 2,
        slotConfigs: [{ type: 'human' }, { type: 'ai', aiProfile: 'v1-random' }],
        origin: 'http://localhost:5173',
      };

      const req1 = new Request('http://localhost/api/room', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const res1 = await room.fetchCreate(req1);
      expect(res1.status).toBe(200);

      const req2 = new Request('http://localhost/api/room', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const res2 = await room.fetchCreate(req2);
      expect(res2.status).toBe(409);
    });
  });

  describe('Lobby connection, Identify, and Auto-Start', () => {
    beforeEach(async () => {
      const payload = {
        roomId: 'room-lobby',
        numPlayers: 2,
        slotConfigs: [{ type: 'human' }, { type: 'human' }],
        origin: 'http://localhost:5173',
      };
      const req = new Request('http://localhost/api/room', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      await room.fetchCreate(req);
    });

    it('handles IDENTIFY message to update human player name', async () => {
      const ws0 = new MockWebSocket();
      const internalSockets = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
      internalSockets.set(0, ws0 as unknown as WebSocket);

      // Claim human slot 0
      const claimMethod = Reflect.get(room, 'claimHumanSlot') as (s: number, n: string) => Promise<void>;
      await claimMethod.call(room, 0, 'InitialName');

      // Send IDENTIFY message
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;

      await handleClientMessage.call(room, 0, JSON.stringify({ type: 'IDENTIFY', name: 'AceShooter' }));

      const lastMsg = ws0.getLastMessage<{ type: string; roster: Array<{ name: string; slot: number }> }>();
      expect(lastMsg?.type).toBe('ROSTER_UPDATE');
      expect(lastMsg?.roster.find((r) => r.slot === 0)?.name).toBe('AceShooter');
    });

    it('auto-starts game when all human slots are connected and sends GAME_START', async () => {
      const ws0 = new MockWebSocket();
      const ws1 = new MockWebSocket();
      const internalSockets = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
      internalSockets.set(0, ws0 as unknown as WebSocket);
      internalSockets.set(1, ws1 as unknown as WebSocket);

      const claimMethod = Reflect.get(room, 'claimHumanSlot') as (s: number, n: string) => Promise<void>;

      // Host joins
      await claimMethod.call(room, 0, 'Alice');
      const initialMsg0 = ws0.getAllMessages<{ type: string }>().find((m) => m.type === 'GAME_START');
      expect(initialMsg0).toBeUndefined(); // Not started yet

      // Guest joins
      await claimMethod.call(room, 1, 'Bob');

      // Now both joined -> auto-start triggered!
      interface GameStartMsg {
        type: string;
        players: unknown[];
        heights: number[];
        materials?: string[];
      }
      const startMsg0 = ws0.getAllMessages<GameStartMsg>().find(
        (m) => m.type === 'GAME_START'
      );
      const startMsg1 = ws1.getAllMessages<GameStartMsg>().find(
        (m) => m.type === 'GAME_START'
      );

      expect(startMsg0).toBeDefined();
      expect(startMsg1).toBeDefined();
      expect(startMsg0?.players.length).toBe(2);
      expect(startMsg0?.heights.length).toBe(800);
      expect(startMsg0?.materials).toBeUndefined();
    });

    it('includes materials on GAME_START when RoomState.materials matches heights', async () => {
      const ws0 = new MockWebSocket();
      const ws1 = new MockWebSocket();
      const internalSockets = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
      internalSockets.set(0, ws0 as unknown as WebSocket);
      internalSockets.set(1, ws1 as unknown as WebSocket);

      const claimMethod = Reflect.get(room, 'claimHumanSlot') as (s: number, n: string) => Promise<void>;
      await claimMethod.call(room, 0, 'Alice');
      await claimMethod.call(room, 1, 'Bob');

      const state = Reflect.get(room, 'state') as { heights: number[]; materials: string[] };
      state.materials = state.heights.map(() => 'DIRT');
      const build = Reflect.get(room, 'buildGameStartMessage') as () => {
        type: string;
        heights: number[];
        materials?: string[];
      };
      const msg = build.call(room);
      expect(msg.materials).toHaveLength(800);
      expect(msg.materials?.[0]).toBe('DIRT');
    });

    it('cleans up slot and notifies roster update on socket disconnect before game start', async () => {
      const ws0 = new MockWebSocket();
      const internalSockets = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
      internalSockets.set(0, ws0 as unknown as WebSocket);

      const claimMethod = Reflect.get(room, 'claimHumanSlot') as (s: number, n: string) => Promise<void>;
      await claimMethod.call(room, 0, 'Alice');

      // Disconnect socket 0
      const disconnectMethod = Reflect.get(room, 'handleSocketDisconnect') as (
        slot: number,
        ws: WebSocket
      ) => Promise<void>;

      await disconnectMethod.call(room, 0, ws0 as unknown as WebSocket);

      expect(internalSockets.has(0)).toBe(false);
      const roomState = Reflect.get(room, 'state') as { joinedHumans: Record<number, unknown> };
      expect(roomState.joinedHumans[0]).toBeUndefined();
    });

    it('does not clean up slot when an old replaced socket disconnects after a new socket joined', async () => {
      const wsHost = new MockWebSocket();
      const internalSockets = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
      internalSockets.set(0, wsHost as unknown as WebSocket);

      const claimMethod = Reflect.get(room, 'claimHumanSlot') as (s: number, n: string) => Promise<void>;
      await claimMethod.call(room, 0, 'HostPlayer');

      // New player connects to slot 0 (replacing host)
      const wsNew = new MockWebSocket();
      internalSockets.set(0, wsNew as unknown as WebSocket);
      await claimMethod.call(room, 0, 'FirefoxPlayer');

      // Now old host socket fires disconnect
      const disconnectMethod = Reflect.get(room, 'handleSocketDisconnect') as (
        slot: number,
        ws: WebSocket
      ) => Promise<void>;

      await disconnectMethod.call(room, 0, wsHost as unknown as WebSocket);

      // Active socket must remain intact
      expect(internalSockets.get(0)).toBe(wsNew as unknown as WebSocket);
      const roomState = Reflect.get(room, 'state') as { joinedHumans: Record<number, { name: string }> };
      expect(roomState.joinedHumans[0]).toBeDefined();
      expect(roomState.joinedHumans[0].name).toBe('FirefoxPlayer');
    });
  });

  describe('Combat turn authority and FIRE handling', () => {
    let ws0: MockWebSocket;
    let ws1: MockWebSocket;

    beforeEach(async () => {
      const payload = {
        roomId: 'room-combat',
        numPlayers: 2,
        slotConfigs: [{ type: 'human' }, { type: 'human' }],
        origin: 'http://localhost:5173',
      };
      const req = new Request('http://localhost/api/room', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      await room.fetchCreate(req);

      ws0 = new MockWebSocket();
      ws1 = new MockWebSocket();
      const internalSockets = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
      internalSockets.set(0, ws0 as unknown as WebSocket);
      internalSockets.set(1, ws1 as unknown as WebSocket);

      const claimMethod = Reflect.get(room, 'claimHumanSlot') as (s: number, n: string) => Promise<void>;
      await claimMethod.call(room, 0, 'Alice');
      await claimMethod.call(room, 1, 'Bob');
    });

    it('accepts FIRE command from active player (slot 0) and broadcasts SHOT', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;

      const fireMsg = {
        type: 'FIRE',
        actionId: crypto.randomUUID(),
        command: { angle: 45, power: 60, weaponId: 'MISSILE' as WeaponId },
      };

      await handleClientMessage.call(room, 0, JSON.stringify(fireMsg));

      const shotMsg0 = ws0.getAllMessages<{ type: string; slot: number; command: { angle: number } }>().find(
        (m) => m.type === 'SHOT'
      );
      const shotMsg1 = ws1.getAllMessages<{ type: string; slot: number; command: { angle: number } }>().find(
        (m) => m.type === 'SHOT'
      );

      expect(shotMsg0).toBeDefined();
      expect(shotMsg1).toBeDefined();
      expect(shotMsg0?.slot).toBe(0);
      expect(shotMsg0?.command.angle).toBe(45);
    });

    it('accepts a main-era REQUEST_GAME_START and sends catch-up', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;
      await handleClientMessage.call(
        room,
        0,
        JSON.stringify({ type: 'REQUEST_GAME_START' }),
      );
      const types = ws0.getAllMessages<{ type: string }>().map((message) => message.type);
      expect(types).toContain('GAME_START');
      expect(types).toContain('SHOT_CATCH_UP');
      expect(types).not.toContain('PROTOCOL_MISMATCH');
      expect(ws0.closeCode).toBeUndefined();
    });

    it('accepts a main-era FIRE without actionId', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;
      await handleClientMessage.call(
        room,
        0,
        JSON.stringify({
          type: 'FIRE',
          command: { angle: 45, power: 50, weaponId: 'MISSILE' },
        }),
      );
      const shot = ws0
        .getAllMessages<{ type: string; actionId?: string }>()
        .find((message) => message.type === 'SHOT');
      expect(shot?.actionId).toMatch(/^v0-fire-/);
      expect(ws0.closeCode).toBeUndefined();
    });

    it('closes only an unsupported numeric protocol version with 4402', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'REQUEST_GAME_START',
        protocolVersion: 99,
      }));
      expect(
        ws0.getAllMessages<{ type: string }>().some((m) => m.type === 'PROTOCOL_MISMATCH'),
      ).toBe(true);
      expect(ws0.closeCode).toBe(4402);
    });

    it('accepts REQUEST_GAME_START with protocolVersion 1 and still sends catch-up', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;
      ws0.sent.length = 0;
      await handleClientMessage.call(
        room,
        0,
        JSON.stringify({
          type: 'REQUEST_GAME_START',
          protocolVersion: 1,
          roundNumber: 1,
          lastSeenShotId: 0,
          lastAppliedShopEpoch: 0,
        }),
      );
      expect(ws0.closeCode).toBeUndefined();
      const types = ws0.getAllMessages<{ type: string }>().map((m) => m.type);
      expect(types).toContain('SHOT_CATCH_UP');
      expect(types).toContain('GAME_START');
    });

    it.each([
      {
        weaponId: 'MISSILE' as const,
        inventory: {},
        expectedStock: undefined,
        expectedWeapon: 'MISSILE' as const,
      },
      {
        weaponId: 'GRENADE' as const,
        inventory: { GRENADE: 2 },
        expectedStock: 1,
        expectedWeapon: 'GRENADE' as const,
      },
      {
        weaponId: 'NUKE' as const,
        inventory: { NUKE: 1 },
        expectedStock: 0,
        expectedWeapon: 'MISSILE' as const,
      },
      {
        weaponId: 'THERMONUCLEAR' as const,
        inventory: { THERMONUCLEAR: 1 },
        expectedStock: 0,
        expectedWeapon: 'MISSILE' as const,
      },
    ])('validates and consumes $weaponId atomically in executeFire', async ({
      weaponId,
      inventory,
      expectedStock,
      expectedWeapon,
    }) => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string,
      ) => Promise<void>;
      const state = Reflect.get(room, 'state') as { players: Player[] };
      state.players[0].inventory = inventory;

      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'FIRE',
        actionId: `fire-matrix-${weaponId}`,
        command: { angle: 45, power: 60, weaponId },
      }));

      expect(
        ws0.getAllMessages<ShotMessage>().find(
          (message) =>
            message.type === 'SHOT' && message.command.weaponId === weaponId,
        ),
      ).toBeDefined();
      expect(state.players[0].inventory[weaponId]).toBe(expectedStock);
      expect(state.players[0].tank.currentWeapon).toBe(expectedWeapon);
    });

    it.each([
      {
        weaponId: 'GRENADE' as const,
        inventory: {},
        reason: 'NO_AMMO',
      },
      {
        weaponId: 'NUKE' as const,
        inventory: { NUKE: 3 },
        reason: 'ILLEGAL_INVENTORY',
      },
    ])('rejects $weaponId with $reason without mutation', async ({
      weaponId,
      inventory,
      reason,
    }) => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string,
      ) => Promise<void>;
      const state = Reflect.get(room, 'state') as { players: Player[] };
      state.players[0].inventory = inventory;
      const before = structuredClone(state.players[0]);

      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'FIRE',
        actionId: `fire-rejected-${weaponId}`,
        command: { angle: 45, power: 60, weaponId },
      }));

      expect(state.players[0]).toEqual(before);
      expect(
        ws0.getAllMessages<{ type: string; reason?: string }>().find(
          (message) =>
            message.type === 'FIRE_REJECTED' && message.reason === reason,
        ),
      ).toBeDefined();
      expect(
        ws0.getAllMessages<{ type: string }>().find(
          (message) => message.type === 'SHOT',
        ),
      ).toBeUndefined();
    });

    it('consumes the last ammo once and keeps an accepted FIRE idempotent', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;
      const state = Reflect.get(room, 'state') as {
        players: Player[];
      };
      state.players[0].inventory = { GRENADE: 1 };
      state.players[0].tank.currentWeapon = 'GRENADE';
      const fire = {
        type: 'FIRE',
        actionId: 'stable-fire-action',
        command: { angle: 45, power: 60, weaponId: 'GRENADE' },
      };

      await handleClientMessage.call(room, 0, JSON.stringify(fire));
      await handleClientMessage.call(room, 0, JSON.stringify(fire));

      const shooterShots = ws0
        .getAllMessages<{ type: string; actionId?: string; shotId?: number }>()
        .filter((message) => message.type === 'SHOT' && message.actionId === fire.actionId);
      const observerShots = ws1
        .getAllMessages<{ type: string; actionId?: string }>()
        .filter((message) => message.type === 'SHOT' && message.actionId === fire.actionId);
      expect(shooterShots).toHaveLength(2);
      expect(observerShots).toHaveLength(1);
      expect(shooterShots[0].shotId).toBe(shooterShots[1].shotId);
      expect(state.players[0].inventory.GRENADE).toBe(0);
      expect(state.players[0].tank.currentWeapon).toBe('MISSILE');

      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOT_SETTLED',
        shotId: shooterShots[0].shotId,
        slot: 0,
        deadSlots: [false, false],
      }));
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOT_EARNINGS',
        shotId: shooterShots[0].shotId,
        authorityEpoch: 1,
        awards: [],
        deadSlots: [false, false],
        directHitVictimIds: [],
        roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
      }));
      ws0.sent.length = 0;
      ws1.sent.length = 0;
      const currentPlayerIndex = (
        Reflect.get(room, 'state') as { currentPlayerIndex: number }
      ).currentPlayerIndex;

      await handleClientMessage.call(room, 0, JSON.stringify(fire));
      const retriedShots = ws0
        .getAllMessages<{ type: string; shotId?: number }>()
        .filter((message) => message.type === 'SHOT');
      expect(retriedShots).toHaveLength(1);
      expect(retriedShots[0].shotId).toBe(shooterShots[0].shotId);
      expect(
        ws1.getAllMessages<{ type: string }>().filter((message) => message.type === 'SHOT'),
      ).toHaveLength(0);
      expect(state.players[0].inventory.GRENADE).toBe(0);
      expect(
        (Reflect.get(room, 'state') as { currentPlayerIndex: number }).currentPlayerIndex,
      ).toBe(currentPlayerIndex);
    });

    it('isolates identical FIRE actionIds by slot', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string,
      ) => Promise<void>;
      const actionId = 'shared-fire-action';

      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'FIRE',
        actionId,
        command: { angle: 45, power: 60, weaponId: 'MISSILE' },
      }));
      const firstShot = ws0
        .getAllMessages<ShotMessage>()
        .find((message) => message.type === 'SHOT' && message.actionId === actionId);
      expect(firstShot).toBeDefined();

      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOT_SETTLED',
        shotId: firstShot?.shotId,
        slot: 0,
        deadSlots: [false, false],
      }));
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOT_EARNINGS',
        shotId: firstShot?.shotId,
        authorityEpoch: 1,
        awards: [],
        deadSlots: [false, false],
        directHitVictimIds: [],
        roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
      }));

      await handleClientMessage.call(room, 1, JSON.stringify({
        type: 'FIRE',
        actionId,
        command: { angle: 135, power: 55, weaponId: 'MISSILE' },
      }));
      const secondShot = ws1
        .getAllMessages<ShotMessage>()
        .find(
          (message) =>
            message.type === 'SHOT' &&
            message.actionId === actionId &&
            message.slot === 1,
        );

      expect(secondShot).toBeDefined();
      expect(secondShot?.shotId).not.toBe(firstShot?.shotId);
      const state = Reflect.get(room, 'state') as {
        processedFireActionsBySlot: Record<number, Record<string, { result: ShotMessage }>>;
      };
      expect(state.processedFireActionsBySlot[0][actionId].result).toMatchObject({
        type: 'SHOT',
        slot: 0,
      });
      expect(state.processedFireActionsBySlot[1][actionId].result).toMatchObject({
        type: 'SHOT',
        slot: 1,
      });
    });

    it('migrates the legacy global FIRE index on cold start and persists only the per-slot format', async () => {
      const setup = createMockCtx();
      const initialRoom = new GameRoom(setup.ctx as DurableObjectState, {});
      Object.defineProperty(initialRoom, 'ctx', { value: setup.ctx, writable: true });
      await initialRoom.fetchCreate(
        new Request('http://localhost/api/room', {
          method: 'POST',
          body: JSON.stringify({
            roomId: 'room-fire-migration',
            numPlayers: 2,
            slotConfigs: [{ type: 'human' }, { type: 'human' }],
            origin: 'http://localhost:5173',
          }),
        }),
      );
      const claimMethod = Reflect.get(initialRoom, 'claimHumanSlot') as (
        slot: number,
        name: string,
      ) => Promise<void>;
      await claimMethod.call(initialRoom, 0, 'Alice');
      await claimMethod.call(initialRoom, 1, 'Bob');

      interface MigratingFireState {
        processedFireActionsBySlot?: Record<number, Record<string, unknown>>;
        processedFireActions?: Record<string, unknown>;
        lastFireResultBySlot?: Record<number, unknown>;
      }
      const persisted = structuredClone(
        setup.mockStorage.storageData.get('state'),
      ) as MigratingFireState;
      persisted.processedFireActions = {
        'legacy-accepted-action': {
          slot: 1,
          result: {
            type: 'SHOT',
            actionId: 'legacy-accepted-action',
            shotId: 4,
            roundNumber: 1,
            shotNumberInRound: 4,
            isFirstShotOfRound: false,
            slot: 1,
            ownerId: 'player-2',
            command: { angle: 135, power: 50, weaponId: 'MISSILE' },
          },
        },
        'legacy-rejected-action': {
          slot: 1,
          result: {
            type: 'FIRE_REJECTED',
            actionId: 'legacy-rejected-action',
            reason: 'NO_AMMO',
            inventory: {},
            currentWeapon: 'MISSILE',
          },
        },
      };
      persisted.lastFireResultBySlot = {
        0: {
          type: 'SHOT',
          actionId: 'old-shot-result',
          shotId: 3,
          roundNumber: 1,
          shotNumberInRound: 3,
          isFirstShotOfRound: false,
          slot: 0,
          ownerId: 'player-1',
          command: { angle: 45, power: 50, weaponId: 'MISSILE' },
        },
        1: {
          type: 'FIRE_REJECTED',
          actionId: 'last-rejected-action',
          reason: 'NOT_YOUR_TURN',
          inventory: {},
          currentWeapon: 'MISSILE',
        },
      };
      delete persisted.processedFireActionsBySlot;
      setup.mockStorage.storageData.set('state', persisted);

      const restoredRoom = new GameRoom(setup.ctx as DurableObjectState, {});
      Object.defineProperty(restoredRoom, 'ctx', { value: setup.ctx, writable: true });
      const initialization = (
        setup.ctx as {
          blockConcurrencyWhile: ReturnType<typeof vi.fn>;
        }
      ).blockConcurrencyWhile.mock.results.at(-1)?.value;
      if (initialization instanceof Promise) await initialization;

      const restoredState = Reflect.get(restoredRoom, 'state') as MigratingFireState;
      expect(restoredState.processedFireActions).toBeUndefined();
      expect(
        restoredState.processedFireActionsBySlot?.[1]?.['legacy-accepted-action'],
      ).toBeDefined();
      expect(
        restoredState.processedFireActionsBySlot?.[1]?.['legacy-rejected-action'],
      ).toBeUndefined();
      expect(restoredState.lastFireResultBySlot?.[0]).toBeUndefined();
      expect(restoredState.lastFireResultBySlot?.[1]).toMatchObject({
        type: 'FIRE_REJECTED',
        actionId: 'last-rejected-action',
      });
      const rePersisted = setup.mockStorage.storageData.get(
        'state',
      ) as MigratingFireState;
      expect(rePersisted.processedFireActions).toBeUndefined();
      expect(rePersisted.processedFireActionsBySlot).toBeDefined();
    });

    it('rejects FIRE command from inactive player (slot 1 while turn is slot 0)', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;

      const fireMsg = {
        type: 'FIRE',
        actionId: crypto.randomUUID(),
        command: { angle: 45, power: 60, weaponId: 'MISSILE' as WeaponId },
      };

      // Player 1 tries to fire on Player 0's turn
      await handleClientMessage.call(room, 1, JSON.stringify(fireMsg));

      const shotMsg = ws0.getAllMessages<{ type: string }>().find((m) => m.type === 'SHOT');
      expect(shotMsg).toBeUndefined();
    });

    it('keeps only the latest FIRE rejection per slot', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string,
      ) => Promise<void>;
      const command = { angle: 45, power: 60, weaponId: 'MISSILE' };

      await handleClientMessage.call(room, 1, JSON.stringify({
        type: 'FIRE',
        actionId: 'rejected-fire-1',
        command,
      }));
      await handleClientMessage.call(room, 1, JSON.stringify({
        type: 'FIRE',
        actionId: 'rejected-fire-2',
        command,
      }));

      const state = Reflect.get(room, 'state') as {
        processedFireActionsBySlot: Record<number, Record<string, unknown>>;
        lastFireResultBySlot: Record<number, { actionId?: string; reason: string }>;
      };
      expect(Object.keys(state.processedFireActionsBySlot[1] ?? {})).toHaveLength(0);
      expect(state.lastFireResultBySlot[1]).toMatchObject({
        actionId: 'rejected-fire-2',
        reason: 'NOT_YOUR_TURN',
      });

      await handleClientMessage.call(room, 1, JSON.stringify({
        type: 'FIRE',
        actionId: 'rejected-fire-2',
        command,
      }));
      expect(
        ws1
          .getAllMessages<{ type: string; actionId?: string }>()
          .filter(
            (message) =>
              message.type === 'FIRE_REJECTED' &&
              message.actionId === 'rejected-fire-2',
          ),
      ).toHaveLength(2);

      await handleClientMessage.call(room, 1, JSON.stringify({
        type: 'FIRE',
        actionId: 'x'.repeat(65),
        command,
      }));
      expect(state.lastFireResultBySlot[1].actionId).toBe('rejected-fire-2');
      expect(
        ws1.getLastMessage<{ type: string; actionId?: string; reason?: string }>(),
      ).toMatchObject({ type: 'FIRE_REJECTED', reason: 'MALFORMED' });
      expect(
        ws1.getLastMessage<{ actionId?: string }>()?.actionId,
      ).toBeUndefined();
    });

    it('lets a refreshed shooter settle the active shot without consuming ammo twice', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string,
      ) => Promise<void>;
      const state = Reflect.get(room, 'state') as {
        players: Player[];
        activeShot: { shotId: number; shooterSettled: boolean } | null;
        currentPlayerIndex: number;
      };
      state.players[0].inventory = { GRENADE: 1 };
      state.players[0].tank.currentWeapon = 'GRENADE';

      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'FIRE',
        actionId: 'refresh-mid-shot',
        command: { angle: 45, power: 60, weaponId: 'GRENADE' },
      }));
      const shot = ws0
        .getAllMessages<ShotMessage>()
        .find(
          (message) =>
            message.type === 'SHOT' && message.actionId === 'refresh-mid-shot',
        );
      expect(shot).toBeDefined();
      expect(state.players[0].inventory.GRENADE).toBe(0);

      ws0.sent.length = 0;
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'REQUEST_GAME_START',
        protocolVersion: 1,
        roundNumber: 1,
        lastSeenShotId: shot?.shotId,
        lastAppliedShopEpoch: 0,
      }));
      const catchUp = ws0
        .getAllMessages<{
          type: string;
          activeShotId?: number | null;
          shots?: ShotMessage[];
        }>()
        .find((message) => message.type === 'SHOT_CATCH_UP');
      expect(catchUp?.activeShotId).toBe(shot?.shotId);
      expect(catchUp?.shots?.map((message) => message.shotId)).toContain(
        shot?.shotId,
      );
      expect(state.players[0].inventory.GRENADE).toBe(0);

      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOT_SETTLED',
        shotId: shot?.shotId,
        slot: 0,
        deadSlots: [false, false],
      }));
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOT_EARNINGS',
        shotId: shot?.shotId,
        authorityEpoch: 1,
        awards: [],
        deadSlots: [false, false],
        directHitVictimIds: [],
        roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
      }));

      expect(state.activeShot).toBeNull();
      expect(state.currentPlayerIndex).toBe(1);
      expect(state.players[0].inventory.GRENADE).toBe(0);
    });

    it('advances turn to slot 1 after receiving SHOT_SETTLED from shooting slot 0', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;

      // 1. Slot 0 fires
      await handleClientMessage.call(
        room,
        0,
        JSON.stringify({
          type: 'FIRE',
          actionId: crypto.randomUUID(),
          command: { angle: 50, power: 70, weaponId: 'MISSILE' },
        })
      );

      const shot = ws0.getAllMessages<{ type: string; shotId: number }>().find((m) => m.type === 'SHOT');
      expect(shot).toBeDefined();
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOT_SETTLED', shotId: shot?.shotId, slot: 0, deadSlots: [false, false],
      }));
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOT_EARNINGS',
        shotId: shot?.shotId,
        authorityEpoch: 1,
        awards: [],
        deadSlots: [false, false],
        directHitVictimIds: [],
        roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
      }));

      const stateUpdate = ws0.getAllMessages<{ type: string; currentPlayerIndex: number }>().find(
        (m) => m.type === 'STATE_UPDATE',
      );

      expect(stateUpdate).toBeDefined();
      expect(stateUpdate?.currentPlayerIndex).toBe(1);

      const roomState = Reflect.get(room, 'state') as { currentPlayerIndex: number };
      expect(roomState.currentPlayerIndex).toBe(1);
    });

    it('rejects FIRE intent sent by earnings authority during an AI turn', async () => {
      const setup = createMockCtx();
      const aiRoom = new GameRoom(setup.ctx as DurableObjectState, {});
      Object.defineProperty(aiRoom, 'ctx', { value: setup.ctx, writable: true });
      await aiRoom.fetchCreate(
        new Request('http://localhost/api/room', {
          method: 'POST',
          body: JSON.stringify({
            roomId: 'room-ai-fire-guard',
            numPlayers: 2,
            slotConfigs: [{ type: 'human' }, { type: 'ai', aiProfile: 'v4-smart' }],
            origin: 'http://localhost:5173',
          }),
        }),
      );
      const wsHuman = new MockWebSocket();
      const internalSockets = Reflect.get(aiRoom, 'sockets') as Map<number, WebSocket>;
      internalSockets.set(0, wsHuman as unknown as WebSocket);

      const claimMethod = Reflect.get(aiRoom, 'claimHumanSlot') as (s: number, n: string) => Promise<void>;
      await claimMethod.call(aiRoom, 0, 'Alice');

      const handleClientMessage = Reflect.get(aiRoom, 'handleClientMessage') as (
        slot: number,
        raw: string,
      ) => Promise<void>;

      // 1. Human (slot 0) fires and settles their shot to pass turn to AI (slot 1)
      await handleClientMessage.call(
        aiRoom,
        0,
        JSON.stringify({
          type: 'FIRE',
          actionId: 'human-fire-1',
          command: { angle: 45, power: 50, weaponId: 'MISSILE' },
        }),
      );
      const shot = wsHuman.getAllMessages<{ type: string; shotId: number }>().find((m) => m.type === 'SHOT');
      await handleClientMessage.call(
        aiRoom,
        0,
        JSON.stringify({
          type: 'SHOT_SETTLED',
          shotId: shot?.shotId,
          slot: 0,
          deadSlots: [false, false],
        }),
      );
      await handleClientMessage.call(
        aiRoom,
        0,
        JSON.stringify({
          type: 'SHOT_EARNINGS',
          shotId: shot?.shotId,
          authorityEpoch: 1,
          awards: [],
          deadSlots: [false, false],
          directHitVictimIds: [],
          roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
        }),
      );

      const aiState = Reflect.get(aiRoom, 'state') as { currentPlayerIndex: number; earningsAuthoritySlot: number; players: Player[] };
      expect(aiState.currentPlayerIndex).toBe(1);
      expect(aiState.earningsAuthoritySlot).toBe(0);

      // 2. Human tries to fire on AI's turn (slot 1) using NUKE
      aiState.players[1].inventory = { NUKE: 1 };
      wsHuman.sent.length = 0;
      await handleClientMessage.call(
        aiRoom,
        0,
        JSON.stringify({
          type: 'FIRE',
          actionId: 'spoofed-ai-fire',
          command: { angle: 30, power: 80, weaponId: 'NUKE' },
        }),
      );

      const rejection = wsHuman
        .getAllMessages<{ type: string; reason?: string; actionId?: string }>()
        .find((m) => m.type === 'FIRE_REJECTED');
      expect(rejection).toBeDefined();
      expect(rejection?.reason).toBe('NOT_YOUR_TURN');
      expect(rejection?.actionId).toBe('spoofed-ai-fire');
      expect(aiState.players[1].inventory.NUKE).toBe(1);
    });
  });

  describe('Parallel Shop Synchronization', () => {
    let ws0: MockWebSocket;
    let ws1: MockWebSocket;

    beforeEach(async () => {
      const payload = {
        roomId: 'room-shop',
        numPlayers: 2,
        slotConfigs: [{ type: 'human' }, { type: 'human' }],
        origin: 'http://localhost:5173',
      };
      const req = new Request('http://localhost/api/room', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      await room.fetchCreate(req);

      ws0 = new MockWebSocket();
      ws1 = new MockWebSocket();
      const internalSockets = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
      internalSockets.set(0, ws0 as unknown as WebSocket);
      internalSockets.set(1, ws1 as unknown as WebSocket);

      const claimMethod = Reflect.get(room, 'claimHumanSlot') as (s: number, n: string) => Promise<void>;
      await claimMethod.call(room, 0, 'Alice');
      await claimMethod.call(room, 1, 'Bob');
      const state = Reflect.get(room, 'state') as { roundEnded: boolean };
      state.roundEnded = true;
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOP_ENTER',
        roundNumber: 1,
      }));
    });

    it('synchronizes SHOP_BUY_SELL without clobbering other players', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;

      // Slot 0 purchases a grenade; no client-owned roster is accepted.
      await handleClientMessage.call(
        room,
        0,
        JSON.stringify({
          type: 'SHOP_BUY_SELL',
          shopEpoch: 1,
          actionId: 'shop-buy-1',
          weaponId: 'GRENADE',
          delta: 1,
        })
      );

      const buyMsg = ws1.getAllMessages<{
        type: string;
        players: Array<{ id: string; money: number }>;
        acknowledgedAction?: { slot: number; actionId: string };
      }>().find(
        (m) => m.type === 'SHOP_STATE' && m.players.some((player) => player.money === 175)
      );

      expect(buyMsg).toBeDefined();
      expect(buyMsg?.players.find((p) => p.id === 'player-1')?.money).toBe(175);
      expect(buyMsg?.acknowledgedAction).toEqual({
        slot: 0,
        actionId: 'shop-buy-1',
      });
    });

    it('normalizes legacy shop actions and ignores forged non-economic snapshot fields', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string,
      ) => Promise<void>;
      const state = Reflect.get(room, 'state') as {
        players: Player[];
        shopSession: { readySlots: number[] } | null;
      };
      const authoritative = state.players[0];
      const legacySnapshot = {
        ...authoritative,
        name: 'Nom falsifié ignoré',
        money: authoritative.money - 75,
        inventory: {
          ...authoritative.inventory,
          GRENADE: (authoritative.inventory.GRENADE ?? 0) + 1,
        },
        tank: {
          ...authoritative.tank,
          health: 9_999,
        },
      };

      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOP_BUY_SELL',
        slot: 0,
        player: legacySnapshot,
      }));

      expect(state.players[0].money).toBe(authoritative.money - 75);
      expect(state.players[0].inventory.GRENADE).toBe(
        (authoritative.inventory.GRENADE ?? 0) + 1,
      );
      expect(state.players[0].name).toBe(authoritative.name);
      expect(state.players[0].tank.health).toBe(authoritative.tank.health);

      const moneyAfterValidTransaction = state.players[0].money;
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOP_BUY_SELL',
        slot: 0,
        player: {
          ...state.players[0],
          money: 999_999,
        },
      }));
      expect(state.players[0].money).toBe(moneyAfterValidTransaction);
      expect(
        ws0.getAllMessages<{ type: string; reason?: string }>().find(
          (message) =>
            message.type === 'SHOP_REJECTED' && message.reason === 'MALFORMED',
        ),
      ).toBeDefined();

      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOP_READY',
        players: state.players,
      }));
      expect(state.shopSession?.readySlots).toContain(0);

      await handleClientMessage.call(room, 1, JSON.stringify({
        type: 'SHOP_ADVANCE',
        nextIndex: 0,
      }));
      expect(state.shopSession).toBeNull();
      expect(ws0.closeCode).toBeUndefined();
    });

    it('does not persist malformed BUY_SELL while keeping READY idempotent', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string,
      ) => Promise<void>;
      const actionId = 'shared-shop-kind-action';

      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOP_BUY_SELL',
        shopEpoch: 1,
        actionId,
        delta: 1,
      }));
      expect(
        ws0
          .getAllMessages<{ type: string; actionId?: string; reason?: string }>()
          .find(
            (message) =>
              message.type === 'SHOP_REJECTED' && message.actionId === actionId,
          ),
      ).toMatchObject({ reason: 'MALFORMED' });

      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOP_READY',
        shopEpoch: 1,
        actionId,
      }));

      const state = Reflect.get(room, 'state') as {
        shopSession: { readySlots: number[] } | null;
        processedShopActions: Record<string, unknown>;
      };
      expect(state.shopSession?.readySlots).toContain(0);
      expect(state.processedShopActions).not.toHaveProperty(`BUY_SELL:0:${actionId}`);
      expect(state.processedShopActions).toHaveProperty(`READY:0:${actionId}`);
    });

    it('applies parallel purchases and retries each action exactly once', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;
      const buy0 = {
        type: 'SHOP_BUY_SELL',
        shopEpoch: 1,
        actionId: 'parallel-buy-0',
        weaponId: 'GRENADE',
        delta: 1,
      };
      const buy1 = {
        type: 'SHOP_BUY_SELL',
        shopEpoch: 1,
        actionId: 'parallel-buy-1',
        weaponId: 'DRILLER',
        delta: 1,
      };

      await handleClientMessage.call(room, 0, JSON.stringify(buy0));
      await handleClientMessage.call(room, 1, JSON.stringify(buy1));
      await handleClientMessage.call(room, 0, JSON.stringify(buy0));

      const state = Reflect.get(room, 'state') as { players: Player[] };
      expect(state.players[0]).toMatchObject({
        money: 175,
        inventory: { GRENADE: 3 },
      });
      expect(state.players[1]).toMatchObject({
        money: 160,
        inventory: { DRILLER: 1 },
      });
    });

    it('returns up-to-date SHOP_STATE on SHOP_BUY_SELL retry when intermediate purchases occurred', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string,
      ) => Promise<void>;

      // 1. Slot 0 buys GRENADE
      const buy0 = {
        type: 'SHOP_BUY_SELL',
        shopEpoch: 1,
        actionId: 'action-buy-alice',
        weaponId: 'GRENADE',
        delta: 1,
      };
      await handleClientMessage.call(room, 0, JSON.stringify(buy0));

      // 2. Slot 1 buys DRILLER
      const buy1 = {
        type: 'SHOP_BUY_SELL',
        shopEpoch: 1,
        actionId: 'action-buy-bob',
        weaponId: 'DRILLER',
        delta: 1,
      };
      await handleClientMessage.call(room, 1, JSON.stringify(buy1));

      // 3. Slot 0 retries their initial buy0
      ws0.sent.length = 0;
      await handleClientMessage.call(room, 0, JSON.stringify(buy0));

      const responses = ws0.getAllMessages<{
        type: string;
        players?: Array<{ id: string; money: number; inventory: Record<string, number> }>;
      }>();
      const retryState = responses.find((m) => m.type === 'SHOP_STATE');
      expect(retryState).toBeDefined();

      // The retry must contain Bob's purchase (money 160, driller 1), not a stale snapshot from before Bob bought!
      const bobInRetry = retryState?.players?.find((p) => p.id === 'player-2');
      expect(bobInRetry?.money).toBe(160);
      expect(bobInRetry?.inventory?.DRILLER).toBe(1);
    });

    it('distinguishes composite idempotency keys across action kinds and slots', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string,
      ) => Promise<void>;

      const sharedActionId = 'shared-action-123';

      // 1. Slot 0 executes a BUY_SELL with sharedActionId
      await handleClientMessage.call(
        room,
        0,
        JSON.stringify({
          type: 'SHOP_BUY_SELL',
          shopEpoch: 1,
          actionId: sharedActionId,
          weaponId: 'GRENADE',
          delta: 1,
        }),
      );

      // 2. Slot 0 executes a SHOP_READY with the same sharedActionId — must be treated as READY, not as a duplicate BUY_SELL
      ws0.sent.length = 0;
      await handleClientMessage.call(
        room,
        0,
        JSON.stringify({
          type: 'SHOP_READY',
          shopEpoch: 1,
          actionId: sharedActionId,
        }),
      );

      const state = Reflect.get(room, 'state') as {
        shopSession: { readySlots: number[] } | null;
      };
      expect(state.shopSession?.readySlots).toContain(0);

      // 3. Slot 1 attempts to use the same actionId on BUY_SELL from another slot — must be processed or isolated per slot
      await handleClientMessage.call(
        room,
        1,
        JSON.stringify({
          type: 'SHOP_BUY_SELL',
          shopEpoch: 1,
          actionId: sharedActionId,
          weaponId: 'DRILLER',
          delta: 1,
        }),
      );

      const stateAfter = Reflect.get(room, 'state') as { players: Player[] };
      expect(stateAfter.players[1].inventory.DRILLER).toBe(1);
    });

    it('rejects a stale shop epoch without mutating the roster', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;
      const state = Reflect.get(room, 'state') as { players: Player[] };
      const before = state.players[0].money;

      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOP_BUY_SELL',
        shopEpoch: 0,
        actionId: 'stale-buy',
        weaponId: 'GRENADE',
        delta: 1,
      }));

      expect(state.players[0].money).toBe(before);
      expect(
        ws0.getAllMessages<{ type: string; reason?: string }>().find(
          (message) =>
            message.type === 'SHOP_REJECTED' &&
            message.reason === 'STALE_SHOP_EPOCH',
        ),
      ).toBeDefined();
    });

    it('normalizes and shops for AI exactly once when the session opens', async () => {
      const setup = createMockCtx();
      const aiRoom = new GameRoom(setup.ctx as DurableObjectState, {});
      Object.defineProperty(aiRoom, 'ctx', { value: setup.ctx, writable: true });
      await aiRoom.fetchCreate(
        new Request('http://localhost/api/room', {
          method: 'POST',
          body: JSON.stringify({
            roomId: 'room-ai-shop-once',
            numPlayers: 2,
            slotConfigs: [
              { type: 'human' },
              { type: 'ai', aiProfile: 'v4-smart' },
            ],
            origin: 'http://localhost:5173',
          }),
        }),
      );
      const socket = new MockWebSocket();
      const sockets = Reflect.get(aiRoom, 'sockets') as Map<number, WebSocket>;
      sockets.set(0, socket as unknown as WebSocket);
      const claim = Reflect.get(aiRoom, 'claimHumanSlot') as (
        slot: number,
        name: string,
      ) => Promise<void>;
      await claim.call(aiRoom, 0, 'Alice');
      const state = Reflect.get(aiRoom, 'state') as {
        shopEpoch: number;
        roundEnded: boolean;
        players: Player[];
        shopSession: {
          shopEpoch: number;
          purchasesByPlayerId: Record<string, Record<string, number>>;
        } | null;
      };
      state.roundEnded = true;
      state.players[1].money = 1_000;
      state.players[1].inventory = { NUKE: 9 };
      const expectedAutoBuy = autoBuyForAI(
        normalizeInventoryAtShopOpen(state.players[1]),
        2,
        {},
      );
      const handle = Reflect.get(aiRoom, 'handleClientMessage') as (
        slot: number,
        raw: string,
      ) => Promise<void>;

      await handle.call(aiRoom, 0, JSON.stringify({
        type: 'SHOP_ENTER',
        roundNumber: 1,
      }));
      expect(state.players[1]).toEqual(expectedAutoBuy.player);
      expect(state.shopSession?.purchasesByPlayerId).toEqual(
        expectedAutoBuy.counters,
      );
      const afterFirst = {
        shopEpoch: state.shopEpoch,
        sessionEpoch: state.shopSession?.shopEpoch,
        money: state.players[1].money,
        inventory: { ...state.players[1].inventory },
        counters: JSON.stringify(state.shopSession?.purchasesByPlayerId ?? {}),
      };
      await handle.call(aiRoom, 0, JSON.stringify({
        type: 'SHOP_ENTER',
        roundNumber: 1,
      }));

      expect(state.shopEpoch).toBe(afterFirst.shopEpoch);
      expect(state.shopSession?.shopEpoch).toBe(afterFirst.sessionEpoch);
      expect(state.players[1].money).toBe(afterFirst.money);
      expect(state.players[1].inventory).toEqual(afterFirst.inventory);
      expect(JSON.stringify(state.shopSession?.purchasesByPlayerId ?? {})).toBe(
        afterFirst.counters,
      );
      expect(state.players[1].inventory.NUKE).toBeLessThanOrEqual(2);

      const restoredRoom = new GameRoom(setup.ctx as DurableObjectState, {});
      Object.defineProperty(restoredRoom, 'ctx', {
        value: setup.ctx,
        writable: true,
      });
      await Promise.resolve();
      await Promise.resolve();
      const restoredState = Reflect.get(restoredRoom, 'state') as typeof state;
      const restoredHandle = Reflect.get(
        restoredRoom,
        'handleClientMessage',
      ) as (slot: number, raw: string) => Promise<void>;

      await restoredHandle.call(restoredRoom, 0, JSON.stringify({
        type: 'SHOP_ENTER',
        roundNumber: 1,
      }));

      expect(restoredState.shopEpoch).toBe(afterFirst.shopEpoch);
      expect(restoredState.players[1].money).toBe(afterFirst.money);
      expect(restoredState.players[1].inventory).toEqual(afterFirst.inventory);
      expect(
        JSON.stringify(restoredState.shopSession?.purchasesByPlayerId ?? {}),
      ).toBe(afterFirst.counters);
    });

    it('broadcasts SHOP_FINISH only when all human slots have sent SHOP_READY', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;

      // Player 0 is ready
      await handleClientMessage.call(
        room,
        0,
        JSON.stringify({
          type: 'SHOP_READY',
          shopEpoch: 1,
          actionId: 'ready-0',
        })
      );

      let shopFinish = ws0.getAllMessages<{ type: string }>().find((m) => m.type === 'SHOP_FINISH');
      expect(shopFinish).toBeUndefined(); // Player 1 is not ready yet

      // Player 1 is ready
      await handleClientMessage.call(
        room,
        1,
        JSON.stringify({
          type: 'SHOP_READY',
          shopEpoch: 1,
          actionId: 'ready-1',
        })
      );

      shopFinish = ws0.getAllMessages<{ type: string }>().find((m) => m.type === 'SHOP_FINISH');
      expect(shopFinish).toBeDefined();
      const persistedAfterFinish = Reflect.get(room, 'state') as {
        roundEnded: boolean;
        processedShopActions: Record<string, unknown>;
      };
      expect(Object.keys(persistedAfterFinish.processedShopActions)).toEqual([
        'READY:1:ready-1',
      ]);

      ws0.sent.length = 0;
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'REQUEST_GAME_START',
        protocolVersion: 1,
        roundNumber: 2,
        lastSeenShotId: 0,
        lastAppliedShopEpoch: 0,
      }));
      const catchUpTypes = ws0
        .getAllMessages<{ type: string }>()
        .map((message) => message.type);
      expect(catchUpTypes).toContain('SHOT_CATCH_UP');
      expect(catchUpTypes).toContain('SHOP_FINISH');
      expect(catchUpTypes.indexOf('SHOT_CATCH_UP')).toBeLessThan(
        catchUpTypes.indexOf('SHOP_FINISH'),
      );

      ws1.sent.length = 0;
      await handleClientMessage.call(room, 1, JSON.stringify({
        type: 'SHOP_READY',
        shopEpoch: 1,
        actionId: 'ready-1',
      }));
      expect(
        ws1.getAllMessages<{ type: string; shopEpoch?: number }>().find(
          (message) =>
            message.type === 'SHOP_FINISH' && message.shopEpoch === 1,
        ),
      ).toBeDefined();

      ws0.sent.length = 0;
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOP_BUY_SELL',
        shopEpoch: 1,
        actionId: 'buy-after-close',
        weaponId: 'GRENADE',
        delta: 1,
      }));
      expect(
        ws0.getAllMessages<{ type: string; reason?: string }>().find(
          (message) =>
            message.type === 'SHOP_REJECTED' && message.reason === 'SHOP_CLOSED',
        ),
      ).toBeDefined();

      persistedAfterFinish.roundEnded = true;
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOP_ENTER',
        roundNumber: 2,
      }));
      expect(persistedAfterFinish.processedShopActions).toEqual({});
    });

    it('advances turn to slot 1 in round 2 when slot 1 died in round 1 and respawned', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;

      // 1. Simulate Round 1 ending with Slot 1 dead
      await handleClientMessage.call(
        room,
        0,
        JSON.stringify({
          type: 'ROUND_END',
          roundWinnerId: 'player-1',
          isDraw: false,
          players: [
            {
              id: 'player-1',
              name: 'Alice',
              isHuman: true,
              money: 300,
              inventory: {},
              tank: {
                id: 'tank-1',
                position: { x: 80, y: 280 },
                angle: 45,
                power: 50,
                health: 100,
                maxHealth: 100,
                shield: 40,
                maxShield: 40,
                isDead: false,
                color: '#5555FF',
                currentWeapon: 'MISSILE',
              },
            },
            {
              id: 'player-2',
              name: 'Bob',
              isHuman: true,
              money: 100,
              inventory: {},
              tank: {
                id: 'tank-2',
                position: { x: 600, y: 280 },
                angle: 135,
                power: 50,
                health: 0,
                maxHealth: 100,
                shield: 0,
                maxShield: 40,
                isDead: true,
                color: '#FF5555',
                currentWeapon: 'MISSILE',
              },
            },
          ],
        })
      );

      // 2. Both players ready up in shop (Round 2 starts)
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOP_READY', shopEpoch: 1, actionId: 'round-two-ready-0',
      }));
      await handleClientMessage.call(room, 1, JSON.stringify({
        type: 'SHOP_READY', shopEpoch: 1, actionId: 'round-two-ready-1',
      }));

      // 3. Slot 0 fires in Round 2
      await handleClientMessage.call(
        room,
        0,
        JSON.stringify({
          type: 'FIRE',
          actionId: crypto.randomUUID(),
          command: { angle: 45, power: 50, weaponId: 'MISSILE' },
        })
      );

      const roundTwoShot = ws0.getAllMessages<{ type: string; shotId: number }>().filter((m) => m.type === 'SHOT').pop();
      await handleClientMessage.call(
        room,
        0,
        JSON.stringify({
          type: 'SHOT_SETTLED',
          shotId: roundTwoShot?.shotId,
          slot: 0,
          deadSlots: [false, false],
        })
      );
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOT_EARNINGS', shotId: roundTwoShot?.shotId, authorityEpoch: 1,
        awards: [], deadSlots: [false, false],
        directHitVictimIds: [],
        roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
      }));

      // 5. Turn MUST advance to slot 1 (Player 2), NOT remain stuck on slot 0!
      const lastStateUpdate = ws0
        .getAllMessages<{ type: string; currentPlayerIndex: number }>()
        .filter((m) => m.type === 'STATE_UPDATE')
        .pop();

      expect(lastStateUpdate?.currentPlayerIndex).toBe(1);
    });
  });

  describe('Security and edge cases', () => {
    async function startSecurityRoom(): Promise<{
      ws0: MockWebSocket;
      handle: (slot: number, raw: string) => Promise<void>;
    }> {
      await room.fetchCreate(new Request('http://localhost/api/room', {
        method: 'POST',
        body: JSON.stringify({
          roomId: 'room-security',
          numPlayers: 2,
          slotConfigs: [{ type: 'human' }, { type: 'human' }],
          origin: 'http://localhost:5173',
        }),
      }));
      const ws0 = new MockWebSocket();
      const sockets = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
      sockets.set(0, ws0 as unknown as WebSocket);
      sockets.set(1, new MockWebSocket() as unknown as WebSocket);
      const claim = Reflect.get(room, 'claimHumanSlot') as (
        slot: number,
        name: string,
      ) => Promise<void>;
      await claim.call(room, 0, 'Alice');
      await claim.call(room, 1, 'Bob');
      const handle = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string,
      ) => Promise<void>;
      return { ws0, handle };
    }

    it('rejects FIRE payloads with invalid weaponId', async () => {
      const { ws0, handle } = await startSecurityRoom();
      const payload = JSON.stringify({ type: 'FIRE', actionId: crypto.randomUUID(), command: { angle: 0, power: 50, weaponId: 'INVALID_WEAPON' } });
      await handle.call(room, 0, payload);
      expect(ws0.getAllMessages<{ type: string; reason?: string }>().some(
        (message) => message.type === 'FIRE_REJECTED' && message.reason === 'MALFORMED',
      )).toBe(true);
    });

    it('rejects FIRE payloads with power out of bounds', async () => {
      const { ws0, handle } = await startSecurityRoom();
      const payloadHigh = JSON.stringify({ type: 'FIRE', actionId: crypto.randomUUID(), command: { angle: 0, power: 150, weaponId: 'MISSILE' } });
      await handle.call(room, 0, payloadHigh);

      const payloadLow = JSON.stringify({ type: 'FIRE', actionId: crypto.randomUUID(), command: { angle: 0, power: -10, weaponId: 'MISSILE' } });
      await handle.call(room, 0, payloadLow);
      expect(ws0.getAllMessages<{ type: string; reason?: string }>().filter(
        (message) => message.type === 'FIRE_REJECTED' && message.reason === 'MALFORMED',
      )).toHaveLength(2);
    });

    it('rejects FIRE payloads with angle out of bounds', async () => {
      const { ws0, handle } = await startSecurityRoom();
      const payloadHigh = JSON.stringify({ type: 'FIRE', actionId: crypto.randomUUID(), command: { angle: 400, power: 50, weaponId: 'MISSILE' } });
      await handle.call(room, 0, payloadHigh);
      expect(ws0.getAllMessages<{ type: string; reason?: string }>().some(
        (message) => message.type === 'FIRE_REJECTED' && message.reason === 'MALFORMED',
      )).toBe(true);
    });

    it('handles invalid JSON gracefully without throwing', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;

      await expect(handleClientMessage.call(room, 0, 'invalid{json')).resolves.toBeUndefined();
    });

    it('drops oversized payloads (>8192 chars)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;

      await handleClientMessage.call(room, 0, 'x'.repeat(9000));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Dropping oversized payload'));
      warnSpy.mockRestore();
    });

    it('rejects websocket upgrades with a bad token', async () => {
      await room.fetchCreate(
        new Request('http://localhost/api/room', {
          method: 'POST',
          body: JSON.stringify({
            roomId: 'room-lobby',
            numPlayers: 2,
            slotConfigs: [{ type: 'human' }, { type: 'human' }],
            origin: 'http://localhost:5173',
          }),
        }),
      );
      const res = await room.fetch(
        new Request('http://localhost/api/rooms/room-lobby/ws?slot=0&token=nope', {
          headers: {
            Upgrade: 'websocket',
            'x-room-id': 'room-lobby',
            'x-slot': '0',
            'x-token': 'nope',
          },
        }),
      );
      expect(res.status).toBe(403);
    });

    it('rejects FIRE payloads that are not a finite command', async () => {
      await room.fetchCreate(
        new Request('http://localhost/api/room', {
          method: 'POST',
          body: JSON.stringify({
            roomId: 'room-bad-fire',
            numPlayers: 2,
            slotConfigs: [{ type: 'human' }, { type: 'human' }],
            origin: 'http://localhost:5173',
          }),
        }),
      );
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;
      const ws0 = new MockWebSocket();
      const internalSockets = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
      internalSockets.set(0, ws0 as unknown as WebSocket);
      internalSockets.set(1, new MockWebSocket() as unknown as WebSocket);
      const claimMethod = Reflect.get(room, 'claimHumanSlot') as (s: number, n: string) => Promise<void>;
      await claimMethod.call(room, 0, 'Alice');
      await claimMethod.call(room, 1, 'Bob');

      await handleClientMessage.call(room, 0, JSON.stringify({ type: 'FIRE', actionId: crypto.randomUUID() }));
      await handleClientMessage.call(
        room,
        0,
        JSON.stringify({ type: 'FIRE', actionId: crypto.randomUUID(), command: { angle: 45, power: 50, weaponId: 12 } }),
      );

      const shots = ws0.getAllMessages<{ type: string }>().filter((m) => m.type === 'SHOT');
      expect(shots).toHaveLength(0);
    });
  });

  describe('Earnings authority and idempotent payment', () => {
    async function startTwoHumanRoom() {
      await room.fetchCreate(new Request('http://localhost/api/room', {
        method: 'POST',
        body: JSON.stringify({
          roomId: 'room-economy',
          numPlayers: 2,
          slotConfigs: [{ type: 'human' }, { type: 'human' }],
          origin: 'http://localhost:5173',
        }),
      }));
      const ws0 = new MockWebSocket();
      const ws1 = new MockWebSocket();
      const sockets = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
      sockets.set(0, ws0 as unknown as WebSocket);
      sockets.set(1, ws1 as unknown as WebSocket);
      const claim = Reflect.get(room, 'claimHumanSlot') as (slot: number, name: string) => Promise<void>;
      await claim.call(room, 0, 'Alice');
      await claim.call(room, 1, 'Bob');
      const handle = Reflect.get(room, 'handleClientMessage') as (slot: number, raw: string) => Promise<void>;
      return { ws0, ws1, sockets, claim, handle };
    }

    it('elects the first human, transfers authority, and does not restore it on reconnect', async () => {
      const { ws0, ws1, sockets, claim } = await startTwoHumanRoom();
      const stateBefore = Reflect.get(room, 'state') as { earningsAuthoritySlot: number | null; authorityEpoch: number };
      expect(stateBefore.earningsAuthoritySlot).toBe(0);
      expect(stateBefore.authorityEpoch).toBe(1);

      const disconnect = Reflect.get(room, 'handleSocketDisconnect') as (slot: number, ws: WebSocket) => Promise<void>;
      await disconnect.call(room, 0, ws0 as unknown as WebSocket);
      const stateAfter = Reflect.get(room, 'state') as { earningsAuthoritySlot: number | null; authorityEpoch: number };
      expect(stateAfter.earningsAuthoritySlot).toBe(1);
      expect(stateAfter.authorityEpoch).toBe(2);

      sockets.set(0, ws0 as unknown as WebSocket);
      await claim.call(room, 0, 'Alice');
      expect((Reflect.get(room, 'state') as { earningsAuthoritySlot: number | null }).earningsAuthoritySlot).toBe(1);
      expect(ws1.getAllMessages<{ type: string }>().some((message) => message.type === 'AUTHORITY_CHANGED')).toBe(true);
    });

    it('rejects non-authority, stale epoch, and decimal awards', async () => {
      const { ws0, handle } = await startTwoHumanRoom();
      await handle.call(room, 0, JSON.stringify({
        type: 'FIRE', actionId: crypto.randomUUID(), command: { angle: 45, power: 50, weaponId: 'MISSILE' },
      }));
      const shot = ws0.getAllMessages<{ type: string; shotId: number }>().find((message) => message.type === 'SHOT');
      const base = {
        type: 'SHOT_EARNINGS', shotId: shot?.shotId, awards: [{ playerId: 'player-1', amount: 10 }],
        deadSlots: [false, false], directHitVictimIds: [], roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
      };
      await handle.call(room, 1, JSON.stringify({ ...base, authorityEpoch: 1 }));
      await handle.call(room, 0, JSON.stringify({ ...base, authorityEpoch: 0 }));
      await handle.call(room, 0, JSON.stringify({ ...base, authorityEpoch: 1, awards: [{ playerId: 'player-1', amount: 1.5 }] }));
      const players = (Reflect.get(room, 'state') as { players: Array<{ money: number }> }).players;
      expect(players[0].money).toBe(250);
    });

    it('applies a report atomically once and advances as soon as physics settles', async () => {
      const { ws0, handle } = await startTwoHumanRoom();
      await handle.call(room, 0, JSON.stringify({
        type: 'FIRE', actionId: crypto.randomUUID(), command: { angle: 45, power: 50, weaponId: 'MISSILE' },
      }));
      const shot = ws0.getAllMessages<{ type: string; shotId: number }>().find((message) => message.type === 'SHOT');
      const report = {
        type: 'SHOT_EARNINGS', shotId: shot?.shotId, authorityEpoch: 1,
        awards: [{ playerId: 'player-1', amount: 10 }], deadSlots: [false, false],
        directHitVictimIds: [],
        roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
      };
      await handle.call(room, 0, JSON.stringify(report));
      await handle.call(room, 0, JSON.stringify(report));
      expect((Reflect.get(room, 'state') as { players: Array<{ money: number }> }).players[0].money).toBe(260);
      expect((Reflect.get(room, 'state') as { currentPlayerIndex: number }).currentPlayerIndex).toBe(0);

      await handle.call(room, 0, JSON.stringify({
        type: 'SHOT_SETTLED', shotId: shot?.shotId, slot: 0, deadSlots: [false, false],
      }));
      expect((Reflect.get(room, 'state') as { currentPlayerIndex: number }).currentPlayerIndex).toBe(1);
    });

    it('advances immediately once physics and a zero-gain report are both present', async () => {
      const { ws0, handle } = await startTwoHumanRoom();
      await handle.call(room, 0, JSON.stringify({
        type: 'FIRE', actionId: crypto.randomUUID(), command: { angle: 45, power: 50, weaponId: 'MISSILE' },
      }));
      const shot = ws0.getAllMessages<{ type: string; shotId: number }>().find((message) => message.type === 'SHOT');
      await handle.call(room, 0, JSON.stringify({
        type: 'SHOT_SETTLED', shotId: shot?.shotId, slot: 0, deadSlots: [false, false],
      }));
      await handle.call(room, 0, JSON.stringify({
        type: 'SHOT_EARNINGS', shotId: shot?.shotId, authorityEpoch: 1,
        awards: [], deadSlots: [false, false],
        directHitVictimIds: [],
        roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
      }));
      expect((Reflect.get(room, 'state') as { currentPlayerIndex: number }).currentPlayerIndex).toBe(1);
    });

    it('records direct-hit revenge authoritatively and rejects BULLDOZER victim reports', async () => {
      const { ws0, handle } = await startTwoHumanRoom();
      await handle.call(room, 0, JSON.stringify({
        type: 'FIRE', actionId: crypto.randomUUID(), command: { angle: 45, power: 50, weaponId: 'MISSILE' },
      }));
      const shot = ws0.getAllMessages<{ type: string; shotId: number }>().find((message) => message.type === 'SHOT');
      await handle.call(room, 0, JSON.stringify({
        type: 'SHOT_EARNINGS', shotId: shot?.shotId, authorityEpoch: 1,
        awards: [], deadSlots: [false, false], directHitVictimIds: ['player-2'],
        roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
      }));
      const state = Reflect.get(room, 'state') as {
        lastDirectAttackerByPlayerId: Record<string, string>;
        players: Player[];
      };
      expect(state.lastDirectAttackerByPlayerId['player-2']).toBe('player-1');
      expect(state.players[1].tank.lastDirectAttackerId).toBe('player-1');
      await handle.call(room, 0, JSON.stringify({
        type: 'SHOT_SETTLED', shotId: shot?.shotId, slot: 0, deadSlots: [false, false],
      }));
      state.players[1].inventory.BULLDOZER = 1;
      await handle.call(room, 1, JSON.stringify({
        type: 'FIRE', actionId: crypto.randomUUID(), command: { angle: 45, power: 50, weaponId: 'BULLDOZER' },
      }));
      const bulldozerShot = ws0.getAllMessages<{ type: string; shotId: number }>()
        .filter((message) => message.type === 'SHOT')
        .pop();
      await handle.call(room, 0, JSON.stringify({
        type: 'SHOT_EARNINGS', shotId: bulldozerShot?.shotId, authorityEpoch: 1,
        awards: [], deadSlots: [false, false], directHitVictimIds: ['player-1'],
        roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
      }));
      expect(state.lastDirectAttackerByPlayerId['player-1']).toBeUndefined();
    });

    it('appoints and persists Zeus after the authoritative zero-gain threshold', async () => {
      const { ws0, handle } = await startTwoHumanRoom();
      const state = Reflect.get(room, 'state') as {
        players: Player[];
        zeusState: { shotsWithoutEarnings: number; activeZeusId: string | null };
        currentPlayerIndex: number;
      };
      for (const player of state.players) player.isHuman = false;
      state.zeusState.shotsWithoutEarnings = 9;

      await handle.call(room, 0, JSON.stringify({
        type: 'FIRE', actionId: crypto.randomUUID(), command: { angle: 45, power: 50, weaponId: 'MISSILE' },
      }));
      const shot = ws0.getAllMessages<{ type: string; shotId: number }>().find((message) => message.type === 'SHOT');
      await handle.call(room, 0, JSON.stringify({
        type: 'SHOT_EARNINGS', shotId: shot?.shotId, authorityEpoch: 1,
        awards: [], deadSlots: [false, false], directHitVictimIds: [],
        roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
      }));
      await handle.call(room, 0, JSON.stringify({
        type: 'SHOT_SETTLED', shotId: shot?.shotId, slot: 0, deadSlots: [false, false],
      }));

      const appointment = ws0.getAllMessages<{
        type: string;
        zeusId: string;
        zeusSlot: number;
      }>().find((message) => message.type === 'ZEUS_APPOINTED');
      expect(appointment).toBeDefined();
      expect(state.zeusState.activeZeusId).toBe(appointment?.zeusId);
      expect(state.currentPlayerIndex).toBe(appointment?.zeusSlot);
      const stored = await (mockCtx as { storage: { get: (key: string) => Promise<unknown> } }).storage.get('state') as {
        zeusState: { activeZeusId: string | null };
      };
      expect(stored.zeusState.activeZeusId).toBe(appointment?.zeusId);
    });
  });

  describe('Persistence, catch-up and ROUND_END', () => {
    it('persists room state after creation', async () => {
      const payload = {
        roomId: 'room-persist',
        numPlayers: 2,
        slotConfigs: [{ type: 'human' }, { type: 'ai', aiProfile: 'v1-random' }],
        origin: 'http://localhost:5173',
      };
      const res = await room.fetchCreate(
        new Request('http://localhost/api/room', {
          method: 'POST',
          body: JSON.stringify(payload),
        }),
      );
      expect(res.status).toBe(200);
      const put = (mockCtx as { storage: { put: ReturnType<typeof vi.fn> } }).storage.put;
      expect(put).toHaveBeenCalled();
    });

    it('writes a restorable snapshot to Durable Object storage', async () => {
      await room.fetchCreate(
        new Request('http://localhost/api/room', {
          method: 'POST',
          body: JSON.stringify({
            roomId: 'restored-room',
            numPlayers: 2,
            slotConfigs: [
              { type: 'human' },
              { type: 'ai', aiProfile: 'v4-smart' },
            ],
            origin: 'http://localhost:5173',
          }),
        }),
      );
      const stored = await (mockCtx as { storage: { get: (k: string) => Promise<unknown> } }).storage.get(
        'state',
      );
      expect(stored).toMatchObject({ roomId: 'restored-room', numPlayers: 2 });
    });

    it('replays GAME_START on REQUEST_GAME_START after the match started', async () => {
      const payload = {
        roomId: 'room-catchup',
        numPlayers: 2,
        slotConfigs: [{ type: 'human' }, { type: 'human' }],
        origin: 'http://localhost:5173',
      };
      await room.fetchCreate(
        new Request('http://localhost/api/room', {
          method: 'POST',
          body: JSON.stringify(payload),
        }),
      );
      const ws0 = new MockWebSocket();
      const ws1 = new MockWebSocket();
      const internalSockets = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
      internalSockets.set(0, ws0 as unknown as WebSocket);
      internalSockets.set(1, ws1 as unknown as WebSocket);
      const claimMethod = Reflect.get(room, 'claimHumanSlot') as (s: number, n: string) => Promise<void>;
      await claimMethod.call(room, 0, 'Alice');
      await claimMethod.call(room, 1, 'Bob');
      ws0.sent.length = 0;

      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'REQUEST_GAME_START',
        protocolVersion: 1,
        roundNumber: 1,
        lastSeenShotId: 0,
        lastAppliedShopEpoch: 0,
      }));

      const types = ws0.getAllMessages<{ type: string }>().map((m) => m.type);
      expect(types).toContain('GAME_START');
      expect(types).toContain('STATE_UPDATE');

      const state = Reflect.get(room, 'state') as {
        shotHistory: ShotMessage[];
        activeShot: { shotId: number } | null;
      };
      const createShot = (shotId: number): ShotMessage => ({
        type: 'SHOT',
        actionId: `catch-up-${shotId}`,
        shotId,
        roundNumber: 1,
        shotNumberInRound: shotId,
        isFirstShotOfRound: shotId === 1,
        slot: shotId % 2,
        ownerId: `player-${(shotId % 2) + 1}`,
        command: { angle: 45, power: 50, weaponId: 'MISSILE' },
      });
      state.shotHistory = [createShot(3), createShot(1), createShot(2)];
      state.activeShot = { shotId: 3 };
      ws0.sent.length = 0;
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'REQUEST_GAME_START',
        protocolVersion: 1,
        roundNumber: 1,
        lastSeenShotId: 1,
        lastAppliedShopEpoch: 0,
      }));
      const catchUp = ws0
        .getAllMessages<{
          type: string;
          activeShotId?: number | null;
          shots?: ShotMessage[];
        }>()
        .find((message) => message.type === 'SHOT_CATCH_UP');
      expect(catchUp?.activeShotId).toBe(3);
      expect(catchUp?.shots?.map((shot) => shot.shotId)).toEqual([2, 3]);
    });

    it('broadcasts authoritative ROUND_END after settled earnings', async () => {
      const payload = {
        roomId: 'room-end',
        numPlayers: 2,
        slotConfigs: [{ type: 'human' }, { type: 'human' }],
        origin: 'http://localhost:5173',
      };
      await room.fetchCreate(
        new Request('http://localhost/api/room', {
          method: 'POST',
          body: JSON.stringify(payload),
        }),
      );
      const ws0 = new MockWebSocket();
      const ws1 = new MockWebSocket();
      const internalSockets = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
      internalSockets.set(0, ws0 as unknown as WebSocket);
      internalSockets.set(1, ws1 as unknown as WebSocket);
      const claimMethod = Reflect.get(room, 'claimHumanSlot') as (s: number, n: string) => Promise<void>;
      await claimMethod.call(room, 0, 'Alice');
      await claimMethod.call(room, 1, 'Bob');

      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'FIRE', actionId: crypto.randomUUID(), command: { angle: 45, power: 50, weaponId: 'MISSILE' },
      }));
      const shot = ws0.getAllMessages<{ type: string; shotId: number }>().find((message) => message.type === 'SHOT');
      await handleClientMessage.call(
        room,
        0,
        JSON.stringify({
          type: 'SHOT_SETTLED', shotId: shot?.shotId, slot: 0, deadSlots: [false, true],
        }),
      );
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOT_EARNINGS', shotId: shot?.shotId, authorityEpoch: 1,
        awards: [], deadSlots: [false, true],
        directHitVictimIds: [],
        roundOutcome: { isRoundEnd: true, isDraw: false, roundWinnerId: 'player-1' },
      }));

      const end = ws0.getAllMessages<{ type: string }>().find((m) => m.type === 'ROUND_END');
      expect(end).toBeDefined();
      expect((Reflect.get(room, 'state') as { roundEnded: boolean }).roundEnded).toBe(true);
    });

    it('rejects unauthorized ROUND_END from non-host slot', async () => {
      const payload = {
        roomId: 'room-idor-round-end',
        numPlayers: 2,
        slotConfigs: [{ type: 'human' }, { type: 'human' }],
        origin: 'http://localhost:5173',
      };
      await room.fetchCreate(
        new Request('http://localhost/api/room', {
          method: 'POST',
          body: JSON.stringify(payload),
        }),
      );
      const ws0 = new MockWebSocket();
      const ws1 = new MockWebSocket();
      const internalSockets = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
      internalSockets.set(0, ws0 as unknown as WebSocket);
      internalSockets.set(1, ws1 as unknown as WebSocket);
      const claimMethod = Reflect.get(room, 'claimHumanSlot') as (s: number, n: string) => Promise<void>;
      await claimMethod.call(room, 0, 'Alice');
      await claimMethod.call(room, 1, 'Bob');
      ws0.sent.length = 0;
      ws1.sent.length = 0;

      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;
      const players = (
        Reflect.get(room, 'state') as { players: Array<Record<string, unknown>> }
      ).players;

      // Slot 1 (non-host) attempts to forcefully trigger ROUND_END
      await handleClientMessage.call(
        room,
        1,
        JSON.stringify({
          type: 'ROUND_END',
          roundWinnerId: 'player-2',
          isDraw: false,
          players,
        }),
      );

      // Round state must remain unchanged (not ended) and no ROUND_END broadcast
      expect((Reflect.get(room, 'state') as { roundEnded: boolean }).roundEnded).toBe(false);
      const roundEnd0 = ws0.getAllMessages<{ type: string }>().find((m) => m.type === 'ROUND_END');
      const roundEnd1 = ws1.getAllMessages<{ type: string }>().find((m) => m.type === 'ROUND_END');
      expect(roundEnd0).toBeUndefined();
      expect(roundEnd1).toBeUndefined();
    });

    it('ignores client-authored SHOP_FINISH snapshots', async () => {
      const payload = {
        roomId: 'room-idor-shop-finish',
        numPlayers: 2,
        slotConfigs: [{ type: 'human' }, { type: 'human' }],
        origin: 'http://localhost:5173',
      };
      await room.fetchCreate(
        new Request('http://localhost/api/room', {
          method: 'POST',
          body: JSON.stringify(payload),
        }),
      );
      const ws0 = new MockWebSocket();
      const ws1 = new MockWebSocket();
      const internalSockets = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
      internalSockets.set(0, ws0 as unknown as WebSocket);
      internalSockets.set(1, ws1 as unknown as WebSocket);
      const claimMethod = Reflect.get(room, 'claimHumanSlot') as (s: number, n: string) => Promise<void>;
      await claimMethod.call(room, 0, 'Alice');
      await claimMethod.call(room, 1, 'Bob');

      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;
      const currentPlayers = (
        Reflect.get(room, 'state') as { players: Array<{ id: string; money: number; tank: { id: string } }> }
      ).players;

      const spoofedPlayers = currentPlayers.map((p, idx) => ({
        ...p,
        money: idx === 1 ? 99999 : 0,
      }));

      // Slot 1 (non-host) attempts to force SHOP_FINISH with spoofed players
      await handleClientMessage.call(
        room,
        1,
        JSON.stringify({
          type: 'SHOP_FINISH',
          players: spoofedPlayers,
        }),
      );

      const postPlayers = (
        Reflect.get(room, 'state') as { players: Array<{ id: string; money: number }> }
      ).players;
      expect(postPlayers[1].money).not.toBe(99999);
    });

    it('ignores a roster attached to an otherwise valid SHOP_ENTER', async () => {
      const payload = {
        roomId: 'room-idor-shop-enter',
        numPlayers: 2,
        slotConfigs: [{ type: 'human' }, { type: 'human' }],
        origin: 'http://localhost:5173',
      };
      await room.fetchCreate(
        new Request('http://localhost/api/room', {
          method: 'POST',
          body: JSON.stringify(payload),
        }),
      );
      const ws0 = new MockWebSocket();
      const ws1 = new MockWebSocket();
      const internalSockets = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
      internalSockets.set(0, ws0 as unknown as WebSocket);
      internalSockets.set(1, ws1 as unknown as WebSocket);
      const claimMethod = Reflect.get(room, 'claimHumanSlot') as (s: number, n: string) => Promise<void>;
      await claimMethod.call(room, 0, 'Alice');
      await claimMethod.call(room, 1, 'Bob');

      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;
      const currentPlayers = (
        Reflect.get(room, 'state') as { players: Array<{ id: string; money: number; tank: { id: string } }> }
      ).players;
      (Reflect.get(room, 'state') as { roundEnded: boolean }).roundEnded = true;

      const spoofedPlayers = currentPlayers.map((p, idx) => ({
        ...p,
        money: idx === 1 ? 88888 : 0,
      }));

      // Slot 1 (non-host) sends SHOP_ENTER with a full spoofed roster
      await handleClientMessage.call(
        room,
        1,
        JSON.stringify({
          type: 'SHOP_ENTER',
          roundNumber: 1,
          players: spoofedPlayers,
        }),
      );

      const postPlayers = (
        Reflect.get(room, 'state') as { players: Array<{ id: string; money: number }> }
      ).players;
      expect(postPlayers[1].money).not.toBe(88888);
      expect((Reflect.get(room, 'state') as { shopSession: unknown }).shopSession).not.toBeNull();
    });

    it('clears shotHistory when completeShopPhase completes round transition', async () => {
      const payload = {
        roomId: 'room-shot-history-clean',
        numPlayers: 2,
        slotConfigs: [{ type: 'human' }, { type: 'human' }],
        origin: 'http://localhost:5173',
      };
      await room.fetchCreate(
        new Request('http://localhost/api/room', {
          method: 'POST',
          body: JSON.stringify(payload),
        }),
      );
      const ws0 = new MockWebSocket();
      const ws1 = new MockWebSocket();
      const internalSockets = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
      internalSockets.set(0, ws0 as unknown as WebSocket);
      internalSockets.set(1, ws1 as unknown as WebSocket);
      const claimMethod = Reflect.get(room, 'claimHumanSlot') as (s: number, n: string) => Promise<void>;
      await claimMethod.call(room, 0, 'Alice');
      await claimMethod.call(room, 1, 'Bob');

      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string,
      ) => Promise<void>;

      // 1. Slot 0 fires in Round 1
      await handleClientMessage.call(
        room,
        0,
        JSON.stringify({
          type: 'FIRE',
          actionId: 'round-1-shot',
          command: { angle: 45, power: 50, weaponId: 'MISSILE' },
        }),
      );

      const shot = ws0.getAllMessages<{ type: string; shotId: number }>().find((m) => m.type === 'SHOT');
      await handleClientMessage.call(
        room,
        0,
        JSON.stringify({
          type: 'SHOT_SETTLED',
          shotId: shot?.shotId,
          slot: 0,
          deadSlots: [false, true],
        }),
      );
      await handleClientMessage.call(
        room,
        0,
        JSON.stringify({
          type: 'SHOT_EARNINGS',
          shotId: shot?.shotId,
          authorityEpoch: 1,
          awards: [],
          deadSlots: [false, true],
          directHitVictimIds: [],
          roundOutcome: { isRoundEnd: true, isDraw: false, roundWinnerId: 'player-1' },
        }),
      );

      const stateBeforeShop = Reflect.get(room, 'state') as {
        shotHistory: ShotMessage[];
        roundEnded: boolean;
      };
      expect(stateBeforeShop.shotHistory.length).toBeGreaterThan(0);

      // 2. Enter shop
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOP_ENTER',
        roundNumber: 1,
      }));

      // 3. Both ready up to complete shop phase and advance to Round 2
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOP_READY',
        shopEpoch: 1,
        actionId: 'ready-r1-p0',
      }));
      await handleClientMessage.call(room, 1, JSON.stringify({
        type: 'SHOP_READY',
        shopEpoch: 1,
        actionId: 'ready-r1-p1',
      }));

      const stateAfterShop = Reflect.get(room, 'state') as {
        roundNumber: number;
        shotHistory: ShotMessage[];
      };
      expect(stateAfterShop.roundNumber).toBe(2);
      // shotHistory must be strictly emptied for Round 2!
      expect(stateAfterShop.shotHistory).toEqual([]);
    });

    it('restores active shopSession across Durable Object cold start and processes subsequent shop messages', async () => {
      const setup = createMockCtx();
      const initialRoom = new GameRoom(setup.ctx as DurableObjectState, {});
      Object.defineProperty(initialRoom, 'ctx', { value: setup.ctx, writable: true });

      await initialRoom.fetchCreate(
        new Request('http://localhost/api/room', {
          method: 'POST',
          body: JSON.stringify({
            roomId: 'room-cold-start-shop',
            numPlayers: 2,
            slotConfigs: [{ type: 'human' }, { type: 'human' }],
            origin: 'http://localhost:5173',
          }),
        }),
      );

      const ws0 = new MockWebSocket();
      const ws1 = new MockWebSocket();
      const internalSockets = Reflect.get(initialRoom, 'sockets') as Map<number, WebSocket>;
      internalSockets.set(0, ws0 as unknown as WebSocket);
      internalSockets.set(1, ws1 as unknown as WebSocket);
      const claimMethod = Reflect.get(initialRoom, 'claimHumanSlot') as (s: number, n: string) => Promise<void>;
      await claimMethod.call(initialRoom, 0, 'Alice');
      await claimMethod.call(initialRoom, 1, 'Bob');

      const handleInitial = Reflect.get(initialRoom, 'handleClientMessage') as (
        slot: number,
        raw: string,
      ) => Promise<void>;

      // 1. End round and open shop
      (Reflect.get(initialRoom, 'state') as { roundEnded: boolean }).roundEnded = true;
      await handleInitial.call(initialRoom, 0, JSON.stringify({
        type: 'SHOP_ENTER',
        roundNumber: 1,
      }));

      // 2. Slot 0 buys a GRENADE and readies up
      await handleInitial.call(initialRoom, 0, JSON.stringify({
        type: 'SHOP_BUY_SELL',
        shopEpoch: 1,
        actionId: 'pre-cold-buy-0',
        weaponId: 'GRENADE',
        delta: 1,
      }));
      await handleInitial.call(initialRoom, 0, JSON.stringify({
        type: 'SHOP_READY',
        shopEpoch: 1,
        actionId: 'pre-cold-ready-0',
      }));

      // Verify that state was written to DO storage
      const storedState = await (setup.ctx as { storage: { get: (k: string) => Promise<unknown> } }).storage.get('state');
      expect(storedState).toBeDefined();

      // 3. Simulate COLD START: create a new GameRoom instance backed by the same storage ctx
      const restoredRoom = new GameRoom(setup.ctx as DurableObjectState, {});
      Object.defineProperty(restoredRoom, 'ctx', { value: setup.ctx, writable: true });
      await Promise.resolve();
      await Promise.resolve();

      const restoredState = Reflect.get(restoredRoom, 'state') as {
        shopSession: {
          shopEpoch: number;
          roundNumber: number;
          readySlots: number[];
          purchasesByPlayerId: Record<string, Record<string, number>>;
        } | null;
        players: Player[];
      };
      expect(restoredState).toBeDefined();
      expect(restoredState.shopSession).not.toBeNull();
      expect(restoredState.shopSession?.shopEpoch).toBe(1);
      expect(restoredState.shopSession?.readySlots).toContain(0);
      expect(restoredState.players[0].inventory.GRENADE).toBe(3);

      // 4. Attach new WebSockets and complete the shop on the restored instance
      const restoredWs0 = new MockWebSocket();
      const restoredWs1 = new MockWebSocket();
      const restoredSockets = Reflect.get(restoredRoom, 'sockets') as Map<number, WebSocket>;
      restoredSockets.set(0, restoredWs0 as unknown as WebSocket);
      restoredSockets.set(1, restoredWs1 as unknown as WebSocket);

      const handleRestored = Reflect.get(restoredRoom, 'handleClientMessage') as (
        slot: number,
        raw: string,
      ) => Promise<void>;

      // Slot 1 buys DRILLER on the restored DO instance
      await handleRestored.call(restoredRoom, 1, JSON.stringify({
        type: 'SHOP_BUY_SELL',
        shopEpoch: 1,
        actionId: 'post-cold-buy-1',
        weaponId: 'DRILLER',
        delta: 1,
      }));

      expect(restoredState.players[1].inventory.DRILLER).toBe(1);

      // Slot 1 readies up to trigger completeShopPhase
      await handleRestored.call(restoredRoom, 1, JSON.stringify({
        type: 'SHOP_READY',
        shopEpoch: 1,
        actionId: 'post-cold-ready-1',
      }));

      const finalState = Reflect.get(restoredRoom, 'state') as {
        roundNumber: number;
        shopSession: unknown;
        players: Player[];
      };
      expect(finalState.roundNumber).toBe(2);
      expect(finalState.shopSession).toBeNull();
      expect(finalState.players[0].inventory.GRENADE).toBe(3);
      expect(finalState.players[1].inventory.DRILLER).toBe(1);
    });
  });
});
