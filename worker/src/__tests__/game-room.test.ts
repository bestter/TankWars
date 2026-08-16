import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GameRoom } from '../game-room';
import type { WeaponId } from '../../../src/types/weapon';

class MockWebSocket {
  public sent: string[] = [];
  public readyState = 1; // WebSocket.OPEN
  public send(data: string): void {
    this.sent.push(data);
  }
  public close(_code?: number, _reason?: string): void {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    room = new GameRoom(mockCtx as any, {});
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

    it('rejects FIRE command from inactive player (slot 1 while turn is slot 0)', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;

      const fireMsg = {
        type: 'FIRE',
        command: { angle: 45, power: 60, weaponId: 'MISSILE' as WeaponId },
      };

      // Player 1 tries to fire on Player 0's turn
      await handleClientMessage.call(room, 1, JSON.stringify(fireMsg));

      const shotMsg = ws0.getAllMessages<{ type: string }>().find((m) => m.type === 'SHOT');
      expect(shotMsg).toBeUndefined();
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
          command: { angle: 50, power: 70, weaponId: 'MISSILE' },
        })
      );

      // 2. Slot 0 sends SHOT_SETTLED
      await handleClientMessage.call(room, 0, JSON.stringify({ type: 'SHOT_SETTLED' }));

      const stateUpdate = ws0.getAllMessages<{ type: string; currentPlayerIndex: number }>().find(
        (m) => m.type === 'STATE_UPDATE'
      );

      expect(stateUpdate).toBeDefined();
      expect(stateUpdate?.currentPlayerIndex).toBe(1);

      const roomState = Reflect.get(room, 'state') as { currentPlayerIndex: number };
      expect(roomState.currentPlayerIndex).toBe(1);
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
    });

    it('synchronizes SHOP_BUY_SELL without clobbering other players', async () => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;

      // Slot 0 purchases a grenade with complete player object
      await handleClientMessage.call(
        room,
        0,
        JSON.stringify({
          type: 'SHOP_BUY_SELL',
          player: {
            id: 'player-1',
            name: 'Alice',
            isHuman: true,
            money: 175,
            inventory: { GRENADE: 1 },
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
        })
      );

      const buyMsg = ws1.getAllMessages<{ type: string; slot: number; players: Array<{ id: string; money: number }> }>().find(
        (m) => m.type === 'SHOP_BUY_SELL'
      );

      expect(buyMsg).toBeDefined();
      expect(buyMsg?.slot).toBe(0);
      expect(buyMsg?.players.find((p) => p.id === 'player-1')?.money).toBe(175);
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
          players: [],
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
          players: [],
        })
      );

      shopFinish = ws0.getAllMessages<{ type: string }>().find((m) => m.type === 'SHOP_FINISH');
      expect(shopFinish).toBeDefined();
    });
  });

  describe('Security and edge cases', () => {
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
  });
});
