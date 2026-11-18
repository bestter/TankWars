import type { AiProfile, Player } from "../../../types/player";
import type { WeaponId } from "../../../types/weapon";
import { WEAPON_REGISTRY } from "../../../types/weapon";
import { secureRandom } from "../../../utils/random";
import type { PurchaseObservation } from "../../observation";
import { getShopPolicy } from "../../shop/shopPolicy";
import { getAiFreeWeaponsTargets } from "../../shop/freeWeapons";
import {
  applyShopTransaction,
  type ShopVisitCounters,
} from "../../shop/shopTransaction";

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isPlainOrNullProtoObject(
  value: unknown,
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (value === Object.prototype) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasForbiddenOwnKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.getOwnPropertyNames(value).some((k) => FORBIDDEN_KEYS.has(k));
}

function readOwnProperty(record: unknown, key: string): unknown {
  if (!isPlainOrNullProtoObject(record)) return undefined;
  if (FORBIDDEN_KEYS.has(key)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  return record[key];
}

function readLegalNonNegativeInt(record: unknown, key: string): number | null {
  const raw = readOwnProperty(record, key);
  const value = raw === undefined ? 0 : raw;
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function copySafeInventory(
  inventory: unknown,
): Partial<Record<WeaponId, number>> {
  const safe: Partial<Record<WeaponId, number>> = {};
  if (!isPlainOrNullProtoObject(inventory)) return safe;
  for (const key of Object.keys(inventory)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    (safe as Record<string, unknown>)[key] = inventory[key];
  }
  return safe;
}

function copySafeCounters(counters: unknown): ShopVisitCounters {
  const safe: Record<string, Record<string, number>> = {};
  if (!isPlainOrNullProtoObject(counters)) return safe;
  for (const playerId of Object.keys(counters)) {
    if (FORBIDDEN_KEYS.has(playerId)) continue;
    const entry = counters[playerId];
    if (!isPlainOrNullProtoObject(entry)) continue;
    const safeEntry: Record<string, number> = {};
    for (const weaponKey of Object.keys(entry)) {
      if (FORBIDDEN_KEYS.has(weaponKey)) continue;
      safeEntry[weaponKey] = entry[weaponKey] as number;
    }
    safe[playerId] = safeEntry;
  }
  return safe;
}

function isLegalMoney(money: unknown): money is number {
  return (
    typeof money === "number" && Number.isSafeInteger(money) && money >= 0
  );
}

export type InitialPlayerCount = 2 | 3 | 4;

const DEFAULT_AI_SHOP_PROFILE: AiProfile = "v2-heuristic";

const AI_SHOP_PREFERENCES = {
  "v1-random": ["GRENADE", "CLUSTER"],
  "v2-heuristic": ["GRENADE", "CLUSTER", "DRILLER", "BULLDOZER"],
  "v3-sniper": ["BULLET", "DRILLER", "BULLDOZER"],
  "v4-smart": [
    "THERMONUCLEAR",
    "NUKE",
    "GRENADE",
    "CLUSTER",
    "DRILLER",
    "BULLDOZER",
  ],
} as const satisfies Record<AiProfile, readonly WeaponId[]>;

const OCCASIONAL_NUCLEAR_PROFILES: ReadonlySet<AiProfile> = new Set([
  "v1-random",
  "v2-heuristic",
]);

const OCCASIONAL_NUCLEAR_OFFERS = [
  { weaponId: "NUKE", chance: 0.1, strategicCap: 1 },
  { weaponId: "THERMONUCLEAR", chance: 0.05, strategicCap: 1 },
] as const satisfies readonly {
  readonly weaponId: WeaponId;
  readonly chance: number;
  readonly strategicCap: number;
}[];

export function isInitialPlayerCount(
  value: number,
): value is InitialPlayerCount {
  return value === 2 || value === 3 || value === 4;
}

function resolveShopProfile(value: unknown): AiProfile {
  switch (value) {
    case "v1-random":
    case "v2-heuristic":
    case "v3-sniper":
    case "v4-smart":
      return value;
    default:
      return DEFAULT_AI_SHOP_PROFILE;
  }
}

function strategicStockCap(
  profile: AiProfile,
  weaponId: WeaponId,
  initialPlayerCount: InitialPlayerCount,
): number {
  return getAiFreeWeaponsTargets(profile, initialPlayerCount)[weaponId] ?? 0;
}

interface MutableShopState {
  player: Player;
  counters: ShopVisitCounters;
  readonly purchases: PurchaseObservation[];
}

function tryBuySingleUnit(
  state: MutableShopState,
  weaponId: WeaponId,
  observe: boolean,
): boolean {
  const transaction = applyShopTransaction({
    player: state.player,
    counters: state.counters,
    weaponId,
    delta: 1,
  });
  if (!transaction.ok) return false;
  if (observe) {
    const stockBefore = readOwnProperty(state.player.inventory, weaponId);
    const stockAfter = readOwnProperty(transaction.player.inventory, weaponId);
    state.purchases.push({
      playerId: state.player.id,
      profile: state.player.aiProfile,
      weaponId,
      quantity: 1,
      price: WEAPON_REGISTRY[weaponId].price,
      moneyBefore: state.player.money,
      moneyAfter: transaction.player.money,
      stockBefore: typeof stockBefore === "number" ? stockBefore : 0,
      stockAfter: typeof stockAfter === "number" ? stockAfter : 0,
    });
  }
  state.player = transaction.player;
  state.counters = transaction.counters;
  return true;
}

function canRollOccasionalNuclear(
  player: Player,
  counters: ShopVisitCounters,
  weaponId: WeaponId,
  strategicCap: number,
): boolean {
  if (!isLegalMoney(player.money)) return false;

  const { price } = WEAPON_REGISTRY[weaponId];
  if (player.money < price) return false;
  const nextMoney = player.money - price;
  if (!Number.isSafeInteger(nextMoney) || nextMoney < 0) return false;

  const policy = getShopPolicy(weaponId);
  const stock = readLegalNonNegativeInt(player.inventory, weaponId);
  if (
    stock === null ||
    stock > policy.maxStock ||
    stock >= strategicCap
  ) {
    return false;
  }

  const playerCounters = readOwnProperty(counters, player.id);
  if (
    playerCounters !== undefined &&
    !isPlainOrNullProtoObject(playerCounters)
  ) {
    return false;
  }
  const count =
    playerCounters === undefined
      ? 0
      : readLegalNonNegativeInt(playerCounters, weaponId);
  if (
    count === null ||
    count >= policy.maxPurchasesPerVisit ||
    !Number.isSafeInteger(count + 1)
  ) {
    return false;
  }

  return true;
}

export interface AutoBuyResult {
  readonly player: Player;
  readonly counters: ShopVisitCounters;
  readonly purchases?: readonly PurchaseObservation[];
}

/**
 * Logique d'achat automatique immutable pour les IA en fonction de leur profil stratégique.
 * Chaque achat unitaire passe par le domaine boutique partagé.
 */
export function autoBuyForAI(
  aiPlayer: Player,
  initialPlayerCount: InitialPlayerCount,
  initialCounters: ShopVisitCounters,
  observe = false,
): AutoBuyResult {
  if (
    !isPlainOrNullProtoObject(aiPlayer) ||
    aiPlayer.isHuman ||
    hasForbiddenOwnKey(aiPlayer) ||
    typeof aiPlayer.id !== "string" ||
    aiPlayer.id.length === 0 ||
    FORBIDDEN_KEYS.has(aiPlayer.id)
  ) {
    return { player: aiPlayer, counters: initialCounters };
  }

  const rawInitialPlayerCounters = readOwnProperty(initialCounters, aiPlayer.id);
  const state: MutableShopState = {
    player: {
      ...aiPlayer,
      inventory: copySafeInventory(aiPlayer.inventory),
    },
    counters: copySafeCounters(initialCounters),
    purchases: [],
  };

  if (
    !isLegalMoney(state.player.money) ||
    (rawInitialPlayerCounters !== undefined &&
      !isPlainOrNullProtoObject(rawInitialPlayerCounters))
  ) {
    return {
      player: state.player,
      counters: state.counters,
      ...(observe ? { purchases: state.purchases } : {}),
    };
  }

  const profile = resolveShopProfile(aiPlayer.aiProfile);

  for (const weaponId of AI_SHOP_PREFERENCES[profile]) {
    const stock = readLegalNonNegativeInt(state.player.inventory, weaponId);
    if (stock === null) continue;
    const purchasesThisVisit = readLegalNonNegativeInt(
      readOwnProperty(state.counters, state.player.id),
      weaponId,
    );
    if (purchasesThisVisit === null) continue;

    const { price } = WEAPON_REGISTRY[weaponId];
    const policy = getShopPolicy(weaponId);
    const strategyMaxStock = strategicStockCap(
      profile,
      weaponId,
      initialPlayerCount,
    );
    const targetStock = Math.min(
      initialPlayerCount * 3,
      strategyMaxStock,
      policy.maxStock,
    );
    const desiredQuantity = Math.max(0, targetStock - stock);
    const affordableQuantity = Math.floor(state.player.money / price);
    const remainingQuota = Math.max(
      0,
      policy.maxPurchasesPerVisit - purchasesThisVisit,
    );
    const remainingStockSpace = Math.max(0, policy.maxStock - stock);
    const quantityToBuy = Math.min(
      desiredQuantity,
      affordableQuantity,
      remainingQuota,
      remainingStockSpace,
    );

    for (let quantity = 0; quantity < quantityToBuy; quantity++) {
      if (!tryBuySingleUnit(state, weaponId, observe)) break;
    }
  }

  if (OCCASIONAL_NUCLEAR_PROFILES.has(profile)) {
    for (const offer of OCCASIONAL_NUCLEAR_OFFERS) {
      if (
        !canRollOccasionalNuclear(
          state.player,
          state.counters,
          offer.weaponId,
          offer.strategicCap,
        )
      ) {
        continue;
      }
      if (secureRandom() < offer.chance) {
        tryBuySingleUnit(state, offer.weaponId, observe);
      }
    }
  }

  return {
    player: state.player,
    counters: state.counters,
    ...(observe ? { purchases: state.purchases } : {}),
  };
}
