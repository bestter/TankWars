/**
 * Persists an in-progress online match in sessionStorage so a tab refresh or
 * accidental return to the menu can resume instead of dropping back into the lobby.
 */

import type { GamePhase, RoundResult } from '../types/game';
import type { Player } from '../types/player';
import type { TerrainMaterial } from '../types/terrain';
import { ALL_WEAPON_IDS, type WeaponId } from '../types/weapon';
import type { EarningsOverlayState } from '../components/gameCanvasReducer';
import {
  createEmptyShopSession,
  type PendingShopIntent,
  type ShopClientSessionState,
} from '../components/gameCanvasReducer';
import type { ShopDenial, ShopVisitCounters } from '../game/shop/shopTransaction';
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

const VALID_FIRE_REJECTED_REASONS: ReadonlySet<string> = new Set<FireRejectedReason>([
  'MALFORMED',
  'NOT_YOUR_TURN',
  'SHOT_IN_FLIGHT',
  'ROUND_ENDED',
  'NO_AMMO',
  'ILLEGAL_INVENTORY',
]);

const VALID_SHOP_DENIALS: ReadonlySet<string> = new Set<ShopDenial>([
  'STOCK_CAP',
  'PURCHASE_LIMIT',
  'INSUFFICIENT_FUNDS',
  'NO_STOCK',
  'NOT_SOLD',
  'ILLEGAL_INVENTORY',
  'MALFORMED',
  'NOT_YOUR_SLOT',
  'ALREADY_READY',
  'SHOP_CLOSED',
  'SHOP_NOT_AVAILABLE',
  'STALE_SHOP_EPOCH',
]);

export function isFireRejectedReason(value: unknown): value is FireRejectedReason {
  return typeof value === 'string' && VALID_FIRE_REJECTED_REASONS.has(value);
}

export function isShopDenial(value: unknown): value is ShopDenial {
  return typeof value === 'string' && VALID_SHOP_DENIALS.has(value);
}

function isWeaponId(value: unknown): value is WeaponId {
  return typeof value === 'string' && (ALL_WEAPON_IDS as readonly string[]).includes(value);
}

function isPendingShopIntent(value: unknown): value is PendingShopIntent {
  if (!isRecord(value) || typeof value.actionId !== 'string' || !isSafeNonNegativeInteger(value.shopEpoch)) {
    return false;
  }
  if (value.kind === 'READY') {
    return true;
  }
  if (value.kind === 'BUY_SELL') {
    return (
      isWeaponId(value.weaponId) &&
      (value.delta === 1 || value.delta === -1) &&
      typeof value.expectedMoney === 'number' &&
      Number.isSafeInteger(value.expectedMoney) &&
      isSafeNonNegativeInteger(value.expectedStock) &&
      isSafeNonNegativeInteger(value.expectedPurchaseCount)
    );
  }
  return false;
}

function isShopVisitCounters(value: unknown): value is ShopVisitCounters {
  if (!isRecord(value)) return false;
  for (const playerCounters of Object.values(value)) {
    if (!isRecord(playerCounters)) return false;
    for (const [weaponKey, count] of Object.entries(playerCounters)) {
      if (!isWeaponId(weaponKey) || !isSafeNonNegativeInteger(count)) {
        return false;
      }
    }
  }
  return true;
}

export function isShopClientSessionState(value: unknown): value is ShopClientSessionState {
  if (!isRecord(value)) return false;
  const epochValid = value.epoch === null || isSafeNonNegativeInteger(value.epoch);
  const roundNumberValid = value.roundNumber === null || isSafeNonNegativeInteger(value.roundNumber);
  const readySlotsValid =
    Array.isArray(value.readySlots) && value.readySlots.every((slot) => isSafeNonNegativeInteger(slot));
  const aiShopAppliedValid = typeof value.aiShopApplied === 'boolean';
  const authoritativeReceivedValid = typeof value.authoritativeReceived === 'boolean';
  const pendingIntentValid = value.pendingIntent === null || isPendingShopIntent(value.pendingIntent);
  const denialValid = value.denial === null || isShopDenial(value.denial);
  const countersValid = isShopVisitCounters(value.counters);

  return (
    epochValid &&
    roundNumberValid &&
    readySlotsValid &&
    aiShopAppliedValid &&
    authoritativeReceivedValid &&
    pendingIntentValid &&
    denialValid &&
    countersValid
  );
}

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

    const parsedMeta: OnlineSessionMeta = {
      roomId: meta.roomId,
      localPlayerId: meta.localPlayerId,
      slot: meta.slot,
      token: meta.token,
    };
    if (Array.isArray(meta.initialHeights) && meta.initialHeights.every((h) => typeof h === 'number' && Number.isFinite(h))) {
      parsedMeta.initialHeights = meta.initialHeights;
    }
    if (Array.isArray(meta.initialMaterials) && meta.initialMaterials.every((m) => typeof m === 'string')) {
      parsedMeta.initialMaterials = meta.initialMaterials as TerrainMaterial[];
    }
    if (typeof meta.initialWind === 'number' && Number.isFinite(meta.initialWind)) {
      parsedMeta.initialWind = meta.initialWind;
    }
    if (isSafeNonNegativeInteger(meta.initialCurrentPlayerIndex)) {
      parsedMeta.initialCurrentPlayerIndex = meta.initialCurrentPlayerIndex;
    }

    const roundEarningsByPlayer: Record<string, number> = {};
    if (isRecord(canvas.roundEarningsByPlayer)) {
      for (const [playerId, earnings] of Object.entries(canvas.roundEarningsByPlayer)) {
        if (typeof earnings === 'number' && Number.isSafeInteger(earnings)) {
          roundEarningsByPlayer[playerId] = earnings;
        }
      }
    }

    return {
      meta: parsedMeta,
      players: parsed.players,
      canvas: {
        gamePhase: canvas.gamePhase as GamePhase,
        currentManche: canvas.currentManche,
        uiPlayers: canvas.uiPlayers,
        shopPlayers: canvas.shopPlayers,
        currentShopIndex: canvas.currentShopIndex,
        roundResult: isRecord(canvas.roundResult) ? (canvas.roundResult as unknown as RoundResult) : null,
        lastRoundOutcome: isRecord(canvas.lastRoundOutcome)
          ? {
              isDraw: Boolean(canvas.lastRoundOutcome.isDraw),
              winner: isRecord(canvas.lastRoundOutcome.winner)
                ? (canvas.lastRoundOutcome.winner as unknown as Player)
                : null,
            }
          : null,
        wind: canvas.wind,
        authoritySlot: typeof canvas.authoritySlot === 'number' ? canvas.authoritySlot : null,
        authorityEpoch: typeof canvas.authorityEpoch === 'number' && Number.isSafeInteger(canvas.authorityEpoch) ? canvas.authorityEpoch : 0,
        lastAppliedShotId: typeof canvas.lastAppliedShotId === 'number' && Number.isSafeInteger(canvas.lastAppliedShotId) ? canvas.lastAppliedShotId : 0,
        lastAppliedZeusStrikeId: typeof canvas.lastAppliedZeusStrikeId === 'number' && Number.isSafeInteger(canvas.lastAppliedZeusStrikeId) ? canvas.lastAppliedZeusStrikeId : 0,
        shopSession: isShopClientSessionState(canvas.shopSession)
          ? canvas.shopSession
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
        fireRejection: isFireRejectedReason(canvas.fireRejection)
          ? canvas.fireRejection
          : null,
        roundEarningsByPlayer,
        earningsOverlay: isRecord(canvas.earningsOverlay) ? (canvas.earningsOverlay as unknown as EarningsOverlayState) : null,
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
