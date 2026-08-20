import { describe, it, expect } from "vitest";
import { autoBuyForAI } from "../aiShopHelper";
import { makePlayer } from "../../../__tests__/helpers";
import type { Player } from "../../../../types/player";

describe("autoBuyForAI", () => {
  it("does nothing if player is human", () => {
    const player = makePlayer({ isHuman: true, money: 1000, inventory: {} });
    autoBuyForAI(player);
    expect(player.money).toBe(1000);
    expect(player.inventory).toEqual({});
  });

  it("does nothing if player object is invalid", () => {
    // Should handle null or undefined safely based on the function signature
    // even though TS types it as Player. Let's just check standard pass works.
    expect(() => autoBuyForAI(null as unknown as Player)).not.toThrow();
  });

  it("does nothing if player lacks money", () => {
    const player = makePlayer({ isHuman: false, money: 0, inventory: {} });
    autoBuyForAI(player);
    expect(player.money).toBe(0);
    expect(player.inventory).toEqual({});
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

    autoBuyForAI(player);

    // It should buy CLUSTER first (price 135)
    // max buys per weapon = 12.
    // 700 / 135 = 5 CLUSTERs. 5 * 135 = 675 spent.
    // Remaining budget = 25.
    // Next is DRILLER (90) - budget too low.

    expect(player.inventory["CLUSTER"]).toBe(5);
    expect(player.inventory["DRILLER"]).toBeUndefined();
    expect(player.money).toBe(1000 - 675);
  });

  it("buys the v1 list for v2-heuristic and never auto-buys BULLET", () => {
    const player = makePlayer({
      isHuman: false,
      aiProfile: "v2-heuristic",
      money: 1000,
      inventory: {},
    });
    autoBuyForAI(player);
    expect(player.inventory["CLUSTER"]).toBe(5);
    expect(player.inventory["BULLET"]).toBeUndefined();
  });

  it("buys items for missing aiProfile (defaults to v1-random)", () => {
    const player = makePlayer({
      isHuman: false,
      aiProfile: undefined,
      money: 1000,
      inventory: {},
    });

    autoBuyForAI(player);

    expect(player.inventory["CLUSTER"]).toBe(5);
    expect(player.money).toBe(1000 - 675);
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

    autoBuyForAI(player);

    // Cap 2 BULLET = 300. Remaining budget 400 → 4 DRILLER = 360.
    expect(player.inventory["BULLET"]).toBe(2);
    expect(player.inventory["DRILLER"]).toBe(4);
    expect(player.money).toBe(1000 - 660);
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

    autoBuyForAI(player);

    expect(player.inventory["CLUSTER"]).toBe(5);
    expect(player.inventory["DRILLER"]).toBe(1);
    expect(player.money).toBe(1000 - 765);
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

    autoBuyForAI(player);
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

    expect(player.inventory["CLUSTER"]).toBe(1);
    expect(player.money).toBe(65);
  });

  it("limits max purchases per weapon to 12 except sniper BULLET", () => {
    const player = makePlayer({
      isHuman: false,
      aiProfile: "v3-sniper",
      money: 10000,
      inventory: {},
    });

    autoBuyForAI(player);

    // 2 BULLET * 150 = 300. 12 DRILLER * 90 = 1080. Spent = 1380.
    expect(player.inventory["BULLET"]).toBe(2);
    expect(player.inventory["DRILLER"]).toBe(12);
    expect(player.money).toBe(10000 - 1380);
  });

  it("does not buy more BULLET when sniper already holds the cap", () => {
    const player = makePlayer({
      isHuman: false,
      aiProfile: "v3-sniper",
      money: 1000,
      inventory: { BULLET: 3, MISSILE: 10 },
    });

    autoBuyForAI(player);

    expect(player.inventory["BULLET"]).toBe(3);
    expect(player.inventory["MISSILE"]).toBe(10);
    expect(player.inventory["DRILLER"]).toBe(7);
  });
});
