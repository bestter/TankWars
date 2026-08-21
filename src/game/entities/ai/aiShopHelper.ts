import type { Player } from "../../../types/player";
import type { WeaponId } from "../../../types/weapon";
import { WEAPON_REGISTRY } from "../../../types/weapon";

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

function toSafeInventory(
  inventory: Player["inventory"],
): NonNullable<Player["inventory"]> {
  const safe = Object.create(null) as NonNullable<Player["inventory"]>;
  if (!inventory || typeof inventory !== "object") return safe;
  for (const [k, v] of Object.entries(inventory)) {
    if (!FORBIDDEN_KEYS.has(k)) {
      (safe as Record<string, unknown>)[k] = v;
    }
  }
  return safe;
}

/**
 * Logique d'achat automatique pour les IA en fonction de leur profil stratégique.
 * Modifie directement l'objet joueur passé en paramètre.
 */
export function autoBuyForAI(aiPlayer: Player): void {
  if (!isSafePlayerTarget(aiPlayer) || aiPlayer.isHuman) return;
  if (hasForbiddenOwnKey(aiPlayer)) return;

  const inventory = toSafeInventory(aiPlayer.inventory);
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
  let money = aiPlayer.money ?? 0;
  const budget = Math.floor(money * budgetRatio);

  for (const wid of preferredOrder) {
    if (wid === "BULLET" && profile !== "v3-sniper") {
      continue;
    }
    const def = WEAPON_REGISTRY[wid];
    if (!def) continue;

    let buysThisWeapon = 0;
    const maxStock = maxStockFor(wid, profile, isDisplacementFocused);
    const maxBuysPerWeapon = 12;

    while (
      buysThisWeapon < maxBuysPerWeapon &&
      (inventory[wid] ?? 0) < maxStock &&
      money >= def.price &&
      spent + def.price <= budget &&
      money > 80 // garde un peu d'argent
    ) {
      const currentStock = inventory[wid] ?? 0;
      money -= def.price;
      inventory[wid] = currentStock + 1;
      spent += def.price;
      buysThisWeapon++;
    }
  }

  aiPlayer.money = money;
  aiPlayer.inventory = inventory;
}
