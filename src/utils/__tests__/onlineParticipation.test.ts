// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { captureOnlineEntry, cleanParticipationUrl, clearParticipation, isParticipation,
  persistParticipation, readOnlineEntry, readParticipation, type OnlineParticipation } from '../onlineParticipation';
import { persistOnlineSession, readOnlineSession, type PersistedOnlineSession } from '../onlineSession';
import { makePlayer, makeRoundMap, makeTank } from '../../game/__tests__/helpers';
import { createEmptyShopSession } from '../../components/gameCanvasReducer';

const guest: OnlineParticipation = { version: 1, room: 'synthetic-room', slot: 1,
  token: 'synthetic-token', name: '', engaged: false, mode: 'guest', slots: [] };
function saveCombat(gamePhase: 'COMBAT' | 'GAME_OVER' = 'COMBAT'): PersistedOnlineSession {
  const players = [makePlayer({ id: 'p1' }), makePlayer({ id: 'p2', tank: makeTank('tank-2', 620, 300) })];
  const session: PersistedOnlineSession = {
    meta: { roomId: guest.room, slot: 1, token: guest.token, localPlayerId: 'p2', initialMap: makeRoundMap() }, players,
    canvas: { map: makeRoundMap(), gamePhase, currentManche: 1, uiPlayers: players, shopPlayers: players,
      currentShopIndex: 0, roundResult: null, lastRoundOutcome: null, wind: 0, authoritySlot: 0,
      authorityEpoch: 1, lastAppliedShotId: 0, lastAppliedZeusStrikeId: 0, roundEarningsByPlayer: {},
      earningsOverlay: null, shopSession: createEmptyShopSession(), lastAppliedShopEpoch: 0,
      lastCompletedRoundNumber: 0, lastSeenShotId: 0, pendingFireIntent: null, fireRejection: null },
  };
  persistOnlineSession(session);
  return session;
}
describe('online participation', () => {
  beforeEach(() => { sessionStorage.clear(); history.replaceState({ useful: 7 }, '', '/'); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it('captures before cleaning and restores without joining', () => {
    history.replaceState({ useful: 7 }, '', '/play?other=yes&room=synthetic-room&slot=1&token=synthetic-token#anchor');
    const entry = readOnlineEntry(true);
    expect(readParticipation()).toBeNull();
    expect(captureOnlineEntry(entry, true)).toEqual([]);
    expect(location.pathname + location.search + location.hash).toBe('/play?other=yes#anchor');
    expect(history.state).toEqual({ useful: 7 });
    expect(readOnlineEntry(true).participation).toEqual(guest);
    expect(captureOnlineEntry(entry, true)).toEqual([]);
  });
  it('prefers valid combat over lobby, and permits the identical invitation', () => {
    saveCombat();
    expect(readOnlineSession()).not.toBeNull();
    persistParticipation(guest);
    expect(readOnlineEntry(true).session?.meta.localPlayerId).toBe('p2');
    history.replaceState({}, '', '/?room=synthetic-room&slot=1&token=synthetic-token');
    const entry = readOnlineEntry(true);
    expect(entry.session?.meta.localPlayerId).toBe('p2');
    captureOnlineEntry(entry, true);
    expect(readOnlineSession()).not.toBeNull();
  });
  it.each(['room=other&slot=1&token=synthetic-token', 'room=synthetic-room&slot=0&token=synthetic-token',
    'room=synthetic-room&slot=1&token=other'])('discards incompatible combat for an explicit invitation: %s', query => {
    saveCombat();
    history.replaceState({}, '', '/?' + query);
    const entry = readOnlineEntry(true);
    expect(entry.session).toBeNull();
    expect(entry.participation).not.toBeNull();
    captureOnlineEntry(entry, true);
    expect(readOnlineSession()).toBeNull();
  });
  it('does not revive a stale lobby after a finished match', () => {
    saveCombat('GAME_OVER');
    persistParticipation(guest);
    expect(readOnlineEntry(true).session).toBeNull();
    expect(readOnlineEntry(true).participation).toBeNull();
  });
  it('rejects an invalid explicit invitation even when valid combat is saved', () => {
    saveCombat();
    history.replaceState({}, '', '/?room=synthetic-room&slot=invalid&token=synthetic-token');
    const entry = readOnlineEntry(true);
    expect(entry.session).toBeNull();
    expect(entry.participation).toBeNull();
    expect(captureOnlineEntry(entry, true)).toContain('online_invitation_invalid');
    expect(readOnlineSession()).toBeNull();
  });
  it('keeps an engaged lobby and its name for an identical invitation without combat', () => {
    const joined = { ...guest, name: 'Guest', engaged: true };
    persistParticipation(joined);
    history.replaceState({}, '', '/?room=synthetic-room&slot=1&token=synthetic-token');
    expect(readOnlineEntry(true).participation).toEqual(joined);
  });
  it.each(['slot=4&room=x&token=x', 'slot=-1&room=x&token=x', 'slot=&room=x&token=x',
    'slot=1&room=x', 'slot=1&room=x&token=x&token=y'])('rejects an invalid explicit link instead of restoring old data: %s', query => {
    persistParticipation(guest);
    history.replaceState({}, '', '/?' + query);
    const entry = readOnlineEntry(true);
    expect(entry.participation).toBeNull();
    expect(entry.session).toBeNull();
    expect(captureOnlineEntry(entry, true)).toContain('online_invitation_invalid');
    expect(location.search).toBe('');
    expect(readParticipation()).toBeNull();
  });
  it('restores host invitations and engaged name', () => {
    const host: OnlineParticipation = { ...guest, slot: 0, name: 'Host', engaged: true, mode: 'host', slots: [
      { slot: 0, type: 'human', url: 'https://example.test/?room=synthetic-room&slot=0&token=synthetic-token' },
      { slot: 1, type: 'ai', aiProfile: 'v1-random', url: null },
    ] };
    expect(isParticipation(host)).toBe(true);
    persistParticipation(host);
    expect(readOnlineEntry(true).participation).toEqual(host);
  });
  it('keeps valid URL credentials on failed writes', () => {
    history.replaceState({}, '', '/?room=synthetic-room&slot=1&token=synthetic-token');
    vi.stubGlobal('sessionStorage', { getItem: () => null, removeItem: () => {}, setItem: () => { throw new Error('blocked'); } });
    const entry = readOnlineEntry(true);
    expect(captureOnlineEntry(entry, true)).toContain('online_private_url_warning');
    expect(location.search).toContain('token=');
    expect(entry.participation).toEqual(guest);
  });
  it('reports failed history cleanup while preserving the saved credentials', () => {
    history.replaceState({}, '', '/?room=synthetic-room&slot=1&token=synthetic-token');
    vi.spyOn(history, 'replaceState').mockImplementation(() => { throw new Error('blocked'); });
    expect(captureOnlineEntry(readOnlineEntry(true), true)).toContain('online_url_cleanup_failed');
    expect(readParticipation()).toEqual(guest);
    expect(cleanParticipationUrl()).toBe(false);
  });
  it('handles read and purge failures without leaking exception contents', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('sensitive'); },
      removeItem: () => { throw new Error('sensitive'); },
    });
    expect(readParticipation()).toBeNull();
    expect(clearParticipation()).toBe(false);
    expect(captureOnlineEntry(readOnlineEntry(false), false)).toEqual([
      'online_restore_unavailable', 'online_storage_clear_failed',
    ]);
  });
  it('rejects corrupt and incompatible storage', () => {
    for (const value of ['{', JSON.stringify({ ...guest, version: 2 }), JSON.stringify({ ...guest, slot: 4 })]) {
      sessionStorage.setItem('tankwars-online-participation-v1', value);
      expect(readParticipation()).toBeNull();
    }
  });
  it('cleans invitations and stored lobbies in local-only builds', () => {
    persistParticipation(guest);
    history.replaceState({}, '', '/?room=x&slot=0&token=x&other=1#hash');
    const entry = readOnlineEntry(false);
    expect(entry.participation).toBeNull();
    expect(entry.session).toBeNull();
    captureOnlineEntry(entry, false);
    expect(location.search + location.hash).toBe('?other=1#hash');
    expect(readParticipation()).toBeNull();
  });
});
