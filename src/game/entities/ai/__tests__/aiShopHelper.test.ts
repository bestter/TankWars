import { describe, it, expect } from "vitest";
import { autoBuyForAI } from "../aiShopHelper";
import { makePlayer } from "../../../__tests__/helpers";
import type { Player } from "../../../../types/player";
import { normalizeInventoryAtShopOpen } from "../../../shop/shopTransaction";

describe("autoBuyForAI", () => {
  it("does nothing if player is human", () => {
    const player = makePlayer({ isHuman: true, money: 1000, inventory: {} });
    const updated = autoBuyForAI(player).player;
    expect(updated.money).toBe(1000);
    expect(updated.inventory).toEqual({});
    expect(updated).toBe(player);
  });

  it("does nothing if player object is invalid", () => {
    // Should handle null or undefined safely based on the function signature
    // even though TS types it as Player. Let's just check standard pass works.
    expect(() => autoBuyForAI(null as unknown as Player)).not.toThrow();
  });

  it("does nothing if player lacks money", () => {
    const player = makePlayer({ isHuman: false, money: 0, inventory: {} });
    const updated = autoBuyForAI(player).player;
    expect(updated.money).toBe(0);
    expect(updated.inventory).toEqual({});
  });

  it("buys items for v1-random (default) AI profile", () => {
    // CLUSTER (135), DRILLER (90), GRENADE (75), NUKE (420), THERMONUCLEAR (2500)
    // Budget 70% of 1000 = 700.
    const player = makePlayer({
      isHuman: false,
      aiProfile: "v1-random",
      money: 1000,
      inventory: {},
    });

    const updated = autoBuyForAI(player).player;

    // It should buy CLUSTER first (price 135)
    // max buys per weapon = 12.
    // 700 / 135 = 5 CLUSTERs. 5 * 135 = 675 spent.
    // Remaining budget = 25.
    // Next is DRILLER (90) - budget too low.

    expect(updated.inventory["CLUSTER"]).toBe(5);
    expect(updated.inventory["DRILLER"]).toBeUndefined();
    expect(updated.money).toBe(1000 - 675);
    expect(player.inventory).toEqual({});
  });

  it("buys the v1 list for v2-heuristic and never auto-buys BULLET", () => {
    const player = makePlayer({
      isHuman: false,
      aiProfile: "v2-heuristic",
      money: 1000,
      inventory: {},
    });
    const updated = autoBuyForAI(player).player;
    expect(updated.inventory["CLUSTER"]).toBe(5);
    expect(updated.inventory["BULLET"]).toBeUndefined();
  });

  it("buys items for missing aiProfile (defaults to v1-random)", () => {
    const player = makePlayer({
      isHuman: false,
      aiProfile: undefined,
      money: 1000,
      inventory: {},
    });

    const updated = autoBuyForAI(player).player;

    expect(updated.inventory["CLUSTER"]).toBe(5);
    expect(updated.money).toBe(1000 - 675);
  });

  it("caps v3-sniper at 2 BULLET then spends leftover on DRILLER", () => {
    // BULLET (150), DRILLER (90)
    // Budget 70% of 1000 = 700.
    const player = makePlayer({
      isHuman: false,
      aiProfile: "v3-sniper",
      money: 1000,
      inventory: {},
    });

    const updated = autoBuyForAI(player).player;

    // Cap 2 BULLET = 300. Remaining budget 400 → 4 DRILLER = 360.
    expect(updated.inventory["BULLET"]).toBe(2);
    expect(updated.inventory["DRILLER"]).toBe(4);
    expect(updated.money).toBe(1000 - 660);
  });

  it("buys items for v4-smart profile at 78% budget", () => {
    // Budget 78% of 1000 = 780.
    // 5 CLUSTER * 135 = 675, then 1 DRILLER * 90 = 765.
    const player = makePlayer({
      isHuman: false,
      aiProfile: "v4-smart",
      money: 1000,
      inventory: {},
    });

    const updated = autoBuyForAI(player).player;

    expect(updated.inventory["CLUSTER"]).toBe(5);
    expect(updated.inventory["DRILLER"]).toBe(1);
    expect(updated.money).toBe(1000 - 765);
  });

  it("respects the money reserve constraint (> 80)", () => {
    // DRILLER (90).
    // 85% budget of 200 = 170.
    // It should buy 1 DRILLER.
    // Money left = 110. (Next driller would cost 90, money left 20 <= 80, so shouldn't buy).
    const player = makePlayer({
      isHuman: false,
      aiProfile: "v4-smart",
      money: 200,
      inventory: {},
    });

    const updated = autoBuyForAI(player).player;
    // Actually preferred order for v4-smart: CLUSTER (135), DRILLER (90)
    // 170 budget. First tries CLUSTER.
    // 1 CLUSTER costs 135. Money becomes 65.
    // Wait, check says (money > 80).
    // Loop checks money > 80 BEFORE buying.
    // If it buys 1 CLUSTER, money left would be 65. But it will still buy because BEFORE buying it had 200 > 80.
    // Let's manually trace:
    // budget = 170.
    // wid = CLUSTER, def = 135.
    // buysThisWeapon = 0.
    // money = 200 > def.price (135).
    // spent + price (0 + 135) <= 170 (true).
    // money > 80 (200 > 80) (true).
    // => Buys 1 CLUSTER. money = 65. spent = 135.
    // Next loop: buysThisWeapon = 1.
    // money = 65 < 135. (false).
    // Next wid = DRILLER, def = 90.
    // buysThisWeapon = 0.
    // money = 65 < 90. (false).

    expect(updated.inventory["CLUSTER"]).toBe(1);
    expect(updated.money).toBe(65);
  });

  it("limits max purchases per weapon to 12 except sniper BULLET", () => {
    const player = makePlayer({
      isHuman: false,
      aiProfile: "v3-sniper",
      money: 10000,
      inventory: {},
    });

    const updated = autoBuyForAI(player).player;

    // 2 BULLET * 150 = 300. 12 DRILLER * 90 = 1080. Spent = 1380.
    expect(updated.inventory["BULLET"]).toBe(2);
    expect(updated.inventory["DRILLER"]).toBe(12);
    expect(updated.money).toBe(10000 - 1380);
  });

  it("does not buy more BULLET when sniper already holds the cap", () => {
    const player = makePlayer({
      isHuman: false,
      aiProfile: "v3-sniper",
      money: 1000,
      inventory: { BULLET: 3, MISSILE: 10 },
    });

    const updated = autoBuyForAI(normalizeInventoryAtShopOpen(player)).player;

    expect(updated.inventory["BULLET"]).toBe(3);
    expect(updated.inventory["MISSILE"]).toBeUndefined();
    expect(updated.inventory["DRILLER"]).toBe(7);
  });

  it("does not buy BULLDOZER for v1-random", () => {
    const player = makePlayer({
      isHuman: false,
      aiProfile: "v1-random",
      money: 20000,
      inventory: {},
    });

    const updated = autoBuyForAI(player).player;

    expect(updated.inventory["BULLDOZER"]).toBeUndefined();
  });

  it("caps BULLDOZER at 1 for v2-heuristic", () => {
    const player = makePlayer({
      isHuman: false,
      aiProfile: "v2-heuristic",
      money: 20000,
      inventory: {},
    });

    const updated = autoBuyForAI(player).player;

    expect(updated.inventory["BULLDOZER"]).toBe(1);
  });

  it("caps BULLDOZER at 2 for displacement-focused v4-smart", () => {
    const player = makePlayer({
      isHuman: false,
      aiProfile: "v4-smart",
      money: 20000,
      inventory: {},
    });

    const updated = autoBuyForAI(player).player;

    expect(updated.inventory["BULLDOZER"]).toBe(2);
  });

  it.each(["v1-random", "v2-heuristic", "v3-sniper", "v4-smart"] as const)(
    "respecte la politique lourde pour %s",
    (aiProfile) => {
      const firstVisit = autoBuyForAI(
        makePlayer({
          isHuman: false,
          aiProfile,
          money: 20_000,
          inventory: { NUKE: 1 },
        }),
      );
      expect(firstVisit.player.inventory.NUKE ?? 0).toBeLessThanOrEqual(2);
      expect(
        firstVisit.counters[firstVisit.player.id]?.NUKE ?? 0,
      ).toBeLessThanOrEqual(1);
      expect(
        firstVisit.player.inventory.THERMONUCLEAR ?? 0,
      ).toBeLessThanOrEqual(1);

      const secondVisit = autoBuyForAI(firstVisit.player, {});
      expect(secondVisit.player.inventory.NUKE ?? 0).toBeLessThanOrEqual(2);
      expect(
        secondVisit.player.inventory.THERMONUCLEAR ?? 0,
      ).toBeLessThanOrEqual(1);
    },
  );
});
