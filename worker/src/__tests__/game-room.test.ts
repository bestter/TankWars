import { CombatCatchUpAssembler, type CombatCatchUpMessage, type CombatSnapshot } from "../../../src/game/online/combatCatchUp";
import type { RoundMap } from "../../../src/game/round/prepareRound";
import { hasValidSpawnRoster, type PreparedRound } from "../../../src/game/round/prepareRound";
import type { GameStartMessage, ShopFinishMessage, ShopActionAcknowledgement, ShopStateMessage, ShopRejectedMessage } from "../../../src/game/online/protocol";
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GameRoom } from '../game-room';
import type { WeaponId } from '../../../src/types/weapon';
import type { Player } from '../../../src/types/player';
import type { ShotMessage } from '../../../src/game/online/protocol';
import { autoBuyForAI } from '../../../src/game/entities/ai/aiShopHelper';
import { normalizeInventoryAtShopOpen } from '../../../src/game/shop/shopTransaction';
import { getRNG, setRNG, type RNG } from '../../../src/utils/random';

// Node adapter for Cloudflare's extension; the workerd smoke test uses the real API.
beforeEach(() => {
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    configurable: true,
    value: (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]),
  });
});

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
  alarmAt?: number;
}

function createMockCtx(): { ctx: unknown; mockStorage: MockStorageState } {
  const storageData = new Map<string, unknown>();
  const mockStorage: MockStorageState = { storageData };

  let activeData = storageData;
  const storageOps = {
    get: vi.fn(async (key: string) => structuredClone(activeData.get(key))),
    put: vi.fn(async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") activeData.set(key, structuredClone(value));
      else for (const [entryKey, entryValue] of Object.entries(key)) activeData.set(entryKey, structuredClone(entryValue));
    }),
    delete: vi.fn(async (key: string | string[]) => {
      if (typeof key === "string") return activeData.delete(key);
      return key.reduce((count, entry) => count + Number(activeData.delete(entry)), 0);
    }),
    list: vi.fn(async (options: { prefix: string }) => new Map([...activeData].filter(([k]) => k.startsWith(options.prefix)).map(([k, v]) => [k, structuredClone(v)]))),
  };
  type MockTransaction = typeof storageOps & {
    setAlarm: (time: number | Date) => Promise<void>;
    deleteAlarm: () => Promise<void>;
  };
  const storage = {
    ...storageOps,
    deleteAll: vi.fn(async () => {
      activeData.clear();
      mockStorage.alarmAt = undefined;
    }),
    getAlarm: vi.fn(async () => mockStorage.alarmAt ?? null),
    setAlarm: vi.fn(async (time: number | Date) => { mockStorage.alarmAt = Number(time); }),
    transaction: vi.fn(async (callback: (txn: MockTransaction) => Promise<void>) => {
      const staged = structuredClone(storageData);
      let alarmAt = mockStorage.alarmAt;
      activeData = staged;
      try {
        await callback({
          ...storageOps,
          setAlarm: async (time: number | Date) => { alarmAt = Number(time); },
          deleteAlarm: async () => { alarmAt = undefined; },
        });
        storageData.clear(); for (const [key, value] of staged) storageData.set(key, value);
        mockStorage.alarmAt = alarmAt;
      } finally { activeData = storageData; }
    }),
  };
  const ctx = {
    blockConcurrencyWhile: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
    waitUntil: vi.fn(), storage,
  };

  return { ctx, mockStorage };
}

function catchUpSnapshot(ws: MockWebSocket): CombatSnapshot | null {
  const assembler = new CombatCatchUpAssembler();
  let snapshot: CombatSnapshot | null = null;
  for (const message of ws.getAllMessages<CombatCatchUpMessage>()) {
    if (message.type.startsWith("COMBAT_CATCH_UP_")) snapshot = assembler.accept(message) ?? snapshot;
  }
  return snapshot;
}

function reportPlayers(room: GameRoom, deadSlots: boolean[] = []): Player[] {
  const players = structuredClone((Reflect.get(room, "state") as { players: Player[] }).players);
  for (const [index, player] of players.entries()) {
    if (deadSlots[index] === true) { player.tank.isDead = true; player.tank.health = 0; }
  }
  return players;
}

describe('GameRoom combat persistence comparisons', () => {
  async function bootPersistence() {
    const setup = createMockCtx();
    const room = new GameRoom(setup.ctx as DurableObjectState, {});
    Object.defineProperty(room, 'ctx', { value: setup.ctx });
    await room.fetchCreate(new Request('http://localhost/create', {
      method: 'POST',
      body: JSON.stringify({ roomId: 'comparison', numPlayers: 2,
        slotConfigs: [{ type: 'human' }, { type: 'human' }], origin: 'http://localhost:5173' }),
    }));
    const events: ShotMessage[] = [1, 2, 3, 4].map((id) => ({
      type: 'SHOT', actionId: `action-${id}`, shotId: id, roundNumber: 1,
      shotNumberInRound: id, isFirstShotOfRound: id === 1, physicsSeed: id,
      eventSequence: id, slot: 0, ownerId: 'player-0',
      command: { angle: 45, power: 60, weaponId: 'MISSILE' },
    }));
    const key = (id: number) => `combat:1:event:${id}`;
    const wrap = (event: ShotMessage) => ({ kind: 'event', key: String(event.eventSequence), value: event });
    for (const event of events) setup.mockStorage.storageData.set(key(event.eventSequence), structuredClone(wrap(event)));

    // Cold start with the persisted combat entries present in storage
    const restored = new GameRoom(setup.ctx as DurableObjectState, {});
    Object.defineProperty(restored, 'ctx', { value: setup.ctx });
    await (setup.ctx as { blockConcurrencyWhile: ReturnType<typeof vi.fn> }).blockConcurrencyWhile.mock.results.at(-1)!.value;

    const state = restored.getRoster()!;
    state.combatJournal = structuredClone(events.slice(0, 3));
    state.combatJournal[2] = { ...events[2], command: { ...events[2].command, power: 70 } };
    state.combatJournal.push({ ...events[3], eventSequence: 5, shotId: 5 });
    const storage = (setup.ctx as { storage: { put: ReturnType<typeof vi.fn> } }).storage;
    const writtenKeys = () => storage.put.mock.calls.flatMap(([batch]) => Object.keys(batch as Record<string, unknown>)).sort();
    const save = () => (Reflect.get(restored, 'saveState') as () => Promise<void>).call(restored);
    storage.put.mockClear();
    return { ...setup, room: restored, storage, writtenKeys, save, key };
  }

  it('writes only deeply changed or new combat entries, including after a cold start', async () => {
    const setup = await bootPersistence();
    await setup.save();
    expect(setup.writtenKeys()).toEqual([setup.key(3), setup.key(5), 'state']);
    expect(setup.mockStorage.storageData.has(setup.key(4))).toBe(false);
    setup.storage.put.mockClear();
    await setup.save();
    expect(setup.writtenKeys()).toEqual(['state']);

    const restored = new GameRoom(setup.ctx as DurableObjectState, {});
    Object.defineProperty(restored, 'ctx', { value: setup.ctx });
    await (setup.ctx as { blockConcurrencyWhile: ReturnType<typeof vi.fn> }).blockConcurrencyWhile.mock.results.at(-1)!.value;
    setup.storage.put.mockClear();
    await (Reflect.get(restored, 'saveState') as () => Promise<void>).call(restored);
    expect(setup.writtenKeys()).toEqual(['state']);
  });

  it('retries changed entries after a failed transaction', async () => {
    const setup = await bootPersistence();
    await setup.save();
    const state = setup.room.getRoster()!;
    const changed = { ...state.combatJournal[0], eventSequence: 6 };
    state.combatJournal.push(changed);
    const before = structuredClone(setup.mockStorage.storageData);
    setup.storage.put.mockRejectedValueOnce(new Error('disk failure'));
    await expect(setup.save()).rejects.toThrow('disk failure');
    expect(setup.mockStorage.storageData).toEqual(before);
    setup.room.getRoster()!.combatJournal.push(changed);
    setup.storage.put.mockClear();
    await setup.save();
    expect(setup.writtenKeys()).toEqual([setup.key(6), 'state']);
  });

  it('skips re-serializing unchanged combat entries and only serializes modified or new entries on warm saves', async () => {
    const setup = await bootPersistence();
    await setup.save();
    const stringify = vi.spyOn(JSON, 'stringify');
    const list = (setup.ctx as { storage: { list: ReturnType<typeof vi.fn> } }).storage.list;
    list.mockClear();
    try {
      await setup.save();
      expect(stringify).toHaveBeenCalledTimes(0);
      expect(list).toHaveBeenCalledTimes(0);

      const state = setup.room.getRoster()!;
      const baseShot = state.combatJournal[0] as ShotMessage;
      state.combatJournal.push({ ...baseShot, eventSequence: 6, shotId: 6 });
      await setup.save();
      expect(stringify).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledTimes(0);
    } finally {
      stringify.mockRestore();
    }
  });

  it('writes an identical entry again after it was removed', async () => {
    const setup = await bootPersistence();
    await setup.save();
    const event = setup.room.getRoster()!.combatJournal.shift()!;
    await setup.save();
    expect(setup.mockStorage.storageData.has(setup.key(event.eventSequence))).toBe(false);
    setup.room.getRoster()!.combatJournal.push(event);
    setup.storage.put.mockClear();
    await setup.save();
    expect(setup.writtenKeys()).toEqual([setup.key(event.eventSequence), 'state']);
  });

  it('lists storage only on cold start or round transition and purges previous round entries atomically', async () => {
    const setup = await bootPersistence();
    const list = (setup.ctx as { storage: { list: ReturnType<typeof vi.fn> } }).storage.list;
    const del = (setup.ctx as { storage: { delete: ReturnType<typeof vi.fn> } }).storage.delete;
    await setup.save();
    setup.storage.put.mockClear();
    list.mockClear();
    del.mockClear();

    // Warm save with a modified ShopState -> ShopFinish entry (as in completeShopPhase before round increment)
    const state = setup.room.getRoster()!;
    state.processedShopActions['READY:0:r0'] = {
      slot: 0,
      result: {
        type: 'SHOP_STATE',
        shopEpoch: 1,
        roundNumber: 1,
        readySlots: [0],
        players: [],
        purchasesByPlayerId: {},
        aiShopApplied: true,
      },
    };
    await setup.save();
    expect(list).toHaveBeenCalledTimes(0);
    expect(setup.writtenKeys()).toEqual(['combat:1:shop:READY:0:r0', 'state']);

    // Mutate shop entry result in-place (simulating SHOP_STATE -> SHOP_FINISH upgrade) and advance round
    state.roundNumber = 2;
    state.combatJournal = [];
    state.earningsResults = {};
    state.processedFireActionsBySlot = {};
    state.processedShopActions = {};
    setup.storage.put.mockClear();
    del.mockClear();
    await setup.save();

    expect(list).toHaveBeenCalledTimes(1);
    const deletedKeys = del.mock.calls.flatMap(([keys]) => keys as string[]).sort();
    expect(deletedKeys).toEqual([
      'combat:1:event:1',
      'combat:1:event:2',
      'combat:1:event:3',
      'combat:1:event:5',
      'combat:1:shop:READY:0:r0',
    ]);
    expect(setup.writtenKeys()).toEqual(['state']);
  });
});

describe('Zeus v3 durable settlement', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  async function boot(count = 2, mixed = false) {
    const setup = createMockCtx();
    const room = new GameRoom(setup.ctx as DurableObjectState, {});
    Object.defineProperty(room, 'ctx', { value: setup.ctx });
    await room.fetchCreate(new Request('http://localhost/create', { method: 'POST', body: JSON.stringify({
      roomId: 'zeus-v3', numPlayers: count, origin: 'http://localhost:5173',
      slotConfigs: Array.from({ length: count }, (_, i) => mixed && i > 0 ? { type: 'ai', aiProfile: 'v1-random' } : { type: 'human' }),
    }) }));
    const sockets = Array.from({ length: count }, () => new MockWebSocket());
    const connections = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
    const claim = Reflect.get(room, 'claimHumanSlot') as (slot: number, name: string) => Promise<void>;
    for (let i = 0; i < (mixed ? 1 : count); i++) { connections.set(i, sockets[i] as unknown as WebSocket); await claim.call(room, i, `Human ${i}`); }
    const send = (slot: number, message: object) => (Reflect.get(room, 'handleClientMessage') as (slot: number, raw: string) => Promise<void>).call(room, slot, JSON.stringify(message));
    const fire = async (weaponId: WeaponId = 'MISSILE') => {
      const slot = room.getRoster()!.currentPlayerIndex;
      await send(slot, { type: 'FIRE', actionId: crypto.randomUUID(), command: { angle: 45, power: 50, weaponId } });
      return room.getRoster()!.activeShot!;
    };
    const report = (shotId: number, amount = 0) => {
      const state = room.getRoster()!;
      const players = reportPlayers(room);
      const shooterId = state.activeShot?.ownerId ?? players[0].id;
      if (amount > 0) {
        const victim = players.find((p) => p.id !== shooterId && !p.tank.isDead);
        if (victim) {
          const damage = Math.max(1, Math.min(victim.tank.health - 1, Math.ceil(amount / 3)));
          victim.tank.health -= damage;
        }
      }
      return {
        type: 'SHOT_EARNINGS', shotId, authorityEpoch: state.authorityEpoch,
        players, awards: amount ? [{ playerId: shooterId, amount }] : [],
        deadSlots: players.map((p) => p.tank.isDead), directHitVictimIds: [],
        roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
      };
    };
    const restart = async (reconnect = true) => {
      const now = Date.now();
      vi.clearAllTimers();
      vi.setSystemTime(now);
      const restored = new GameRoom(setup.ctx as DurableObjectState, {});
      Object.defineProperty(restored, 'ctx', { value: setup.ctx });
      await (setup.ctx as { blockConcurrencyWhile: ReturnType<typeof vi.fn> }).blockConcurrencyWhile.mock.results.at(-1)!.value;
      const restoredConnections = Reflect.get(restored, 'sockets') as Map<number, WebSocket>;
      if (reconnect) {
        for (let i = 0; i < (mixed ? 1 : count); i++) restoredConnections.set(i, sockets[i] as unknown as WebSocket);
      }
      await vi.advanceTimersByTimeAsync(0);
      return restored;
    };
    return { room, setup, sockets, send, fire, report, restart };
  }

  it('relays an unreported shot to the next connected authority and applies its report once', async () => {
    const { room, setup, sockets, send, fire, report } = await boot(3);
    const launchedAt = Date.now();
    const shot = await fire();
    const oldReport = report(shot.shotId, 15);
    const before = room.getRoster()!.players[0].money;
    expect(setup.mockStorage.alarmAt).toBe(launchedAt + 20_000);
    await send(0, { type: 'SHOT_SETTLED', shotId: shot.shotId, slot: 0, deadSlots: [false, false, false] });

    await vi.advanceTimersByTimeAsync(19_999);
    // The platform consumes the stored alarm when the handler starts.
    setup.mockStorage.alarmAt = undefined;
    await room.alarm();
    expect(room.getRoster()!.earningsAuthoritySlot).toBe(0);
    expect(setup.mockStorage.alarmAt).toBe(launchedAt + 20_000);
    await vi.advanceTimersByTimeAsync(1);
    await room.alarm();
    expect(room.getRoster()).toMatchObject({ earningsAuthoritySlot: 1, authorityEpoch: oldReport.authorityEpoch + 1 });
    expect(setup.mockStorage.alarmAt).toBe(launchedAt + 40_000);
    expect(catchUpSnapshot(sockets[1])).toMatchObject({ activeShotId: shot.shotId, authoritySlot: 1 });
    const relayMessages = sockets[1].getAllMessages<{ type: string }>().map(({ type }) => type);
    expect(relayMessages.filter((type) => type === 'COMBAT_CATCH_UP_END' || type === 'AUTHORITY_CHANGED'))
      .toEqual(['AUTHORITY_CHANGED', 'COMBAT_CATCH_UP_END', 'AUTHORITY_CHANGED']);

    await send(0, oldReport);
    await send(1, { ...oldReport, awards: [] });
    expect(sockets[0].getLastMessage()).toMatchObject({ type: 'EARNINGS_REJECTED', reason: 'STALE_AUTHORITY' });
    expect(sockets[1].getLastMessage()).toMatchObject({ type: 'EARNINGS_REJECTED', reason: 'STALE_AUTHORITY' });
    expect(room.getRoster()!.players[0].money).toBe(before);

    await send(1, report(shot.shotId, 30));
    expect(setup.mockStorage.alarmAt).toBe(Date.now() + 24 * 60 * 60 * 1000);
    await send(1, report(shot.shotId, 90));
    await send(0, oldReport);
    await vi.advanceTimersByTimeAsync(20_000);
    await room.alarm();
    expect(room.getRoster()).toMatchObject({
      activeShot: null, currentPlayerIndex: 1, roundEnded: false, lastResolvedShotId: shot.shotId,
      roundEarningsByPlayer: { 'player-1': 30 },
    });
    expect(room.getRoster()!.players[0].money).toBe(before + 30);
    expect(sockets[2].getAllMessages<{ type: string }>().filter((m) => m.type === 'STATE_UPDATE')).toHaveLength(1);
  });

  it('gives the first live replacement a bounded window after a last-second disconnect', async () => {
    const { room, setup, sockets, send, fire, report } = await boot();
    const launchedAt = Date.now();
    const shot = await fire();
    await vi.advanceTimersByTimeAsync(19_800);
    const disconnect = Reflect.get(room, 'handleSocketDisconnect') as (slot: number, ws: MockWebSocket) => Promise<void>;
    await disconnect.call(room, 0, sockets[0]);
    expect(room.getRoster()!.earningsAuthoritySlot).toBe(1);
    expect(setup.mockStorage.alarmAt).toBe(launchedAt + 39_800);
    expect(catchUpSnapshot(sockets[1])).toMatchObject({ activeShotId: shot.shotId, authoritySlot: 1 });
    await vi.advanceTimersByTimeAsync(200);
    await room.alarm();
    expect(room.getRoster()).toMatchObject({ roundEnded: false, earningsAuthoritySlot: 1 });
    expect(setup.mockStorage.alarmAt).toBe(launchedAt + 39_800);
    await send(1, report(shot.shotId, 30));
    expect(room.getRoster()).toMatchObject({ lastResolvedShotId: shot.shotId, roundEnded: false });
  });

  it('skips the timed-out seat when the replacement disconnects and keeps the final deadline', async () => {
    const { room, setup, sockets, fire, restart } = await boot(3);
    const launchedAt = Date.now();
    const shot = await fire();
    await vi.advanceTimersByTimeAsync(20_000);
    await room.alarm();
    expect(room.getRoster()!.earningsAuthoritySlot).toBe(1);

    const restored = await restart();
    const disconnect = Reflect.get(restored, 'handleSocketDisconnect') as (slot: number, ws: MockWebSocket) => Promise<void>;
    await disconnect.call(restored, 1, sockets[1]);
    expect(restored.getRoster()!.earningsAuthoritySlot).toBe(2);
    expect(catchUpSnapshot(sockets[2])).toMatchObject({ activeShotId: shot.shotId, authoritySlot: 2 });
    await disconnect.call(restored, 2, sockets[2]);
    expect(restored.getRoster()!.earningsAuthoritySlot).toBeNull();
    expect(setup.mockStorage.alarmAt).toBe(launchedAt + 40_000);
    await vi.advanceTimersByTimeAsync(20_000);
    await restored.alarm();
    expect(restored.getRoster()).toMatchObject({ activeShot: null, roundEnded: true });
  });

  it.each(['cold start', 'empty room'])('grants only the first replacement a reporting window after a %s', async (scenario) => {
    const { room, fire, restart, setup, sockets } = await boot(3);
    const launchedAt = Date.now();
    const shot = await fire();
    await vi.advanceTimersByTimeAsync(19_900);
    const disconnect = (target: GameRoom, slot: number, socket: MockWebSocket) =>
      (Reflect.get(target, 'handleSocketDisconnect') as (slot: number, ws: MockWebSocket) => Promise<void>).call(target, slot, socket);
    if (scenario === 'empty room') {
      await disconnect(room, 2, sockets[2]);
      await disconnect(room, 1, sockets[1]);
      await disconnect(room, 0, sockets[0]);
      expect(room.getRoster()!.earningsAuthoritySlot).toBeNull();
    }
    const restored = scenario === 'cold start' ? await restart(false) : room;
    const socket = new MockWebSocket();
    const connections = Reflect.get(restored, 'sockets') as Map<number, MockWebSocket>;
    connections.set(1, socket);
    const claim = Reflect.get(restored, 'claimHumanSlot') as (slot: number, name: string, ws: MockWebSocket) => Promise<void>;
    const storage = (setup.ctx as { storage: { transaction: ReturnType<typeof vi.fn> } }).storage;
    storage.transaction.mockClear();
    await claim.call(restored, 1, 'Renamed Human 1', socket);
    expect(storage.transaction).toHaveBeenCalledTimes(1);
    expect(catchUpSnapshot(socket)).toMatchObject({ activeShotId: shot.shotId, authoritySlot: 1 });
    expect(socket.getAllMessages<{ type: string }>().filter(({ type }) => type === 'COMBAT_CATCH_UP_BEGIN')).toHaveLength(1);
    expect(setup.mockStorage.alarmAt).toBe(launchedAt + 39_900);
    await vi.advanceTimersByTimeAsync(100);
    await restored.alarm();
    expect(restored.getRoster()).toMatchObject({ roundEnded: false, earningsAuthoritySlot: 1 });

    await disconnect(restored, 1, socket);
    const finalSocket = new MockWebSocket();
    connections.set(2, finalSocket);
    await claim.call(restored, 2, 'Human 2', finalSocket);
    expect(restored.getRoster()!.earningsAuthoritySlot).toBe(2);
    expect(setup.mockStorage.alarmAt).toBe(launchedAt + 39_900);
  });

  it('keeps the deadline when the original reporter reclaims its empty seat', async () => {
    const { room, setup, sockets, fire } = await boot(2, true);
    const launchedAt = Date.now();
    await fire();
    const disconnect = Reflect.get(room, 'handleSocketDisconnect') as (slot: number, ws: MockWebSocket) => Promise<void>;
    await disconnect.call(room, 0, sockets[0]);
    await vi.advanceTimersByTimeAsync(19_900);
    const socket = new MockWebSocket();
    const connections = Reflect.get(room, 'sockets') as Map<number, MockWebSocket>;
    connections.set(0, socket);
    const claim = Reflect.get(room, 'claimHumanSlot') as (slot: number, name: string, ws: MockWebSocket) => Promise<void>;
    await claim.call(room, 0, 'Human 0', socket);
    expect(room.getRoster()!.earningsAuthoritySlot).toBe(0);
    expect(setup.mockStorage.alarmAt).toBe(launchedAt + 20_000);
  });

  it.each(['shot', 'Zeus strike'])('expires the empty room after resolving an abandoned %s', async (action) => {
    const { room, setup, sockets, send, fire, report, restart } = await boot();
    if (action === 'Zeus strike') room.getRoster()!.zeusState.shotsWithoutEarnings = 9;
    const shot = await fire();
    if (action === 'Zeus strike') {
      await send(0, { type: 'SHOT_SETTLED', shotId: shot.shotId, slot: 0, deadSlots: [false, false] });
      await send(0, report(shot.shotId));
      await vi.advanceTimersByTimeAsync(0);
      expect(setup.mockStorage.alarmAt).toBe(room.getRoster()!.activeZeusStrike!.resolveAt);
    }
    const actionDeadline = setup.mockStorage.alarmAt!;
    const disconnect = Reflect.get(room, 'handleSocketDisconnect') as (slot: number, ws: MockWebSocket) => Promise<void>;
    await disconnect.call(room, 0, sockets[0]);
    await disconnect.call(room, 1, sockets[1]);
    expect(setup.mockStorage.alarmAt).toBe(actionDeadline);

    const restored = await restart(false);
    vi.clearAllTimers();
    vi.setSystemTime(actionDeadline);
    setup.mockStorage.alarmAt = undefined;
    await restored.alarm();
    expect(restored.getRoster()).toMatchObject({ activeShot: null, activeZeusStrike: null, roundEnded: true });
    const expiry = actionDeadline + 24 * 60 * 60 * 1000;
    expect(setup.mockStorage.alarmAt).toBe(expiry);

    vi.setSystemTime(expiry - 1);
    setup.mockStorage.alarmAt = undefined;
    await restored.alarm();
    expect(restored.getRoster()).not.toBeNull();
    expect(setup.mockStorage.alarmAt).toBe(expiry);

    vi.setSystemTime(expiry);
    setup.mockStorage.alarmAt = undefined;
    await restored.alarm();
    expect(restored.getRoster()).toBeNull();
    expect(setup.mockStorage.storageData.size).toBe(0);
  });

  it('keeps reconnect and IDENTIFY writes behind a failed shot transaction', async () => {
    const { room, setup, send, fire, sockets } = await boot();
    const storage = (setup.ctx as { storage: { transaction: ReturnType<typeof vi.fn> } }).storage;
    storage.transaction.mockClear();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    storage.transaction.mockImplementationOnce(async () => {
      enter();
      await released;
      throw new Error('shot storage unavailable');
    });
    const firing = expect(fire('GRENADE')).rejects.toThrow('shot storage unavailable');
    await entered;
    const claim = Reflect.get(room, 'claimHumanSlot') as (slot: number, name: string, ws: MockWebSocket) => Promise<void>;
    const reconnecting = claim.call(room, 1, 'Reconnected', sockets[1]);
    const identifying = send(1, { type: 'IDENTIFY', name: 'Identified' });
    const catchingUp = send(1, {
      type: 'REQUEST_GAME_START', protocolVersion: 6, roundNumber: 1, lastSeenShotId: 0, lastAppliedShopEpoch: 0,
    });
    await Promise.resolve();
    const transactionsDuringFire = storage.transaction.mock.calls.length;
    release();
    await Promise.all([firing, reconnecting, identifying, catchingUp]);
    expect(transactionsDuringFire).toBe(1);
    expect(setup.mockStorage.storageData.get('state')).toMatchObject({
      activeShot: null,
      joinedHumans: { 1: { name: 'Identified' } },
    });
    expect(room.getRoster()!.shotHistory).toEqual([]);
    expect(catchUpSnapshot(sockets[1])).toMatchObject({ activeShotId: null, events: [] });
    expect(setup.mockStorage.alarmAt).toBe(Date.now() + 24 * 60 * 60 * 1000);
  });

  it('resolves the watchdog waitUntil when human settlement cancels its timer', async () => {
    const { setup, fire, send } = await boot();
    const { waitUntil } = setup.ctx as { waitUntil: ReturnType<typeof vi.fn<(task: Promise<void>) => void>> };
    const shot = await fire();
    const watchdog = waitUntil.mock.calls.at(-1)![0];
    const settled = vi.fn();
    void watchdog.then(settled);
    expect(settled).not.toHaveBeenCalled();
    await send(0, { type: 'SHOT_SETTLED', shotId: shot.shotId, slot: 0, deadSlots: [false, false] });
    expect(settled).toHaveBeenCalledOnce();
  });

  it.each([false, true])('publishes committed earnings before concurrent settlement (round ends: %s)', async (roundEnds) => {
    const { room, setup, sockets, send, fire, report } = await boot();
    const launchedAt = Date.now();
    const shot = await fire();
    vi.setSystemTime(launchedAt + 19_999);
    type Transaction = (callback: (txn: unknown) => Promise<void>) => Promise<void>;
    const storage = (setup.ctx as { storage: { transaction: ReturnType<typeof vi.fn<Transaction>> } }).storage;
    const transaction = storage.transaction.getMockImplementation()!;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    storage.transaction.mockImplementationOnce(async (callback) => {
      enter();
      await released;
      return transaction(callback);
    });
    const reportMessage = report(shot.shotId, 30);
    if (roundEnds) {
      reportMessage.players = reportPlayers(room, [false, true]);
      reportMessage.deadSlots = [false, true];
      Object.assign(reportMessage.roundOutcome, {
        isRoundEnd: true, roundWinnerId: reportMessage.players[0].id,
      });
    }
    const reporting = send(0, reportMessage);
    await entered;
    const settling = send(0, { type: 'SHOT_SETTLED', shotId: shot.shotId, slot: 0, deadSlots: reportMessage.deadSlots });
    const alarm = room.alarm();
    release();
    await Promise.all([reporting, settling, alarm]);

    const messages = sockets[1].getAllMessages<{ type: string }>();
    expect(messages.map(({ type }) => type).filter((type) =>
      ['SHOT_EARNINGS_APPLIED', 'STATE_UPDATE', 'ROUND_END'].includes(type),
    )).toEqual(['SHOT_EARNINGS_APPLIED', roundEnds ? 'ROUND_END' : 'STATE_UPDATE']);
    expect(room.getRoster()).toMatchObject({ activeShot: null, lastResolvedShotId: shot.shotId, roundEnded: roundEnds });
    expect(setup.mockStorage.alarmAt).toBe(Date.now() + 24 * 60 * 60 * 1000);
  });

  it('preserves the final deadline on restart and replays a single draw with existing earnings intact', async () => {
    const { room, setup, sockets, send, fire, report, restart } = await boot();
    const first = await fire();
    await send(0, report(first.shotId, 25));
    await send(0, { type: 'SHOT_SETTLED', shotId: first.shotId, slot: 0, deadSlots: [false, false] });
    expect(setup.mockStorage.alarmAt).toBe(Date.now() + 24 * 60 * 60 * 1000);
    const launchedAt = Date.now();
    const grenades = room.getRoster()!.players[1].inventory.GRENADE!;
    const pending = await fire('GRENADE');
    await vi.advanceTimersByTimeAsync(20_000);
    await room.alarm();
    expect(room.getRoster()!.earningsAuthoritySlot).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    const restored = await restart();
    expect(setup.mockStorage.alarmAt).toBe(launchedAt + 40_000);
    await restored.alarm();
    expect(restored.getRoster()!.activeShot?.shotId).toBe(pending.shotId);
    await vi.advanceTimersByTimeAsync(5_000);
    await restored.alarm();
    await restored.alarm();
    expect(restored.getRoster()).toMatchObject({
      activeShot: null, roundEnded: true, lastResolvedShotId: first.shotId,
      roundEarningsByPlayer: { 'player-1': 25 },
    });
    expect(Object.keys(restored.getRoster()!.earningsResults)).toEqual([String(first.shotId)]);
    const messages = () => sockets[0].getAllMessages<{ type: string }>().filter((m) => m.type === 'ROUND_END');
    expect(messages()).toHaveLength(1);
    const draw = messages()[0];
    expect(draw).toMatchObject({ roundWinnerId: null, isDraw: true, abandonedShotId: pending.shotId });
    const onceMore = await restart();
    const handle = (slot: number, message: object) => (Reflect.get(onceMore, 'handleClientMessage') as
      (slot: number, raw: string) => Promise<void>).call(onceMore, slot, JSON.stringify(message));
    await handle(0, { type: 'REQUEST_GAME_START', protocolVersion: 6, roundNumber: 1, lastSeenShotId: 0, lastAppliedShopEpoch: 0 });
    expect(messages()).toEqual([draw, draw]);
    expect(catchUpSnapshot(sockets[0])).toMatchObject({ activeShotId: null, abandonedShotId: pending.shotId });
    await handle(1, { ...report(pending.shotId, 100), authorityEpoch: onceMore.getRoster()!.authorityEpoch });
    expect(sockets[1].getLastMessage()).toMatchObject({ type: 'EARNINGS_REJECTED', reason: 'WRONG_SHOT' });
    await handle(1, { type: 'FIRE', actionId: pending.actionId, command: pending.command });
    expect(onceMore.getRoster()!.shotHistory).toHaveLength(2);
    expect(onceMore.getRoster()!.players[1].inventory.GRENADE).toBe(grenades - 1);
    expect(onceMore.getRoster()!.roundEarningsByPlayer['player-1']).toBe(25);
  });

  it('rejects a report at the deadline even if the alarm has not run yet', async () => {
    const { room, setup, sockets, send, fire, report } = await boot();
    const shot = await fire();
    vi.setSystemTime(setup.mockStorage.alarmAt!);

    await send(0, report(shot.shotId, 50));
    expect(room.getRoster()).toMatchObject({ earningsAuthoritySlot: 1, activeShot: { earningsApplied: false }, earningsResults: {} });
    expect(sockets[0].getLastMessage()).toMatchObject({ type: 'EARNINGS_REJECTED' });

    vi.setSystemTime(setup.mockStorage.alarmAt!);
    await send(1, report(shot.shotId, 50));
    expect(sockets[1].getLastMessage()).toMatchObject({ type: 'EARNINGS_REJECTED', reason: 'WRONG_SHOT' });
    expect(room.getRoster()).toMatchObject({ activeShot: null, roundEnded: true, earningsResults: {} });
    expect(sockets[0].getLastMessage()).toMatchObject({ type: 'ROUND_END', isDraw: true, abandonedShotId: shot.shotId });
  });

  it('bounds a legacy pending shot after cold start when no alternate authority is available', async () => {
    const { setup, fire, restart } = await boot(2, true);
    const shot = await fire();
    const stored = setup.mockStorage.storageData.get('state') as { activeShot: { reportRecovery?: unknown } };
    delete stored.activeShot.reportRecovery;
    delete setup.mockStorage.alarmAt;
    const restored = await restart();
    expect(setup.mockStorage.alarmAt).toBe(Date.now() + 20_000);
    await vi.advanceTimersByTimeAsync(20_000);
    await restored.alarm();
    expect(restored.getRoster()).toMatchObject({ roundEnded: true, activeShot: null, earningsResults: {} });
    expect(restored.getRoster()!.shotHistory.map((message) => message.shotId)).toEqual([shot.shotId]);
  });

  it('prevents a late-disconnecting timed-out authority from regaining authority and relays to survivor', async () => {
    const { room, sockets, send, fire, report } = await boot(2);
    const launchedAt = Date.now();
    const shot = await fire();
    const disconnect = Reflect.get(room, 'handleSocketDisconnect') as (slot: number, ws: MockWebSocket) => Promise<void>;
    const claim = Reflect.get(room, 'claimHumanSlot') as (slot: number, name: string, ws: MockWebSocket) => Promise<void>;
    const connections = Reflect.get(room, 'sockets') as Map<number, WebSocket>;

    await vi.advanceTimersByTimeAsync(20_500);
    // Slot 0 disconnects after deadlineAt before alarm() runs; relay still caps at launchedAt + 40_000.
    await disconnect.call(room, 0, sockets[0]);
    expect(room.getRoster()).toMatchObject({
      earningsAuthoritySlot: 1,
      activeShot: {
        reportRecovery: {
          relayed: true,
          timedOutSlot: 0,
          deadlineAt: launchedAt + 40_000,
        },
      },
    });

    await disconnect.call(room, 1, sockets[1]);
    expect(room.getRoster()!.earningsAuthoritySlot).toBeNull();

    const reconnected0 = new MockWebSocket();
    connections.set(0, reconnected0 as unknown as WebSocket);
    await claim.call(room, 0, 'Human 0', reconnected0);
    expect(room.getRoster()!.earningsAuthoritySlot).toBeNull();

    const reconnected1 = new MockWebSocket();
    connections.set(1, reconnected1 as unknown as WebSocket);
    await claim.call(room, 1, 'Human 1', reconnected1);
    expect(room.getRoster()!.earningsAuthoritySlot).toBe(1);

    await send(1, report(shot.shotId, 25));
    expect(room.getRoster()!.players[0].money).toBe(275);
  });

  it.each([false, true])('keeps the recovery alarm when SHOT_EARNINGS arrives before SHOT_SETTLED and completes on cold-start alarm (roundEnds=%s)', async (roundEnds) => {
    const { room, setup, sockets, send, fire, report, restart } = await boot(2);
    const launchedAt = Date.now();
    const shot = await fire();
    expect(setup.mockStorage.alarmAt).toBe(launchedAt + 20_000);

    const reportMessage = report(shot.shotId, 25);
    if (roundEnds) {
      reportMessage.players = reportPlayers(room, [false, true]);
      reportMessage.deadSlots = [false, true];
      Object.assign(reportMessage.roundOutcome, {
        isRoundEnd: true, roundWinnerId: reportMessage.players[0].id,
      });
    }
    await send(0, reportMessage);

    expect(room.getRoster()!.activeShot).toMatchObject({
      shotId: shot.shotId,
      earningsApplied: true,
      shooterSettled: false,
    });
    expect(setup.mockStorage.alarmAt).toBe(launchedAt + 20_000);

    vi.setSystemTime(launchedAt + 20_000);
    const restored = await restart();
    setup.mockStorage.alarmAt = undefined;
    await restored.alarm();

    expect(restored.getRoster()).toMatchObject({
      activeShot: null,
      currentPlayerIndex: roundEnds ? 0 : 1,
      roundEnded: roundEnds,
      lastResolvedShotId: shot.shotId,
      roundEarningsByPlayer: { 'player-1': 25 },
    });
    expect(setup.mockStorage.alarmAt).toBe(Date.now() + 24 * 60 * 60 * 1000);
    expect(sockets[1].getAllMessages<{ type: string }>().some((m) => m.type === (roundEnds ? 'ROUND_END' : 'STATE_UPDATE'))).toBe(true);
  });

  it('clears the recovery alarm once a delayed releaseAt shot finishes settling', async () => {
    const { room, setup, send, fire, report } = await boot(2);
    const launchedAt = Date.now();
    const shot = await fire();
    await send(0, report(shot.shotId, 10));

    const active = room.getRoster()!.activeShot!;
    active.releaseAt = launchedAt + 500;
    await send(0, { type: 'SHOT_SETTLED', shotId: shot.shotId, slot: 0, deadSlots: [false, false] });
    expect(setup.mockStorage.alarmAt).toBe(launchedAt + 500);
    expect(room.getRoster()!.activeShot).not.toBeNull();

    await vi.advanceTimersByTimeAsync(500);
    expect(room.getRoster()).toMatchObject({
      activeShot: null,
      currentPlayerIndex: 1,
      lastResolvedShotId: shot.shotId,
    });
    expect(setup.mockStorage.alarmAt).toBe(Date.now() + 24 * 60 * 60 * 1000);
  });

  it('serializes shop purchases, readiness, IDENTIFY and REQUEST_GAME_START through runShotOperation', async () => {
    const { room, setup, sockets, send } = await boot(2);
    room.getRoster()!.roundEnded = true;
    await send(0, { type: 'SHOP_ENTER', roundNumber: 1 });
    const shopEpoch = room.getRoster()!.shopSession!.shopEpoch;
    const grenadesBefore = room.getRoster()!.players[1].inventory.GRENADE ?? 0;
    await send(0, { type: 'SHOP_READY', shopEpoch, actionId: 'ready-0' });

    const storage = (setup.ctx as { storage: { transaction: ReturnType<typeof vi.fn> } }).storage;
    const originalTransaction = storage.transaction.getMockImplementation()! as (cb: unknown) => Promise<void>;
    storage.transaction.mockClear();
    let enteredBuy!: () => void;
    let releaseBuy!: () => void;
    const buyEntered = new Promise<void>((resolve) => { enteredBuy = resolve; });
    const buyReleased = new Promise<void>((resolve) => { releaseBuy = resolve; });
    storage.transaction.mockImplementationOnce(async (callback) => {
      enteredBuy();
      await buyReleased;
      await originalTransaction(callback);
    });

    const buying = send(1, { type: 'SHOP_BUY_SELL', shopEpoch, actionId: 'buy-1', weaponId: 'GRENADE', delta: 1 });
    await buyEntered;

    const readying = send(1, { type: 'SHOP_READY', shopEpoch, actionId: 'ready-1' });
    const identifying = send(1, { type: 'IDENTIFY', name: 'UpdatedBob' });
    const catchingUp = send(0, { type: 'REQUEST_GAME_START', protocolVersion: 6, roundNumber: 1, lastSeenShotId: 0, lastAppliedShopEpoch: 0 });
    await Promise.resolve();
    const transactionsWhilePaused = storage.transaction.mock.calls.length;

    releaseBuy();
    await Promise.all([buying, readying, identifying, catchingUp]);

    expect(transactionsWhilePaused).toBe(1);
    const state = room.getRoster()!;
    expect(state.roundNumber).toBe(2);
    expect(state.shopSession).toBeNull();
    expect(state.joinedHumans[1].name).toBe('UpdatedBob');
    expect(state.players[1].inventory.GRENADE).toBe(grenadesBefore + 1);
    expect(sockets[0].getAllMessages<ShopFinishMessage>().some((m) => m.type === 'SHOP_FINISH' && m.nextRoundNumber === 2)).toBe(true);
    expect(catchUpSnapshot(sockets[0])?.roundNumber).toBe(2);
  });

  it('serializes completeZeusStrike behind in-flight shot transactions', async () => {
    const { room, setup, fire, send, report } = await boot(2);
    room.getRoster()!.zeusState.shotsWithoutEarnings = 9;
    const shot = await fire();
    await send(0, { type: 'SHOT_SETTLED', shotId: shot.shotId, slot: 0, deadSlots: [false, false] });
    await send(0, report(shot.shotId));
    await vi.advanceTimersByTimeAsync(0);
    const strike = room.getRoster()!.activeZeusStrike;
    expect(strike).not.toBeNull();

    await vi.advanceTimersByTimeAsync(699);
    const storage = (setup.ctx as { storage: { transaction: ReturnType<typeof vi.fn> } }).storage;
    const originalTransaction = storage.transaction.getMockImplementation()! as (cb: unknown) => Promise<void>;
    storage.transaction.mockClear();
    let enteredIdentify!: () => void;
    let releaseIdentify!: () => void;
    const identifyEntered = new Promise<void>((resolve) => { enteredIdentify = resolve; });
    const identifyReleased = new Promise<void>((resolve) => { releaseIdentify = resolve; });
    storage.transaction.mockImplementationOnce(async (callback) => {
      enteredIdentify();
      await identifyReleased;
      await originalTransaction(callback);
    });

    const identifying = send(0, { type: 'IDENTIFY', name: 'ZeusWatcher' });
    await identifyEntered;
    await vi.advanceTimersByTimeAsync(1);
    const transactionsWhilePaused = storage.transaction.mock.calls.length;

    releaseIdentify();
    await identifying;
    await (Reflect.get(room, 'shotOperation') as Promise<void>);

    expect(transactionsWhilePaused).toBe(1);
    const state = room.getRoster()!;
    expect(state.joinedHumans[0].name).toBe('ZeusWatcher');
    expect(state.activeZeusStrike).toBeNull();
    expect(state.combatJournal.filter((e) => e.type === 'ZEUS_STRIKE_APPLIED')).toHaveLength(1);
  });

  it('clears roundClosedWithoutReport after shopping and allows a normal Round 2 win', async () => {
    const { room, setup, sockets, send, fire, report } = await boot(2);
    await fire();
    await vi.advanceTimersByTimeAsync(20_000);
    setup.mockStorage.alarmAt = undefined;
    await room.alarm();
    await vi.advanceTimersByTimeAsync(20_000);
    await room.alarm();
    expect(room.getRoster()).toMatchObject({ roundEnded: true, roundClosedWithoutReport: true });

    await send(0, { type: 'SHOP_ENTER', roundNumber: 1 });
    const shopEpoch = room.getRoster()!.shopSession!.shopEpoch;
    await send(0, { type: 'SHOP_BUY_SELL', shopEpoch, actionId: 'buy-0', weaponId: 'GRENADE', delta: 1 });
    await send(0, { type: 'SHOP_READY', shopEpoch, actionId: 'ready-0' });
    await send(1, { type: 'SHOP_READY', shopEpoch, actionId: 'ready-1' });
    expect(room.getRoster()!.roundNumber).toBe(2);
    expect(room.getRoster()!.roundEnded).toBe(false);
    expect(room.getRoster()!.roundClosedWithoutReport).toBeUndefined();

    const shot2 = await fire();
    const deadPlayers = reportPlayers(room, [false, true]);
    const authoritySlot = room.getRoster()!.earningsAuthoritySlot!;
    await send(0, { type: 'SHOT_SETTLED', shotId: shot2.shotId, slot: 0, deadSlots: [false, true] });
    await send(authoritySlot, {
      ...report(shot2.shotId, 50),
      players: deadPlayers,
      deadSlots: [false, true],
      roundOutcome: { isRoundEnd: true, isDraw: false, roundWinnerId: 'player-1' },
    });
    const roundEnds = sockets[0].getAllMessages<{
      type: string; roundNumber: number; isDraw: boolean; roundWinnerId: string | null;
    }>().filter((m) => m.type === 'ROUND_END');
    expect(roundEnds).toHaveLength(2);
    expect(roundEnds[1]).toMatchObject({ roundNumber: 2, isDraw: false, roundWinnerId: 'player-1' });
    expect(room.getRoster()!.roundClosedWithoutReport).toBeUndefined();
  });

  it('coordinates fetch WebSocket upgrades with IDENTIFY and REQUEST_GAME_START without duplicate writes or catch-ups', async () => {
    class MockUpgradeWebSocket extends MockWebSocket {
      private listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
      public accept = vi.fn();
      public addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(listener);
        this.listeners.set(type, list);
      }
      public dispatch(type: string, event: { data?: unknown } = {}): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    const connectViaFetch = async (room: GameRoom, slot: number): Promise<MockUpgradeWebSocket> => {
      const OriginalResponse = globalThis.Response;
      let capturedServer!: MockUpgradeWebSocket;
      class MockWebSocketPair {
        public 0: MockUpgradeWebSocket;
        public 1: MockUpgradeWebSocket;
        constructor() {
          this[0] = new MockUpgradeWebSocket();
          this[1] = new MockUpgradeWebSocket();
          capturedServer = this[1];
        }
      }
      const WrappedResponse = function (body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
        if (init?.status === 101) {
          return { status: 101, webSocket: init.webSocket } as unknown as Response;
        }
        return new OriginalResponse(body, init);
      } as unknown as typeof Response;

      vi.stubGlobal('WebSocketPair', MockWebSocketPair);
      vi.stubGlobal('Response', WrappedResponse);
      try {
        const state = room.getRoster()!;
        const token = state.tokens[slot];
        const response = await room.fetch(new Request(
          `http://localhost/ws?room=${state.roomId}&slot=${slot}&token=${token}&protocolVersion=6`,
          { headers: { Upgrade: 'websocket' } },
        ));
        expect(response.status).toBe(101);
        return capturedServer;
      } finally {
        vi.unstubAllGlobals();
      }
    };

    const { room, setup, sockets, send, fire } = await boot(2);
    await send(0, { type: 'IDENTIFY', name: 'Ace' });
    const storage = (setup.ctx as { storage: { transaction: ReturnType<typeof vi.fn> } }).storage;
    const disconnect = Reflect.get(room, 'handleSocketDisconnect') as (slot: number, ws: MockWebSocket) => Promise<void>;

    // 1. Reconnect without ?name= keeps 'Ace' and skips redundant saveState().
    await disconnect.call(room, 0, sockets[0]);
    storage.transaction.mockClear();
    const aceWs = await connectViaFetch(room, 0);
    await vi.advanceTimersByTimeAsync(0);
    await (Reflect.get(room, 'shotOperation') as Promise<void>);
    expect(room.getRoster()!.joinedHumans[0].name).toBe('Ace');
    expect(storage.transaction).not.toHaveBeenCalled();

    // 2. REQUEST_GAME_START arriving before setTimeout(0) claims once, elects authority, and suppresses setTimeout duplicate.
    const shot = await fire();
    await disconnect.call(room, 1, sockets[1]);
    await disconnect.call(room, 0, aceWs);
    expect(room.getRoster()!.earningsAuthoritySlot).toBeNull();

    const earlyWs = await connectViaFetch(room, 0);
    earlyWs.dispatch('message', {
      data: JSON.stringify({
        type: 'REQUEST_GAME_START', protocolVersion: 6, roundNumber: 1, lastSeenShotId: 0, lastAppliedShopEpoch: 0,
      }),
    });
    await (Reflect.get(room, 'shotOperation') as Promise<void>);
    expect(room.getRoster()!.earningsAuthoritySlot).toBe(0);
    expect(earlyWs.getAllMessages<{ type: string }>().filter((m) => m.type === 'COMBAT_CATCH_UP_BEGIN')).toHaveLength(1);
    expect(catchUpSnapshot(earlyWs)).toMatchObject({ activeShotId: shot.shotId, authoritySlot: 0 });

    await vi.advanceTimersByTimeAsync(0);
    await (Reflect.get(room, 'shotOperation') as Promise<void>);
    expect(earlyWs.getAllMessages<{ type: string }>().filter((m) => m.type === 'COMBAT_CATCH_UP_BEGIN')).toHaveLength(1);

    // 3. When the lobby observes GAME_START before mounting combat, the combat
    // handler's first explicit request still receives the full catch-up.
    const lateWs = await connectViaFetch(room, 1);
    await vi.advanceTimersByTimeAsync(0);
    await (Reflect.get(room, 'shotOperation') as Promise<void>);
    expect(lateWs.getAllMessages<{ type: string }>().some((m) => m.type === 'GAME_START')).toBe(true);
    expect(catchUpSnapshot(lateWs)).toBeNull();

    lateWs.dispatch('message', {
      data: JSON.stringify({
        type: 'REQUEST_GAME_START', protocolVersion: 6, roundNumber: 1, lastSeenShotId: 0, lastAppliedShopEpoch: 0,
      }),
    });
    await (Reflect.get(room, 'shotOperation') as Promise<void>);
    expect(lateWs.getAllMessages<{ type: string }>().filter((m) => m.type === 'COMBAT_CATCH_UP_BEGIN')).toHaveLength(1);
    expect(catchUpSnapshot(lateWs)).toMatchObject({ activeShotId: shot.shotId });

    lateWs.dispatch('message', {
      data: JSON.stringify({
        type: 'REQUEST_GAME_START', protocolVersion: 6, roundNumber: 1, lastSeenShotId: 0, lastAppliedShopEpoch: 0,
      }),
    });
    await (Reflect.get(room, 'shotOperation') as Promise<void>);
    expect(lateWs.getAllMessages<{ type: string }>().filter((m) => m.type === 'COMBAT_CATCH_UP_BEGIN')).toHaveLength(2);
  });

  it.each([
    [{}, null, null], [{ shotId: 7 }, 7, null], [{ authorityEpoch: 3 }, null, 3],
    [{ shotId: '7', authorityEpoch: -1 }, null, null], [{ shotId: 7, authorityEpoch: 3 }, 7, 3],
  ])('rejects unreadable reports with independently nullable identifiers (%j)', async (header, shotId, authorityEpoch) => {
    const { room, sockets, send, fire } = await boot(); await fire();
    const before = structuredClone(room.getRoster()); const observerCount = sockets[1].sent.length;
    await send(0, { type: 'SHOT_EARNINGS', ...header });
    expect(sockets[0].getLastMessage()).toEqual({ type: 'EARNINGS_REJECTED', shotId, authorityEpoch, reason: 'MALFORMED' });
    expect(sockets[1].sent).toHaveLength(observerCount);
    expect(room.getRoster()).toEqual(before);
  });

  it('redelivers every acquired result before checking divergent retries, including shop and restart', async () => {
    const { room, sockets, send, fire, report, restart } = await boot();
    const first = await fire();
    await send(0, report(first.shotId, 10));
    const result = sockets[0].getAllMessages<{ type: string }>().find((m) => m.type === 'SHOT_EARNINGS_APPLIED');
    await send(0, { type: 'SHOT_SETTLED', shotId: first.shotId, slot: 0, deadSlots: [false, false] });
    const second = await fire(); await send(0, report(second.shotId, 20));
    await send(1, { type: 'SHOT_SETTLED', shotId: second.shotId, slot: 1, deadSlots: [false, false] });
    room.getRoster()!.roundEnded = true;
    await send(0, { type: 'SHOP_ENTER', roundNumber: 1 });
    const before = structuredClone(room.getRoster());
    const observerCount = sockets[0].sent.length;
    await send(1, { type: 'SHOT_EARNINGS', shotId: first.shotId, authorityEpoch: 'invalid', players: 'invalid' });
    expect(sockets[1].getLastMessage()).toEqual({ type: 'EARNINGS_REJECTED', shotId: first.shotId, authorityEpoch: null, reason: 'STALE_AUTHORITY' });
    expect(sockets[0].sent).toHaveLength(observerCount);
    await send(0, { type: 'SHOT_EARNINGS', shotId: first.shotId, authorityEpoch: 0, players: 'invalid' });
    expect(sockets[0].getLastMessage()).toEqual(result);
    expect(room.getRoster()).toEqual(before);
    const restored = await restart();
    const handle = Reflect.get(restored, 'handleClientMessage') as (slot: number, raw: string) => Promise<void>;
    const restoredBefore = structuredClone(restored.getRoster());
    const countBefore = sockets[0].sent.length;
    await handle.call(restored, 1, JSON.stringify({ type: 'SHOT_EARNINGS', shotId: first.shotId }));
    expect(sockets[1].getLastMessage()).toMatchObject({ type: 'EARNINGS_REJECTED', reason: 'STALE_AUTHORITY' });
    expect(sockets[0].sent).toHaveLength(countBefore);
    await handle.call(restored, 0, JSON.stringify({ type: 'SHOT_EARNINGS', shotId: first.shotId }));
    expect(sockets[1].getLastMessage()).toEqual(result);
    expect(restored.getRoster()).toEqual(restoredBefore);
    expect(restored.getRoster()!.roundEarningsByPlayer['player-1']).toBe(10);
    expect(restored.getRoster()!.roundEarningsByPlayer['player-2']).toBe(20);
    for (const slot of [0, 1]) await handle.call(restored, slot, JSON.stringify({ type: 'SHOP_READY', shopEpoch: 1, actionId: `ready-${slot}` }));
    expect(restored.getRoster()!.earningsResults).toEqual({});
    expect(restored.getRoster()!.roundEarningsByPlayer['player-1']).toBe(0);
    await handle.call(restored, 0, JSON.stringify({ ...report(first.shotId), authorityEpoch: restored.getRoster()!.authorityEpoch, players: reportPlayers(restored) }));
    expect(sockets[0].getLastMessage()).toMatchObject({ type: 'EARNINGS_REJECTED', reason: 'WRONG_SHOT' });
  });

  it.each(['health', 'shield'] as const)('rejects increasing %s without any combat/economic mutation or broadcast', async (field) => {
    const { room, setup, sockets, send, fire, report } = await boot();
    const state = room.getRoster()!;
    state.players[1].tank.health = 50;
    state.players[1].tank.maxShield = 50;
    state.players[1].tank.shield = 20;
    state.zeusState.shotsWithoutEarnings = 9;
    const shot = await fire();
    await send(0, { type: 'SHOT_SETTLED', shotId: shot.shotId, slot: 0, deadSlots: [false, false] });
    const bad = report(shot.shotId, 0);
    bad.players[0].tank.position.x += 10;
    bad.players[1].tank[field] += 0.000000001;
    const before = structuredClone(state);
    const storageBefore = structuredClone(setup.mockStorage.storageData);
    const observerCount = sockets[1].sent.length;
    await send(0, bad);
    expect(sockets[0].getLastMessage()).toEqual({ type: 'EARNINGS_REJECTED', shotId: shot.shotId, authorityEpoch: 1, reason: 'CAP_MISMATCH' });
    expect(sockets[1].sent).toHaveLength(observerCount);
    expect(room.getRoster()).toEqual(before);
    expect(setup.mockStorage.storageData).toEqual(storageBefore);
    await send(0, report(shot.shotId, 10));
    expect(state.players[0].money).toBe(before.players[0].money + 10);
    expect(state.currentPlayerIndex).toBe(1);
  });

  it('restricts acquired retries to the current authority after transfer and persistent recovery', async () => {
    const { room, sockets, send, fire, report, restart } = await boot(3);
    const shot = await fire();
    await send(0, report(shot.shotId, 10));
    const result = sockets[0].getAllMessages<{ type: string }>().find((m) => m.type === 'SHOT_EARNINGS_APPLIED');
    expect(result).toBeDefined();
    await send(0, { type: 'SHOT_SETTLED', shotId: shot.shotId, slot: 0, deadSlots: [false, false, false] });
    const disconnect = Reflect.get(room, 'handleSocketDisconnect') as (slot: number, ws: WebSocket) => Promise<void>;
    await disconnect.call(room, 0, sockets[0] as unknown as WebSocket);
    const connections = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
    connections.set(0, sockets[0] as unknown as WebSocket);
    await (Reflect.get(room, 'claimHumanSlot') as (slot: number, name: string) => Promise<void>).call(room, 0, 'Human 0');
    expect(room.getRoster()!.earningsAuthoritySlot).toBe(1);
    const restored = await restart();
    const before = structuredClone(restored.getRoster());
    const storageSend = (slot: number, message: object) => (Reflect.get(restored, 'handleClientMessage') as (slot: number, raw: string) => Promise<void>).call(restored, slot, JSON.stringify(message));
    for (const slot of [0, 2]) {
      const counts = sockets.map((socket) => socket.sent.length);
      await storageSend(slot, { type: 'SHOT_EARNINGS', shotId: shot.shotId, authorityEpoch: 1, awards: 'invalid' });
      expect(sockets[slot].getLastMessage()).toEqual({ type: 'EARNINGS_REJECTED', shotId: shot.shotId, authorityEpoch: 1, reason: 'STALE_AUTHORITY' });
      sockets.forEach((socket, index) => expect(socket.sent.length).toBe(counts[index] + Number(index === slot)));
    }
    await storageSend(1, { type: 'SHOT_EARNINGS', shotId: shot.shotId, authorityEpoch: 1, awards: 'invalid' });
    sockets.forEach((socket) => expect(socket.getLastMessage()).toEqual(result));
    expect(restored.getRoster()).toEqual(before);
  });

  it.each([1, 2, 3])('resumes only missing settlement stages after durable checkpoint %i', async (checkpoint) => {
    const { room, send, fire, report, restart } = await boot();
    room.getRoster()!.zeusState.shotsWithoutEarnings = 9;
    room.getRoster()!.players[0].tank.health = 20;
    const shot = await fire();
    await send(0, { type: 'SHOT_SETTLED', shotId: shot.shotId, slot: 0, deadSlots: [false, false] });
    const save = Reflect.get(room, 'saveState') as () => Promise<void>;
    let calls = 0;
    Reflect.set(room, 'saveState', async () => { await save.call(room); if (++calls === checkpoint) throw new Error('simulated eviction'); });
    await expect(send(0, report(shot.shotId))).rejects.toThrow('simulated eviction');
    const restored = await restart();
    const state = restored.getRoster()!;
    expect(state.zeusState.activeZeusId).toBe('player-1');
    expect(state.zeusState.nextAppointmentId).toBe(2);
    expect(state.combatJournal.filter((e) => e.type === 'ZEUS_APPOINTED')).toHaveLength(1);
    expect(state.combatJournal.filter((e) => e.type === 'ZEUS_STRIKE')).toHaveLength(1);
    expect(state.earningsResults[String(shot.shotId)].awards).toEqual([]);
    await vi.advanceTimersByTimeAsync(800);
    expect(restored.getRoster()!.players[0].money).toBe(325);
    expect(restored.getRoster()!.roundEarningsByPlayer['player-1']).toBe(75);
    expect(restored.getRoster()!.combatJournal.filter((e) => e.type === 'ZEUS_STRIKE_APPLIED')).toHaveLength(1);
  });

  it('restores an allocated strike with the same target, seed state and id, without another draw', async () => {
    const { room, fire, send, report, restart } = await boot();
    room.getRoster()!.zeusState.shotsWithoutEarnings = 9;
    const shot = await fire();
    await send(0, { type: 'SHOT_SETTLED', shotId: shot.shotId, slot: 0, deadSlots: [false, false] });
    await send(0, report(shot.shotId)); await vi.advanceTimersByTimeAsync(0);
    const strike = structuredClone(room.getRoster()!.activeZeusStrike);
    const restored = await restart();
    expect(restored.getRoster()!.activeZeusStrike).toEqual(strike);
    const inventory = structuredClone(restored.getRoster()!.players[restored.getRoster()!.currentPlayerIndex].inventory);
    await (Reflect.get(restored, 'handleClientMessage') as (slot: number, raw: string) => Promise<void>).call(restored,
      restored.getRoster()!.currentPlayerIndex, JSON.stringify({ type: 'FIRE', actionId: 'during-zeus', command: { angle: 45, power: 60, weaponId: 'GRENADE' } }));
    expect(restored.getRoster()!.players[restored.getRoster()!.currentPlayerIndex].inventory).toEqual(inventory);
    await vi.advanceTimersByTimeAsync(800);
    expect(restored.getRoster()!.players.filter((p) => p.tank.isDead)).toHaveLength(1);
  });

  it('rolls back all state, cache and journal writes on a transaction failure before broadcasting', async () => {
    const { room, setup, sockets, send, fire, report } = await boot();
    const shot = await fire();
    const storage = setup.ctx as { storage: { put: ReturnType<typeof vi.fn> } };
    const before = structuredClone(setup.mockStorage.storageData);
    const sent = sockets[0].sent.length;
    const original = storage.storage.put.getMockImplementation()! as (key: string | Record<string, unknown>, value?: unknown) => Promise<void>;
    storage.storage.put.mockImplementation(async (key: string | Record<string, unknown>, value?: unknown) => {
      if (key === 'state' || (typeof key === "object" && "state" in key)) throw new Error('disk failure');
      await original(key, value);
    });
    await expect(send(0, report(shot.shotId, 10))).rejects.toThrow('disk failure');
    expect(setup.mockStorage.storageData).toEqual(before);
    expect(sockets[0].sent).toHaveLength(sent);
    expect(room.getRoster()!.players[0].money).toBe(250);
    expect(room.getRoster()!.earningsResults).toEqual({});
    storage.storage.put.mockImplementation(original);
    await send(0, report(shot.shotId, 10));
    expect(room.getRoster()!.players[0].money).toBe(260);
    expect(setup.mockStorage.storageData.get('state')).not.toHaveProperty('combatJournal');
    expect([...setup.mockStorage.storageData.keys()].some((k) => k.includes(':earnings:'))).toBe(true);
  });

  it('accepts the eliminated human authority as a spectator and appoints a real AI slot', async () => {
    const { room, fire, send, report } = await boot(3, true);
    const shot = await fire();
    const deathReport = report(shot.shotId);
    deathReport.players[0].tank.isDead = true;
    deathReport.players[0].tank.health = 0;
    deathReport.deadSlots[0] = true;
    await send(0, { type: 'SHOT_SETTLED', shotId: shot.shotId, slot: 0, deadSlots: deathReport.deadSlots });
    await send(0, deathReport);
    expect(room.getRoster()!.earningsAuthoritySlot).toBe(0);
    expect(room.getRoster()!.players[0].tank.isDead).toBe(true);
    room.getRoster()!.zeusState.shotsWithoutEarnings = 9;
    await vi.advanceTimersByTimeAsync(1200);
    const aiShot = room.getRoster()!.activeShot!;
    expect(aiShot.slot).toBe(1);
    await send(0, report(aiShot.shotId));
    await vi.advanceTimersByTimeAsync(0);
    const zeus = room.getRoster()!.players.find((p) => p.id === room.getRoster()!.zeusState.activeZeusId);
    expect(zeus?.isHuman).toBe(false);
    expect(room.getRoster()!.slotConfigs[room.getRoster()!.currentPlayerIndex].type).toBe('ai');
    expect(room.getRoster()!.activeZeusStrike).not.toBeNull();
  });

  it.each([3, 4])('requires a new match for an old schema (%i) even when its map and physical roster are complete', async (legacySchemaVersion) => {
    const { setup, restart, sockets } = await boot();
    const persisted = structuredClone(setup.mockStorage.storageData.get('state')) as Record<string, unknown>;
    persisted.combatSchemaVersion = legacySchemaVersion;
    setup.mockStorage.storageData.set('state', persisted);
    const restored = await restart();
    const before = structuredClone(restored.getRoster());
    await (Reflect.get(restored, 'handleClientMessage') as (slot: number, raw: string) => Promise<void>).call(restored, 0,
      JSON.stringify({ type: 'REQUEST_GAME_START', protocolVersion: 6, roundNumber: 1, lastSeenShotId: 999, lastAppliedShopEpoch: 0 }));
    expect(sockets[0].getLastMessage()).toMatchObject({ type: 'ROUND_PREPARATION_FAILED', reason: 'NEW_GAME_REQUIRED' });
    expect(restored.getRoster()).toEqual(before);
    expect(restored.getRoster()!.activeShot).toBeNull();
    expect(restored.getRoster()!.activeZeusStrike).toBeNull();
  });

  it.each([
    { scenario: 'before deadline', advanceMs: 10_000, applyEarnings: false, disconnectPeer: false },
    { scenario: 'relay at deadline', advanceMs: 20_000, applyEarnings: false, disconnectPeer: false },
    { scenario: 'close round at deadline without peer', advanceMs: 20_000, applyEarnings: false, disconnectPeer: true },
    { scenario: 'complete shot when earnings already applied', advanceMs: 20_000, applyEarnings: true, disconnectPeer: false },
  ] as const)('ignores shot recovery alarm on persisted schema v4 without mutating state or broadcasting ($scenario)', async ({
    advanceMs,
    applyEarnings,
    disconnectPeer,
  }) => {
    const { setup, sockets, send, fire, report, restart } = await boot(2);
    const shot = await fire();
    if (applyEarnings) {
      await send(0, report(shot.shotId, 25));
      vi.setSystemTime(Date.now() + advanceMs);
    } else {
      await vi.advanceTimersByTimeAsync(advanceMs);
    }

    const persisted = structuredClone(setup.mockStorage.storageData.get('state')) as Record<string, unknown>;
    expect(persisted.activeShot).not.toBeNull();
    persisted.combatSchemaVersion = 4;
    setup.mockStorage.storageData.set('state', persisted);

    const restored = await restart(!disconnectPeer);
    const beforeState = structuredClone(restored.getRoster());
    const beforeStorage = structuredClone(setup.mockStorage.storageData);
    const beforeAlarm = setup.mockStorage.alarmAt;
    const storage = (setup.ctx as {
      storage: { transaction: ReturnType<typeof vi.fn>; setAlarm: ReturnType<typeof vi.fn> };
    }).storage;
    storage.transaction.mockClear();
    storage.setAlarm.mockClear();
    sockets[0].sent.length = 0;
    sockets[1].sent.length = 0;

    await restored.alarm();

    expect(storage.transaction).not.toHaveBeenCalled();
    expect(storage.setAlarm).not.toHaveBeenCalled();
    expect(restored.getRoster()).toEqual(beforeState);
    expect(setup.mockStorage.storageData).toEqual(beforeStorage);
    expect(setup.mockStorage.alarmAt).toBe(beforeAlarm);
    expect(sockets[0].sent).toEqual([]);
    expect(sockets[1].sent).toEqual([]);
  });

  it('still relays and closes a persisted schema v6 room via alarm', async () => {
    const { setup, sockets, fire, restart } = await boot(2);
    const shot = await fire();
    await vi.advanceTimersByTimeAsync(20_000);

    const restored = await restart();
    setup.mockStorage.alarmAt = undefined;
    await restored.alarm();
    expect(restored.getRoster()).toMatchObject({
      earningsAuthoritySlot: 1,
      roundEnded: false,
    });
    expect(sockets[1].getAllMessages<{ type: string }>().some((m) => m.type === 'AUTHORITY_CHANGED')).toBe(true);

    await vi.advanceTimersByTimeAsync(20_000);
    setup.mockStorage.alarmAt = undefined;
    await restored.alarm();
    expect(restored.getRoster()).toMatchObject({
      activeShot: null,
      roundEnded: true,
      roundClosedWithoutReport: true,
    });
    expect(sockets[0].getLastMessage()).toMatchObject({
      type: 'ROUND_END',
      isDraw: true,
      abandonedShotId: shot.shotId,
    });
  });

  it('restores a strike result committed before broadcast without another victim, credit or turn', async () => {
    const { room, fire, send, report, restart } = await boot();
    room.getRoster()!.zeusState.shotsWithoutEarnings = 9;
    const shot = await fire();
    await send(0, { type: 'SHOT_SETTLED', shotId: shot.shotId, slot: 0, deadSlots: [false, false] });
    await send(0, report(shot.shotId)); await vi.advanceTimersByTimeAsync(0);
    const strikeId = room.getRoster()!.activeZeusStrike!.strikeId;
    const save = Reflect.get(room, 'saveState') as () => Promise<void>;
    Reflect.set(room, 'saveState', async () => { await save.call(room); throw new Error('evicted before broadcast'); });
    await expect((Reflect.get(room, 'completeZeusStrike') as (id: number) => Promise<void>).call(room, strikeId)).rejects.toThrow('evicted before broadcast');
    const restored = await restart();
    const before = structuredClone(restored.getRoster());
    await (Reflect.get(restored, 'completeZeusStrike') as (id: number) => Promise<void>).call(restored, strikeId);
    expect(restored.getRoster()).toEqual(before);
    expect(restored.getRoster()!.roundEnded).toBe(true);
    expect(restored.getRoster()!.players.filter((p) => p.tank.isDead)).toHaveLength(1);
    expect(Object.values(restored.getRoster()!.roundEarningsByPlayer).reduce((a, b) => a + b, 0)).toBe(75);
    expect(restored.getRoster()!.combatJournal.filter((e) => e.type === 'ZEUS_STRIKE_APPLIED')).toHaveLength(1);
  });
});

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invitationToken(url: string): string {
  const token = new URL(url).searchParams.get('token');
  if (token === null || token.length === 0) {
    throw new Error(`invitation URL missing token: ${url}`);
  }
  return token;
}

interface CreatedRoomSlots {
  slots: Array<{ slot: number; type: string; url: string | null }>;
}

function humanInvitationTokens(json: CreatedRoomSlots): string[] {
  return json.slots
    .filter((slot) => slot.type === 'human')
    .map((slot) => {
      expect(slot.url).toEqual(expect.any(String));
      if (slot.url === null) {
        throw new Error(`human slot ${slot.slot} missing invitation URL`);
      }
      const token = invitationToken(slot.url);
      expect(token).toMatch(UUID_V4);
      expect(slot.url).toContain(`token=${encodeURIComponent(token)}`);
      return token;
    });
}

describe('Authoritative safe round preparation', () => {
  async function startedRoom(withAI = false) {
    const setup = createMockCtx();
    const room = new GameRoom(setup.ctx as DurableObjectState, {});
    Object.defineProperty(room, 'ctx', { value: setup.ctx, writable: true });
    await room.fetchCreate(new Request('http://localhost/internal/create', {
      method: 'POST', body: JSON.stringify({ roomId: 'safe-round', numPlayers: withAI ? 3 : 2,
        slotConfigs: [{ type: 'human' }, { type: 'human' }, ...(withAI ? [{ type: 'ai', aiProfile: 'v1-random' }] : [])], origin: 'http://localhost:5173' }),
    }));
    const sockets = [new MockWebSocket(), new MockWebSocket()];
    const connections = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
    sockets.forEach((ws, i) => connections.set(i, ws as unknown as WebSocket));
    const claim = Reflect.get(room, 'claimHumanSlot') as (slot: number, name: string) => Promise<void>;
    await claim.call(room, 0, 'Alice'); await claim.call(room, 1, 'Bob');
    const state = Reflect.get(room, 'state') as {
      map: RoundMap; players: Player[]; initialRoundPlayers: Player[]; roundNumber: number;
      roundEnded: boolean; shopSession: {
        shopEpoch: number; readySlots: number[]; closingAction: ShopActionAcknowledgement | null;
        purchasesByPlayerId: Record<string, Record<string, number>>; aiShopApplied: boolean;
      } | null;
      preparationAttempt: number; lastCompletedShop: ShopFinishMessage | null;
      processedShopActions: Record<string, { slot: number; result: ShopStateMessage | ShopFinishMessage | ShopRejectedMessage }>;
    };
    const handle = Reflect.get(room, 'handleClientMessage') as (slot: number, raw: string) => Promise<void>;
    const send = (slot: number, value: object) => handle.call(room, slot, JSON.stringify(value));
    return { setup, room, sockets, state, send };
  }

  it('persists the complete first map and roster and reuses them for two clients and retries', async () => {
    const { setup, state, sockets, send } = await startedRoom();
    const first = sockets[0].getAllMessages<GameStartMessage>().find((m) => m.type === 'GAME_START')!;
    const second = sockets[1].getAllMessages<GameStartMessage>().find((m) => m.type === 'GAME_START')!;
    expect(first).toEqual(second);
    expect(hasValidSpawnRoster(first.map, first.players)).toBe(true);
    expect(setup.mockStorage.storageData.get('state')).toMatchObject({ map: first.map, initialRoundPlayers: first.players });
    state.players[1].tank.health = 0;
    state.players[1].tank.isDead = true;
    await send(0, { type: 'REQUEST_GAME_START', protocolVersion: 6, roundNumber: 1, lastSeenShotId: 0, lastAppliedShopEpoch: 0 });
    const retry = sockets[0].getAllMessages<GameStartMessage>().filter((m) => m.type === 'GAME_START').at(-1);
    expect(retry).toEqual(first); // initial combat baseline survives live damage
  });

  it.each([
    ['last READY', false], ['earlier READY', false], ['REQUEST_GAME_START', false],
    ['last READY', true], ['earlier READY', true], ['REQUEST_GAME_START', true],
  ] as const)('keeps purchases and the closing ack on failure and retries via %s (restart: %s)', async (retry, restart) => {
    const { setup, room, sockets, state, send } = await startedRoom(true);
    state.roundEnded = true;
    await send(0, { type: 'SHOP_ENTER', roundNumber: 1 });
    const epoch = state.shopSession!.shopEpoch;
    await send(0, { type: 'SHOP_BUY_SELL', shopEpoch: epoch, actionId: 'buy-safe', weaponId: 'GRENADE', delta: 1 });
    const rosterBefore = structuredClone(state.players);
    const mapBefore = structuredClone(state.map);
    const original = Reflect.get(room, 'prepareRoomRound') as (players: Player[], roundNumber: number) => PreparedRound;
    const prepare = vi.fn().mockReturnValueOnce({ ok: false, reason: 'ROUND_PREPARATION_FAILED' })
      .mockImplementation((players: Player[], roundNumber: number) => original.call(room, players, roundNumber));
    Reflect.set(room, 'prepareRoomRound', prepare);
    await send(0, { type: 'SHOP_READY', shopEpoch: epoch, actionId: 'ready-0' });
    await send(1, { type: 'SHOP_READY', shopEpoch: epoch, actionId: 'ready-1' });
    expect(state.map).toEqual(mapBefore);
    expect(state.players).toEqual(rosterBefore);
    expect(state.roundNumber).toBe(1);
    expect(state.roundEnded).toBe(true);
    expect(state.shopSession).not.toBeNull();
    expect(state.shopSession?.closingAction).toEqual({ slot: 1, actionId: 'ready-1' });
    expect(state.processedShopActions['READY:1:ready-1'].result).toMatchObject({
      type: 'SHOP_STATE', readySlots: [0, 1], acknowledgedAction: { slot: 1, actionId: 'ready-1' },
    });
    expect(state.preparationAttempt).toBe(1);
    expect(sockets[0].getAllMessages<{ type: string }>().some((m) => m.type === 'SHOP_FINISH')).toBe(false);
    let retryRoom = room;
    if (restart) {
      setup.mockStorage.storageData.set('state', structuredClone(setup.mockStorage.storageData.get('state')));
      retryRoom = new GameRoom(setup.ctx as DurableObjectState, {});
      Object.defineProperty(retryRoom, 'ctx', { value: setup.ctx, writable: true });
      const context = setup.ctx as { blockConcurrencyWhile: ReturnType<typeof vi.fn> };
      await context.blockConcurrencyWhile.mock.results.at(-1)?.value;
      const restoredState = Reflect.get(retryRoom, 'state') as typeof state;
      expect(restoredState.shopSession).toEqual(state.shopSession);
      expect(restoredState.players).toEqual(rosterBefore);
      expect(restoredState.preparationAttempt).toBe(1);
      const connections = Reflect.get(retryRoom, 'sockets') as Map<number, WebSocket>;
      sockets.forEach((ws, i) => connections.set(i, ws as unknown as WebSocket));
      prepare.mockImplementation((players: Player[], roundNumber: number) => original.call(retryRoom, players, roundNumber));
      Reflect.set(retryRoom, 'prepareRoomRound', prepare);
    }
    const retryHandle = Reflect.get(retryRoom, 'handleClientMessage') as (slot: number, raw: string) => Promise<void>;
    const retrySend = (slot: number, value: object) => retryHandle.call(retryRoom, slot, JSON.stringify(value));
    const retryState = Reflect.get(retryRoom, 'state') as typeof state;
    if (retry === 'REQUEST_GAME_START') {
      await retrySend(0, { type: 'REQUEST_GAME_START', protocolVersion: 6, roundNumber: 1, lastSeenShotId: 0, lastAppliedShopEpoch: 0 });
    } else {
      const slot = retry === 'last READY' ? 1 : 0;
      await retrySend(slot, { type: 'SHOP_READY', shopEpoch: epoch, actionId: `ready-${slot}` });
      expect(sockets[slot].getLastMessage()).toMatchObject({
        type: 'SHOP_FINISH', acknowledgedAction: { slot, actionId: `ready-${slot}` },
      });
    }
    const finish = retryState.lastCompletedShop!;
    expect(finish.acknowledgedAction).toEqual({ slot: 1, actionId: 'ready-1' });
    expect(finish.map.roundNumber).toBe(2);
    expect(hasValidSpawnRoster(finish.map, finish.players)).toBe(true);
    expect(finish.players.map((p) => p.inventory)).toEqual(rosterBefore.map((p) => p.inventory));
    expect(finish.players.map((p) => p.money)).toEqual(rosterBefore.map((p) => p.money));
    expect(setup.mockStorage.storageData.get('state')).toMatchObject({ map: finish.map, lastCompletedShop: finish });
    expect(sockets[0].getAllMessages<ShopFinishMessage>().find((m) => m.type === 'SHOP_FINISH'))
      .toEqual(sockets[1].getAllMessages<ShopFinishMessage>().find((m) => m.type === 'SHOP_FINISH'));
    retryState.players[0].tank.isDead = true;
    for (const slot of [0, 1]) {
      await retrySend(slot, { type: 'SHOP_READY', shopEpoch: epoch, actionId: `ready-${slot}` });
      expect(sockets[slot].getLastMessage()).toEqual({
        ...finish, acknowledgedAction: { slot, actionId: `ready-${slot}` },
      });
    }
    await retrySend(0, { type: 'SHOP_BUY_SELL', shopEpoch: epoch, actionId: 'buy-safe', weaponId: 'GRENADE', delta: 1 });
    expect(sockets[0].getLastMessage()).toEqual({ ...finish, acknowledgedAction: { slot: 0, actionId: 'buy-safe' } });
    expect(retryState.players[0].tank.isDead).toBe(true);
    expect(retryState.players.map((p) => p.inventory)).toEqual(rosterBefore.map((p) => p.inventory));
    expect(retryState.players.map((p) => p.money)).toEqual(rosterBefore.map((p) => p.money));
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(retryState.lastCompletedShop).toEqual(finish);
    expect(finish.players[0].tank.isDead).toBe(false);
  });

  it('rejects a persisted schema v5 closing shop session with NEW_GAME_REQUIRED without advancing or broadcasting round 2, while v6 completes normally', async () => {
    const setupClosingShop = async (schemaVersion: 5 | 6) => {
      const { setup, room, state, send } = await startedRoom(true);
      state.roundEnded = true;
      await send(0, { type: 'SHOP_ENTER', roundNumber: 1 });
      const epoch = state.shopSession!.shopEpoch;
      await send(0, { type: 'SHOP_BUY_SELL', shopEpoch: epoch, actionId: 'buy-safe', weaponId: 'GRENADE', delta: 1 });

      const original = Reflect.get(room, 'prepareRoomRound') as (players: Player[], roundNumber: number) => PreparedRound;
      const prepare = vi.fn().mockReturnValueOnce({ ok: false, reason: 'ROUND_PREPARATION_FAILED' })
        .mockImplementation((players: Player[], roundNumber: number) => original.call(room, players, roundNumber));
      Reflect.set(room, 'prepareRoomRound', prepare);

      await send(0, { type: 'SHOP_READY', shopEpoch: epoch, actionId: 'ready-0' });
      await send(1, { type: 'SHOP_READY', shopEpoch: epoch, actionId: 'ready-1' });
      expect(state.roundNumber).toBe(1);
      expect(state.shopSession?.readySlots).toEqual([0, 1]);
      expect(state.shopSession?.closingAction).toEqual({ slot: 1, actionId: 'ready-1' });

      const persisted = structuredClone(setup.mockStorage.storageData.get('state')) as Record<string, unknown>;
      persisted.combatSchemaVersion = schemaVersion;
      setup.mockStorage.storageData.set('state', persisted);

      const restored = new GameRoom(setup.ctx as DurableObjectState, {});
      Object.defineProperty(restored, 'ctx', { value: setup.ctx, writable: true });
      const context = setup.ctx as {
        blockConcurrencyWhile: ReturnType<typeof vi.fn>;
        storage: { transaction: ReturnType<typeof vi.fn> };
      };
      await context.blockConcurrencyWhile.mock.results.at(-1)?.value;
      return { setup, restored, storage: context.storage };
    };

    // 1. Persisted v4 room: must refuse with NEW_GAME_REQUIRED before completeShopPhase / authority election / IDENTIFY
    const v4 = await setupClosingShop(5);
    const v4BeforeState = structuredClone(v4.restored.getRoster());
    const v4BeforeStorage = structuredClone(v4.setup.mockStorage.storageData);
    const ws0 = new MockWebSocket();
    const ws1 = new MockWebSocket();
    const connections = Reflect.get(v4.restored, 'sockets') as Map<number, WebSocket>;
    connections.set(0, ws0 as unknown as WebSocket);
    connections.set(1, ws1 as unknown as WebSocket);
    v4.storage.transaction.mockClear();

    const handleV4 = Reflect.get(v4.restored, 'handleClientMessage') as (slot: number, raw: string) => Promise<void>;
    await handleV4.call(v4.restored, 0, JSON.stringify({
      type: 'REQUEST_GAME_START',
      protocolVersion: 6,
      roundNumber: 1,
      lastSeenShotId: 0,
      lastAppliedShopEpoch: 0,
    }));
    await handleV4.call(v4.restored, 0, JSON.stringify({ type: 'IDENTIFY', name: 'RenamedV4' }));
    expect(ws0.getAllMessages()).toHaveLength(1);
    await handleV4.call(v4.restored, 0, JSON.stringify({ type: 'SHOP_ENTER', roundNumber: 1 }));
    const disconnectV4 = Reflect.get(v4.restored, 'handleSocketDisconnect') as (slot: number, ws: WebSocket) => Promise<void>;
    await disconnectV4.call(v4.restored, 0, ws0 as unknown as WebSocket);

    expect(ws0.getAllMessages()).toEqual([
      { type: 'ROUND_PREPARATION_FAILED', reason: 'NEW_GAME_REQUIRED', roundNumber: 1 },
      { type: 'ROUND_PREPARATION_FAILED', reason: 'NEW_GAME_REQUIRED', roundNumber: 1 },
    ]);
    expect(ws1.getAllMessages()).toEqual([]);
    expect(v4.storage.transaction).not.toHaveBeenCalled();
    expect(v4.restored.getRoster()).toEqual(v4BeforeState);
    expect(v4.setup.mockStorage.storageData).toEqual(v4BeforeStorage);

    // 1b. Also verify real WebSocket upgrade path (claimHumanSlotLocked + pendingClaimNames) on v4
    class MockUpgradeWebSocket extends MockWebSocket {
      private listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
      public accept = vi.fn();
      public addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(listener);
        this.listeners.set(type, list);
      }
      public dispatch(type: string, event: { data?: unknown } = {}): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    const OriginalResponse = globalThis.Response;
    let upgradedWs!: MockUpgradeWebSocket;
    class MockWebSocketPair {
      public 0: MockUpgradeWebSocket;
      public 1: MockUpgradeWebSocket;
      constructor() {
        this[0] = new MockUpgradeWebSocket();
        this[1] = new MockUpgradeWebSocket();
        upgradedWs = this[1];
      }
    }
    const WrappedResponse = function (body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
      if (init?.status === 101) {
        return { status: 101, webSocket: init.webSocket } as unknown as Response;
      }
      return new OriginalResponse(body, init);
    } as unknown as typeof Response;
    vi.stubGlobal('WebSocketPair', MockWebSocketPair);
    vi.stubGlobal('Response', WrappedResponse);
    try {
      const stateV4 = v4.restored.getRoster()!;
      const res = await v4.restored.fetch(new Request(
        `http://localhost/ws?room=${stateV4.roomId}&slot=0&token=${stateV4.tokens[0]}&protocolVersion=6`,
        { headers: { Upgrade: 'websocket' } },
      ));
      expect(res.status).toBe(101);
      upgradedWs.dispatch('message', {
        data: JSON.stringify({
          type: 'REQUEST_GAME_START',
          protocolVersion: 6,
          roundNumber: 1,
          lastSeenShotId: 0,
          lastAppliedShopEpoch: 0,
        }),
      });
      await (Reflect.get(v4.restored, 'shotOperation') as Promise<void>);
      const waitUntilCalls = (v4.setup.ctx as { waitUntil: ReturnType<typeof vi.fn> }).waitUntil.mock.calls;
      await waitUntilCalls.at(-1)?.[0];
      await (Reflect.get(v4.restored, 'shotOperation') as Promise<void>);
      expect(upgradedWs.getAllMessages()).toEqual([
        { type: 'ROUND_PREPARATION_FAILED', reason: 'NEW_GAME_REQUIRED', roundNumber: 1 },
      ]);
      expect(v4.storage.transaction).not.toHaveBeenCalled();
      expect(v4.restored.getRoster()).toEqual(v4BeforeState);
      expect(v4.setup.mockStorage.storageData).toEqual(v4BeforeStorage);
    } finally {
      vi.unstubAllGlobals();
    }

    // 2. Persisted v5 room with identical closing shop session: must still advance to round 2 normally
    const v5 = await setupClosingShop(6);
    const v5Ws0 = new MockWebSocket();
    const v5Ws1 = new MockWebSocket();
    const v5Connections = Reflect.get(v5.restored, 'sockets') as Map<number, WebSocket>;
    v5Connections.set(0, v5Ws0 as unknown as WebSocket);
    v5Connections.set(1, v5Ws1 as unknown as WebSocket);
    const handleV5 = Reflect.get(v5.restored, 'handleClientMessage') as (slot: number, raw: string) => Promise<void>;

    await handleV5.call(v5.restored, 0, JSON.stringify({
      type: 'REQUEST_GAME_START',
      protocolVersion: 6,
      roundNumber: 1,
      lastSeenShotId: 0,
      lastAppliedShopEpoch: 0,
    }));

    expect(v5.restored.getRoster()).toMatchObject({
      roundNumber: 2,
      roundEnded: false,
      shopSession: null,
    });
    expect(v5Ws0.getAllMessages<{ type: string }>().map((m) => m.type)).toEqual(
      expect.arrayContaining(['SHOP_FINISH', 'STATE_UPDATE', 'GAME_START', 'COMBAT_CATCH_UP_BEGIN']),
    );
    expect(v5Ws1.getAllMessages<{ type: string }>().map((m) => m.type)).toEqual(
      expect.arrayContaining(['SHOP_FINISH', 'STATE_UPDATE']),
    );
  });

  it.each(['ready-0', 'legacy-ready'] as const)('restores a legacy closing identity only via a valid READY (%s)', async (actionId) => {
    const { setup, room, state, send } = await startedRoom();
    state.roundEnded = true;
    await send(0, { type: 'SHOP_ENTER', roundNumber: 1 });
    await send(0, { type: 'SHOP_READY', shopEpoch: 1, actionId: 'ready-0' });
    // Older persisted sessions could contain all ready slots without a closing action or its index entry.
    state.shopSession!.readySlots = [0, 1];
    Reflect.deleteProperty(state.shopSession!, 'closingAction');
    setup.mockStorage.storageData.set('state', structuredClone(state));
    const restored = new GameRoom(setup.ctx as DurableObjectState, {});
    Object.defineProperty(restored, 'ctx', { value: setup.ctx, writable: true });
    const context = setup.ctx as { blockConcurrencyWhile: ReturnType<typeof vi.fn> };
    await context.blockConcurrencyWhile.mock.results.at(-1)?.value;
    const restoredState = Reflect.get(restored, 'state') as typeof state;
    expect(restoredState.shopSession?.closingAction).toBeNull();
    const socket = new MockWebSocket();
    (Reflect.get(restored, 'sockets') as Map<number, WebSocket>).set(0, socket as unknown as WebSocket);
    const handle = Reflect.get(restored, 'handleClientMessage') as (slot: number, raw: string) => Promise<void>;
    const prepare = vi.spyOn(restored as unknown as { prepareRoomRound: (players: Player[], round: number) => PreparedRound }, 'prepareRoomRound');
    await handle.call(restored, 0, JSON.stringify({ type: 'REQUEST_GAME_START', protocolVersion: 6,
      roundNumber: 1, lastSeenShotId: 0, lastAppliedShopEpoch: 0 }));
    expect(prepare).not.toHaveBeenCalled();
    expect(socket.getAllMessages<{ type: string }>().some((m) => m.type === 'SHOP_STATE')).toBe(true);
    await handle.call(restored, 0, JSON.stringify({ type: 'SHOP_READY', shopEpoch: 0, actionId }));
    expect(prepare).not.toHaveBeenCalled();
    expect(restoredState.shopSession?.closingAction).toBeNull();
    // Use a different ID after a persisted refusal: an action's original refusal must remain stable.
    const validId = actionId === 'legacy-ready' ? 'valid-legacy-ready' : actionId;
    await handle.call(restored, 0, JSON.stringify({ type: 'SHOP_READY', shopEpoch: 1, actionId: validId }));
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(restoredState.lastCompletedShop?.acknowledgedAction).toEqual({ slot: 0, actionId: validId });
    expect(restoredState.shopSession).toBeNull();
    expect(room).not.toBe(restored);
  });

  it('rejects unknown IDs and wrong epochs, preserves refusals and clears the index only at the next shop', async () => {
    const { room, sockets, state, send } = await startedRoom();
    state.roundEnded = true;
    await send(0, { type: 'SHOP_ENTER', roundNumber: 1 });
    await send(0, { type: 'SHOP_BUY_SELL', shopEpoch: 1, actionId: 'refused-sale', weaponId: 'NUKE', delta: -1 });
    const refusal = sockets[0].getLastMessage();
    expect(refusal).toMatchObject({ type: 'SHOP_REJECTED' });
    await send(0, { type: 'SHOP_BUY_SELL', shopEpoch: 1, actionId: 'accepted-buy', weaponId: 'GRENADE', delta: 1 });
    await send(0, { type: 'SHOP_READY', shopEpoch: 1, actionId: 'ready-0' });
    const original = Reflect.get(room, 'prepareRoomRound') as (players: Player[], round: number) => PreparedRound;
    const prepare = vi.fn().mockReturnValueOnce({ ok: false, reason: 'ROUND_PREPARATION_FAILED' })
      .mockImplementation((players: Player[], round: number) => original.call(room, players, round));
    Reflect.set(room, 'prepareRoomRound', prepare);
    await send(1, { type: 'SHOP_READY', shopEpoch: 1, actionId: 'ready-1' });
    await send(0, { type: 'SHOP_READY', shopEpoch: 1, actionId: 'unknown-ready' });
    expect(sockets[0].getLastMessage()).toMatchObject({ type: 'SHOP_REJECTED', reason: 'ALREADY_READY' });
    await send(0, { type: 'SHOP_READY', shopEpoch: 0, actionId: 'ready-0' });
    expect(sockets[0].getLastMessage()).toMatchObject({ type: 'SHOP_REJECTED', reason: 'STALE_SHOP_EPOCH' });
    expect(prepare).toHaveBeenCalledTimes(1);
    await send(1, { type: 'SHOP_READY', shopEpoch: 1, actionId: 'ready-1' });
    const finishedRoster = structuredClone(state.players);
    for (const value of [
      { type: 'SHOP_READY', shopEpoch: 2, actionId: 'ready-0' },
      { type: 'SHOP_BUY_SELL', shopEpoch: 0, actionId: 'accepted-buy', weaponId: 'GRENADE', delta: 1 },
    ]) {
      await send(0, value);
      expect(sockets[0].getLastMessage()).toMatchObject({ type: 'SHOP_REJECTED', reason: 'STALE_SHOP_EPOCH' });
    }
    await send(0, { type: 'SHOP_READY', shopEpoch: 1, actionId: 'never-accepted' });
    expect(sockets[0].getLastMessage()).toMatchObject({ type: 'SHOP_REJECTED', reason: 'SHOP_CLOSED' });
    await send(0, { type: 'SHOP_BUY_SELL', shopEpoch: 1, actionId: 'refused-sale', weaponId: 'NUKE', delta: -1 });
    expect(sockets[0].getLastMessage()).toEqual(refusal);
    await send(0, { type: 'SHOP_READY', shopEpoch: 1, actionId: 'unknown-ready' });
    expect(sockets[0].getLastMessage()).toMatchObject({ type: 'SHOP_REJECTED', reason: 'ALREADY_READY' });
    await send(0, { type: 'SHOP_BUY_SELL', shopEpoch: 1, actionId: 'accepted-buy', weaponId: 'GRENADE', delta: 1 });
    expect(sockets[0].getLastMessage()).toMatchObject({ type: 'SHOP_FINISH', acknowledgedAction: { slot: 0, actionId: 'accepted-buy' } });
    expect(state.players).toEqual(finishedRoster);
    expect(prepare).toHaveBeenCalledTimes(2);
    state.roundEnded = true;
    await send(0, { type: 'SHOP_ENTER', roundNumber: 2 });
    expect(state.processedShopActions).toEqual({});
    expect(state.shopSession?.closingAction).toBeNull();
    await send(0, { type: 'SHOP_READY', shopEpoch: 1, actionId: 'ready-0' });
    expect(sockets[0].getLastMessage()).toMatchObject({ type: 'SHOP_REJECTED', reason: 'STALE_SHOP_EPOCH' });
  });

  it('broadcasts the next map only after storage resolves', async () => {
    const { setup, room, sockets, state, send } = await startedRoom();
    state.roundEnded = true;
    const enter = Reflect.get(room, 'handleShopEnter') as (slot: number, round: number) => Promise<void>;
    await enter.call(room, 0, 1);
    await send(0, { type: 'SHOP_READY', shopEpoch: 1, actionId: 'ready-first' });
    const context = setup.ctx as { storage: { transaction: ReturnType<typeof vi.fn> } };
    const transaction = context.storage.transaction.getMockImplementation()! as (cb: (txn: unknown) => Promise<void>) => Promise<void>;
    const releases: Array<() => void> = [];
    vi.spyOn(context.storage, "transaction").mockImplementation(async (cb) => {
      if (releases.length < 2) await new Promise<void>((resolve) => releases.push(resolve));
      await transaction(cb);
    });
    const completing = send(1, { type: "SHOP_READY", shopEpoch: 1, actionId: "ready-persist" });
    expect(sockets[0].getAllMessages<{ type: string }>().some((m) => m.type === "SHOP_FINISH")).toBe(false);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases[0]();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(sockets[0].getAllMessages<{ type: string }>().some((m) => m.type === "SHOP_FINISH")).toBe(false);
    releases[1](); await completing;
    expect(sockets[0].getAllMessages<{ type: string }>().some((m) => m.type === "SHOP_FINISH")).toBe(true);
  });

  it('retains previous action result on saveState failure during completeShopPhase and replays idempotently', async () => {
    const { setup, room, sockets, state, send } = await startedRoom();
    state.roundEnded = true;
    const enter = Reflect.get(room, 'handleShopEnter') as (slot: number, round: number) => Promise<void>;
    await enter.call(room, 0, 1);

    // Slot 0 becomes ready (saving SHOP_STATE for slot 0)
    await send(0, { type: 'SHOP_READY', shopEpoch: 1, actionId: 'ready-0' });
    expect(sockets[0].getAllMessages<{ type: string }>().some((m) => m.type === 'SHOP_FINISH')).toBe(false);

    // Prepare to intercept the second saveState during slot 1's SHOP_READY:
    // Slot 1's handleShopReady calls saveState once for the SHOP_STATE entry,
    // then completeShopPhase calls saveState a second time to persist the round transition.
    const context = setup.ctx as { storage: { transaction: ReturnType<typeof vi.fn> } };
    const origTransaction = context.storage.transaction.getMockImplementation()! as (cb: (txn: unknown) => Promise<void>) => Promise<void>;
    let txnCount = 0;
    let failRoundTransition = true;
    vi.spyOn(context.storage, 'transaction').mockImplementation(async (cb) => {
      txnCount++;
      if (txnCount === 2 && failRoundTransition) {
        throw new Error('simulated disk failure on round transition save');
      }
      return origTransaction(cb);
    });

    // Slot 1 sends SHOP_READY. The second transaction in completeShopPhase will fail.
    await expect(send(1, { type: 'SHOP_READY', shopEpoch: 1, actionId: 'ready-1' })).rejects.toThrow(
      'simulated disk failure on round transition save',
    );

    // 1. Verify no SHOP_FINISH has been announced to any player
    expect(sockets[0].getAllMessages<{ type: string }>().some((m) => m.type === 'SHOP_FINISH')).toBe(false);
    expect(sockets[1].getAllMessages<{ type: string }>().some((m) => m.type === 'SHOP_FINISH')).toBe(false);

    // 2. Verify state was rolled back to round 1 and shopSession is preserved
    const rosterAfterFailure = room.getRoster()!;
    expect(rosterAfterFailure.roundNumber).toBe(1);
    expect(rosterAfterFailure.shopSession).not.toBeNull();

    // 3. Verify the previous action result was preserved as SHOP_STATE (not corrupted into SHOP_FINISH)
    const ready1ActionKey = 'READY:1:ready-1';
    expect(rosterAfterFailure.processedShopActions[ready1ActionKey]?.result.type).toBe('SHOP_STATE');

    // Allow transactions to succeed now
    failRoundTransition = false;

    // 4. Replay the same SHOP_READY with the exact same idempotence key
    await send(1, { type: 'SHOP_READY', shopEpoch: 1, actionId: 'ready-1' });

    // 5. Verify the server announces SHOP_FINISH only AFTER the successful save
    const finish0 = sockets[0].getAllMessages<ShopFinishMessage>().filter((m) => m.type === 'SHOP_FINISH');
    const finish1 = sockets[1].getAllMessages<ShopFinishMessage>().filter((m) => m.type === 'SHOP_FINISH');
    expect(finish0).toHaveLength(1);
    expect(finish1.length).toBeGreaterThanOrEqual(1);
    expect(finish0[0].nextRoundNumber).toBe(2);
    expect(sockets[1].getLastMessage()).toMatchObject({
      type: 'SHOP_FINISH',
      acknowledgedAction: { slot: 1, actionId: 'ready-1' },
    });

    // 6. Verify that exactly one next round (round 2) was created and committed
    const finalRoster = room.getRoster()!;
    expect(finalRoster.roundNumber).toBe(2);
    expect(finalRoster.shopSession).toBeNull();

    // 7. Replaying once more is a clean idempotent no-op (still round 2, no round 3 created)
    sockets[1].sent.length = 0;
    await send(1, { type: 'SHOP_READY', shopEpoch: 1, actionId: 'ready-1' });
    expect(finalRoster.roundNumber).toBe(2);
  });

  it('does not list storage on first shot of a synchronized round with empty combat cache', async () => {
    const { setup, sockets, send } = await startedRoom();
    const list = (setup.ctx as { storage: { list: ReturnType<typeof vi.fn> } }).storage.list;
    const storage = (setup.ctx as { storage: { put: ReturnType<typeof vi.fn> } }).storage;
    list.mockClear();
    storage.put.mockClear();

    const actionId = 'first-shot-action-id';
    await send(0, {
      type: 'FIRE',
      actionId,
      command: { angle: 45, power: 50, weaponId: 'MISSILE' },
    });

    // Verify no additional txn.list was executed during this shot
    expect(list).toHaveBeenCalledTimes(0);

    // Verify both entries (event and fire idempotence) as well as main state are persisted
    const writtenKeys = storage.put.mock.calls.flatMap(([batch]) => Object.keys(batch as Record<string, unknown>)).sort();
    expect(writtenKeys).toEqual([
      'combat:1:event:1',
      `combat:1:fire:0:${actionId}`,
      'state',
    ]);
    expect(setup.mockStorage.storageData.has('combat:1:event:1')).toBe(true);
    expect(setup.mockStorage.storageData.has(`combat:1:fire:0:${actionId}`)).toBe(true);

    // Verify shot was broadcasted to players
    expect(sockets[0].getAllMessages<{ type: string }>().some((m) => m.type === 'SHOT')).toBe(true);
  });

  it('loads the same map after restart and rejects a legacy room without generating a replacement', async () => {
    const { setup, state } = await startedRoom();
    const before = structuredClone(state.map);
    const restored = new GameRoom(setup.ctx as DurableObjectState, {});
    Object.defineProperty(restored, 'ctx', { value: setup.ctx, writable: true });
    const context = setup.ctx as { blockConcurrencyWhile: ReturnType<typeof vi.fn> };
    await context.blockConcurrencyWhile.mock.results.at(-1)?.value;
    const build = Reflect.get(restored, 'buildGameStartMessage') as () => GameStartMessage | null;
    expect(build.call(restored)?.map).toEqual(before);
    const legacy = Reflect.get(restored, 'state') as { map: RoundMap | null };
    legacy.map = null;
    const prepare = vi.fn(); Reflect.set(restored, 'prepareRoomRound', prepare);
    const socket = new MockWebSocket();
    const catchUp = Reflect.get(restored, 'sendCombatCatchUpToSocket') as (ws: WebSocket, slot: number) => void;
    catchUp.call(restored, socket as unknown as WebSocket, 0);
    expect(socket.getLastMessage()).toMatchObject({ type: 'ROUND_PREPARATION_FAILED', reason: 'NEW_GAME_REQUIRED' });
    expect(prepare).not.toHaveBeenCalled();
  });
});

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

    it('gives each human slot a distinct UUID v4 token encoded in its invitation URL', async () => {
      const req = new Request('http://localhost/api/room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: 'room-tokens',
          numPlayers: 3,
          slotConfigs: [
            { type: 'human' },
            { type: 'ai', aiProfile: 'v1-random' },
            { type: 'human' },
          ],
          origin: 'http://localhost:5173',
        }),
      });

      const res = await room.fetchCreate(req);
      expect(res.status).toBe(200);

      const json = (await res.json()) as CreatedRoomSlots;
      const tokens = humanInvitationTokens(json);

      expect(tokens).toHaveLength(2);
      expect(new Set(tokens).size).toBe(tokens.length);
      expect(json.slots[1].url).toBeNull();
    });

    it('issues different tokens for two separate room creations', async () => {
      const createBody = (roomId: string) =>
        JSON.stringify({
          roomId,
          numPlayers: 2,
          slotConfigs: [{ type: 'human' }, { type: 'human' }],
          origin: 'http://localhost:5173',
        });

      const firstRes = await room.fetchCreate(
        new Request('http://localhost/api/room', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: createBody('room-a'),
        }),
      );
      expect(firstRes.status).toBe(200);
      const firstTokens = humanInvitationTokens(
        (await firstRes.json()) as CreatedRoomSlots,
      );

      const setup2 = createMockCtx();
      const room2 = new GameRoom(setup2.ctx as DurableObjectState, {});
      Object.defineProperty(room2, 'ctx', { value: setup2.ctx, writable: true });

      const secondRes = await room2.fetchCreate(
        new Request('http://localhost/api/room', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: createBody('room-b'),
        }),
      );
      expect(secondRes.status).toBe(200);
      const secondTokens = humanInvitationTokens(
        (await secondRes.json()) as CreatedRoomSlots,
      );

      expect(firstTokens).toHaveLength(2);
      expect(secondTokens).toHaveLength(2);
      expect(new Set([...firstTokens, ...secondTokens]).size).toBe(4);
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
        map: RoundMap;
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
      expect(startMsg0?.map.heights.length).toBe(800);
      expect(startMsg0?.map).toEqual(startMsg1?.map);
      expect(startMsg0?.players).toEqual(startMsg1?.players);
      expect(startMsg0?.map.materials.length).toBe(800);
    });

    it('includes persisted materials on every GAME_START', async () => {
      const ws0 = new MockWebSocket();
      const ws1 = new MockWebSocket();
      const internalSockets = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
      internalSockets.set(0, ws0 as unknown as WebSocket);
      internalSockets.set(1, ws1 as unknown as WebSocket);

      const claimMethod = Reflect.get(room, 'claimHumanSlot') as (s: number, n: string) => Promise<void>;
      await claimMethod.call(room, 0, 'Alice');
      await claimMethod.call(room, 1, 'Bob');

      const state = Reflect.get(room, 'state') as { map: RoundMap };
      const build = Reflect.get(room, 'buildGameStartMessage') as () => {
        type: string;
        map: RoundMap;
      };
      const msg = build.call(room);
      expect(msg.map.materials).toHaveLength(800);
      expect(msg.map).toEqual(state.map);
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

    it('rejects an unversioned REQUEST_GAME_START without catch-up', async () => {
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
      expect(types).not.toContain('COMBAT_CATCH_UP_BEGIN');
      expect(types).toContain('PROTOCOL_MISMATCH');
      expect(ws0.closeCode).toBe(4402);
    });

    it('rejects FIRE without actionId', async () => {
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
      expect(shot).toBeUndefined();
      expect(ws0.getLastMessage<{ type: string }>()?.type).toBe('FIRE_REJECTED');
      expect(ws0.closeCode).toBeUndefined();
    });

    it.each([4, 5, 99])('closes unsupported numeric protocol version %i with 4402', async (receivedVersion) => {
      const handleClientMessage = Reflect.get(room, 'handleClientMessage') as (
        slot: number,
        raw: string
      ) => Promise<void>;
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'REQUEST_GAME_START',
        protocolVersion: receivedVersion,
      }));
      expect(
        ws0.getAllMessages<{ type: string; requiredVersion?: number; receivedVersion?: number | null }>(),
      ).toContainEqual({
        type: 'PROTOCOL_MISMATCH',
        requiredVersion: 6,
        receivedVersion,
      });
      expect(ws0.closeCode).toBe(4402);
    });

    it('accepts REQUEST_GAME_START with protocolVersion 6 and still sends catch-up', async () => {
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
          protocolVersion: 6,
          roundNumber: 1,
          lastSeenShotId: 0,
          lastAppliedShopEpoch: 0,
        }),
      );
      expect(ws0.closeCode).toBeUndefined();
      const types = ws0.getAllMessages<{ type: string }>().map((m) => m.type);
      expect(types).toContain('COMBAT_CATCH_UP_BEGIN');
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
        type: 'SHOT_EARNINGS', players: reportPlayers(room, [false, false]),
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
        type: 'SHOT_EARNINGS', players: reportPlayers(room, [false, false]),
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
            type: 'SHOT', physicsSeed: 1, eventSequence: 4,
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
      expect(rePersisted.processedFireActionsBySlot).toBeUndefined();
      const storage = setup.ctx as { storage: { list: (o: { prefix: string }) => Promise<Map<string, { kind: string }>> } };
      const entries = await storage.storage.list({ prefix: "combat:" });
      expect([...entries.values()].some((entry) => entry.kind === "fire")).toBe(true);
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
        protocolVersion: 6,
        roundNumber: 1,
        lastSeenShotId: shot?.shotId,
        lastAppliedShopEpoch: 0,
      }));
      const catchUp = catchUpSnapshot(ws0);
      expect(catchUp?.activeShotId).toBe(shot?.shotId);
      expect(catchUp?.events.filter((e) => e.type === "SHOT").map((e) => e.shotId)).toContain(shot?.shotId);
      expect(state.players[0].inventory.GRENADE).toBe(0);

      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOT_SETTLED',
        shotId: shot?.shotId,
        slot: 0,
        deadSlots: [false, false],
      }));
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'SHOT_EARNINGS', players: reportPlayers(room, [false, false]),
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
        type: 'SHOT_EARNINGS', players: reportPlayers(room, [false, false]),
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
          type: 'SHOT_EARNINGS', players: reportPlayers(aiRoom, [false, false]),
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

    it('keeps reinforcement isolated by slot and honors duplicate, cancelled and stale actions', async () => {
      const state = Reflect.get(room, 'state') as { players: Player[] };
      state.players[0].money = 420;
      state.players[1].money = 420;
      const handle = Reflect.get(room, 'handleClientMessage') as (slot: number, raw: string) => Promise<void>;
      const buy = { type: 'SHOP_BUY_SELL', shopEpoch: 1, actionId: 'shield-buy', equipmentId: 'REINFORCED_SHIELD', delta: 1 };
      const send = (slot: number, msg: object) => handle.call(room, slot, JSON.stringify(msg));
      await send(0, { ...buy, shopEpoch: 0, actionId: 'shield-stale' });
      expect(ws0.getLastMessage()).toMatchObject({ reason: 'STALE_SHOP_EPOCH' });
      await send(0, buy);
      await send(0, buy);
      const purchase = { type: 'SHOP_STATE', purchasesByPlayerId: { 'player-1': { REINFORCED_SHIELD: 1 } }, players: [
        expect.objectContaining({ money: 0, reinforcedShieldPending: true, tank: expect.objectContaining({ shield: 40 }) }),
        expect.objectContaining({ money: 420 }),
      ] };
      expect(ws0.getLastMessage()).toMatchObject(purchase);
      expect(ws1.getLastMessage()).toMatchObject(purchase);
      const cancel = { ...buy, delta: -1, actionId: 'shield-cancel' };
      await send(0, cancel);
      await send(0, cancel);
      await send(0, { ...buy, actionId: 'shield-rebuy' });
      expect(ws0.getLastMessage()).toMatchObject({ reason: 'PURCHASE_LIMIT' });
      await send(1, buy);
      await send(0, { type: 'SHOP_READY', shopEpoch: 1, actionId: 'shield-ready-0' });
      await send(1, { type: 'SHOP_READY', shopEpoch: 1, actionId: 'shield-ready-1' });
      for (const socket of [ws0, ws1]) {
        const finish = socket.getAllMessages<{ type: string }>().find(msg => msg.type === 'SHOP_FINISH');
        expect(finish).toMatchObject({ nextRoundNumber: 2, players: [
          expect.objectContaining({ money: 420, tank: expect.objectContaining({ shield: 40, maxShield: 40 }) }),
          expect.objectContaining({ money: 0, tank: expect.objectContaining({ shield: 160, maxShield: 40 }) }),
        ] });
      }
      expect(state.players.every(player => player.reinforcedShieldPending === undefined)).toBe(true);
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

    it('rejects legacy shop actions without changing authoritative players', async () => {
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

      expect(state.players[0]).toEqual(authoritative);
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
      expect(state.shopSession?.readySlots).not.toContain(0);

      await handleClientMessage.call(room, 1, JSON.stringify({
        type: 'SHOP_ADVANCE',
        nextIndex: 0,
      }));
      expect(state.shopSession).not.toBeNull();
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

    it.each(['v1-random', 'v2-heuristic'] as const)(
      'rolls occasional nuclears at most once per shop epoch for %s across repeat SHOP_ENTER and GameRoom restore when rolls fail',
      async (aiProfile) => {
        const previousRng: RNG = getRNG();
        try {
          const rolls = [0.1, 0.05];
          let index = 0;
          let drawCount = 0;
          setRNG({
            next() {
              drawCount++;
              return rolls[index++] ?? 0.99;
            },
          });

          const setup = createMockCtx();
          const aiRoom = new GameRoom(setup.ctx as DurableObjectState, {});
          Object.defineProperty(aiRoom, 'ctx', { value: setup.ctx, writable: true });
          await aiRoom.fetchCreate(
            new Request('http://localhost/api/room', {
              method: 'POST',
              body: JSON.stringify({
                roomId: `room-ai-occasional-fail-${aiProfile}`,
                numPlayers: 2,
                slotConfigs: [
                  { type: 'human' },
                  { type: 'ai', aiProfile },
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
          state.players[1].money = 5_000;
          state.players[1].inventory = {};
          const handle = Reflect.get(aiRoom, 'handleClientMessage') as (
            slot: number,
            raw: string,
          ) => Promise<void>;

          await handle.call(
            aiRoom,
            0,
            JSON.stringify({ type: 'SHOP_ENTER', roundNumber: 1 }),
          );

          expect(drawCount).toBe(2);
          const expectedOrdinaryInventory =
            aiProfile === 'v1-random'
              ? { GRENADE: 1, CLUSTER: 1 }
              : { GRENADE: 6, CLUSTER: 6, DRILLER: 2, BULLDOZER: 2 };
          const expectedMoneyAfter =
            aiProfile === 'v1-random'
              ? 5_000 - (75 + 135 + 420)
              : 5_000 - (6 * 75 + 6 * 135 + 2 * 90 + 2 * 150 + 420);
          expect(state.players[1].inventory).toEqual(expectedOrdinaryInventory);
          expect(state.players[1].money).toBe(expectedMoneyAfter);
          expect(state.players[1].tank.currentWeapon).toBe('MISSILE');

          // Changer le RNG vers des tirages gagnants ne doit rien déclencher au RESUME ni après restauration
          setRNG({
            next() {
              drawCount++;
              return 0.01;
            },
          });

          await handle.call(
            aiRoom,
            0,
            JSON.stringify({ type: 'SHOP_ENTER', roundNumber: 1 }),
          );
          expect(drawCount).toBe(2);
          expect(state.players[1].inventory).toEqual(expectedOrdinaryInventory);
          expect(state.players[1].money).toBe(expectedMoneyAfter);

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

          await restoredHandle.call(
            restoredRoom,
            0,
            JSON.stringify({ type: 'SHOP_ENTER', roundNumber: 1 }),
          );
          expect(drawCount).toBe(2);
          expect(restoredState.players[1].inventory).toEqual(
            expectedOrdinaryInventory,
          );
          expect(restoredState.players[1].money).toBe(expectedMoneyAfter);
        } finally {
          setRNG(previousRng);
        }
      },
    );

    it.each(['v1-random', 'v2-heuristic'] as const)(
      'persists and broadcasts occasional NUKE and THERMONUCLEAR purchases once for %s when rolls succeed',
      async (aiProfile) => {
        const previousRng: RNG = getRNG();
        try {
          const rolls = [0.09, 0.04];
          let index = 0;
          let drawCount = 0;
          setRNG({
            next() {
              drawCount++;
              return rolls[index++] ?? 0.99;
            },
          });

          const setup = createMockCtx();
          const aiRoom = new GameRoom(setup.ctx as DurableObjectState, {});
          Object.defineProperty(aiRoom, 'ctx', { value: setup.ctx, writable: true });
          await aiRoom.fetchCreate(
            new Request('http://localhost/api/room', {
              method: 'POST',
              body: JSON.stringify({
                roomId: `room-ai-occasional-win-${aiProfile}`,
                numPlayers: 2,
                slotConfigs: [
                  { type: 'human' },
                  { type: 'ai', aiProfile },
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
            roundEnded: boolean;
            players: Player[];
            shopSession: {
              purchasesByPlayerId: Record<string, Record<string, number>>;
            } | null;
          };
          state.roundEnded = true;
          state.players[1].money = 5_000;
          state.players[1].inventory = {};
          const handle = Reflect.get(aiRoom, 'handleClientMessage') as (
            slot: number,
            raw: string,
          ) => Promise<void>;

          socket.sent.length = 0;
          await handle.call(
            aiRoom,
            0,
            JSON.stringify({ type: 'SHOP_ENTER', roundNumber: 1 }),
          );

          const expectedInventory =
            aiProfile === 'v1-random'
              ? { GRENADE: 1, CLUSTER: 1, NUKE: 1, THERMONUCLEAR: 1 }
              : {
                  GRENADE: 6,
                  CLUSTER: 6,
                  DRILLER: 2,
                  BULLDOZER: 2,
                  NUKE: 1,
                  THERMONUCLEAR: 1,
                };
          const expectedMoneyAfter =
            aiProfile === 'v1-random'
              ? 5_000 - (75 + 135 + 420 + 2_500 + 420)
              : 5_000 - (6 * 75 + 6 * 135 + 2 * 90 + 2 * 150 + 420 + 2_500);

          expect(drawCount).toBe(2);
          expect(state.players[1].inventory).toEqual(expectedInventory);
          expect(state.players[1].money).toBe(expectedMoneyAfter);
          expect(state.players[1].tank.currentWeapon).toBe('MISSILE');
          expect(
            state.shopSession?.purchasesByPlayerId[state.players[1].id],
          ).toEqual(aiProfile === 'v1-random' ? { ...expectedInventory, REINFORCED_SHIELD: 1 } : expectedInventory);

          const shopStateMsg = socket
            .getAllMessages<ShopStateMessage>()
            .find((m) => m.type === 'SHOP_STATE');
          expect(shopStateMsg?.players[1].inventory).toEqual(expectedInventory);
          expect(shopStateMsg?.players[1].money).toBe(expectedMoneyAfter);

          await handle.call(
            aiRoom,
            0,
            JSON.stringify({ type: 'SHOP_ENTER', roundNumber: 1 }),
          );
          expect(drawCount).toBe(2);
        } finally {
          setRNG(previousRng);
        }
      },
    );

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
        'READY:0:ready-0',
        'READY:1:ready-1',
      ]);

      ws0.sent.length = 0;
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'REQUEST_GAME_START',
        protocolVersion: 6,
        roundNumber: 2,
        lastSeenShotId: 0,
        lastAppliedShopEpoch: 0,
      }));
      const catchUpTypes = ws0
        .getAllMessages<{ type: string }>()
        .map((message) => message.type);
      expect(catchUpTypes).toContain('COMBAT_CATCH_UP_BEGIN');
      expect(catchUpTypes).toContain('SHOP_FINISH');
      expect(catchUpTypes.indexOf('COMBAT_CATCH_UP_END')).toBeLessThan(
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
        type: 'SHOT_EARNINGS', players: reportPlayers(room, [false, false]), shotId: roundTwoShot?.shotId, authorityEpoch: 1,
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

    it('refuses mismatched tokens without changing the legitimate socket or room', async () => {
      await room.fetchCreate(new Request('http://localhost/internal/create', {
        method: 'POST', body: JSON.stringify({ roomId: 'synthetic-room', numPlayers: 2,
          slotConfigs: [{ type: 'human' }, { type: 'human' }], origin: 'http://localhost:5173' }),
      }));
      const state = Reflect.get(room, 'state') as { tokens: Record<number, string> };
      state.tokens[0] = 'synthetic-token';
      const legitimate = new MockWebSocket();
      const sockets = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
      sockets.set(0, legitimate as unknown as WebSocket);
      const before = structuredClone(state);
      for (const token of ['Synthetic-token', 'synthetic-Token', 'synthetic-tokeN', '', 'short', 'synthetic-token-long', 'é']) {
        const response = await room.fetch(new Request(
          'http://localhost/ws?room=synthetic-room&slot=0&protocolVersion=6&token=' + encodeURIComponent(token),
          { headers: { Upgrade: 'websocket' } },
        ));
        expect(response.status).toBe(403);
        expect(await response.text()).toBe('Invalid token for slot');
        expect(state).toEqual(before);
        expect(sockets.get(0)).toBe(legitimate);
        expect(legitimate.closeCode).toBeUndefined();
        expect(legitimate.sent).toEqual([]);
      }
    });

    it.each([
      ['protocolVersion=4', 4],
      ['missing protocolVersion', null],
    ] as const)('rejects WebSocket handshake with %s via PROTOCOL_MISMATCH and close 4402', async (_label, expectedReceived) => {
      await room.fetchCreate(new Request('http://localhost/internal/create', {
        method: 'POST', body: JSON.stringify({ roomId: 'ws-mismatch-room', numPlayers: 2,
          slotConfigs: [{ type: 'human' }, { type: 'human' }], origin: 'http://localhost:5173' }),
      }));
      const state = Reflect.get(room, 'state') as { tokens: Record<number, string> };
      const token = state.tokens[0];
      class MismatchSocket extends MockWebSocket {
        public accept = vi.fn();
      }
      let capturedServer!: MismatchSocket;
      class MockWebSocketPair {
        public 0: MismatchSocket;
        public 1: MismatchSocket;
        constructor() {
          this[0] = new MismatchSocket();
          this[1] = new MismatchSocket();
          capturedServer = this[1];
        }
      }
      const OriginalResponse = globalThis.Response;
      const WrappedResponse = function (body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
        if (init?.status === 101) {
          return { status: 101, webSocket: init.webSocket } as unknown as Response;
        }
        return new OriginalResponse(body, init);
      } as unknown as typeof Response;
      vi.stubGlobal('WebSocketPair', MockWebSocketPair);
      vi.stubGlobal('Response', WrappedResponse);
      try {
        const versionQuery = expectedReceived === null ? '' : `&protocolVersion=${expectedReceived}`;
        const response = await room.fetch(new Request(
          `http://localhost/ws?room=ws-mismatch-room&slot=0${versionQuery}&token=${encodeURIComponent(token)}`,
          { headers: { Upgrade: 'websocket' } },
        ));
        expect(response.status).toBe(101);
        expect(capturedServer.accept).toHaveBeenCalledOnce();
        expect(capturedServer.getAllMessages()).toEqual([
          { type: 'PROTOCOL_MISMATCH', requiredVersion: 6, receivedVersion: expectedReceived },
        ]);
        expect(capturedServer.closeCode).toBe(4402);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('does not route sub-path /api/rooms/:id/create or GET /create to fetchCreate', async () => {
      const subPathRes = await room.fetch(
        new Request('http://localhost/api/rooms/room-sub/create', {
          method: 'POST',
          body: JSON.stringify({
            roomId: 'room-sub',
            numPlayers: 2,
            slotConfigs: [{ type: 'human' }, { type: 'human' }],
          }),
        }),
      );
      expect(subPathRes.status).toBe(400);
      expect(await subPathRes.text()).toBe('GameRoom: unsupported');
      expect(room.getRoster()).toBeNull();

      const getCreateRes = await room.fetch(new Request('http://localhost/internal/create'));
      expect(getCreateRes.status).toBe(400);
      expect(await getCreateRes.text()).toBe('GameRoom: unsupported');
      expect(room.getRoster()).toBeNull();
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
      const damagedPlayers = reportPlayers(room, [false, false]);
      damagedPlayers[1].tank.health = 95;
      const base = {
        type: 'SHOT_EARNINGS', players: damagedPlayers, shotId: shot?.shotId, awards: [{ playerId: 'player-1', amount: 10 }],
        deadSlots: [false, false], directHitVictimIds: [], roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
      };
      await handle.call(room, 1, JSON.stringify({ ...base, authorityEpoch: 1 }));
      await handle.call(room, 0, JSON.stringify({ ...base, authorityEpoch: 0 }));
      await handle.call(room, 0, JSON.stringify({ ...base, authorityEpoch: 1, awards: [{ playerId: 'player-1', amount: 1.5 }] }));
      await handle.call(room, 0, JSON.stringify({ ...base, authorityEpoch: 1, awards: [{ playerId: 'player-1', amount: 999_999 }] }));
      const players = (Reflect.get(room, 'state') as { players: Array<{ money: number }> }).players;
      expect(players[0].money).toBe(250);
    });

    it('applies a report atomically once and advances as soon as physics settles', async () => {
      const { ws0, handle } = await startTwoHumanRoom();
      await handle.call(room, 0, JSON.stringify({
        type: 'FIRE', actionId: crypto.randomUUID(), command: { angle: 45, power: 50, weaponId: 'MISSILE' },
      }));
      const shot = ws0.getAllMessages<{ type: string; shotId: number }>().find((message) => message.type === 'SHOT');
      const damagedPlayers = reportPlayers(room, [false, false]);
      damagedPlayers[1].tank.health = 95;
      const report = {
        type: 'SHOT_EARNINGS', players: damagedPlayers, shotId: shot?.shotId, authorityEpoch: 1,
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
        type: 'SHOT_EARNINGS', players: reportPlayers(room, [false, false]), shotId: shot?.shotId, authorityEpoch: 1,
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
      const directHitPlayers = reportPlayers(room, [false, false]);
      directHitPlayers[1].tank.health = 95;
      await handle.call(room, 0, JSON.stringify({
        type: 'SHOT_EARNINGS', players: directHitPlayers, shotId: shot?.shotId, authorityEpoch: 1,
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
      const bulldozerPlayers = reportPlayers(room, [false, false]);
      bulldozerPlayers[0].tank.health = 95;
      await handle.call(room, 0, JSON.stringify({
        type: 'SHOT_EARNINGS', players: bulldozerPlayers, shotId: bulldozerShot?.shotId, authorityEpoch: 1,
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
        type: 'SHOT_EARNINGS', players: reportPlayers(room, [false, false]), shotId: shot?.shotId, authorityEpoch: 1,
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
        protocolVersion: 6,
        roundNumber: 1,
        lastSeenShotId: 0,
        lastAppliedShopEpoch: 0,
      }));

      const types = ws0.getAllMessages<{ type: string }>().map((m) => m.type);
      expect(types).toContain('GAME_START');
      expect(types).toContain('COMBAT_CATCH_UP_END');

      const state = Reflect.get(room, 'state') as {
        shotHistory: ShotMessage[];
        activeShot: { shotId: number } | null;
      };
      const createShot = (shotId: number): ShotMessage => ({
        type: 'SHOT',
        physicsSeed: 1, eventSequence: shotId,
        actionId: `catch-up-${shotId}`,
        shotId,
        roundNumber: 1,
        shotNumberInRound: shotId,
        isFirstShotOfRound: shotId === 1,
        slot: shotId % 2,
        ownerId: `player-${(shotId % 2) + 1}`,
        command: { angle: 45, power: 50, weaponId: 'MISSILE' },
      });
      state.shotHistory = [createShot(1), createShot(2), createShot(3)];
      Reflect.set(state, "combatJournal", state.shotHistory);
      Reflect.set(state, "nextEventSequence", 4);
      Reflect.set(state, "activeShot", { ...createShot(3), shooterSettled: false, earningsApplied: false, zeusEvaluated: false, releaseAt: null, appointment: null });
      ws0.sent.length = 0;
      await handleClientMessage.call(room, 0, JSON.stringify({
        type: 'REQUEST_GAME_START',
        protocolVersion: 6,
        roundNumber: 1,
        lastSeenShotId: 1,
        lastAppliedShopEpoch: 0,
      }));
      const catchUp = catchUpSnapshot(ws0);
      expect(catchUp?.activeShotId).toBe(3);
      expect(catchUp?.events.filter((e) => e.type === "SHOT").map((e) => e.shotId)).toEqual([1, 2, 3]);
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
        type: 'SHOT_EARNINGS', players: reportPlayers(room, [false, true]), shotId: shot?.shotId, authorityEpoch: 1,
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
          type: 'SHOT_EARNINGS', players: reportPlayers(room, [false, true]),
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

    it('restores pending reinforcement across Durable Object cold start and activates it once', async () => {
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

      const initialState = Reflect.get(initialRoom, 'state') as { roundEnded: boolean; players: Player[] };
      initialState.roundEnded = true;
      initialState.players[0].money = 420;
      await handleInitial.call(initialRoom, 0, JSON.stringify({
        type: 'SHOP_ENTER',
        roundNumber: 1,
      }));

      // Slot 0 purchases the reinforcement and confirms the visit.
      await handleInitial.call(initialRoom, 0, JSON.stringify({
        type: 'SHOP_BUY_SELL',
        shopEpoch: 1,
        actionId: 'pre-cold-buy-0',
        equipmentId: 'REINFORCED_SHIELD',
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
      expect(restoredState.players[0]).toMatchObject({ money: 0, reinforcedShieldPending: true, tank: { shield: 40 } });
      expect(restoredState.shopSession?.purchasesByPlayerId['player-1']).toMatchObject({ REINFORCED_SHIELD: 1 });

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
      expect(finalState.players[0]).toMatchObject({ money: 0, tank: { shield: 160, maxShield: 40 } });
      expect(finalState.players[0]).not.toHaveProperty('reinforcedShieldPending');
      expect(finalState.players[1].inventory.DRILLER).toBe(1);
    });

    it('does not persist SHOP_CLOSED rejections, drops oversized ArrayBuffer payloads, and cleans up idle rooms after 24h', async () => {
      vi.useFakeTimers();
      try {
        const baseNow = 1_700_000_000_000;
        vi.setSystemTime(baseNow);
        const setup = createMockCtx();
        const room = new GameRoom(setup.ctx as DurableObjectState, {});
        Object.defineProperty(room, 'ctx', { value: setup.ctx });
        await room.fetchCreate(new Request('http://localhost/internal/create', {
          method: 'POST',
          body: JSON.stringify({
            roomId: 'security-room',
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

        const handle = Reflect.get(room, 'handleClientMessage') as (slot: number, raw: unknown) => Promise<void>;
        await handle.call(room, 0, new ArrayBuffer(9000));

        const state = Reflect.get(room, 'state') as {
          processedShopActions: Record<string, unknown>;
        };
        // Spam SHOP_BUY_SELL while shop is closed
        for (let i = 0; i < 5; i++) {
          await handle.call(room, 0, JSON.stringify({
            type: 'SHOP_BUY_SELL',
            shopEpoch: 1,
            actionId: `closed-${i}`,
            weaponId: 'GRENADE',
            delta: 1,
          }));
        }
        expect(Object.keys(state.processedShopActions)).toEqual([]);

        const disconnect = Reflect.get(room, 'handleSocketDisconnect') as (slot: number, ws: WebSocket) => Promise<void>;
        await disconnect.call(room, 0, ws0 as unknown as WebSocket);
        await disconnect.call(room, 1, ws1 as unknown as WebSocket);
        expect(setup.mockStorage.alarmAt).toBeDefined();

        vi.setSystemTime(baseNow + 24 * 60 * 60 * 1000 + 1);
        await room.alarm();
        expect(Reflect.get(room, 'state')).toBeNull();
        expect(setup.mockStorage.storageData.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('extends the 24h backup alarm on reconnect, protects occupied rooms, and expires restarted rooms without close or after POST /join', async () => {
      vi.useFakeTimers();
      const idleTtlMs = 24 * 60 * 60 * 1000;
      try {
        const baseNow = 1_700_000_000_000;
        vi.setSystemTime(baseNow);
        const setup = createMockCtx();
        const room = new GameRoom(setup.ctx as DurableObjectState, {});
        Object.defineProperty(room, 'ctx', { value: setup.ctx });
        await room.fetchCreate(new Request('http://localhost/internal/create', {
          method: 'POST',
          body: JSON.stringify({
            roomId: 'reconnect-alarm-room',
            numPlayers: 2,
            slotConfigs: [{ type: 'human' }, { type: 'human' }],
            origin: 'http://localhost:5173',
          }),
        }));

        const ws0 = new MockWebSocket();
        const ws1 = new MockWebSocket();
        const sockets = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
        const claim = Reflect.get(room, 'claimHumanSlot') as (slot: number, name: string, ws?: WebSocket) => Promise<void>;
        const disconnect = Reflect.get(room, 'handleSocketDisconnect') as (slot: number, ws: WebSocket) => Promise<void>;

        sockets.set(0, ws0 as unknown as WebSocket);
        await claim.call(room, 0, 'Alice', ws0 as unknown as WebSocket);
        sockets.set(1, ws1 as unknown as WebSocket);
        await claim.call(room, 1, 'Bob', ws1 as unknown as WebSocket);
        expect(setup.mockStorage.alarmAt).toBe(baseNow + idleTtlMs);

        // Cas 1 : déconnexion complète puis reconnexion avec élection d'autorité (electEarningsAuthority)
        await disconnect.call(room, 0, ws0 as unknown as WebSocket);
        await disconnect.call(room, 1, ws1 as unknown as WebSocket);
        expect(setup.mockStorage.alarmAt).toBe(baseNow + idleTtlMs);

        const reconnect1At = baseNow + 10_000;
        vi.setSystemTime(reconnect1At);
        const ws0b = new MockWebSocket();
        sockets.set(0, ws0b as unknown as WebSocket);
        await claim.call(room, 0, 'Alice', ws0b as unknown as WebSocket);
        expect(setup.mockStorage.alarmAt).toBe(reconnect1At + idleTtlMs);
        expect(room.getRoster()?.lastActivityAt).toBe(reconnect1At);

        // Cas 2 : après démarrage à froid avec autorité déjà sur le slot 0,
        // reconnexion du slot 0 sans changement d'autorité ni de nom (needsIdleRefreshOnReconnect === true)
        const coldStarted = new GameRoom(setup.ctx as DurableObjectState, {});
        Object.defineProperty(coldStarted, 'ctx', { value: setup.ctx });
        await (setup.ctx as { blockConcurrencyWhile: ReturnType<typeof vi.fn> }).blockConcurrencyWhile.mock.results.at(-1)!.value;
        const reconnect2At = reconnect1At + 5_000;
        vi.setSystemTime(reconnect2At);
        const ws0c = new MockWebSocket();
        const coldSockets = Reflect.get(coldStarted, 'sockets') as Map<number, WebSocket>;
        coldSockets.set(0, ws0c as unknown as WebSocket);
        const coldClaim = Reflect.get(coldStarted, 'claimHumanSlot') as (slot: number, name: string, ws?: WebSocket) => Promise<void>;
        await coldClaim.call(coldStarted, 0, 'Alice', ws0c as unknown as WebSocket);
        expect(setup.mockStorage.alarmAt).toBe(reconnect2At + idleTtlMs);
        expect(coldStarted.getRoster()?.lastActivityAt).toBe(reconnect2At);

        // Cas 3 : la salle reste occupée lorsque l'alarme se déclenche -> préservée et reportée de 24 h
        const occupiedAlarmAt = reconnect2At + idleTtlMs;
        vi.setSystemTime(occupiedAlarmAt);
        setup.mockStorage.alarmAt = undefined;
        await coldStarted.alarm();
        expect(coldStarted.getRoster()).not.toBeNull();
        expect(coldStarted.getRoster()?.lastActivityAt).toBe(occupiedAlarmAt);
        expect(setup.mockStorage.alarmAt).toBe(occupiedAlarmAt + idleTtlMs);

        // Cas 4 : arrêt brutal du DO sans événement close ni requête ultérieure -> expire à l'échéance reportée
        const restartedWithoutClose = new GameRoom(setup.ctx as DurableObjectState, {});
        Object.defineProperty(restartedWithoutClose, 'ctx', { value: setup.ctx });
        await (setup.ctx as { blockConcurrencyWhile: ReturnType<typeof vi.fn> }).blockConcurrencyWhile.mock.results.at(-1)!.value;
        expect(setup.mockStorage.alarmAt).toBe(occupiedAlarmAt + idleTtlMs);

        vi.setSystemTime(occupiedAlarmAt + idleTtlMs - 1);
        setup.mockStorage.alarmAt = undefined;
        await restartedWithoutClose.alarm();
        expect(restartedWithoutClose.getRoster()).not.toBeNull();
        expect(setup.mockStorage.alarmAt).toBe(occupiedAlarmAt + idleTtlMs);

        // Même après un POST /join réussi sur le DO redémarré sans socket actif, l'alarme reste armée et purge la salle
        const joinResp = await restartedWithoutClose.fetch(
          new Request('https://internal/api/rooms/reconnect-alarm-room/join', { method: 'POST' }),
        );
        expect(joinResp.status).toBe(200);
        expect(setup.mockStorage.alarmAt).toBe(occupiedAlarmAt + idleTtlMs);

        vi.setSystemTime(occupiedAlarmAt + idleTtlMs);
        setup.mockStorage.alarmAt = undefined;
        await restartedWithoutClose.alarm();
        expect(restartedWithoutClose.getRoster()).toBeNull();
        expect(setup.mockStorage.storageData.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('self-heals missing idle alarms on cold start before POST /join and transitions from shot or Zeus deadlines in occupied rooms', async () => {
      vi.useFakeTimers();
      const idleTtlMs = 24 * 60 * 60 * 1000;
      try {
        const baseNow = 1_700_000_000_000;
        vi.setSystemTime(baseNow);
        const setup = createMockCtx();
        const room = new GameRoom(setup.ctx as DurableObjectState, {});
        Object.defineProperty(room, 'ctx', { value: setup.ctx });
        await room.fetchCreate(new Request('http://localhost/internal/create', {
          method: 'POST',
          body: JSON.stringify({
            roomId: 'deadline-handoff-room',
            numPlayers: 2,
            slotConfigs: [{ type: 'human' }, { type: 'human' }],
            origin: 'http://localhost:5173',
          }),
        }));

        const ws0 = new MockWebSocket();
        const ws1 = new MockWebSocket();
        const sockets = Reflect.get(room, 'sockets') as Map<number, WebSocket>;
        const claim = Reflect.get(room, 'claimHumanSlot') as (slot: number, name: string, ws?: WebSocket) => Promise<void>;
        const handle = Reflect.get(room, 'handleClientMessage') as (slot: number, raw: string) => Promise<void>;

        sockets.set(0, ws0 as unknown as WebSocket);
        await claim.call(room, 0, 'Alice', ws0 as unknown as WebSocket);
        sockets.set(1, ws1 as unknown as WebSocket);
        await claim.call(room, 1, 'Bob', ws1 as unknown as WebSocket);

        // 1. Tir occupé : échéance de récupération (20 s) -> bascule vers l'échéance d'inactivité (24 h)
        const shot1At = baseNow + 1_000;
        vi.setSystemTime(shot1At);
        await handle.call(room, 0, JSON.stringify({
          type: 'FIRE',
          actionId: 'occupied-shot-1',
          command: { angle: 45, power: 50, weaponId: 'MISSILE' },
        }));
        const shot1 = room.getRoster()!.activeShot!;
        expect(setup.mockStorage.alarmAt).toBe(shot1At + 20_000);

        const settle1At = shot1At + 500;
        vi.setSystemTime(settle1At);
        await handle.call(room, 0, JSON.stringify({
          type: 'SHOT_SETTLED',
          shotId: shot1.shotId,
          slot: 0,
          deadSlots: [false, false],
        }));
        await handle.call(room, 0, JSON.stringify({
          type: 'SHOT_EARNINGS',
          shotId: shot1.shotId,
          authorityEpoch: room.getRoster()!.authorityEpoch,
          players: reportPlayers(room),
          awards: [],
          deadSlots: [false, false],
          directHitVictimIds: [],
          roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
        }));
        expect(room.getRoster()!.activeShot).toBeNull();
        expect(setup.mockStorage.alarmAt).toBe(settle1At + idleTtlMs);

        // 2. Frappe Zeus occupée : échéance resolveAt (700 ms) -> bascule vers l'échéance d'inactivité (24 h)
        room.getRoster()!.zeusState.shotsWithoutEarnings = 9;
        const shot2At = settle1At + 1_000;
        vi.setSystemTime(shot2At);
        await handle.call(room, 1, JSON.stringify({
          type: 'FIRE',
          actionId: 'occupied-shot-2',
          command: { angle: 45, power: 50, weaponId: 'MISSILE' },
        }));
        const shot2 = room.getRoster()!.activeShot!;
        await handle.call(room, 1, JSON.stringify({
          type: 'SHOT_SETTLED',
          shotId: shot2.shotId,
          slot: 1,
          deadSlots: [false, false],
        }));
        await handle.call(room, 0, JSON.stringify({
          type: 'SHOT_EARNINGS',
          shotId: shot2.shotId,
          authorityEpoch: room.getRoster()!.authorityEpoch,
          players: reportPlayers(room),
          awards: [],
          deadSlots: [false, false],
          directHitVictimIds: [],
          roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
        }));
        await vi.advanceTimersByTimeAsync(0);
        const strike = room.getRoster()!.activeZeusStrike!;
        expect(setup.mockStorage.alarmAt).toBe(strike.resolveAt);

        vi.setSystemTime(strike.resolveAt);
        await vi.advanceTimersByTimeAsync(700);
        expect(room.getRoster()!.activeZeusStrike).toBeNull();
        const afterZeusExpiry = Date.now() + idleTtlMs;
        expect(setup.mockStorage.alarmAt).toBe(afterZeusExpiry);

        // 3. Auto-réparation d'une salle persistée dont l'alarme manquait avant redémarrage + POST /join
        setup.mockStorage.alarmAt = undefined;
        const healedRoom = new GameRoom(setup.ctx as DurableObjectState, {});
        Object.defineProperty(healedRoom, 'ctx', { value: setup.ctx });
        await (setup.ctx as { blockConcurrencyWhile: ReturnType<typeof vi.fn> }).blockConcurrencyWhile.mock.results.at(-1)!.value;
        expect(setup.mockStorage.alarmAt).toBe(afterZeusExpiry);

        const joinResp = await healedRoom.fetch(
          new Request('https://internal/api/rooms/deadline-handoff-room/join', { method: 'POST' }),
        );
        expect(joinResp.status).toBe(200);

        vi.setSystemTime(afterZeusExpiry);
        setup.mockStorage.alarmAt = undefined;
        await healedRoom.alarm();
        expect(healedRoom.getRoster()).toBeNull();
        expect(setup.mockStorage.storageData.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('logs WebSocket rate-limit warnings at most once per window per slot', async () => {
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const baseNow = 1_700_000_000_000;
        vi.setSystemTime(baseNow);
        const setup = createMockCtx();
        const room = new GameRoom(setup.ctx as DurableObjectState, {});
        Object.defineProperty(room, 'ctx', { value: setup.ctx });
        await room.fetchCreate(new Request('http://localhost/internal/create', {
          method: 'POST',
          body: JSON.stringify({
            roomId: 'rate-warn-room',
            numPlayers: 2,
            slotConfigs: [{ type: 'human' }, { type: 'human' }],
            origin: 'http://localhost:5173',
          }),
        }));

        const handle = Reflect.get(room, 'handleClientMessage') as (slot: number, raw: unknown) => Promise<void>;
        for (let i = 0; i < 150; i++) {
          await handle.call(room, 0, '{}');
        }
        const rateWarnings = warnSpy.mock.calls.filter(([msg]) =>
          typeof msg === 'string' && msg.includes('Rate-limiting WebSocket messages'),
        );
        expect(rateWarnings).toHaveLength(1);

        vi.setSystemTime(baseNow + 5_001);
        for (let i = 0; i < 125; i++) {
          await handle.call(room, 0, '{}');
        }
        const rateWarningsAfterWindow = warnSpy.mock.calls.filter(([msg]) =>
          typeof msg === 'string' && msg.includes('Rate-limiting WebSocket messages'),
        );
        expect(rateWarningsAfterWindow).toHaveLength(2);
      } finally {
        warnSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('closes a WebSocket with 1008 after sustained rate-limit violations', async () => {
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        vi.setSystemTime(1_700_000_000_000);
        const setup = createMockCtx();
        const room = new GameRoom(setup.ctx as DurableObjectState, {});
        Object.defineProperty(room, 'ctx', { value: setup.ctx });
        await room.fetchCreate(new Request('http://localhost/internal/create', {
          method: 'POST',
          body: JSON.stringify({
            roomId: 'rate-close-room',
            numPlayers: 2,
            slotConfigs: [{ type: 'human' }, { type: 'human' }],
            origin: 'http://localhost:5173',
          }),
        }));

        const ws0 = new MockWebSocket();
        (Reflect.get(room, 'sockets') as Map<number, WebSocket>).set(0, ws0 as unknown as WebSocket);
        const handle = Reflect.get(room, 'handleClientMessage') as (slot: number, raw: unknown) => Promise<void>;
        for (let i = 0; i < 120 + 240; i++) {
          await handle.call(room, 0, '{}');
        }
        expect(ws0.closeCode).toBe(1008);
      } finally {
        warnSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('bounds accepted BUY_SELL entries in processedShopActions via FIFO eviction while preserving READY', async () => {
      const setup = createMockCtx();
      const room = new GameRoom(setup.ctx as DurableObjectState, {});
      Object.defineProperty(room, 'ctx', { value: setup.ctx });
      await room.fetchCreate(new Request('http://localhost/internal/create', {
        method: 'POST',
        body: JSON.stringify({
          roomId: 'shop-cap-room',
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

      const state = Reflect.get(room, 'state') as {
        roundEnded: boolean;
        players: Player[];
        processedShopActions: Record<string, { slot: number; result: ShopRejectedMessage }>;
      };
      state.roundEnded = true;
      const handle = Reflect.get(room, 'handleClientMessage') as (slot: number, raw: unknown) => Promise<void>;
      await handle.call(room, 0, JSON.stringify({ type: 'SHOP_ENTER', roundNumber: 1 }));
      await handle.call(room, 0, JSON.stringify({ type: 'SHOP_READY', shopEpoch: 1, actionId: 'ready-0' }));

      // Seed 511 prior BUY_SELL entries so total reaches 512 (MAX_PROCESSED_SHOP_ACTIONS)
      for (let i = 0; i < 511; i++) {
        state.processedShopActions[`BUY_SELL:1:pre-${i}`] = {
          slot: 1,
          result: { type: 'SHOP_REJECTED', shopEpoch: 1, actionId: `pre-${i}`, reason: 'NO_STOCK' },
        };
      }

      state.players[1].inventory.GRENADE = 10;
      for (let i = 0; i < 5; i++) {
        await handle.call(room, 1, JSON.stringify({
          type: 'SHOP_BUY_SELL',
          shopEpoch: 1,
          actionId: `sell-${i}`,
          weaponId: 'GRENADE',
          delta: -1,
        }));
      }

      const keys = Object.keys(state.processedShopActions);
      expect(keys.length).toBe(512);
      expect(Object.hasOwn(state.processedShopActions, 'READY:0:ready-0')).toBe(true);
      expect(Object.hasOwn(state.processedShopActions, 'BUY_SELL:1:pre-0')).toBe(false);
      expect(Object.hasOwn(state.processedShopActions, 'BUY_SELL:1:pre-4')).toBe(false);
      expect(Object.hasOwn(state.processedShopActions, 'BUY_SELL:1:pre-5')).toBe(true);
      expect(Object.hasOwn(state.processedShopActions, 'BUY_SELL:1:sell-4')).toBe(true);
    });

    it('never calls saveState on an incompatible started room during disconnect or alarm without lastActivityAt', async () => {
      vi.useFakeTimers();
      const idleTtlMs = 24 * 60 * 60 * 1000;
      try {
        const now = 1_700_000_000_000;
        vi.setSystemTime(now);
        const setup = createMockCtx();
        const room = new GameRoom(setup.ctx as DurableObjectState, {});
        Object.defineProperty(room, 'ctx', { value: setup.ctx });
        await room.fetchCreate(new Request('http://localhost/internal/create', {
          method: 'POST',
          body: JSON.stringify({
            roomId: 'legacy-alarm-room',
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

        const persisted = structuredClone(setup.mockStorage.storageData.get('state')) as Record<string, unknown>;
        persisted.combatSchemaVersion = 5;
        delete persisted.lastActivityAt;
        setup.mockStorage.storageData.set('state', persisted);

        const reloaded = new GameRoom(setup.ctx as DurableObjectState, {});
        Object.defineProperty(reloaded, 'ctx', { value: setup.ctx });
        await (setup.ctx as { blockConcurrencyWhile: ReturnType<typeof vi.fn> }).blockConcurrencyWhile.mock.results.at(-1)!.value;

        const context = setup.ctx as { storage: { transaction: ReturnType<typeof vi.fn> } };
        context.storage.transaction.mockClear();

        await reloaded.alarm();
        expect(context.storage.transaction).not.toHaveBeenCalled();
        expect(setup.mockStorage.alarmAt).toBe(now + idleTtlMs);

        const wsLegacy = new MockWebSocket();
        (Reflect.get(reloaded, 'sockets') as Map<number, WebSocket>).set(1, wsLegacy as unknown as WebSocket);
        const disconnect = Reflect.get(reloaded, 'handleSocketDisconnect') as (slot: number, ws: WebSocket) => Promise<void>;
        await disconnect.call(reloaded, 1, wsLegacy as unknown as WebSocket);
        expect(context.storage.transaction).not.toHaveBeenCalled();
        expect(setup.mockStorage.alarmAt).toBe(now + idleTtlMs);
      } finally {
        vi.useRealTimers();
      }
    });

    it('preserves null prototype on processedFireActionsBySlot after a failed saveState rollback', async () => {
      const setup = createMockCtx();
      const room = new GameRoom(setup.ctx as DurableObjectState, {});
      Object.defineProperty(room, 'ctx', { value: setup.ctx });
      await room.fetchCreate(new Request('http://localhost/internal/create', {
        method: 'POST',
        body: JSON.stringify({
          roomId: 'rollback-proto-room',
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

      const handle = Reflect.get(room, 'handleClientMessage') as (slot: number, raw: unknown) => Promise<void>;
      await handle.call(room, 0, JSON.stringify({
        type: 'FIRE',
        actionId: 'fire-1',
        command: { angle: 45, power: 50, weaponId: 'MISSILE' },
      }));

      const context = setup.ctx as { storage: { transaction: ReturnType<typeof vi.fn> } };
      context.storage.transaction.mockRejectedValueOnce(new Error('storage failure'));
      const saveState = Reflect.get(room, 'saveState') as () => Promise<void>;
      await expect(saveState.call(room)).rejects.toThrow('storage failure');

      const state = Reflect.get(room, 'state') as {
        processedFireActionsBySlot: Record<number, Record<string, unknown>>;
      };
      expect(Object.getPrototypeOf(state.processedFireActionsBySlot[0])).toBeNull();
    });

    it('validates slotConfigs in fetchCreate, treats Upgrade case-insensitively, and sends null for non-numeric protocolVersion', async () => {
      const setup = createMockCtx();
      const room = new GameRoom(setup.ctx as DurableObjectState, {});
      Object.defineProperty(room, 'ctx', { value: setup.ctx });

      const badLength = await room.fetchCreate(new Request('http://localhost/internal/create', {
        method: 'POST',
        body: JSON.stringify({
          roomId: 'bad-slots-length',
          numPlayers: 2,
          slotConfigs: [{ type: 'human' }],
        }),
      }));
      expect(badLength.status).toBe(400);

      const badType = await room.fetchCreate(new Request('http://localhost/internal/create', {
        method: 'POST',
        body: JSON.stringify({
          roomId: 'bad-slots-type',
          numPlayers: 2,
          slotConfigs: [{ type: 'human' }, { type: 'evil' }],
        }),
      }));
      expect(badType.status).toBe(400);

      const postUpgrade = await room.fetch(new Request('http://localhost/internal/create', {
        method: 'POST',
        headers: { Upgrade: 'WebSocket' },
        body: JSON.stringify({
          roomId: 'ws-upgrade-post',
          numPlayers: 2,
          slotConfigs: [{ type: 'human' }, { type: 'human' }],
        }),
      }));
      expect(postUpgrade.status).toBe(404);
      expect(room.getRoster()).toBeNull();

      await room.fetchCreate(new Request('http://localhost/internal/create', {
        method: 'POST',
        body: JSON.stringify({
          roomId: 'ws-alpha-version-room',
          numPlayers: 2,
          slotConfigs: [{ type: 'human' }, { type: 'human' }],
          origin: 'http://localhost:5173',
        }),
      }));
      const token = (Reflect.get(room, 'state') as { tokens: string[] }).tokens[0];

      class AlphaSocket extends MockWebSocket {
        public accept = vi.fn();
      }
      let capturedServer!: AlphaSocket;
      class AlphaWebSocketPair {
        public 0: AlphaSocket;
        public 1: AlphaSocket;
        constructor() {
          this[0] = new AlphaSocket();
          this[1] = new AlphaSocket();
          capturedServer = this[1];
        }
      }
      const OriginalResponse = globalThis.Response;
      const WrappedResponse = function (body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
        if (init?.status === 101) {
          return { status: 101, webSocket: init.webSocket } as unknown as Response;
        }
        return new OriginalResponse(body, init);
      } as unknown as typeof Response;
      vi.stubGlobal('WebSocketPair', AlphaWebSocketPair);
      vi.stubGlobal('Response', WrappedResponse);
      try {
        const res = await room.fetch(new Request(
          `http://localhost/ws?room=ws-alpha-version-room&slot=0&protocolVersion=abc&token=${encodeURIComponent(token)}`,
          { headers: { Upgrade: 'WebSocket' } },
        ));
        expect(res.status).toBe(101);
        expect(capturedServer.getAllMessages()).toEqual([
          { type: 'PROTOCOL_MISMATCH', requiredVersion: 6, receivedVersion: null },
        ]);
        expect(capturedServer.closeCode).toBe(4402);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
