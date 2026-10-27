import type { SlotUI } from '../components/onlineLobbyTypes';
import { clearOnlineSession, readOnlineSession } from './onlineSession';

const KEY = 'tankwars-online-participation-v1';
export type OnlineEntryMessage = 'online_storage_clear_failed' | 'online_invitation_invalid' |
  'online_private_url_warning' | 'online_restore_unavailable' | 'online_url_cleanup_failed';
export function reportOnlinePersistenceFailure(message: OnlineEntryMessage): void {
  queueMicrotask(() => window.dispatchEvent(new CustomEvent('online-persistence-warning', { detail: message })));
}
export interface OnlineParticipation {
  version: 1;
  room: string;
  slot: number;
  token: string;
  name: string;
  engaged: boolean;
  mode: 'host' | 'guest';
  slots: SlotUI[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function validSlot(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 4;
}
export function sameParticipation(a: OnlineParticipation, b: { roomId: string; slot?: number; token?: string }): boolean {
  return a.room === b.roomId && a.slot === b.slot && a.token === b.token;
}
export function isParticipation(value: unknown): value is OnlineParticipation {
  if (!record(value) || value.version !== 1 || !nonempty(value.room) || !validSlot(value.slot) ||
    !nonempty(value.token) || typeof value.name !== 'string' || value.name.length > 16 ||
    typeof value.engaged !== 'boolean' || (value.engaged && !value.name.trim()) ||
    (value.mode !== 'host' && value.mode !== 'guest') || !Array.isArray(value.slots)) return false;
  if (value.mode === 'guest') return value.slots.length === 0;
  return value.slot === 0 && value.engaged && value.slots.length >= 2 && value.slots.length <= 4 &&
    value.slots.every((entry: unknown, index: number) => {
      if (!record(entry) || entry.slot !== index || !['human', 'ai'].includes(String(entry.type))) return false;
      if (entry.type === 'ai') return entry.url === null && typeof entry.aiProfile === 'string';
      if (typeof entry.url !== 'string') return false;
      try {
        const url = new URL(entry.url);
        return ['http:', 'https:'].includes(url.protocol) && url.searchParams.get('room') === value.room &&
          url.searchParams.get('slot') === String(index) && nonempty(url.searchParams.get('token')) &&
          (index !== 0 || url.searchParams.get('token') === value.token);
      } catch { return false; }
    });
}
export function persistParticipation(value: OnlineParticipation): boolean {
  try { sessionStorage.setItem(KEY, JSON.stringify(value)); return true; }
  catch { return false; }
}
export function parseCreatedParticipation(value: unknown, name: string): OnlineParticipation | null {
  if (!record(value) || !Array.isArray(value.slots)) return null;
  const first: unknown = value.slots[0];
  if (!record(first) || typeof first.url !== 'string') return null;
  try {
    const candidate = { version: 1, room: value.roomId, slot: 0,
      token: new URL(first.url).searchParams.get('token'), name, engaged: true,
      mode: 'host', slots: value.slots };
    return isParticipation(candidate) ? candidate : null;
  } catch { return null; }
}
export function readParticipation(): OnlineParticipation | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    return isParticipation(value) ? value : null;
  } catch { return null; }
}
export function clearParticipation(): boolean {
  try { sessionStorage.removeItem(KEY); return true; }
  catch { return false; }
}
export function cleanParticipationUrl(): boolean {
  try {
    const url = new URL(window.location.href);
    if (!['room', 'slot', 'token'].some(key => url.searchParams.has(key))) return true;
    for (const key of ['room', 'slot', 'token']) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    return true;
  } catch { return false; }
}

/** Read-only selection; callers perform capture/cleanup after React commits. */
export function readOnlineEntry(enabled: boolean) {
  let readFailed = false;
  try { sessionStorage.getItem(KEY); } catch { readFailed = true; }
  const params = new URLSearchParams(window.location.search);
  const explicit = ['room', 'slot', 'token'].some(key => params.has(key));
  const room = params.get('room');
  const rawSlot = params.get('slot');
  const token = params.get('token');
  const slot = rawSlot !== null && /^[0-3]$/.test(rawSlot) ? Number(rawSlot) : -1;
  const valid = nonempty(room) && validSlot(slot) && nonempty(token) &&
    ['room', 'slot', 'token'].every(key => params.getAll(key).length === 1);
  const saved = enabled ? readOnlineSession() : null;
  const lobby = enabled ? readParticipation() : null;
  const invitation: OnlineParticipation | null = enabled && explicit && valid
    ? { version: 1, room, slot, token, name: '', engaged: false, mode: 'guest', slots: [] } : null;
  const session = enabled && (!explicit || (invitation && sameParticipation(invitation, saved?.meta ?? { roomId: '' }))) &&
    saved?.canvas.gamePhase !== 'GAME_OVER' ? saved : null;
  const participation = invitation
    ? (lobby && sameParticipation(invitation, { roomId: lobby.room, slot: lobby.slot, token: lobby.token }) ? lobby : invitation)
    : enabled && !explicit && !session && saved?.canvas.gamePhase !== 'GAME_OVER' ? lobby : null;
  return { explicit, invalid: enabled && explicit && !valid, session, participation, readFailed };
}

export function captureOnlineEntry(entry: ReturnType<typeof readOnlineEntry>, enabled: boolean): OnlineEntryMessage[] {
  const messages: OnlineEntryMessage[] = [];
  if (entry.readFailed) messages.push('online_restore_unavailable');
  if (!enabled || entry.invalid || (entry.explicit && !entry.session)) {
    if (!clearOnlineSession()) messages.push('online_storage_clear_failed');
    if (!clearParticipation()) messages.push('online_storage_clear_failed');
  }
  if (entry.invalid) messages.push('online_invitation_invalid');
  let persisted = true;
  if (enabled && entry.participation && !entry.session) {
    persisted = persistParticipation(entry.participation);
    if (!persisted) messages.push(entry.explicit ? 'online_private_url_warning' : 'online_restore_unavailable');
  }
  if ((!enabled || entry.invalid || persisted) && !cleanParticipationUrl()) messages.push('online_url_cleanup_failed');
  return [...new Set(messages)];
}
