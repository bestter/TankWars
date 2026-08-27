import type { Player } from "../../types/player";
import {
  ALL_WEAPON_IDS,
  SHOP_WEAPON_IDS,
  WEAPON_REGISTRY,
  type WeaponId,
} from "../../types/weapon";
import { getShopPolicy } from "./shopPolicy";

export type ShopBuyDenial =
  | "STOCK_CAP"
  | "PURCHASE_LIMIT"
  | "INSUFFICIENT_FUNDS";

export type ShopSellDenial = "NO_STOCK" | "NOT_SOLD";

export type ShopEconomyDenial =
  | ShopBuyDenial
  | ShopSellDenial
  | "ILLEGAL_INVENTORY"
  | "MALFORMED";

export type ShopSessionDenial =
  | "MALFORMED"
  | "NOT_YOUR_SLOT"
  | "ALREADY_READY"
  | "SHOP_CLOSED"
  | "SHOP_NOT_AVAILABLE"
  | "STALE_SHOP_EPOCH";

export type ShopDenial = ShopEconomyDenial | ShopSessionDenial;

export type ShopVisitCounters = Readonly<
  Partial<
    Record<string, Readonly<Partial<Record<WeaponId, number>>>>
  >
>;

export interface ShopTransactionInput {
  readonly player: Player;
  readonly counters: ShopVisitCounters;
  readonly weaponId: WeaponId;
  readonly delta: 1 | -1;
}

export type ShopTransactionResult =
  | {
      readonly ok: true;
      readonly player: Player;
      readonly counters: ShopVisitCounters;
    }
  | {
      readonly ok: false;
      readonly reason: ShopEconomyDenial;
      readonly player: Player;
      readonly counters: ShopVisitCounters;
    };

export type FireInventoryDenial = "NO_AMMO" | "ILLEGAL_INVENTORY";

export type FireInventoryResult =
  | { readonly ok: true; readonly player: Player }
  | {
      readonly ok: false;
      readonly reason: FireInventoryDenial;
      readonly player: Player;
    };

function isShopWeapon(weaponId: WeaponId): boolean {
  return SHOP_WEAPON_IDS.includes(weaponId);
}

function readLegalStock(
  player: Player,
  weaponId: WeaponId,
): { readonly legal: true; readonly stock: number } | { readonly legal: false } {
  const rawStock = player.inventory?.[weaponId];
  const stock = rawStock === undefined ? 0 : rawStock;
  if (!Number.isSafeInteger(stock) || stock < 0) return { legal: false };

  const { maxStock } = getShopPolicy(weaponId);
  if (stock > maxStock) return { legal: false };
  return { legal: true, stock };
}

function readPurchaseCount(
  counters: ShopVisitCounters,
  playerId: string,
  weaponId: WeaponId,
): { readonly legal: true; readonly count: number } | { readonly legal: false } {
  const rawCount = counters[playerId]?.[weaponId];
  const count = rawCount === undefined ? 0 : rawCount;
  return Number.isSafeInteger(count) && count >= 0
    ? { legal: true, count }
    : { legal: false };
}

function withPurchaseCount(
  counters: ShopVisitCounters,
  playerId: string,
  weaponId: WeaponId,
  count: number,
): ShopVisitCounters {
  return {
    ...counters,
    [playerId]: {
      ...counters[playerId],
      [weaponId]: count,
    },
  };
}

function reject(
  input: ShopTransactionInput,
  reason: ShopEconomyDenial,
): ShopTransactionResult {
  return {
    ok: false,
    reason,
    player: input.player,
    counters: input.counters,
  };
}

export function applyShopTransaction(
  input: ShopTransactionInput,
): ShopTransactionResult {
  const { player, counters, weaponId, delta } = input;
  if (!isShopWeapon(weaponId)) return reject(input, "NOT_SOLD");

  const stockResult = readLegalStock(player, weaponId);
  if (!stockResult.legal) return reject(input, "ILLEGAL_INVENTORY");

  const { stock } = stockResult;
  const policy = getShopPolicy(weaponId);
  const countResult = readPurchaseCount(counters, player.id, weaponId);
  if (!countResult.legal) return reject(input, "MALFORMED");

  if (delta === 1) {
    if (stock >= policy.maxStock) return reject(input, "STOCK_CAP");
    if (countResult.count >= policy.maxPurchasesPerVisit) {
      return reject(input, "PURCHASE_LIMIT");
    }
    if (
      !Number.isSafeInteger(player.money) ||
      player.money < 0 ||
      player.money < WEAPON_REGISTRY[weaponId].price
    ) {
      return reject(input, "INSUFFICIENT_FUNDS");
    }

    const nextMoney = player.money - WEAPON_REGISTRY[weaponId].price;
    const nextStock = stock + 1;
    const nextCount = countResult.count + 1;
    if (
      !Number.isSafeInteger(nextMoney) ||
      nextMoney < 0 ||
      !Number.isSafeInteger(nextStock) ||
      !Number.isSafeInteger(nextCount)
    ) {
      return reject(input, "MALFORMED");
    }

    return {
      ok: true,
      player: {
        ...player,
        money: nextMoney,
        inventory: { ...player.inventory, [weaponId]: nextStock },
      },
      counters: withPurchaseCount(
        counters,
        player.id,
        weaponId,
        nextCount,
      ),
    };
  }

  if (stock < 1) return reject(input, "NO_STOCK");

  const nextMoney = player.money + WEAPON_REGISTRY[weaponId].price;
  if (!Number.isSafeInteger(nextMoney) || nextMoney < 0) {
    return reject(input, "MALFORMED");
  }

  return {
    ok: true,
    player: {
      ...player,
      money: nextMoney,
      inventory: { ...player.inventory, [weaponId]: stock - 1 },
    },
    counters,
  };
}

export function normalizeInventoryAtShopOpen(player: Player): Player {
  const inventory: Partial<Record<WeaponId, number>> = {};
  for (const weaponId of ALL_WEAPON_IDS) {
    if (weaponId === "MISSILE") continue;
    const rawStock = player.inventory?.[weaponId];
    if (rawStock === undefined) continue;
    inventory[weaponId] =
      Number.isSafeInteger(rawStock) && rawStock >= 0 ? rawStock : 0;
  }

  if (inventory.NUKE !== undefined) {
    inventory.NUKE = Math.min(
      inventory.NUKE,
      getShopPolicy("NUKE").maxStock,
    );
  }
  if (inventory.THERMONUCLEAR !== undefined) {
    inventory.THERMONUCLEAR = Math.min(
      inventory.THERMONUCLEAR,
      getShopPolicy("THERMONUCLEAR").maxStock,
    );
  }

  return { ...player, inventory };
}

export function normalizeRosterAtShopOpen(
  players: ReadonlyArray<Player>,
): Player[] {
  return players.map(normalizeInventoryAtShopOpen);
}

export function consumeWeaponForFire(
  player: Player,
  weaponId: WeaponId,
): FireInventoryResult {
  if (weaponId === "MISSILE") {
    return {
      ok: true,
      player: {
        ...player,
        tank: { ...player.tank, currentWeapon: "MISSILE" },
        inventory: { ...player.inventory },
      },
    };
  }

  const stockResult = readLegalStock(player, weaponId);
  if (!stockResult.legal) {
    return { ok: false, reason: "ILLEGAL_INVENTORY", player };
  }
  if (stockResult.stock < 1) {
    return { ok: false, reason: "NO_AMMO", player };
  }

  const nextStock = stockResult.stock - 1;
  return {
    ok: true,
    player: {
      ...player,
      tank: {
        ...player.tank,
        currentWeapon: nextStock === 0 ? "MISSILE" : weaponId,
      },
      inventory: { ...player.inventory, [weaponId]: nextStock },
    },
  };
}
