import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  persistOnlineSession,
  readOnlineSession,
  clearOnlineSession,
  type PersistedOnlineSession,
} from '../onlineSession';
import { makePlayer } from '../../game/__tests__/helpers';

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
});