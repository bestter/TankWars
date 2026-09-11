import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  persistOnlineSession,
  readOnlineSession,
  clearOnlineSession,
  isFireRejectedReason,
  isShopDenial,
  isShopClientSessionState,
  type PersistedOnlineSession,
} from '../onlineSession';
import { makePlayer } from '../../game/__tests__/helpers';
import { createEmptyShopSession } from '../../components/gameCanvasReducer';

function installSessionStorageMock(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  });
  return store;
}

function makeSession(overrides: Partial<PersistedOnlineSession> = {}): PersistedOnlineSession {
  const player = makePlayer({ id: 'player-1', name: 'Host' });
  return {
    meta: {
      roomId: 'room-abc',
      localPlayerId: 'player-1',
      slot: 0,
      token: 'TOKEN1',
      initialHeights: [100, 101, 102],
      initialMaterials: ['DIRT', 'ROCK'],
      initialWind: 12,
      initialCurrentPlayerIndex: 0,
    },
    players: [player],
    canvas: {
      gamePhase: 'COMBAT',
      currentManche: 1,
      uiPlayers: [player],
      shopPlayers: [player],
      currentShopIndex: 0,
      roundResult: null,
      lastRoundOutcome: null,
      wind: 12,
      authoritySlot: 0,
      authorityEpoch: 1,
      lastAppliedShotId: 0,
      lastAppliedZeusStrikeId: 0,
      roundEarningsByPlayer: {},
      earningsOverlay: null,
      shopSession: createEmptyShopSession(),
      lastAppliedShopEpoch: 0,
      lastCompletedRoundNumber: 0,
      lastSeenShotId: 0,
      pendingFireIntent: null,
      fireRejection: null,
    },
    ...overrides,
  };
}

describe('onlineSession', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installSessionStorageMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('persists and reads a valid online session round-trip', () => {
    const session = makeSession();
    persistOnlineSession(session);

    expect(readOnlineSession()).toEqual(session);
    expect(store.has('tankwars-online-session-v1')).toBe(true);
  });

  it('accepts the two-field hitReaction contract', () => {
    const session = makeSession();
    const player = {
      ...session.players[0],
      tank: {
        ...session.players[0].tank,
        hitReaction: { wasDirectHit: true, fallDistance: 42 },
      },
    };
    session.players = [player];
    session.canvas.uiPlayers = [player];
    session.canvas.shopPlayers = [player];

    persistOnlineSession(session);
    expect(readOnlineSession()?.players[0].tank.hitReaction).toEqual({
      wasDirectHit: true,
      fallDistance: 42,
    });
  });

  it('keeps accepting a legacy snapshot with an ignored shotStep field', () => {
    const session = makeSession();
    const player = {
      ...session.players[0],
      tank: {
        ...session.players[0].tank,
        hitReaction: {
          wasDirectHit: true,
          fallDistance: 42,
          shotStep: 2,
        },
      },
    };
    session.players = [player];
    session.canvas.uiPlayers = [player];
    session.canvas.shopPlayers = [player];

    persistOnlineSession(session);
    expect(readOnlineSession()).not.toBeNull();
  });

  it.each([42, 120, Number.MAX_VALUE])('normalizes persisted reaction distance %s without mutating live state', (distance) => {
    const session = makeSession();
    session.players[0].tank.hitReaction = { wasDirectHit: true, fallDistance: distance };
    persistOnlineSession(session);
    const serialized = store.get('tankwars-online-session-v1') ?? '';
    expect(serialized).toContain('"fallDistance":' + Math.min(120, distance));
    expect(session.players[0].tank.hitReaction.fallDistance).toBe(distance);

    // Bypass the writer to exercise snapshots produced before the cap existed.
    store.set('tankwars-online-session-v1', JSON.stringify(session));
    const restored = readOnlineSession();
    for (const player of [
      ...(restored?.players ?? []),
      ...(restored?.canvas.uiPlayers ?? []),
      ...(restored?.canvas.shopPlayers ?? []),
    ]) {
      expect(player.tank.hitReaction).toEqual({
        wasDirectHit: true,
        fallDistance: Math.min(120, distance),
      });
    }
    expect(restored).not.toBeNull();
  });

  it('persists a pending FIRE intent with its original actionId and command', () => {
    const session = makeSession();
    session.canvas.pendingFireIntent = {
      actionId: 'fire-before-refresh',
      command: { angle: 42, power: 73, weaponId: 'GRENADE' },
    };

    persistOnlineSession(session);

    expect(readOnlineSession()?.canvas.pendingFireIntent).toEqual(
      session.canvas.pendingFireIntent,
    );
  });

  it('drops persisted FIRE and shop intents whose actionId exceeds 64 characters', () => {
    const session = makeSession();
    store.set(
      'tankwars-online-session-v1',
      JSON.stringify({
        ...session,
        canvas: {
          ...session.canvas,
          pendingFireIntent: {
            actionId: 'f'.repeat(65),
            command: { angle: 42, power: 73, weaponId: 'GRENADE' },
          },
          shopSession: {
            ...createEmptyShopSession(),
            epoch: 1,
            roundNumber: 1,
            pendingIntent: {
              kind: 'READY',
              actionId: 's'.repeat(65),
              shopEpoch: 1,
            },
          },
        },
      }),
    );

    const restored = readOnlineSession();
    expect(restored).not.toBeNull();
    expect(restored?.canvas.pendingFireIntent).toBeNull();
    expect(restored?.canvas.shopSession).toEqual(createEmptyShopSession());
  });

  it('returns null when storage is empty', () => {
    expect(readOnlineSession()).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    store.set('tankwars-online-session-v1', '{not-json');
    expect(readOnlineSession()).toBeNull();
  });

  it('returns null when roomId is missing', () => {
    const session = makeSession();
    persistOnlineSession({
      ...session,
      meta: { ...session.meta, roomId: '' },
    });
    expect(readOnlineSession()).toBeNull();
  });

  it.each([
    ['localPlayerId', ''],
    ['token', '   '],
    ['slot', Number.MAX_SAFE_INTEGER + 1],
  ] as const)('returns null when meta.%s is invalid', (key, value) => {
    const session = makeSession();
    store.set(
      'tankwars-online-session-v1',
      JSON.stringify({
        ...session,
        meta: { ...session.meta, [key]: value },
      }),
    );

    expect(readOnlineSession()).toBeNull();
  });

  it('returns null when players is not an array', () => {
    store.set(
      'tankwars-online-session-v1',
      JSON.stringify({
        meta: { roomId: 'x', localPlayerId: 'p1', slot: 0, token: 't' },
        players: null,
        canvas: makeSession().canvas,
      }),
    );
    expect(readOnlineSession()).toBeNull();
  });

  it('rejects a player whose nested weapon is not valid', () => {
    const session = makeSession();
    const invalidPlayer = {
      ...session.players[0],
      tank: { ...session.players[0].tank, currentWeapon: 'LASER' },
    };
    store.set(
      'tankwars-online-session-v1',
      JSON.stringify({
        ...session,
        players: [invalidPlayer],
      }),
    );

    expect(readOnlineSession()).toBeNull();
  });

  it('drops invalid materials, FIRE intent, result and overlay instead of casting them', () => {
    const session = makeSession();
    store.set(
      'tankwars-online-session-v1',
      JSON.stringify({
        ...session,
        meta: {
          ...session.meta,
          initialMaterials: ['DIRT', 'LAVA'],
        },
        canvas: {
          ...session.canvas,
          pendingFireIntent: {
            actionId: 'invalid-fire',
            command: { angle: 45, power: 50, weaponId: 'LASER' },
          },
          roundResult: { damageDealt: {} },
          lastRoundOutcome: { isDraw: 'yes', winner: null },
          earningsOverlay: {
            shotId: 1,
            awards: [{ playerId: '', amount: 10 }],
            displayedAt: 100,
          },
        },
      }),
    );

    const read = readOnlineSession();
    expect(read).not.toBeNull();
    expect(read?.meta.initialMaterials).toBeUndefined();
    expect(read?.canvas.pendingFireIntent).toBeNull();
    expect(read?.canvas.roundResult).toBeNull();
    expect(read?.canvas.lastRoundOutcome).toBeNull();
    expect(read?.canvas.earningsOverlay).toBeNull();
  });

  it('keeps fully validated round results and earnings overlays', () => {
    const session = makeSession();
    session.canvas.roundResult = {
      damageDealt: { 'player-1': 12.5 },
      earningsByPlayer: { 'player-1': 38 },
      terrainDestroyed: 44.25,
      survivors: ['player-1'],
    };
    session.canvas.lastRoundOutcome = {
      isDraw: false,
      winner: session.players[0],
    };
    session.canvas.earningsOverlay = {
      shotId: 4,
      awards: [{
        playerId: 'player-1',
        playerName: 'Host',
        color: session.players[0].tank.color,
        amount: 38,
        x: 120,
        y: 300,
      }],
      displayedAt: 1_000,
    };

    persistOnlineSession(session);

    const read = readOnlineSession();
    expect(read?.canvas.roundResult).toEqual(session.canvas.roundResult);
    expect(read?.canvas.lastRoundOutcome).toEqual(session.canvas.lastRoundOutcome);
    expect(read?.canvas.earningsOverlay).toEqual(session.canvas.earningsOverlay);
  });

  it('clearOnlineSession removes persisted data', () => {
    persistOnlineSession(makeSession());
    clearOnlineSession();
    expect(readOnlineSession()).toBeNull();
    expect(store.has('tankwars-online-session-v1')).toBe(false);
  });

  it('swallows sessionStorage quota errors on persist', () => {
    vi.stubGlobal('sessionStorage', {
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
      getItem: () => null,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    });

    expect(() => persistOnlineSession(makeSession())).not.toThrow();
    expect(readOnlineSession()).toBeNull();
  });

  it('validates FireRejectedReason and ShopDenial guards accurately', () => {
    expect(isFireRejectedReason('NOT_YOUR_TURN')).toBe(true);
    expect(isFireRejectedReason('NO_AMMO')).toBe(true);
    expect(isFireRejectedReason('UNKNOWN_REASON')).toBe(false);
    expect(isFireRejectedReason(123)).toBe(false);

    expect(isShopDenial('STOCK_CAP')).toBe(true);
    expect(isShopDenial('STALE_SHOP_EPOCH')).toBe(true);
    expect(isShopDenial('INVALID_DENIAL')).toBe(false);
  });

  it('validates isShopClientSessionState accurately', () => {
    expect(isShopClientSessionState(createEmptyShopSession())).toBe(true);
    expect(isShopClientSessionState({ epoch: -1 })).toBe(false);
    expect(isShopClientSessionState(null)).toBe(false);
  });

  it('safely falls back to empty shop session when persisted shopSession is malformed', () => {
    const rawSession = makeSession();
    store.set(
      'tankwars-online-session-v1',
      JSON.stringify({
        ...rawSession,
        canvas: {
          ...rawSession.canvas,
          shopSession: {
            epoch: -1, // invalid negative epoch
            roundNumber: 'not-a-number',
            readySlots: 'invalid',
          },
        },
      }),
    );

    const read = readOnlineSession();
    expect(read).not.toBeNull();
    expect(read?.canvas.shopSession).toEqual(createEmptyShopSession());
  });

  it('safely falls back to null fireRejection when persisted string is not a valid FireRejectedReason', () => {
    const rawSession = makeSession();
    store.set(
      'tankwars-online-session-v1',
      JSON.stringify({
        ...rawSession,
        canvas: {
          ...rawSession.canvas,
          fireRejection: 'UNAUTHORIZED_HACKER_REASON',
        },
      }),
    );

    const read = readOnlineSession();
    expect(read).not.toBeNull();
    expect(read?.canvas.fireRejection).toBeNull();
  });

  it('correctly reads valid active shopSession with counters and pendingIntent', () => {
    const rawSession = makeSession();
    const activeShopSession = {
      epoch: 2,
      roundNumber: 1,
      counters: {
        'player-1': { GRENADE: 2 },
      },
      readySlots: [0],
      aiShopApplied: true,
      authoritativeReceived: true,
      pendingIntent: {
        kind: 'BUY_SELL' as const,
        actionId: 'action-intent-1',
        shopEpoch: 2,
        weaponId: 'GRENADE' as const,
        delta: 1 as const,
      },
      denial: null,
    };
    rawSession.canvas.shopSession = activeShopSession;
    rawSession.canvas.fireRejection = 'NO_AMMO';
    persistOnlineSession(rawSession);

    const read = readOnlineSession();
    expect(read).not.toBeNull();
    expect(read?.canvas.shopSession).toEqual(activeShopSession);
    expect(read?.canvas.fireRejection).toBe('NO_AMMO');
  });
});
