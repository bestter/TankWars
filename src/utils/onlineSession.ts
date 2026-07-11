/**
 * Persists an in-progress online match in sessionStorage so a tab refresh or
 * accidental return to the menu can resume instead of dropping back into the lobby.
 */

import type { GamePhase, RoundResult } from '../types/game';
import type { Player } from '../types/player';

export interface OnlineSessionMeta {
  roomId: string;
  localPlayerId: string;
  slot: number;
  token: string;
  initialHeights?: number[];
  initialWind?: number;
  initialCurrentPlayerIndex?: number;
}

export interface OnlineCanvasSnapshot {
  gamePhase: GamePhase;
  currentManche: number;
  uiPlayers: Player[];
  shopPlayers: Player[];
  currentShopIndex: number;
  roundResult: RoundResult | null;
  lastRoundOutcome: { isDraw: boolean; winner: Player | null } | null;
  wind: number;
}

export interface PersistedOnlineSession {
  meta: OnlineSessionMeta;
  players: Player[];
  canvas: OnlineCanvasSnapshot;
}

const STORAGE_KEY = 'tankwars-online-session-v1';

export function persistOnlineSession(session: PersistedOnlineSession): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // quota / private mode — ignore
  }
}

export function readOnlineSession(): PersistedOnlineSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedOnlineSession;
    if (!parsed?.meta?.roomId || !Array.isArray(parsed.players)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearOnlineSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}