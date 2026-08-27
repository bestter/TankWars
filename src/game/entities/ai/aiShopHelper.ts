import type { Player } from "../../../types/player";
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

function maxStockFor(
  wid: WeaponId,
  profile: string,
  displacementFocused: boolean,
): number {
  if (wid === "BULLET" && profile === "v3-sniper") return 2;
  if (wid === "BULLDOZER") return displacementFocused ? 2 : 1;
  return Number.POSITIVE_INFINITY;
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
  initialCounters: ShopVisitCounters = {},
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
  const profile = aiPlayer.aiProfile ?? "v1-random";
  const isDisplacementFocused = profile === "v4-smart";

  // Budget et priorités selon le profil IA
  let preferredOrder: WeaponId[] = [
    "CLUSTER",
    "DRILLER",
    "GRENADE",
    "NUKE",
    "THERMONUCLEAR",
  ];
  let budgetRatio = 0.7; // défaut : 70 % du budget

  if (profile === "v3-sniper") {
    // Sniper : armes cinétiques précises seulement (Bullet, Driller)
    preferredOrder = ["BULLET", "DRILLER"];
    budgetRatio = 0.7;
  } else if (profile === "v4-smart") {
    preferredOrder = [
      "CLUSTER",
      "DRILLER",
      "BULLDOZER",
      "GRENADE",
      "NUKE",
      "THERMONUCLEAR",
    ];
    budgetRatio = 0.78;
  } else if (profile === "v2-heuristic") {
    preferredOrder = [
      "CLUSTER",
      "DRILLER",
      "GRENADE",
      "NUKE",
      "THERMONUCLEAR",
      "BULLDOZER",
    ];
  }

  let spent = 0;
  let money = player.money;
  const budget = Math.floor(money * budgetRatio);

  for (const wid of preferredOrder) {
    if (wid === "BULLET" && profile !== "v3-sniper") {
      continue;
    }
    const def = WEAPON_REGISTRY[wid];
    if (!def) continue;

    const strategyMaxStock = maxStockFor(
      wid,
      profile,
      isDisplacementFocused,
    );
    const targetStock = Math.min(
      strategyMaxStock,
      getShopPolicy(wid).maxStock,
    );

    while (
      (player.inventory[wid] ?? 0) < targetStock &&
      money >= def.price &&
      spent + def.price <= budget &&
      money > 80 // garde un peu d'argent
    ) {
      const transaction = applyShopTransaction({
        player,
        counters,
        weaponId: wid,
        delta: 1,
      });
      if (!transaction.ok) break;
      const previousMoney = player.money;
      player = transaction.player;
      counters = transaction.counters;
      money = player.money;
      spent += previousMoney - money;
    }
  }

  return { player, counters };
}
