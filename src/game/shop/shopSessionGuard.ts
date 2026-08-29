import type { ShopSessionDenial } from "./shopTransaction";
import { isValidActionId } from "../online/actionId";

export interface ShopSessionSnapshot {
  readonly epoch: number;
  readonly roundNumber: number;
  readonly readySlots: ReadonlyArray<number>;
}

export type ShopEnterGuardResult =
  | { readonly ok: true; readonly mode: "CREATE" | "RESUME" }
  | { readonly ok: false; readonly reason: ShopSessionDenial };

export interface ShopEnterGuardInput {
  readonly isHumanSlot: boolean;
  readonly roundEnded: boolean;
  readonly shotInFlight: boolean;
  readonly zeusStrikeActive: boolean;
  readonly serverRoundNumber: number;
  readonly requestedRoundNumber: number;
  readonly session: ShopSessionSnapshot | null;
}

export function guardShopEnter(
  input: ShopEnterGuardInput,
): ShopEnterGuardResult {
  if (!input.isHumanSlot) return { ok: false, reason: "NOT_YOUR_SLOT" };
  if (
    !input.roundEnded ||
    input.shotInFlight ||
    input.zeusStrikeActive ||
    input.requestedRoundNumber !== input.serverRoundNumber
  ) {
    return { ok: false, reason: "SHOP_NOT_AVAILABLE" };
  }
  if (input.session) {
    return input.session.roundNumber === input.serverRoundNumber
      ? { ok: true, mode: "RESUME" }
      : { ok: false, reason: "SHOP_NOT_AVAILABLE" };
  }
  return { ok: true, mode: "CREATE" };
}

export type ShopActionGuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ShopSessionDenial };

export interface ShopActionGuardInput {
  readonly isHumanSlot: boolean;
  readonly slot: number;
  readonly actionId: string;
  readonly requestedEpoch: number;
  readonly session: ShopSessionSnapshot | null;
}

export function guardShopAction(
  input: ShopActionGuardInput,
): ShopActionGuardResult {
  if (!isValidActionId(input.actionId)) {
    return { ok: false, reason: "MALFORMED" };
  }
  if (!input.session) return { ok: false, reason: "SHOP_CLOSED" };
  if (input.requestedEpoch !== input.session.epoch) {
    return { ok: false, reason: "STALE_SHOP_EPOCH" };
  }
  if (!input.isHumanSlot) return { ok: false, reason: "NOT_YOUR_SLOT" };
  if (input.session.readySlots.includes(input.slot)) {
    return { ok: false, reason: "ALREADY_READY" };
  }
  return { ok: true };
}
