import type { AiProfile, Player } from "../../../types/player";
import type { WeaponId } from "../../../types/weapon";
import { WEAPON_REGISTRY } from "../../../types/weapon";
import { getShopPolicy } from "../../shop/shopPolicy";
import {
  applyShopTransaction,
  type ShopVisitCounters,
} from "../../shop/shopTransaction";

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function hasForbiddenOwnKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.keys(value as Record<string, unknown>).some((k) =>
    FORBIDDEN_KEYS.has(k),
  );
}

function isSafePlayerTarget(value: unknown): value is Player {
  if (!value || typeof value !== "object") return false;
  if (value === Object.prototype) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export type InitialPlayerCount = 2 | 3 | 4;

const DEFAULT_AI_SHOP_PROFILE: AiProfile = "v2-heuristic";

const AI_SHOP_PREFERENCES = {
  "v1-random": ["GRENADE", "CLUSTER"],
  "v2-heuristic": [
    "GRENADE",
    "CLUSTER",
    "DRILLER",
    "BULLDOZER",
    "NUKE",
  ],
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
  switch (profile) {
    case "v1-random":
      return weaponId === "GRENADE" || weaponId === "CLUSTER"
        ? initialPlayerCount - 1
        : 0;
    case "v2-heuristic":
      if (weaponId === "GRENADE" || weaponId === "CLUSTER") {
        return initialPlayerCount * 3;
      }
      if (weaponId === "DRILLER" || weaponId === "BULLDOZER") {
        return initialPlayerCount;
      }
      return weaponId === "NUKE" ? 1 : 0;
    case "v3-sniper":
      if (weaponId === "BULLET") return initialPlayerCount * 3;
      if (weaponId === "DRILLER" || weaponId === "BULLDOZER") {
        return initialPlayerCount * 2;
      }
      return 0;
    case "v4-smart":
      if (
        weaponId === "GRENADE" ||
        weaponId === "CLUSTER" ||
        weaponId === "DRILLER" ||
        weaponId === "BULLDOZER"
      ) {
        return initialPlayerCount * 3;
      }
      if (weaponId === "NUKE") return 2;
      return weaponId === "THERMONUCLEAR" ? 1 : 0;
  }
}

export interface AutoBuyResult {
  readonly player: Player;
  readonly counters: ShopVisitCounters;
}

/**
 * Logique d'achat automatique immutable pour les IA en fonction de leur profil stratégique.
 * Chaque achat unitaire passe par le domaine boutique partagé.
 */
export function autoBuyForAI(
  aiPlayer: Player,
  initialPlayerCount: InitialPlayerCount,
  initialCounters: ShopVisitCounters,
): AutoBuyResult {
  if (
    !isSafePlayerTarget(aiPlayer) ||
    aiPlayer.isHuman ||
    hasForbiddenOwnKey(aiPlayer)
  ) {
    return { player: aiPlayer, counters: initialCounters };
  }

  let player = aiPlayer;
  let counters = initialCounters;
  const profile = resolveShopProfile(aiPlayer.aiProfile);

  for (const weaponId of AI_SHOP_PREFERENCES[profile]) {
    const stock = player.inventory[weaponId] ?? 0;
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
    const affordableQuantity = Math.floor(player.money / price);
    const purchasesThisVisit = counters[player.id]?.[weaponId] ?? 0;
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
      const transaction = applyShopTransaction({
        player,
        counters,
        weaponId,
        delta: 1,
      });
      if (!transaction.ok) break;
      player = transaction.player;
      counters = transaction.counters;
    }
  }

  return { player, counters };
}
