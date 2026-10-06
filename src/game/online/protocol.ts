import type { CombatCatchUpMessage } from "./combatCatchUp";
import { encodedCombatBytes, MAX_COMBAT_MESSAGE_BYTES, utf8Bytes } from "./combatTransport";
import { isRoundMap, hasValidSpawnRoster, type RoundMap } from "../round/prepareRound";
import {
  FIRE_COMMAND_MAX_ANGLE,
  FIRE_COMMAND_MAX_POWER,
  FIRE_COMMAND_MIN_ANGLE,
  FIRE_COMMAND_MIN_POWER,
  VGA_PALETTE,
  type FireCommand,
} from "../../types/game";
import type { Player } from "../../types/player";
import { ALL_WEAPON_IDS, type WeaponId } from "../../types/weapon";
import type {
  FireInventoryDenial,
  ShopDenial,
  ShopVisitCounters,
} from "../shop/shopTransaction";
import { isValidActionId } from "./actionId";

export const ONLINE_PROTOCOL_VERSION = 3 as const;
export const MINIMUM_CLIENT_PROTOCOL_VERSION = 3 as const;
export const PROTOCOL_MISMATCH_CLOSE_CODE = 4402 as const;

export interface RequestGameStartMessage {
  type: "REQUEST_GAME_START";
  protocolVersion: typeof ONLINE_PROTOCOL_VERSION;
  roundNumber: number;
  lastSeenShotId: number;
  lastAppliedShopEpoch: number;
}

export interface ProtocolMismatchMessage {
  type: "PROTOCOL_MISMATCH";
  requiredVersion: number;
  receivedVersion: number | null;
}

export interface GameStartMessage {
  type: "GAME_START";
  protocolVersion: typeof ONLINE_PROTOCOL_VERSION;
  currentPlayerIndex: number;
  players: Player[];
  map: RoundMap;
}

export interface ClientFireMessage {
  type: "FIRE";
  actionId: string;
  command: FireCommand;
}

export interface ShopEnterMessage {
  type: "SHOP_ENTER";
  roundNumber: number;
}

export interface ShopBuySellMessage {
  type: "SHOP_BUY_SELL";
  shopEpoch: number;
  actionId: string;
  weaponId: WeaponId;
  delta: 1 | -1;
}

export interface ShopReadyMessage {
  type: "SHOP_READY";
  shopEpoch: number;
  actionId: string;
}

export interface AuthorityChangedMessage {
  type: "AUTHORITY_CHANGED";
  authoritySlot: number | null;
  authorityEpoch: number;
}

export interface ShotMessage {
  type: "SHOT";
  actionId: string;
  shotId: number;
  roundNumber: number;
  shotNumberInRound: number;
  isFirstShotOfRound: boolean;
  physicsSeed: number;
  eventSequence: number;
  slot: number;
  ownerId: string;
  command: FireCommand;
}

export interface ShopStateMessage {
  type: "SHOP_STATE";
  shopEpoch: number;
  roundNumber: number;
  readySlots: number[];
  players: Player[];
  purchasesByPlayerId: ShopVisitCounters;
  aiShopApplied: boolean;
  acknowledgedAction?: ShopActionAcknowledgement;
}

export interface ShopActionAcknowledgement {
  slot: number;
  actionId: string;
}

export interface ShopRejectedMessage {
  type: "SHOP_REJECTED";
  shopEpoch: number | null;
  actionId?: string;
  weaponId?: WeaponId;
  delta?: 1 | -1;
  reason: ShopDenial;
}

export interface ShopFinishMessage {
  map: RoundMap;
  type: "SHOP_FINISH";
  shopEpoch: number;
  completedRoundNumber: number;
  nextRoundNumber: number;
  players: Player[];
  acknowledgedAction?: ShopActionAcknowledgement;
}

export type FireRejectedReason =
  | "MALFORMED"
  | "NOT_YOUR_TURN"
  | "ZEUS_TURN"
  | "SHOT_IN_FLIGHT"
  | "ROUND_ENDED"
  | FireInventoryDenial;

export interface FireRejectedMessage {
  type: "FIRE_REJECTED";
  actionId?: string;
  reason: FireRejectedReason;
  inventory: Partial<Record<WeaponId, number>>;
  currentWeapon: WeaponId;
}

export interface ShotSettledMessage {
  type: "SHOT_SETTLED";
  shotId: number;
  slot: number;
  deadSlots: boolean[];
}

export interface RoundOutcomeWire {
  isRoundEnd: boolean;
  isDraw: boolean;
  roundWinnerId: string | null;
}

export const EARNINGS_REJECTED_REASONS = ["MALFORMED", "MISSING_PLAYER", "DUPLICATE_PLAYER", "DEATH_INCONSISTENT", "RESURRECTION", "STALE_AUTHORITY", "WRONG_SHOT", "ROUND_MISMATCH", "IDENTITY_MISMATCH", "INVENTORY_MISMATCH", "CAP_MISMATCH", "ILLEGAL_VICTIM"] as const;
export type EarningsRejectedReason = typeof EARNINGS_REJECTED_REASONS[number];
export interface EarningsRejectedMessage {
  type: "EARNINGS_REJECTED";
  shotId: number | null;
  authorityEpoch: number | null;
  reason: EarningsRejectedReason;
}

export interface ShotEarningsMessage {
  players: Player[];
  type: "SHOT_EARNINGS";
  shotId: number;
  authorityEpoch: number;
  awards: Array<{ playerId: string; amount: number }>;
  deadSlots: boolean[];
  roundOutcome: RoundOutcomeWire;
  directHitVictimIds: string[];
}

export interface ShotEarningsAppliedMessage {
  economicRevision: number;
  roundEarningsByPlayer: Record<string, number>;
  type: "SHOT_EARNINGS_APPLIED";
  shotId: number;
  awards: Array<{ playerId: string; amount: number }>;
  balances: Array<{ playerId: string; money: number }>;
  hasEarnings: boolean;
  blockDurationMs: number;
  roundOutcome: RoundOutcomeWire;
}

export interface StateUpdateMessage {
  type: "STATE_UPDATE";
  currentPlayerIndex: number;
  roundEnded: boolean;
  players?: Player[];
}

export interface RoundEndMessage {
  type: "ROUND_END";
  players: Player[];
  roundWinnerId: string | null;
  isDraw: boolean;
  roundNumber: number;
}

export interface ZeusAppointedMessage {
  roundNumber: number;
  eventSequence: number;
  afterShotId: number;
  type: "ZEUS_APPOINTED";
  appointmentId: number;
  zeusId: string;
  zeusSlot: number;
  rotationSlots: number[];
}

export interface ZeusStrikeMessage {
  roundNumber: number;
  eventSequence: number;
  afterShotId: number;
  type: "ZEUS_STRIKE";
  strikeId: number;
  zeusId: string;
  targetId: string;
  resolveAt: number;
}

export interface ZeusStrikeAppliedMessage {
  economicRevision: number;
  roundEarningsByPlayer: Record<string, number>;
  roundNumber: number;
  eventSequence: number;
  afterShotId: number;
  type: "ZEUS_STRIKE_APPLIED";
  strikeId: number;
  zeusId: string;
  targetId: string;
  award: { playerId: string; amount: number };
  balances: Array<{ playerId: string; money: number }>;
  deadSlots: boolean[];
  roundOutcome: RoundOutcomeWire;
  nextPlayerIndex: number | null;
}

export interface ZeusStateMessage {
  roundNumber?: number;
  eventSequence?: number;
  type: "ZEUS_STATE";
  activeZeusId: string | null;
  currentPlayerIndex: number;
  rotationSlots: number[];
  deadSlots: boolean[];
  activeStrike: ZeusStrikeMessage | null;
  lastAppliedStrikeId: number;
}

export interface RoundPreparationFailedMessage {
  type: "ROUND_PREPARATION_FAILED";
  reason: "EXHAUSTED" | "NEW_GAME_REQUIRED";
  roundNumber: number;
}

export type StrictOnlineMessage =
  | CombatCatchUpMessage
  | RoundPreparationFailedMessage
  | RequestGameStartMessage
  | ProtocolMismatchMessage
  | GameStartMessage
  | ClientFireMessage
  | ShopEnterMessage
  | ShopBuySellMessage
  | ShopReadyMessage
  | AuthorityChangedMessage
  | ShotMessage
  | ShotSettledMessage
  | EarningsRejectedMessage
  | ShotEarningsMessage
  | ShotEarningsAppliedMessage
  | StateUpdateMessage
  | RoundEndMessage
  | ShopStateMessage
  | ShopRejectedMessage
  | ShopFinishMessage
  | FireRejectedMessage
  | ZeusAppointedMessage
  | ZeusStrikeMessage
  | ZeusStrikeAppliedMessage
  | ZeusStateMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isWeaponId(value: unknown): value is WeaponId {
  return (
    typeof value === "string" &&
    ALL_WEAPON_IDS.includes(value as WeaponId)
  );
}

function isNullableSlot(value: unknown): value is number | null {
  return value === null || isSafeNonNegativeInteger(value);
}

function isFireCommand(value: unknown): value is FireCommand {
  if (!isRecord(value)) return false;
  return (
    typeof value.angle === "number" &&
    Number.isFinite(value.angle) &&
    value.angle >= FIRE_COMMAND_MIN_ANGLE &&
    value.angle <= FIRE_COMMAND_MAX_ANGLE &&
    typeof value.power === "number" &&
    Number.isFinite(value.power) &&
    value.power >= FIRE_COMMAND_MIN_POWER &&
    value.power <= FIRE_COMMAND_MAX_POWER &&
    isWeaponId(value.weaponId)
  );
}

function isInventory(
  value: unknown,
): value is Partial<Record<WeaponId, number>> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([weaponId, stock]) =>
      isWeaponId(weaponId) && isSafeNonNegativeInteger(stock),
  );
}

function isShopVisitCounters(value: unknown): value is ShopVisitCounters {
  if (!isRecord(value)) return false;
  return Object.values(value).every((playerCounters) => {
    if (!isRecord(playerCounters)) return false;
    return Object.entries(playerCounters).every(
      ([weaponId, count]) =>
        isWeaponId(weaponId) && isSafeNonNegativeInteger(count),
    );
  });
}

const SHOP_DENIALS: readonly ShopDenial[] = [
  "STOCK_CAP",
  "PURCHASE_LIMIT",
  "INSUFFICIENT_FUNDS",
  "NO_STOCK",
  "NOT_SOLD",
  "ILLEGAL_INVENTORY",
  "MALFORMED",
  "NOT_YOUR_SLOT",
  "ALREADY_READY",
  "SHOP_CLOSED",
  "SHOP_NOT_AVAILABLE",
  "STALE_SHOP_EPOCH",
];

function isShopDenial(value: unknown): value is ShopDenial {
  return (
    typeof value === "string" &&
    SHOP_DENIALS.includes(value as ShopDenial)
  );
}

const FIRE_REJECTION_REASONS: readonly FireRejectedReason[] = [
  "MALFORMED",
  "NOT_YOUR_TURN",
  "SHOT_IN_FLIGHT",
  "ZEUS_TURN",
  "ROUND_ENDED",
  "NO_AMMO",
  "ILLEGAL_INVENTORY",
];

function isFireRejectedReason(value: unknown): value is FireRejectedReason {
  return (
    typeof value === "string" &&
    FIRE_REJECTION_REASONS.includes(value as FireRejectedReason)
  );
}

function isAwards(value: unknown): value is Array<{ playerId: string; amount: number }> {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.playerId === "string" &&
        isSafeNonNegativeInteger(entry.amount),
    )
  );
}

function isBalances(value: unknown): value is Array<{ playerId: string; money: number }> {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.playerId === "string" &&
        isSafeNonNegativeInteger(entry.money),
    )
  );
}

function isRoundOutcome(value: unknown): value is RoundOutcomeWire {
  return (
    isRecord(value) &&
    typeof value.isRoundEnd === "boolean" &&
    typeof value.isDraw === "boolean" &&
    (value.roundWinnerId === null || typeof value.roundWinnerId === "string")
  );
}

function isDeadSlots(value: unknown): value is boolean[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "boolean");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isSlotArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isSafeNonNegativeInteger);
}

function isShopActionAcknowledgement(
  value: unknown,
): value is ShopActionAcknowledgement {
  return (
    isRecord(value) &&
    isSafeNonNegativeInteger(value.slot) &&
    isValidActionId(value.actionId)
  );
}

function isCombatIdentity(value: Record<string, unknown>): boolean {
  return isSafeNonNegativeInteger(value.roundNumber) && isSafeNonNegativeInteger(value.eventSequence) && isSafeNonNegativeInteger(value.afterShotId);
}

function isEconomicResult(value: Record<string, unknown>): boolean {
  return isSafeNonNegativeInteger(value.economicRevision) && isRecord(value.roundEarningsByPlayer) && Object.values(value.roundEarningsByPlayer).every(isSafeNonNegativeInteger);
}

function isZeusStrike(value: unknown): value is ZeusStrikeMessage {
  return (
    isRecord(value) &&
    value.type === "ZEUS_STRIKE" && isCombatIdentity(value) &&
    isSafeNonNegativeInteger(value.strikeId) &&
    typeof value.zeusId === "string" &&
    typeof value.targetId === "string" &&
    isSafeNonNegativeInteger(value.resolveAt)
  );
}

export function isPlayers(value: unknown, earnings = false): value is Player[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          entry.id.trim().length === 0 ||
          typeof entry.name !== "string" ||
          typeof entry.isHuman !== "boolean" ||
          !isSafeNonNegativeInteger(entry.money) ||
          !isInventory(entry.inventory) ||
          !isRecord(entry.tank)
        ) {
          return false;
        }

        const tank = entry.tank;
        return (
          typeof tank.id === "string" &&
          tank.id.trim().length > 0 &&
          isRecord(tank.position) &&
          typeof tank.position.x === "number" &&
          Number.isFinite(tank.position.x) &&
          typeof tank.position.y === "number" &&
          Number.isFinite(tank.position.y) &&
          typeof tank.angle === "number" &&
          Number.isFinite(tank.angle) &&
          tank.angle >= FIRE_COMMAND_MIN_ANGLE && tank.angle <= FIRE_COMMAND_MAX_ANGLE &&
          typeof tank.power === "number" &&
          Number.isFinite(tank.power) &&
          tank.power >= FIRE_COMMAND_MIN_POWER && tank.power <= FIRE_COMMAND_MAX_POWER &&
          typeof tank.health === "number" &&
          Number.isFinite(tank.health) &&
          typeof tank.maxHealth === "number" &&
          Number.isFinite(tank.maxHealth) &&
          tank.maxHealth >= 0 && (earnings || (tank.health >= 0 && tank.health <= tank.maxHealth)) &&
          typeof tank.shield === "number" &&
          Number.isFinite(tank.shield) &&
          typeof tank.maxShield === "number" &&
          Number.isFinite(tank.maxShield) &&
          tank.maxShield >= 0 && (earnings || (tank.shield >= 0 && tank.shield <= tank.maxShield)) &&
          typeof tank.isDead === "boolean" &&
          typeof tank.color === "string" &&
          Object.values(VGA_PALETTE).some((color) => color === tank.color) &&
          (entry.aiProfile === undefined || entry.aiProfile === null || (typeof entry.aiProfile === "string" && ["v1-random", "v2-heuristic", "v3-sniper", "v4-smart"].includes(entry.aiProfile))) &&
          (tank.lastHitBy === undefined || (typeof tank.lastHitBy === "string" && tank.lastHitBy.length > 0)) &&
          (tank.lastDirectAttackerId === undefined || (typeof tank.lastDirectAttackerId === "string" && tank.lastDirectAttackerId.length > 0)) &&
          (tank.hitReaction === undefined || tank.hitReaction === null || (isRecord(tank.hitReaction) &&
            typeof tank.hitReaction.wasDirectHit === "boolean" &&
            typeof tank.hitReaction.fallDistance === "number" && Number.isFinite(tank.hitReaction.fallDistance) && tank.hitReaction.fallDistance >= 0)) &&
          isWeaponId(tank.currentWeapon)
        );
      },
    )
  );
}

function isShotMessage(value: unknown): value is ShotMessage {
  return (
    isRecord(value) &&
    value.type === "SHOT" &&
    isValidActionId(value.actionId) &&
    isSafeNonNegativeInteger(value.shotId) &&
    isSafeNonNegativeInteger(value.roundNumber) &&
    isSafeNonNegativeInteger(value.shotNumberInRound) &&
    isSafeNonNegativeInteger(value.physicsSeed) && value.physicsSeed <= 0xffffffff &&
    isSafeNonNegativeInteger(value.eventSequence) &&
    typeof value.isFirstShotOfRound === "boolean" &&
    isSafeNonNegativeInteger(value.slot) &&
    typeof value.ownerId === "string" &&
    isFireCommand(value.command)
  );
}

export function isStrictOnlineMessage(value: unknown): value is StrictOnlineMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "COMBAT_CATCH_UP_BEGIN":
    case "COMBAT_CATCH_UP_FRAGMENT":
    case "COMBAT_CATCH_UP_END":
      return isCombatCatchUpMessage(value);
    case "REQUEST_GAME_START":
      return (
        value.protocolVersion === ONLINE_PROTOCOL_VERSION &&
        isSafeNonNegativeInteger(value.roundNumber) &&
        isSafeNonNegativeInteger(value.lastSeenShotId) &&
        isSafeNonNegativeInteger(value.lastAppliedShopEpoch)
      );
    case "PROTOCOL_MISMATCH":
      return (
        isSafeNonNegativeInteger(value.requiredVersion) &&
        (value.receivedVersion === null ||
          isSafeNonNegativeInteger(value.receivedVersion))
      );
    case "GAME_START":
      return (
        value.protocolVersion === ONLINE_PROTOCOL_VERSION &&
        isSafeNonNegativeInteger(value.currentPlayerIndex) &&
        isPlayers(value.players) && value.currentPlayerIndex < value.players.length &&
        isRoundMap(value.map) && hasValidSpawnRoster(value.map, value.players)
      );
    case "FIRE":
      return isValidActionId(value.actionId) && isFireCommand(value.command);
    case "SHOP_ENTER":
      return isSafeNonNegativeInteger(value.roundNumber);
    case "SHOP_BUY_SELL":
      return (
        isSafeNonNegativeInteger(value.shopEpoch) &&
        isValidActionId(value.actionId) &&
        isWeaponId(value.weaponId) &&
        (value.delta === 1 || value.delta === -1)
      );
    case "SHOP_READY":
      return (
        isSafeNonNegativeInteger(value.shopEpoch) &&
        isValidActionId(value.actionId)
      );
    case "AUTHORITY_CHANGED":
      return isNullableSlot(value.authoritySlot) && isSafeNonNegativeInteger(value.authorityEpoch);
    case "SHOT":
      return isShotMessage(value);
    case "SHOT_SETTLED":
      return (
        isSafeNonNegativeInteger(value.shotId) &&
        isSafeNonNegativeInteger(value.slot) &&
        isDeadSlots(value.deadSlots)
      );
    case "EARNINGS_REJECTED":
      return isNullableSlot(value.shotId) && isNullableSlot(value.authorityEpoch) &&
        EARNINGS_REJECTED_REASONS.some((reason) => reason === value.reason);
    case "SHOT_EARNINGS":
      return (
        isPlayers(value.players, true) &&
        isSafeNonNegativeInteger(value.shotId) &&
        isSafeNonNegativeInteger(value.authorityEpoch) &&
        isAwards(value.awards) &&
        isDeadSlots(value.deadSlots) &&
        isRoundOutcome(value.roundOutcome) &&
        isStringArray(value.directHitVictimIds)
      );
    case "SHOT_EARNINGS_APPLIED":
      return (
        isEconomicResult(value) &&
        isSafeNonNegativeInteger(value.shotId) &&
        isAwards(value.awards) &&
        isBalances(value.balances) &&
        typeof value.hasEarnings === "boolean" &&
        isSafeNonNegativeInteger(value.blockDurationMs) &&
        isRoundOutcome(value.roundOutcome)
      );
    case "STATE_UPDATE":
      return (
        isSafeNonNegativeInteger(value.currentPlayerIndex) &&
        typeof value.roundEnded === "boolean" &&
        (value.players === undefined || isPlayers(value.players))
      );
    case "ROUND_END":
      return (
        isPlayers(value.players) &&
        (value.roundWinnerId === null || typeof value.roundWinnerId === "string") &&
        typeof value.isDraw === "boolean" &&
        isSafeNonNegativeInteger(value.roundNumber)
      );
    case "SHOP_STATE":
      return (
        isSafeNonNegativeInteger(value.shopEpoch) &&
        isSafeNonNegativeInteger(value.roundNumber) &&
        isSlotArray(value.readySlots) &&
        isPlayers(value.players) &&
        isShopVisitCounters(value.purchasesByPlayerId) &&
        typeof value.aiShopApplied === "boolean" &&
        (value.acknowledgedAction === undefined ||
          isShopActionAcknowledgement(value.acknowledgedAction))
      );
    case "SHOP_REJECTED":
      return (
        (value.shopEpoch === null ||
          isSafeNonNegativeInteger(value.shopEpoch)) &&
        (value.actionId === undefined || isValidActionId(value.actionId)) &&
        (value.weaponId === undefined || isWeaponId(value.weaponId)) &&
        (value.delta === undefined || value.delta === 1 || value.delta === -1) &&
        isShopDenial(value.reason)
      );
    case "ROUND_PREPARATION_FAILED":
      return (value.reason === "EXHAUSTED" || value.reason === "NEW_GAME_REQUIRED") &&
        isSafeNonNegativeInteger(value.roundNumber);
    case "SHOP_FINISH":
      return (
        isSafeNonNegativeInteger(value.shopEpoch) &&
        isSafeNonNegativeInteger(value.completedRoundNumber) &&
        isSafeNonNegativeInteger(value.nextRoundNumber) &&
        value.nextRoundNumber === Number(value.completedRoundNumber) + 1 &&
        isRoundMap(value.map) && value.map.roundNumber === value.nextRoundNumber &&
        isPlayers(value.players) && hasValidSpawnRoster(value.map, value.players) &&
        (value.acknowledgedAction === undefined ||
          isShopActionAcknowledgement(value.acknowledgedAction))
      );
    case "FIRE_REJECTED":
      return (
        (value.actionId === undefined || isValidActionId(value.actionId)) &&
        isFireRejectedReason(value.reason) &&
        isInventory(value.inventory) &&
        isWeaponId(value.currentWeapon)
      );
    case "ZEUS_APPOINTED":
      return (
        isCombatIdentity(value) &&
        isSafeNonNegativeInteger(value.appointmentId) &&
        typeof value.zeusId === "string" &&
        isSafeNonNegativeInteger(value.zeusSlot) &&
        isSlotArray(value.rotationSlots)
      );
    case "ZEUS_STRIKE":
      return isZeusStrike(value);
    case "ZEUS_STRIKE_APPLIED":
      return (
        isCombatIdentity(value) && isEconomicResult(value) &&
        isSafeNonNegativeInteger(value.strikeId) &&
        typeof value.zeusId === "string" &&
        typeof value.targetId === "string" &&
        isRecord(value.award) &&
        typeof value.award.playerId === "string" &&
        isSafeNonNegativeInteger(value.award.amount) &&
        isBalances(value.balances) &&
        isDeadSlots(value.deadSlots) &&
        isRoundOutcome(value.roundOutcome) &&
        isNullableSlot(value.nextPlayerIndex)
      );
    case "ZEUS_STATE":
      return (
        (value.activeZeusId === null || typeof value.activeZeusId === "string") &&
        isSafeNonNegativeInteger(value.currentPlayerIndex) &&
        isSlotArray(value.rotationSlots) &&
        isDeadSlots(value.deadSlots) &&
        (value.activeStrike === null || isZeusStrike(value.activeStrike)) &&
        isSafeNonNegativeInteger(value.lastAppliedStrikeId)
      );
    default:
      return false;
  }
}

export type ShopBuySellDecodeResult =
  | { readonly ok: true; readonly message: ShopBuySellMessage }
  | { readonly ok: false; readonly rejection: ShopRejectedMessage };

export function decodeShopBuySellMessage(
  value: unknown,
): ShopBuySellDecodeResult {
  if (isRecord(value) && value.type === "SHOP_BUY_SELL") {
    if (
      isSafeNonNegativeInteger(value.shopEpoch) &&
      isValidActionId(value.actionId) &&
      isWeaponId(value.weaponId) &&
      (value.delta === 1 || value.delta === -1)
    ) {
      return {
        ok: true,
        message: {
          type: "SHOP_BUY_SELL",
          shopEpoch: value.shopEpoch,
          actionId: value.actionId,
          weaponId: value.weaponId,
          delta: value.delta,
        },
      };
    }
    return {
      ok: false,
      rejection: {
        type: "SHOP_REJECTED",
        shopEpoch: isSafeNonNegativeInteger(value.shopEpoch)
          ? value.shopEpoch
          : null,
        ...(isValidActionId(value.actionId) ? { actionId: value.actionId } : {}),
        ...(isWeaponId(value.weaponId) ? { weaponId: value.weaponId } : {}),
        ...(value.delta === 1 || value.delta === -1
          ? { delta: value.delta }
          : {}),
        reason: "MALFORMED",
      },
    };
  }
  return {
    ok: false,
    rejection: {
      type: "SHOP_REJECTED",
      shopEpoch: null,
      reason: "MALFORMED",
    },
  };
}

export type ShopReadyDecodeResult =
  | { readonly ok: true; readonly message: ShopReadyMessage }
  | { readonly ok: false; readonly rejection: ShopRejectedMessage };

export function decodeShopReadyMessage(value: unknown): ShopReadyDecodeResult {
  if (
    isRecord(value) &&
    value.type === "SHOP_READY" &&
    isSafeNonNegativeInteger(value.shopEpoch) &&
    isValidActionId(value.actionId)
  ) {
    return {
      ok: true,
      message: {
        type: "SHOP_READY",
        shopEpoch: value.shopEpoch,
        actionId: value.actionId,
      },
    };
  }
  const record = isRecord(value) ? value : {};
  return {
    ok: false,
    rejection: {
      type: "SHOP_REJECTED",
      shopEpoch: isSafeNonNegativeInteger(record.shopEpoch)
        ? record.shopEpoch
        : null,
      ...(isValidActionId(record.actionId) ? { actionId: record.actionId } : {}),
      reason: "MALFORMED",
    },
  };
}

export type FireDecodeResult =
  | { readonly ok: true; readonly message: ClientFireMessage }
  | { readonly ok: false; readonly actionId?: string };

export function decodeFireMessage(value: unknown): FireDecodeResult {
  if (
    isRecord(value) &&
    value.type === "FIRE" &&
    isValidActionId(value.actionId) &&
    isFireCommand(value.command)
  ) {
    return {
      ok: true,
      message: {
        type: "FIRE",
        actionId: value.actionId,
        command: value.command,
      },
    };
  }
  if (isRecord(value) && isValidActionId(value.actionId)) {
    return { ok: false, actionId: value.actionId };
  }
  return { ok: false };
}

export function parseStrictOnlineMessage(raw: string): StrictOnlineMessage | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (isRecord(value) && typeof value.type === "string" && value.type.startsWith("COMBAT_CATCH_UP_") &&
        utf8Bytes(raw) > MAX_COMBAT_MESSAGE_BYTES) return null;
    return isStrictOnlineMessage(value) ? value : null;
  } catch {
    return null;
  }
}

function isCombatCatchUpMessage(value: Record<string, unknown>): boolean {
  if (typeof value.catchUpId !== "string" || value.catchUpId.length === 0 || value.catchUpId.length > 128 ||
      !isSafeNonNegativeInteger(value.roundNumber) || value.roundNumber === 0 ||
      !isSafeNonNegativeInteger(value.fragmentCount) || value.fragmentCount === 0 ||
      !isSafeNonNegativeInteger(value.boundary)) return false;
  if (value.type !== "COMBAT_CATCH_UP_FRAGMENT") {
    if ([value.index, value.kind, value.data, value.events, value.firstSequence, value.lastSequence].some((field) => field !== undefined)) return false;
  } else {
    if (!isSafeNonNegativeInteger(value.index) || value.index >= value.fragmentCount) return false;
    if (value.kind === "BASE") {
      if (typeof value.data !== "string" || value.data.length === 0 || value.events !== undefined ||
          value.firstSequence !== undefined || value.lastSequence !== undefined) return false;
    } else if (value.kind === "EVENTS") {
      if (value.data !== undefined || !Array.isArray(value.events) || value.events.length === 0 ||
          !isSafeNonNegativeInteger(value.firstSequence) || value.firstSequence === 0 ||
          !isSafeNonNegativeInteger(value.lastSequence) || value.lastSequence < value.firstSequence ||
          value.lastSequence > value.boundary || value.events.length !== value.lastSequence - value.firstSequence + 1) return false;
      const firstSequence = value.firstSequence;
      const roundNumber = value.roundNumber;
      if (!value.events.every((event: unknown, index) => isRecord(event) &&
          typeof event.type === "string" && ["SHOT", "ZEUS_APPOINTED", "ZEUS_STRIKE", "ZEUS_STRIKE_APPLIED"].includes(event.type) &&
          isStrictOnlineMessage(event) && "eventSequence" in event && "roundNumber" in event &&
          event.roundNumber === roundNumber && event.eventSequence === firstSequence + index)) return false;
    } else return false;
  }
  try {
    return encodedCombatBytes(value) <= MAX_COMBAT_MESSAGE_BYTES;
  } catch {
    return false;
  }
}

export function readProtocolVersion(value: unknown): number | null {
  if (!isRecord(value)) return null;
  return isSafeNonNegativeInteger(value.protocolVersion)
    ? value.protocolVersion
    : null;
}
