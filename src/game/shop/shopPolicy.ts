import type { WeaponId } from "../../types/weapon";

export interface ShopPolicyRule {
  readonly maxStock: number;
  readonly maxPurchasesPerVisit: number;
}

export const SHOP_POLICY = {
  NUKE: { maxStock: 2, maxPurchasesPerVisit: 1 },
  THERMONUCLEAR: { maxStock: 1, maxPurchasesPerVisit: 1 },
} as const satisfies Partial<Record<WeaponId, ShopPolicyRule>>;

export const DEFAULT_SHOP_POLICY = {
  maxStock: Number.POSITIVE_INFINITY,
  maxPurchasesPerVisit: 12,
} as const satisfies ShopPolicyRule;

export function getShopPolicy(weaponId: WeaponId): ShopPolicyRule {
  if (weaponId === "NUKE" || weaponId === "THERMONUCLEAR") {
    return SHOP_POLICY[weaponId];
  }
  return DEFAULT_SHOP_POLICY;
}
