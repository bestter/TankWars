import { describe, expect, it } from 'vitest';
import { isParticipation, parseCreatedParticipation, type OnlineParticipation } from '../onlineParticipation';

const host: OnlineParticipation = {
  version: 1, room: 'synthetic-room', slot: 0, token: 'synthetic-host', name: 'Host',
  engaged: true, mode: 'host', slots: [
    { slot: 0, type: 'human', url: 'https://example.test/?room=synthetic-room&slot=0&token=synthetic-host' },
    { slot: 1, type: 'human', url: 'https://example.test/?room=synthetic-room&slot=1&token=synthetic-guest' },
  ],
};

describe('isParticipation', () => {
  it('accepts a guest before or after joining and an engaged host with invitations', () => {
    const guest = { ...host, slot: 1, mode: 'guest', slots: [], name: '', engaged: false };
    expect(isParticipation(guest)).toBe(true);
    expect(isParticipation({ ...guest, name: 'Guest', engaged: true })).toBe(true);
    expect(isParticipation(host)).toBe(true);
  });
  it('accepts the name boundary and host rosters of two to four players', () => {
    expect(isParticipation({ ...host, name: 'X'.repeat(16) })).toBe(true);
    for (const length of [2, 3, 4]) {
      const slots = [...host.slots, ...Array.from({ length: length - 2 }, (_, index) => (
        { slot: index + 2, type: 'ai', aiProfile: 'v1-random', url: null }
      ))];
      expect(isParticipation({ ...host, slots })).toBe(true);
    }
  });
  it.each([
    null, [], {}, { ...host, version: 2 }, { ...host, room: ' ' },
    { ...host, slot: -1 }, { ...host, slot: 4 }, { ...host, slot: 0.5 }, { ...host, slot: '0' },
    { ...host, token: '' }, { ...host, name: 1 }, { ...host, name: 'X'.repeat(17) },
    { ...host, name: ' ' }, { ...host, engaged: 'true' }, { ...host, mode: 'unknown' },
    { ...host, slots: null }, { ...host, slots: [] }, { ...host, slots: [host.slots[0]] },
    { ...host, slots: [...host.slots, ...host.slots, host.slots[0]] },
    { ...host, mode: 'guest' }, { ...host, engaged: false }, { ...host, slot: 1 },
  ])('rejects malformed or incompatible participation %#', value => {
    expect(isParticipation(value)).toBe(false);
  });
  it.each([
    { slot: 1, type: 'human', url: host.slots[0].url },
    { slot: 0, type: 'unknown', url: host.slots[0].url },
    { slot: 0, type: 'human', url: null },
    { slot: 0, type: 'human', url: 'not-a-url' },
    { slot: 0, type: 'human', url: 'javascript:alert(1)' },
    { slot: 0, type: 'human', url: 'https://example.test/?room=other&slot=0&token=synthetic-host' },
    { slot: 0, type: 'human', url: 'https://example.test/?room=synthetic-room&slot=1&token=synthetic-host' },
    { slot: 0, type: 'human', url: 'https://example.test/?room=synthetic-room&slot=0&token=other' },
    { slot: 0, type: 'human', url: 'https://example.test/?room=synthetic-room&slot=0' },
    { slot: 0, type: 'ai', url: host.slots[0].url, aiProfile: 'v1-random' },
    { slot: 0, type: 'ai', url: null },
  ])('rejects malformed host invitation entries %#', entry => {
    expect(isParticipation({ ...host, slots: [entry, host.slots[1]] })).toBe(false);
  });
});

describe('parseCreatedParticipation', () => {
  it('extracts the host credentials and preserves every invitation without mutating the response', () => {
    const response = { roomId: host.room, slots: structuredClone(host.slots) };
    const before = structuredClone(response);
    expect(parseCreatedParticipation(response, 'Host')).toEqual(host);
    expect(response).toEqual(before);
  });
  it.each([
    null, [], {}, { roomId: host.room, slots: null }, { roomId: host.room, slots: [] },
    { roomId: host.room, slots: [null] }, { roomId: host.room, slots: [{ url: 42 }] },
    { roomId: host.room, slots: [{ url: 'not-a-url' }, host.slots[1]] },
    { roomId: 'other', slots: host.slots },
    { roomId: host.room, slots: [{ slot: 0, type: 'human', url: 'https://example.test/?room=synthetic-room&slot=0' }, host.slots[1]] },
    { roomId: host.room, slots: [host.slots[0], { ...host.slots[1], slot: 3 }] },
  ])('rejects invalid external room responses without throwing %#', response => {
    expect(parseCreatedParticipation(response, 'Host')).toBeNull();
  });
  it.each(['', ' ', 'X'.repeat(17)])('rejects a name that cannot be restored %#', name => {
    expect(parseCreatedParticipation({ roomId: host.room, slots: host.slots }, name)).toBeNull();
  });
});
