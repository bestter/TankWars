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
        expectedMoney: 175,
        expectedStock: 3,
        expectedPurchaseCount: 3,
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
