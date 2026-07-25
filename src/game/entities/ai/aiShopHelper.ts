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
  if (!aiPlayer || aiPlayer.isHuman) return;
  if (hasForbiddenOwnKey(aiPlayer)) return;

  aiPlayer.inventory = toSafeInventory(aiPlayer.inventory);

  const profile = aiPlayer.aiProfile ?? "v1-random";

  // Configure budget and priorities depending on AI profile
  let preferredOrder: WeaponId[] = [
    "CLUSTER",
    "DRILLER",
    "GRENADE",
    "NUKE",
    "THERMONUCLEAR",
  ];
  let budgetRatio = 0.7; // default 70% budget spending

  if (profile === "v3-sniper") {
    // Sniper only wants precise kinetic weapons: Driller, Bullet
    preferredOrder = ["BULLET", "DRILLER"];
    budgetRatio = 0.7;
  } else if (profile === "v4-smart") {
    // Smart AI spends more aggressively (85% budget) on its tools
    preferredOrder = [
      "CLUSTER",
      "DRILLER",
      "GRENADE",
      "NUKE",
      "THERMONUCLEAR",
    ];
    budgetRatio = 0.85;
  }

  let spent = 0;
  const budget = Math.floor((aiPlayer.money ?? 0) * budgetRatio);

  for (const wid of preferredOrder) {
    if (wid === "BULLET" && profile !== "v3-sniper") {
      continue;
    }
    const def = WEAPON_REGISTRY[wid];
    if (!def) continue;

    let buysThisWeapon = 0;
    const maxBuysPerWeapon = 12;

    while (
      buysThisWeapon < maxBuysPerWeapon &&
      (aiPlayer.money ?? 0) >= def.price &&
      spent + def.price <= budget &&
      (aiPlayer.money ?? 0) > 80 // garde un peu d'argent
    ) {
      const currentStock = aiPlayer.inventory?.[wid] ?? 0;
      aiPlayer.money = (aiPlayer.money ?? 0) - def.price;
      aiPlayer.inventory = { ...toSafeInventory(aiPlayer.inventory), [wid]: currentStock + 1 };
      spent += def.price;
      buysThisWeapon++;
    }
  }
}
