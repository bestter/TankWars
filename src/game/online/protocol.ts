import type { FireCommand } from "../../types/game";
import type { Player } from "../../types/player";
import { ALL_WEAPON_IDS, type WeaponId } from "../../types/weapon";
import type {
  FireInventoryDenial,
  ShopDenial,
  ShopVisitCounters,
} from "../shop/shopTransaction";
import { isValidActionId } from "./actionId";
import type { TerrainMaterial } from "../../types/terrain";

export const ONLINE_PROTOCOL_VERSION = 1 as const;
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
  wind?: number;
  players?: Player[];
  heights?: number[];
  materials?: TerrainMaterial[];
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
  type: "SHOP_FINISH";
  shopEpoch: number;
  completedRoundNumber: number;
  nextRoundNumber: number;
  players: Player[];
}

export type FireRejectedReason =
  | "MALFORMED"
  | "NOT_YOUR_TURN"
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

export interface ShotCatchUpMessage {
  type: "SHOT_CATCH_UP";
  roundNumber: number;
  activeShotId: number | null;
  shots: ShotMessage[];
  lastFireResult: ShotMessage | FireRejectedMessage | null;
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

export interface ShotEarningsMessage {
  type: "SHOT_EARNINGS";
  shotId: number;
  authorityEpoch: number;
  awards: Array<{ playerId: string; amount: number }>;
  deadSlots: boolean[];
  roundOutcome: RoundOutcomeWire;
  directHitVictimIds: string[];
}

export interface ShotEarningsAppliedMessage {
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
  type: "ZEUS_APPOINTED";
  appointmentId: number;
  zeusId: string;
  zeusSlot: number;
  rotationSlots: number[];
}

export interface ZeusStrikeMessage {
  type: "ZEUS_STRIKE";
  strikeId: number;
  zeusId: string;
  targetId: string;
  resolveAt: number;
}

export interface ZeusStrikeAppliedMessage {
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
  type: "ZEUS_STATE";
  activeZeusId: string | null;
  currentPlayerIndex: number;
  rotationSlots: number[];
  deadSlots: boolean[];
  activeStrike: ZeusStrikeMessage | null;
  lastAppliedStrikeId: number;
}

export type StrictOnlineMessage =
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
  | ShotEarningsMessage
  | ShotEarningsAppliedMessage
  | StateUpdateMessage
  | RoundEndMessage
  | ShopStateMessage
  | ShopRejectedMessage
  | ShopFinishMessage
  | FireRejectedMessage
  | ShotCatchUpMessage
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
    typeof value.power === "number" &&
    Number.isFinite(value.power) &&
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

function isZeusStrike(value: unknown): value is ZeusStrikeMessage {
  return (
    isRecord(value) &&
    value.type === "ZEUS_STRIKE" &&
    isSafeNonNegativeInteger(value.strikeId) &&
    typeof value.zeusId === "string" &&
    typeof value.targetId === "string" &&
    isSafeNonNegativeInteger(value.resolveAt)
  );
}

function isPlayers(value: unknown): value is Player[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
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
          isRecord(tank.position) &&
          typeof tank.position.x === "number" &&
          Number.isFinite(tank.position.x) &&
          typeof tank.position.y === "number" &&
          Number.isFinite(tank.position.y) &&
          typeof tank.angle === "number" &&
          Number.isFinite(tank.angle) &&
          typeof tank.power === "number" &&
          Number.isFinite(tank.power) &&
          typeof tank.health === "number" &&
          Number.isFinite(tank.health) &&
          typeof tank.maxHealth === "number" &&
          Number.isFinite(tank.maxHealth) &&
          typeof tank.shield === "number" &&
          Number.isFinite(tank.shield) &&
          typeof tank.maxShield === "number" &&
          Number.isFinite(tank.maxShield) &&
          typeof tank.isDead === "boolean" &&
          typeof tank.color === "string" &&
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
    typeof value.isFirstShotOfRound === "boolean" &&
    isSafeNonNegativeInteger(value.slot) &&
    typeof value.ownerId === "string" &&
    isFireCommand(value.command)
  );
}

export function isStrictOnlineMessage(value: unknown): value is StrictOnlineMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
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
        isSafeNonNegativeInteger(value.currentPlayerIndex)
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
    case "SHOT_EARNINGS":
      return (
        isSafeNonNegativeInteger(value.shotId) &&
        isSafeNonNegativeInteger(value.authorityEpoch) &&
        isAwards(value.awards) &&
        isDeadSlots(value.deadSlots) &&
        isRoundOutcome(value.roundOutcome) &&
        isStringArray(value.directHitVictimIds)
      );
    case "SHOT_EARNINGS_APPLIED":
      return (
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
        typeof value.aiShopApplied === "boolean"
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
    case "SHOP_FINISH":
      return (
        isSafeNonNegativeInteger(value.shopEpoch) &&
        isSafeNonNegativeInteger(value.completedRoundNumber) &&
        isSafeNonNegativeInteger(value.nextRoundNumber) &&
        isPlayers(value.players)
      );
    case "FIRE_REJECTED":
      return (
        (value.actionId === undefined || isValidActionId(value.actionId)) &&
        isFireRejectedReason(value.reason) &&
        isInventory(value.inventory) &&
        isWeaponId(value.currentWeapon)
      );
    case "SHOT_CATCH_UP":
      return (
        isSafeNonNegativeInteger(value.roundNumber) &&
        isNullableSlot(value.activeShotId) &&
        Array.isArray(value.shots) &&
        value.shots.every(isShotMessage) &&
        (value.lastFireResult === null ||
          isShotMessage(value.lastFireResult) ||
          (isRecord(value.lastFireResult) &&
            value.lastFireResult.type === "FIRE_REJECTED" &&
            (value.lastFireResult.actionId === undefined ||
              isValidActionId(value.lastFireResult.actionId)) &&
            isFireRejectedReason(value.lastFireResult.reason) &&
            isInventory(value.lastFireResult.inventory) &&
            isWeaponId(value.lastFireResult.currentWeapon)))
      );
    case "ZEUS_APPOINTED":
      return (
        isSafeNonNegativeInteger(value.appointmentId) &&
        typeof value.zeusId === "string" &&
        isSafeNonNegativeInteger(value.zeusSlot) &&
        isSlotArray(value.rotationSlots)
      );
    case "ZEUS_STRIKE":
      return isZeusStrike(value);
    case "ZEUS_STRIKE_APPLIED":
      return (
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
    return isStrictOnlineMessage(value) ? value : null;
  } catch {
    return null;
  }
}

export function readProtocolVersion(value: unknown): number | null {
  if (!isRecord(value)) return null;
  return isSafeNonNegativeInteger(value.protocolVersion)
    ? value.protocolVersion
    : null;
}

export function isLegacyFirePayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "FIRE" &&
    value.actionId === undefined &&
    isFireCommand(value.command)
  );
}

export function isLegacyShopPayload(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "SHOP_ADVANCE") return true;
  if (value.type === "SHOP_BUY_SELL") {
    return isRecord(value.player) || value.actionId === undefined;
  }
  if (value.type === "SHOP_READY") {
    return value.actionId === undefined && Array.isArray(value.players);
  }
  return false;
}
