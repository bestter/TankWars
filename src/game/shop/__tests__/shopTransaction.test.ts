import { describe, expect, it } from "vitest";
import { calculateTransactionCost } from "../shopTransaction";
import { type WeaponId } from "../../../types/weapon";

describe("calculateTransactionCost", () => {
  const mockBasePrices: Record<WeaponId, number> = {
    MISSILE: 50,
    GRENADE: 75,
    CLUSTER: 135,
    NUKE: 420,
    THERMONUCLEAR: 2500,
    DRILLER: 90,
    BULLET: 150,
    BULLDOZER: 150,
  };

  it("calculates the correct cost for a single item", () => {
    expect(calculateTransactionCost("GRENADE", 1, mockBasePrices)).toBe(75);
    expect(calculateTransactionCost("NUKE", 1, mockBasePrices)).toBe(420);
  });

  it("calculates the correct cost for multiple items", () => {
    expect(calculateTransactionCost("GRENADE", 3, mockBasePrices)).toBe(225);
    expect(calculateTransactionCost("THERMONUCLEAR", 2, mockBasePrices)).toBe(5000);
  });

  it("returns 0 if quantity is 0", () => {
    expect(calculateTransactionCost("CLUSTER", 0, mockBasePrices)).toBe(0);
  });

  it("handles negative quantities (if applicable/allowed by logic)", () => {
    expect(calculateTransactionCost("DRILLER", -1, mockBasePrices)).toBe(-90);
  });

  it("returns 0 if the weapon is not in the base prices (though typescript should prevent this, good to test edge cases if types are bypassed)", () => {
    const incompletePrices = { GRENADE: 75 } as Record<WeaponId, number>;
    expect(calculateTransactionCost("NUKE", 2, incompletePrices)).toBe(0);
  });
});
