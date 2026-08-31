import { describe, expect, it } from "vitest";
import type { AiProfile, Player } from "../../../../types/player";
import {
  WEAPON_REGISTRY,
  type WeaponId,
} from "../../../../types/weapon";
import { makePlayer } from "../../../__tests__/helpers";
import type { ShopVisitCounters } from "../../../shop/shopTransaction";
import {
  autoBuyForAI,
  type InitialPlayerCount,
} from "../aiShopHelper";

interface RichProfileCase {
  readonly profile: AiProfile;
  readonly initialPlayerCount: InitialPlayerCount;
  readonly expectedInventory: Partial<Record<WeaponId, number>>;
}

const RICH_PROFILE_CASES: readonly RichProfileCase[] = [
  ...([2, 3, 4] as const).map((initialPlayerCount) => ({
    profile: "v1-random" as const,
    initialPlayerCount,
    expectedInventory: {
      GRENADE: initialPlayerCount - 1,
      CLUSTER: initialPlayerCount - 1,
    },
  })),
  ...([2, 3, 4] as const).map((initialPlayerCount) => ({
    profile: "v2-heuristic" as const,
    initialPlayerCount,
    expectedInventory: {
      GRENADE: initialPlayerCount * 3,
      CLUSTER: initialPlayerCount * 3,
      DRILLER: initialPlayerCount,
      BULLDOZER: initialPlayerCount,
      NUKE: 1,
    },
  })),
  ...([2, 3, 4] as const).map((initialPlayerCount) => ({
    profile: "v3-sniper" as const,
    initialPlayerCount,
    expectedInventory: {
      BULLET: initialPlayerCount * 3,
      DRILLER: initialPlayerCount * 2,
      BULLDOZER: initialPlayerCount * 2,
    },
  })),
  ...([2, 3, 4] as const).map((initialPlayerCount) => ({
    profile: "v4-smart" as const,
    initialPlayerCount,
    expectedInventory: {
      THERMONUCLEAR: 1,
      NUKE: 1,
      GRENADE: initialPlayerCount * 3,
      CLUSTER: initialPlayerCount * 3,
      DRILLER: initialPlayerCount * 3,
      BULLDOZER: initialPlayerCount * 3,
    },
  })),
];

function expectedCost(
  inventory: Partial<Record<WeaponId, number>>,
): number {
  return Object.entries(inventory).reduce((total, [weaponId, quantity]) => {
    return total + WEAPON_REGISTRY[weaponId as WeaponId].price * quantity;
  }, 0);
}

function makeAiPlayer(
  aiProfile: Player["aiProfile"],
  overrides: Partial<Player> = {},
): Player {
  return makePlayer({
    isHuman: false,
    aiProfile,
    money: 20_000,
    inventory: {},
    ...overrides,
  });
}

describe("autoBuyForAI", () => {
  it("does nothing for a human player", () => {
    const player = makePlayer({ isHuman: true, money: 1_000, inventory: {} });
    const counters: ShopVisitCounters = {};

    const result = autoBuyForAI(player, 2, counters);

    expect(result.player).toBe(player);
    expect(result.counters).toBe(counters);
  });

  it("does nothing for an invalid player object", () => {
    expect(() =>
      autoBuyForAI(null as unknown as Player, 2, {}),
    ).not.toThrow();
  });

  it.each(RICH_PROFILE_CASES)(
    "atteint les cibles de $profile avec N=$initialPlayerCount",
    ({ profile, initialPlayerCount, expectedInventory }) => {
      const player = makeAiPlayer(profile);

      const result = autoBuyForAI(player, initialPlayerCount, {});

      expect(result.player.inventory).toEqual(expectedInventory);
      expect(result.player.money).toBe(
        player.money - expectedCost(expectedInventory),
      );
      expect(result.counters[result.player.id]).toEqual(expectedInventory);
      expect(player.inventory).toEqual({});
    },
  );

  it.each([
    {
      profile: "v1-random" as const,
      money: 135,
      expectedWeapon: "GRENADE" as const,
    },
    {
      profile: "v2-heuristic" as const,
      money: 135,
      expectedWeapon: "GRENADE" as const,
    },
    {
      profile: "v3-sniper" as const,
      money: 150,
      expectedWeapon: "BULLET" as const,
    },
    {
      profile: "v4-smart" as const,
      money: 2_500,
      expectedWeapon: "THERMONUCLEAR" as const,
    },
  ])(
    "commence par $expectedWeapon pour $profile",
    ({ profile, money, expectedWeapon }) => {
      const result = autoBuyForAI(
        makeAiPlayer(profile, { money }),
        2,
        {},
      );

      expect(result.player.inventory[expectedWeapon]).toBe(1);
      const boughtWeapons = Object.keys(result.counters[result.player.id] ?? {});
      expect(boughtWeapons[0]).toBe(expectedWeapon);
    },
  );

  it("uses the OK profile for a missing or unknown aiProfile", () => {
    const okResult = autoBuyForAI(makeAiPlayer("v2-heuristic"), 2, {});
    const missingResult = autoBuyForAI(makeAiPlayer(undefined), 2, {});
    const unknownResult = autoBuyForAI(
      makeAiPlayer("future-profile" as Player["aiProfile"]),
      2,
      {},
    );

    expect(missingResult.player.inventory).toEqual(okResult.player.inventory);
    expect(missingResult.player.money).toBe(okResult.player.money);
    expect(unknownResult.player.inventory).toEqual(okResult.player.inventory);
    expect(unknownResult.player.money).toBe(okResult.player.money);
  });

  it("buys only the affordable quantity and keeps no implicit reserve", () => {
    const partial = autoBuyForAI(
      makeAiPlayer("v2-heuristic", { money: 200 }),
      2,
      {},
    );
    const exact = autoBuyForAI(
      makeAiPlayer("v1-random", { money: 75 }),
      2,
      {},
    );

    expect(partial.player.inventory).toEqual({ GRENADE: 2 });
    expect(partial.player.money).toBe(50);
    expect(exact.player.inventory).toEqual({ GRENADE: 1 });
    expect(exact.player.money).toBe(0);
  });

  it("tries cheaper later weapons instead of saving for an unaffordable weapon", () => {
    const result = autoBuyForAI(
      makeAiPlayer("v4-smart", { money: 200 }),
      2,
      {},
    );

    expect(result.player.inventory).toEqual({ GRENADE: 2 });
    expect(result.player.money).toBe(50);
  });

  it("keeps a legal surplus and continues with the next preference", () => {
    const result = autoBuyForAI(
      makeAiPlayer("v1-random", {
        money: 135,
        inventory: { GRENADE: 2 },
      }),
      2,
      {},
    );

    expect(result.player.inventory).toEqual({ GRENADE: 2, CLUSTER: 1 });
    expect(result.player.money).toBe(0);
  });

  it("respects counters already consumed during the visit", () => {
    const player = makeAiPlayer("v2-heuristic", { money: 2_000 });
    const counters: ShopVisitCounters = {
      [player.id]: { GRENADE: 12 },
    };

    const result = autoBuyForAI(player, 2, counters);

    expect(result.player.inventory.GRENADE).toBeUndefined();
    expect(result.player.inventory.CLUSTER).toBe(6);
    expect(result.counters[player.id]?.GRENADE).toBe(12);
  });

  it("continues with the next weapon after a transaction refusal", () => {
    const result = autoBuyForAI(
      makeAiPlayer("v1-random", {
        money: 200,
        inventory: { GRENADE: -1 },
      }),
      2,
      {},
    );

    expect(result.player.inventory.GRENADE).toBe(-1);
    expect(result.player.inventory.CLUSTER).toBe(1);
    expect(result.player.money).toBe(65);
  });

  it("lets Expert reach two NUKE only across two visits", () => {
    const player = makeAiPlayer("v4-smart", {
      money: 10_000,
      inventory: {
        THERMONUCLEAR: 1,
        GRENADE: 6,
        CLUSTER: 6,
        DRILLER: 6,
        BULLDOZER: 6,
      },
    });

    const firstVisit = autoBuyForAI(player, 2, {});
    const secondVisit = autoBuyForAI(firstVisit.player, 2, {});

    expect(firstVisit.player.inventory.NUKE).toBe(1);
    expect(firstVisit.counters[player.id]?.NUKE).toBe(1);
    expect(secondVisit.player.inventory.NUKE).toBe(2);
    expect(secondVisit.counters[player.id]?.NUKE).toBe(1);
  });

  it("never changes the original player or counters", () => {
    const player = makeAiPlayer("v2-heuristic", { money: 500 });
    const counters: ShopVisitCounters = {};

    const result = autoBuyForAI(player, 2, counters);

    expect(result.player).not.toBe(player);
    expect(result.counters).not.toBe(counters);
    expect(player.money).toBe(500);
    expect(player.inventory).toEqual({});
    expect(counters).toEqual({});
  });
});
