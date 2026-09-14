import { describe, expect, it } from "vitest";
import { getShopPolicy, SHOP_POLICY, DEFAULT_SHOP_POLICY } from "../shopPolicy";

describe("shopPolicy", () => {
  describe("getShopPolicy", () => {
    it("should return the specific policy for NUKE", () => {
      const policy = getShopPolicy("NUKE");
      expect(policy).toBe(SHOP_POLICY.NUKE);
      expect(policy.maxStock).toBe(2);
      expect(policy.maxPurchasesPerVisit).toBe(1);
    });

    it("should return the specific policy for THERMONUCLEAR", () => {
      const policy = getShopPolicy("THERMONUCLEAR");
      expect(policy).toBe(SHOP_POLICY.THERMONUCLEAR);
      expect(policy.maxStock).toBe(1);
      expect(policy.maxPurchasesPerVisit).toBe(1);
    });

    it("should return the default policy for generic weapons", () => {
      const genericWeapons = ["MISSILE", "GRENADE", "CLUSTER", "DRILLER", "BULLET", "BULLDOZER"] as const;

      for (const weapon of genericWeapons) {
        const policy = getShopPolicy(weapon);
        expect(policy).toBe(DEFAULT_SHOP_POLICY);
        expect(policy.maxStock).toBe(Number.POSITIVE_INFINITY);
        expect(policy.maxPurchasesPerVisit).toBe(12);
      }
    });
  });
});
