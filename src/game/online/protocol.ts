import type { FireCommand } from "../../types/game";
import type { Player } from "../../types/player";
import { ALL_WEAPON_IDS } from "../../types/weapon";

export interface AuthorityChangedMessage {
  type: "AUTHORITY_CHANGED";
  authoritySlot: number | null;
  authorityEpoch: number;
}

export interface ShotMessage {
  type: "SHOT";
  shotId: number;
  roundNumber: number;
  shotNumberInRound: number;
  isFirstShotOfRound: boolean;
  slot: number;
  ownerId: string;
  command: FireCommand;
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
  | AuthorityChangedMessage
  | ShotMessage
  | ShotSettledMessage
  | ShotEarningsMessage
  | ShotEarningsAppliedMessage
  | StateUpdateMessage
  | RoundEndMessage
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
    typeof value.weaponId === "string" &&
    ALL_WEAPON_IDS.includes(value.weaponId as FireCommand["weaponId"])
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
      (entry) =>
        isRecord(entry) &&
        typeof entry.id === "string" &&
        typeof entry.money === "number" &&
        isRecord(entry.tank),
    )
  );
}

export function isStrictOnlineMessage(value: unknown): value is StrictOnlineMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "AUTHORITY_CHANGED":
      return isNullableSlot(value.authoritySlot) && isSafeNonNegativeInteger(value.authorityEpoch);
    case "SHOT":
      return (
        isSafeNonNegativeInteger(value.shotId) &&
        isSafeNonNegativeInteger(value.roundNumber) &&
        isSafeNonNegativeInteger(value.shotNumberInRound) &&
        typeof value.isFirstShotOfRound === "boolean" &&
        isSafeNonNegativeInteger(value.slot) &&
        typeof value.ownerId === "string" &&
        isFireCommand(value.command)
      );
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

export function parseStrictOnlineMessage(raw: string): StrictOnlineMessage | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isStrictOnlineMessage(value) ? value : null;
  } catch {
    return null;
  }
}
