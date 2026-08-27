/**
 * Persists an in-progress online match in sessionStorage so a tab refresh or
 * accidental return to the menu can resume instead of dropping back into the lobby.
 */

import type { GamePhase, RoundResult } from '../types/game';
import type { Player } from '../types/player';
import type { TerrainMaterial } from '../types/terrain';
import type { EarningsOverlayState } from '../components/gameCanvasReducer';
import {
  createEmptyShopSession,
  type ShopClientSessionState,
} from '../components/gameCanvasReducer';
import type { FireRejectedReason } from '../game/online/protocol';

export interface OnlineSessionMeta {
  roomId: string;
  localPlayerId: string;
  slot: number;
  token: string;
  initialHeights?: number[];
  initialMaterials?: TerrainMaterial[];
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
  authoritySlot: number | null;
  authorityEpoch: number;
  lastAppliedShotId: number;
  lastAppliedZeusStrikeId?: number;
  shopSession: ShopClientSessionState;
  lastAppliedShopEpoch: number;
  lastCompletedRoundNumber: number;
  lastSeenShotId: number;
  fireRejection: FireRejectedReason | null;
  roundEarningsByPlayer: Record<string, number>;
  earningsOverlay: EarningsOverlayState | null;
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
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.meta) || !isRecord(parsed.canvas)) return null;
    const meta = parsed.meta;
    const canvas = parsed.canvas;
    if (
      typeof meta.roomId !== 'string' || !meta.roomId ||
      typeof meta.localPlayerId !== 'string' ||
      typeof meta.slot !== 'number' || !Number.isSafeInteger(meta.slot) ||
      typeof meta.token !== 'string' ||
      !isPlayerArray(parsed.players) ||
      !isPlayerArray(canvas.uiPlayers) ||
      !isPlayerArray(canvas.shopPlayers) ||
      typeof canvas.gamePhase !== 'string' ||
      typeof canvas.currentManche !== 'number' ||
      typeof canvas.currentShopIndex !== 'number' ||
      typeof canvas.wind !== 'number'
    ) return null;

    const validPhases: GamePhase[] = ['MENU', 'SHOP', 'COMBAT', 'RESOLUTION', 'CELEBRATION', 'SUMMARY', 'GAME_OVER'];
    if (!validPhases.includes(canvas.gamePhase as GamePhase)) return null;
    return {
      meta: meta as unknown as OnlineSessionMeta,
      players: parsed.players,
      canvas: {
        gamePhase: canvas.gamePhase as GamePhase,
        currentManche: canvas.currentManche,
        uiPlayers: canvas.uiPlayers,
        shopPlayers: canvas.shopPlayers,
        currentShopIndex: canvas.currentShopIndex,
        roundResult: isRecord(canvas.roundResult) ? canvas.roundResult as unknown as RoundResult : null,
        lastRoundOutcome: isRecord(canvas.lastRoundOutcome)
          ? canvas.lastRoundOutcome as unknown as OnlineCanvasSnapshot['lastRoundOutcome']
          : null,
        wind: canvas.wind,
        authoritySlot: typeof canvas.authoritySlot === 'number' ? canvas.authoritySlot : null,
        authorityEpoch: typeof canvas.authorityEpoch === 'number' && Number.isSafeInteger(canvas.authorityEpoch) ? canvas.authorityEpoch : 0,
        lastAppliedShotId: typeof canvas.lastAppliedShotId === 'number' && Number.isSafeInteger(canvas.lastAppliedShotId) ? canvas.lastAppliedShotId : 0,
        lastAppliedZeusStrikeId: typeof canvas.lastAppliedZeusStrikeId === 'number' && Number.isSafeInteger(canvas.lastAppliedZeusStrikeId) ? canvas.lastAppliedZeusStrikeId : 0,
        shopSession: isRecord(canvas.shopSession)
          ? canvas.shopSession as unknown as ShopClientSessionState
          : createEmptyShopSession(),
        lastAppliedShopEpoch: isSafeNonNegativeInteger(canvas.lastAppliedShopEpoch)
          ? canvas.lastAppliedShopEpoch
          : 0,
        lastCompletedRoundNumber: isSafeNonNegativeInteger(canvas.lastCompletedRoundNumber)
          ? canvas.lastCompletedRoundNumber
          : 0,
        lastSeenShotId: isSafeNonNegativeInteger(canvas.lastSeenShotId)
          ? canvas.lastSeenShotId
          : 0,
        fireRejection:
          typeof canvas.fireRejection === 'string'
            ? canvas.fireRejection as FireRejectedReason
            : null,
        roundEarningsByPlayer: isRecord(canvas.roundEarningsByPlayer)
          ? canvas.roundEarningsByPlayer as Record<string, number>
          : {},
        earningsOverlay: isRecord(canvas.earningsOverlay)
          ? canvas.earningsOverlay as unknown as EarningsOverlayState
          : null,
      },
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPlayerArray(value: unknown): value is Player[] {
  return Array.isArray(value) && value.every((player) => isRecord(player) && typeof player.id === 'string' && isRecord(player.tank));
}

export function clearOnlineSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
