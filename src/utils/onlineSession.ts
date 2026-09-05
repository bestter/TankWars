/**
 * Persists an in-progress online match in sessionStorage so a tab refresh or
 * accidental return to the menu can resume instead of dropping back into the lobby.
 */

import {
  FIRE_COMMAND_MAX_ANGLE,
  FIRE_COMMAND_MAX_POWER,
  FIRE_COMMAND_MIN_ANGLE,
  FIRE_COMMAND_MIN_POWER,
  VGA_PALETTE,
  type GamePhase,
  type RoundResult,
} from '../types/game';
import type { AiProfile, Player, TankHitReaction } from '../types/player';
import { TERRAIN_MATERIAL, type TerrainMaterial } from '../types/terrain';
import { ALL_WEAPON_IDS, type WeaponId } from '../types/weapon';
import type { EarningsOverlayState } from '../components/gameCanvasReducer';
import {
  createEmptyShopSession,
  type PendingFireIntent,
  type PendingShopIntent,
  type ShopClientSessionState,
} from '../components/gameCanvasReducer';
import type { ShopDenial, ShopVisitCounters } from '../game/shop/shopTransaction';
import type { FireRejectedReason } from '../game/online/protocol';
import { isValidActionId } from '../game/online/actionId';

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
  pendingFireIntent: PendingFireIntent | null;
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

const VALID_GAME_PHASES: ReadonlySet<string> = new Set<GamePhase>([
  'MENU',
  'SHOP',
  'COMBAT',
  'RESOLUTION',
  'CELEBRATION',
  'SUMMARY',
  'GAME_OVER',
]);

const VALID_TERRAIN_MATERIALS: ReadonlySet<string> = new Set<TerrainMaterial>(
  Object.values(TERRAIN_MATERIAL),
);

const VALID_COLORS: ReadonlySet<string> = new Set(
  Object.values(VGA_PALETTE),
);

const VALID_AI_PROFILES: ReadonlySet<string> = new Set<AiProfile>([
  'v1-random',
  'v2-heuristic',
  'v3-sniper',
  'v4-smart',
]);

const VALID_WEAPON_IDS: ReadonlySet<string> = new Set(ALL_WEAPON_IDS);

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
  return typeof value === 'string' && VALID_WEAPON_IDS.has(value);
}

function isGamePhase(value: unknown): value is GamePhase {
  return typeof value === 'string' && VALID_GAME_PHASES.has(value);
}

function isTerrainMaterial(value: unknown): value is TerrainMaterial {
  return typeof value === 'string' && VALID_TERRAIN_MATERIALS.has(value);
}

function isPendingFireIntent(value: unknown): value is PendingFireIntent {
  if (!isRecord(value) || !isValidActionId(value.actionId) || !isRecord(value.command)) {
    return false;
  }
  return (
    isFiniteNumber(value.command.angle) &&
    value.command.angle >= FIRE_COMMAND_MIN_ANGLE &&
    value.command.angle <= FIRE_COMMAND_MAX_ANGLE &&
    isFiniteNumber(value.command.power) &&
    value.command.power >= FIRE_COMMAND_MIN_POWER &&
    value.command.power <= FIRE_COMMAND_MAX_POWER &&
    isWeaponId(value.command.weaponId)
  );
}

function isPendingShopIntent(value: unknown): value is PendingShopIntent {
  if (!isRecord(value) || !isValidActionId(value.actionId) || !isSafeNonNegativeInteger(value.shopEpoch)) {
    return false;
  }
  if (value.kind === 'READY') {
    return true;
  }
  if (value.kind === 'BUY_SELL') {
    return (
      isWeaponId(value.weaponId) &&
      (value.delta === 1 || value.delta === -1)
    );
  }
  return false;
}

function isShopVisitCounters(value: unknown): value is ShopVisitCounters {
  if (!isRecord(value)) return false;
  for (const [playerId, playerCounters] of Object.entries(value)) {
    if (!isNonEmptyString(playerId)) return false;
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
      !isNonEmptyString(meta.roomId) ||
      !isNonEmptyString(meta.localPlayerId) ||
      !isSafeNonNegativeInteger(meta.slot) ||
      !isNonEmptyString(meta.token) ||
      !isPlayerArray(parsed.players) ||
      !isPlayerArray(canvas.uiPlayers) ||
      !isPlayerArray(canvas.shopPlayers) ||
      !isGamePhase(canvas.gamePhase) ||
      !isSafePositiveInteger(canvas.currentManche) ||
      !isSafeNonNegativeInteger(canvas.currentShopIndex) ||
      !isFiniteNumber(canvas.wind)
    ) return null;
    if (
      meta.slot >= parsed.players.length ||
      parsed.players[meta.slot]?.id !== meta.localPlayerId ||
      (canvas.shopPlayers.length === 0
        ? canvas.currentShopIndex !== 0
        : canvas.currentShopIndex >= canvas.shopPlayers.length)
    ) {
      return null;
    }

    const parsedMeta: OnlineSessionMeta = {
      roomId: meta.roomId,
      localPlayerId: meta.localPlayerId,
      slot: meta.slot,
      token: meta.token,
    };
    if (Array.isArray(meta.initialHeights) && meta.initialHeights.every(isFiniteNumber)) {
      parsedMeta.initialHeights = meta.initialHeights;
    }
    if (Array.isArray(meta.initialMaterials) && meta.initialMaterials.every(isTerrainMaterial)) {
      parsedMeta.initialMaterials = meta.initialMaterials;
    }
    if (isFiniteNumber(meta.initialWind)) {
      parsedMeta.initialWind = meta.initialWind;
    }
    if (
      isSafeNonNegativeInteger(meta.initialCurrentPlayerIndex) &&
      meta.initialCurrentPlayerIndex < parsed.players.length
    ) {
      parsedMeta.initialCurrentPlayerIndex = meta.initialCurrentPlayerIndex;
    }

    const roundEarningsByPlayer = isSafeNonNegativeRecord(
      canvas.roundEarningsByPlayer,
    )
      ? { ...canvas.roundEarningsByPlayer }
      : {};

    return {
      meta: parsedMeta,
      players: parsed.players,
      canvas: {
        gamePhase: canvas.gamePhase,
        currentManche: canvas.currentManche,
        uiPlayers: canvas.uiPlayers,
        shopPlayers: canvas.shopPlayers,
        currentShopIndex: canvas.currentShopIndex,
        roundResult: isRoundResult(canvas.roundResult) ? canvas.roundResult : null,
        lastRoundOutcome: isLastRoundOutcome(canvas.lastRoundOutcome)
          ? canvas.lastRoundOutcome
          : null,
        wind: canvas.wind,
        authoritySlot:
          isSafeNonNegativeInteger(canvas.authoritySlot) &&
          canvas.authoritySlot < parsed.players.length
          ? canvas.authoritySlot
          : null,
        authorityEpoch: isSafeNonNegativeInteger(canvas.authorityEpoch)
          ? canvas.authorityEpoch
          : 0,
        lastAppliedShotId: isSafeNonNegativeInteger(canvas.lastAppliedShotId)
          ? canvas.lastAppliedShotId
          : 0,
        lastAppliedZeusStrikeId: isSafeNonNegativeInteger(canvas.lastAppliedZeusStrikeId)
          ? canvas.lastAppliedZeusStrikeId
          : 0,
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
        pendingFireIntent: isPendingFireIntent(canvas.pendingFireIntent)
          ? canvas.pendingFireIntent
          : null,
        fireRejection: isFireRejectedReason(canvas.fireRejection)
          ? canvas.fireRejection
          : null,
        roundEarningsByPlayer,
        earningsOverlay: isEarningsOverlayState(canvas.earningsOverlay)
          ? canvas.earningsOverlay
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && value > 0;
}

function isInventory(value: unknown): value is Player['inventory'] {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([weaponId, stock]) =>
      isWeaponId(weaponId) && isSafeNonNegativeInteger(stock),
  );
}

function isTankHitReaction(value: unknown): value is TankHitReaction {
  return (
    isRecord(value) &&
    typeof value.wasDirectHit === 'boolean' &&
    isFiniteNumber(value.fallDistance) &&
    value.fallDistance >= 0
  );
}

function isPlayer(value: unknown): value is Player {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.name) ||
    typeof value.isHuman !== 'boolean' ||
    !isSafeNonNegativeInteger(value.money) ||
    !isInventory(value.inventory) ||
    !isRecord(value.tank)
  ) {
    return false;
  }

  const tank = value.tank;
  const optionalAttackerIdsValid =
    (tank.lastHitBy === undefined || isNonEmptyString(tank.lastHitBy)) &&
    (tank.lastDirectAttackerId === undefined ||
      isNonEmptyString(tank.lastDirectAttackerId));
  const hitReactionValid =
    tank.hitReaction === undefined || isTankHitReaction(tank.hitReaction);
  const aiProfileValid =
    value.aiProfile === undefined ||
    (typeof value.aiProfile === 'string' && VALID_AI_PROFILES.has(value.aiProfile));

  return (
    !Array.isArray(tank.position) &&
    isRecord(tank.position) &&
    isNonEmptyString(tank.id) &&
    isFiniteNumber(tank.position.x) &&
    isFiniteNumber(tank.position.y) &&
    isFiniteNumber(tank.angle) &&
    isFiniteNumber(tank.power) &&
    tank.power >= FIRE_COMMAND_MIN_POWER &&
    tank.power <= FIRE_COMMAND_MAX_POWER &&
    isFiniteNumber(tank.health) &&
    isFiniteNumber(tank.maxHealth) &&
    tank.maxHealth >= 0 &&
    isFiniteNumber(tank.shield) &&
    isFiniteNumber(tank.maxShield) &&
    tank.maxShield >= 0 &&
    typeof tank.isDead === 'boolean' &&
    typeof tank.color === 'string' &&
    VALID_COLORS.has(tank.color) &&
    isWeaponId(tank.currentWeapon) &&
    optionalAttackerIdsValid &&
    hitReactionValid &&
    aiProfileValid
  );
}

function isPlayerArray(value: unknown): value is Player[] {
  return Array.isArray(value) && value.every(isPlayer);
}

function isFiniteNonNegativeRecord(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([identifier, amount]) =>
      identifier.trim().length > 0 && isFiniteNumber(amount) && amount >= 0,
  );
}

function isSafeNonNegativeRecord(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([identifier, amount]) =>
      identifier.trim().length > 0 && isSafeNonNegativeInteger(amount),
  );
}

function isRoundResult(value: unknown): value is RoundResult {
  return (
    isRecord(value) &&
    isFiniteNonNegativeRecord(value.damageDealt) &&
    isSafeNonNegativeRecord(value.earningsByPlayer) &&
    isFiniteNumber(value.terrainDestroyed) &&
    value.terrainDestroyed >= 0 &&
    Array.isArray(value.survivors) &&
    value.survivors.every(isNonEmptyString)
  );
}

function isLastRoundOutcome(
  value: unknown,
): value is { isDraw: boolean; winner: Player | null } {
  return (
    isRecord(value) &&
    typeof value.isDraw === 'boolean' &&
    (value.winner === null || isPlayer(value.winner))
  );
}

function isEarningsOverlayState(value: unknown): value is EarningsOverlayState {
  if (
    !isRecord(value) ||
    !isSafeNonNegativeInteger(value.shotId) ||
    !isSafeNonNegativeInteger(value.displayedAt) ||
    !Array.isArray(value.awards)
  ) {
    return false;
  }

  return value.awards.every(
    (award) =>
      isRecord(award) &&
      isNonEmptyString(award.playerId) &&
      isNonEmptyString(award.playerName) &&
      typeof award.color === 'string' &&
      VALID_COLORS.has(award.color) &&
      isSafeNonNegativeInteger(award.amount) &&
      isFiniteNumber(award.x) &&
      isFiniteNumber(award.y),
  );
}

export function clearOnlineSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
