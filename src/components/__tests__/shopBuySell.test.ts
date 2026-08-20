import { describe, it, expect } from "vitest";
import { applyShopDelta } from "../shopBuySell";
import { makePlayer } from "../../game/__tests__/helpers";
import { WEAPON_REGISTRY } from "../../types/weapon";

describe("applyShopDelta", () => {
  it("buys GRENADE by deducting price and incrementing stock", () => {
    const player = makePlayer({ money: 200, inventory: { GRENADE: 2 } });
    const updated = applyShopDelta(player, "GRENADE", 1);
    expect(updated).not.toBeNull();
    expect(updated?.money).toBe(200 - WEAPON_REGISTRY.GRENADE.price);
    expect(updated?.inventory.GRENADE).toBe(3);
    expect(player.money).toBe(200);
  });

  it("sells GRENADE by refunding price and decrementing stock", () => {
    const player = makePlayer({ money: 100, inventory: { GRENADE: 2 } });
    const updated = applyShopDelta(player, "GRENADE", -1);
    expect(updated?.money).toBe(100 + WEAPON_REGISTRY.GRENADE.price);
    expect(updated?.inventory.GRENADE).toBe(1);
  });

  it("refuses a buy the player cannot afford", () => {
    const player = makePlayer({ money: 10, inventory: {} });
    expect(applyShopDelta(player, "GRENADE", 1)).toBeNull();
  });

  it("requires the full 420 dollars to buy a NUKE", () => {
    const shortPlayer = makePlayer({ money: 419, inventory: { NUKE: 0 } });
    expect(applyShopDelta(shortPlayer, "NUKE", 1)).toBeNull();

    const fundedPlayer = makePlayer({ money: 420, inventory: { NUKE: 0 } });
    const updated = applyShopDelta(fundedPlayer, "NUKE", 1);

    expect(WEAPON_REGISTRY.NUKE.price).toBe(420);
    expect(updated?.money).toBe(0);
    expect(updated?.inventory.NUKE).toBe(1);
  });

  it("refunds the updated NUKE price when selling", () => {
    const player = makePlayer({ money: 80, inventory: { NUKE: 1 } });
    const updated = applyShopDelta(player, "NUKE", -1);

    expect(updated?.money).toBe(500);
    expect(updated?.inventory.NUKE).toBe(0);
  });

  it("refuses a sell when stock is 0", () => {
    const player = makePlayer({ money: 500, inventory: { GRENADE: 0 } });
    expect(applyShopDelta(player, "GRENADE", -1)).toBeNull();
  });

  it("refuses MISSILE because it is not sold", () => {
    const player = makePlayer({ money: 500, inventory: {} });
    expect(applyShopDelta(player, "MISSILE", 1)).toBeNull();
  });
});
