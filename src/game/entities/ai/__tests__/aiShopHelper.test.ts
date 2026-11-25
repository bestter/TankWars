import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiProfile, Player } from "../../../../types/player";
import {
  DEFAULT_INVENTORY,
  WEAPON_REGISTRY,
  type WeaponId,
} from "../../../../types/weapon";
import * as randomModule from "../../../../utils/random";
import { getRNG, setRNG, type RNG } from "../../../../utils/random";
import { makePlayer, makeTank } from "../../../__tests__/helpers";
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
    tank: makeTank("tank-1", 120, 300, { maxShield: 40 }),
    isHuman: false,
    aiProfile,
    money: 20_000,
    inventory: {},
    ...overrides,
  });
}

function installFixedSequenceRng(values: readonly number[]): {
  readonly getDrawCount: () => number;
  readonly getDraws: () => readonly number[];
} {
  let index = 0;
  const draws: number[] = [];
  const rng: RNG = {
    next() {
      const value = values[index] ?? values[values.length - 1] ?? 0.99;
      index++;
      draws.push(value);
      return value;
    },
  };
  setRNG(rng);
  return {
    getDrawCount: () => draws.length,
    getDraws: () => draws,
  };
}

function fullOrdinaryInventory(
  profile: "v1-random" | "v2-heuristic",
  initialPlayerCount: InitialPlayerCount = 2,
): Partial<Record<WeaponId, number>> {
  if (profile === "v1-random") {
    return {
      GRENADE: initialPlayerCount - 1,
      CLUSTER: initialPlayerCount - 1,
    };
  }
  return {
    GRENADE: initialPlayerCount * 3,
    CLUSTER: initialPlayerCount * 3,
    DRILLER: initialPlayerCount,
    BULLDOZER: initialPlayerCount,
  };
}

describe("reinforced shield purchase", () => {
  it.each(["v1-random", "v2-heuristic", "v3-sniper", "v4-smart"] as const)(
    "%s uses only the balance left after weapon offers", (profile) => {
      const atStrategicCap = RICH_PROFILE_CASES.find(entry => entry.profile === profile && entry.initialPlayerCount === 2);
      const inventory = { ...atStrategicCap?.expectedInventory, NUKE: 2, THERMONUCLEAR: 1 };
      for (const [money, shield, expected] of [[419, 40, false], [420, 40, true], [420, 41, false]] as const) {
        const rng = installFixedSequenceRng([0.99]);
        const player = makeAiPlayer(profile, { money, inventory });
        Object.assign(player.tank, { shield, maxShield: 40 });
        const result = autoBuyForAI(player, 2, {}, true);
        expect(result.player.reinforcedShieldPending === true).toBe(expected);
        expect(result.player.money).toBe(money - (expected ? 420 : 0));
        expect(result.player.inventory).toEqual(inventory);
        expect(rng.getDrawCount()).toBe(0);
      }
    },
  );
});

describe("autoBuyForAI", () => {
  let previousRng: RNG;

  beforeEach(() => {
    previousRng = getRNG();
    installFixedSequenceRng([0.99, 0.99]);
  });

  afterEach(() => {
    setRNG(previousRng);
    vi.restoreAllMocks();
  });

  it.each(RICH_PROFILE_CASES)("observes each accepted unit transaction without changing $profile (N=$initialPlayerCount)", ({ profile, initialPlayerCount }) => {
    const player = makeAiPlayer(profile);
    const firstRng = installFixedSequenceRng([0.09, 0.04]);
    const observed = autoBuyForAI(player, initialPlayerCount, {}, true);
    const observedDraws = [...firstRng.getDraws()];

    const secondRng = installFixedSequenceRng([0.09, 0.04]);
    const ordinary = autoBuyForAI(player, initialPlayerCount, {});
    expect(secondRng.getDraws()).toEqual(observedDraws);
    expect(observed.player).toEqual(ordinary.player);
    expect(observed.counters).toEqual(ordinary.counters);

    let money = player.money;
    const inventory = { ...player.inventory };
    for (const purchase of observed.purchases ?? []) {
      if (purchase.weaponId === undefined) {
        expect(purchase).toMatchObject({ equipmentId: "REINFORCED_SHIELD", price: 420, moneyBefore: money });
        money -= purchase.price;
        expect(purchase.moneyAfter).toBe(money);
        continue;
      }
      expect(purchase).toMatchObject({
        playerId: player.id,
        profile,
        quantity: 1,
        moneyBefore: money,
        stockBefore: inventory[purchase.weaponId] ?? 0,
        price: WEAPON_REGISTRY[purchase.weaponId].price,
      });
      money -= purchase.price;
      inventory[purchase.weaponId] = (inventory[purchase.weaponId] ?? 0) + 1;
      expect(purchase.moneyAfter).toBe(money);
      expect(purchase.stockAfter).toBe(inventory[purchase.weaponId]);
    }
    expect(observed.player.money).toBe(money);
    expect(observed.player.inventory).toEqual(inventory);

    // Une 2e évaluation quand les plafonds/quotas sont atteints n'achète plus rien et ne consomme aucun tirage
    const exhaustedRng = installFixedSequenceRng([0.01, 0.01]);
    expect(
      autoBuyForAI(observed.player, initialPlayerCount, observed.counters, true)
        .purchases,
    ).toEqual([]);
    expect(exhaustedRng.getDrawCount()).toBe(0);
    expect(
      autoBuyForAI({ ...player, money: 0 }, initialPlayerCount, {}, true)
        .purchases,
    ).toEqual([]);
  });

  it("allows an isolated repeat call to roll again after losing rolls, while blocking once caps or visit quotas are reached", () => {
    const player = makeAiPlayer("v2-heuristic", {
      money: 5_000,
      inventory: fullOrdinaryInventory("v2-heuristic", 2),
    });

    const losingRng = installFixedSequenceRng([0.1, 0.05]);
    const first = autoBuyForAI(player, 2, {}, true);
    expect(losingRng.getDrawCount()).toBe(2);
    expect(first.purchases).toMatchObject([{ equipmentId: "REINFORCED_SHIELD", price: 420 }]);
    expect(first.player.inventory.NUKE).toBeUndefined();
    expect(first.player.inventory.THERMONUCLEAR).toBeUndefined();
    expect(first.counters).toEqual({ [player.id]: { REINFORCED_SHIELD: 1 } });

    // Appel isolé distinct après échec des jets : les compteurs ne mémorisent pas les échecs
    const winningRng = installFixedSequenceRng([0.09, 0.04]);
    const retry = autoBuyForAI(first.player, 2, first.counters, true);
    expect(winningRng.getDrawCount()).toBe(2);
    expect(retry.purchases?.map((p) => p.weaponId)).toEqual([
      "NUKE",
      "THERMONUCLEAR",
    ]);

    // Une fois achetées (stock = 1 et compteur = 1), aucun autre tirage ni achat n'est possible
    const postCapRng = installFixedSequenceRng([0.0, 0.0]);
    const afterCap = autoBuyForAI(retry.player, 2, retry.counters, true);
    expect(postCapRng.getDrawCount()).toBe(0);
    expect(afterCap.purchases).toEqual([]);
  });

  it("does nothing for a human player", () => {
    const player = makePlayer({ isHuman: true, money: 1_000, inventory: {} });
    const counters: ShopVisitCounters = {};
    const rng = installFixedSequenceRng([0.0, 0.0]);

    const result = autoBuyForAI(player, 2, counters);

    expect(result.player).toBe(player);
    expect(result.counters).toBe(counters);
    expect(rng.getDrawCount()).toBe(0);
  });

  it("does nothing for an invalid player object", () => {
    expect(() =>
      autoBuyForAI(null as unknown as Player, 2, {}),
    ).not.toThrow();
  });

  it.each(RICH_PROFILE_CASES)(
    "atteint les cibles ordinaires de $profile avec N=$initialPlayerCount quand les jets nucléaires échouent",
    ({ profile, initialPlayerCount, expectedInventory }) => {
      const player = makeAiPlayer(profile);
      installFixedSequenceRng([0.99, 0.99]);

      const result = autoBuyForAI(player, initialPlayerCount, {});

      expect(result.player.inventory).toEqual(expectedInventory);
      expect(result.player.money).toBe(
        player.money - expectedCost(expectedInventory) - 420,
      );
      expect(result.counters[result.player.id]).toEqual({ ...expectedInventory, REINFORCED_SHIELD: 1 });
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
    for (const sequence of [
      [0.99, 0.99],
      [0.09, 0.04],
    ] as const) {
      installFixedSequenceRng(sequence);
      const okResult = autoBuyForAI(makeAiPlayer("v2-heuristic"), 2, {});

      installFixedSequenceRng(sequence);
      const missingResult = autoBuyForAI(makeAiPlayer(undefined), 2, {});

      installFixedSequenceRng(sequence);
      const unknownResult = autoBuyForAI(
        makeAiPlayer("future-profile" as Player["aiProfile"]),
        2,
        {},
      );

      expect(missingResult.player.inventory).toEqual(okResult.player.inventory);
      expect(missingResult.player.money).toBe(okResult.player.money);
      expect(unknownResult.player.inventory).toEqual(okResult.player.inventory);
      expect(unknownResult.player.money).toBe(okResult.player.money);
    }
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

  it("buys nothing when the AI has no money", () => {
    const player = makeAiPlayer("v2-heuristic", { money: 0, inventory: {} });
    const rng = installFixedSequenceRng([0.0, 0.0]);

    const result = autoBuyForAI(player, 2, {});

    expect(result.player.inventory).toEqual({});
    expect(result.player.money).toBe(0);
    expect(result.counters).toEqual({});
    expect(rng.getDrawCount()).toBe(0);
  });

  it("keeps Simple N=2 DEFAULT_INVENTORY grenade surplus and may buy CLUSTER", () => {
    const result = autoBuyForAI(
      makeAiPlayer("v1-random", {
        money: 135,
        inventory: { ...DEFAULT_INVENTORY },
      }),
      2,
      {},
    );

    expect(result.player.inventory).toEqual({ GRENADE: 2, CLUSTER: 1 });
    expect(result.player.inventory.GRENADE).toBe(DEFAULT_INVENTORY.GRENADE);
    expect(result.counters[result.player.id]?.GRENADE).toBeUndefined();
    expect(result.counters[result.player.id]?.CLUSTER).toBe(1);
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
    const rng = installFixedSequenceRng([0.0, 0.0]);

    const firstVisit = autoBuyForAI(player, 2, {});
    const secondVisit = autoBuyForAI(firstVisit.player, 2, {});

    expect(firstVisit.player.inventory.NUKE).toBe(1);
    expect(firstVisit.counters[player.id]?.NUKE).toBe(1);
    expect(secondVisit.player.inventory.NUKE).toBe(2);
    expect(secondVisit.counters[player.id]?.NUKE).toBe(1);
    expect(rng.getDrawCount()).toBe(0);
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

  describe("occasional nuclear purchases (#218)", () => {
    it.each(["v1-random", "v2-heuristic"] as const)(
      "%s buys both NUKE and THERMONUCLEAR from 2920 remaining balance on winning rolls (0.09, 0.04)",
      (profile) => {
        const rng = installFixedSequenceRng([0.09, 0.04]);
        const player = makeAiPlayer(profile, {
          money: 2_920,
          inventory: fullOrdinaryInventory(profile, 2),
        });

        const result = autoBuyForAI(player, 2, {}, true);

        expect(rng.getDrawCount()).toBe(2);
        expect(result.player.money).toBe(0);
        expect(result.player.inventory).toEqual({
          ...fullOrdinaryInventory(profile, 2),
          NUKE: 1,
          THERMONUCLEAR: 1,
        });
        expect(result.counters[player.id]).toEqual({
          NUKE: 1,
          THERMONUCLEAR: 1,
        });
        expect(result.purchases).toEqual([
          {
            playerId: player.id,
            profile,
            weaponId: "NUKE",
            quantity: 1,
            price: 420,
            moneyBefore: 2_920,
            moneyAfter: 2_500,
            stockBefore: 0,
            stockAfter: 1,
          },
          {
            playerId: player.id,
            profile,
            weaponId: "THERMONUCLEAR",
            quantity: 1,
            price: 2_500,
            moneyBefore: 2_500,
            moneyAfter: 0,
            stockBefore: 0,
            stockAfter: 1,
          },
        ]);
        expect(result.player.tank.currentWeapon).toBe("MISSILE");
      },
    );

    it.each(["v1-random", "v2-heuristic"] as const)(
      "%s re-evaluates balance after NUKE at 2500 and skips THERMONUCLEAR roll (0.09 -> 1 draw)",
      (profile) => {
        const rng = installFixedSequenceRng([0.09, 0.01]);
        const player = makeAiPlayer(profile, {
          money: 2_500,
          inventory: fullOrdinaryInventory(profile, 2),
        });

        const result = autoBuyForAI(player, 2, {}, true);

        expect(rng.getDrawCount()).toBe(1);
        expect(result.player.money).toBe(1_660);
        expect(result.player.inventory.NUKE).toBe(1);
        expect(result.player.inventory.THERMONUCLEAR).toBeUndefined();
        expect(result.purchases?.map((p) => p.weaponId ?? p.equipmentId)).toEqual(["NUKE", "REINFORCED_SHIELD"]);
      },
    );

    it.each(["v1-random", "v2-heuristic"] as const)(
      "%s buys THERMONUCLEAR at 2500 when NUKE fails at exact bound 0.10 and THERMO wins at 0.04",
      (profile) => {
        const rng = installFixedSequenceRng([0.1, 0.04]);
        const player = makeAiPlayer(profile, {
          money: 2_500,
          inventory: fullOrdinaryInventory(profile, 2),
        });

        const result = autoBuyForAI(player, 2, {}, true);

        expect(rng.getDrawCount()).toBe(2);
        expect(result.player.money).toBe(0);
        expect(result.player.inventory.NUKE).toBeUndefined();
        expect(result.player.inventory.THERMONUCLEAR).toBe(1);
        expect(result.purchases?.map((p) => p.weaponId)).toEqual([
          "THERMONUCLEAR",
        ]);
      },
    );

    it.each(["v1-random", "v2-heuristic"] as const)(
      "%s handles exact 420 vs 419 balance and exact probability bounds",
      (profile) => {
        const ordinary = fullOrdinaryInventory(profile, 2);

        const at420 = installFixedSequenceRng([0]);
        const boughtAt420 = autoBuyForAI(
          makeAiPlayer(profile, { money: 420, inventory: ordinary }),
          2,
          {},
          true,
        );
        expect(at420.getDrawCount()).toBe(1);
        expect(boughtAt420.player.money).toBe(0);
        expect(boughtAt420.player.inventory.NUKE).toBe(1);

        const at419 = installFixedSequenceRng([0]);
        const skippedAt419 = autoBuyForAI(
          makeAiPlayer(profile, { money: 419, inventory: ordinary }),
          2,
          {},
          true,
        );
        expect(at419.getDrawCount()).toBe(0);
        expect(skippedAt419.purchases).toEqual([]);

        const nukeNearMiss = installFixedSequenceRng([0.099999999]);
        const nukeHit = autoBuyForAI(
          makeAiPlayer(profile, { money: 420, inventory: ordinary }),
          2,
          {},
        );
        expect(nukeNearMiss.getDrawCount()).toBe(1);
        expect(nukeHit.player.inventory.NUKE).toBe(1);

        const nukeExactFail = installFixedSequenceRng([0.1]);
        const nukeMiss = autoBuyForAI(
          makeAiPlayer(profile, { money: 420, inventory: ordinary }),
          2,
          {},
        );
        expect(nukeExactFail.getDrawCount()).toBe(1);
        expect(nukeMiss.player.inventory.NUKE).toBeUndefined();

        const thermoNearMiss = installFixedSequenceRng([0.1, 0.049999999]);
        const thermoHit = autoBuyForAI(
          makeAiPlayer(profile, { money: 2_500, inventory: ordinary }),
          2,
          {},
        );
        expect(thermoNearMiss.getDrawCount()).toBe(2);
        expect(thermoHit.player.inventory.THERMONUCLEAR).toBe(1);

        const thermoExactFail = installFixedSequenceRng([0.1, 0.05]);
        const thermoMiss = autoBuyForAI(
          makeAiPlayer(profile, { money: 2_500, inventory: ordinary }),
          2,
          {},
        );
        expect(thermoExactFail.getDrawCount()).toBe(2);
        expect(thermoMiss.player.inventory.THERMONUCLEAR).toBeUndefined();
      },
    );

    it.each([
      { profile: "v1-random" as const, initialPlayerCount: 2 as const },
      { profile: "v1-random" as const, initialPlayerCount: 3 as const },
      { profile: "v1-random" as const, initialPlayerCount: 4 as const },
      { profile: "v2-heuristic" as const, initialPlayerCount: 2 as const },
      { profile: "v2-heuristic" as const, initialPlayerCount: 3 as const },
      { profile: "v2-heuristic" as const, initialPlayerCount: 4 as const },
    ])(
      "buys ordinary targets first without reserve then nuclears for $profile (N=$initialPlayerCount)",
      ({ profile, initialPlayerCount }) => {
        const ordinary = fullOrdinaryInventory(profile, initialPlayerCount);
        const ordinaryCost = expectedCost(ordinary);

        // Pas assez pour les ordinaires + 420 : les achats ordinaires passent en priorité, 0 tirage nucléaire
        const noNukeRng = installFixedSequenceRng([0.0, 0.0]);
        const justBelowNuke = autoBuyForAI(
          makeAiPlayer(profile, { money: ordinaryCost + 419 }),
          initialPlayerCount,
          {},
        );
        expect(justBelowNuke.player.inventory).toEqual(ordinary);
        expect(justBelowNuke.player.money).toBe(419);
        expect(noNukeRng.getDrawCount()).toBe(0);

        // Solde complet : achats ordinaires puis NUKE et THERMONUCLEAR
        const fullRng = installFixedSequenceRng([0.09, 0.04]);
        const withBoth = autoBuyForAI(
          makeAiPlayer(profile, { money: 20_000 }),
          initialPlayerCount,
          {},
        );
        const expectedAll = { ...ordinary, NUKE: 1, THERMONUCLEAR: 1 };
        expect(fullRng.getDrawCount()).toBe(2);
        expect(withBoth.player.inventory).toEqual(expectedAll);
        expect(withBoth.player.money).toBe(
          20_000 - expectedCost(expectedAll) - 420,
        );
      },
    );

    it("never rolls for v3-sniper, v4-smart, or humans regardless of money", () => {
      const rng = installFixedSequenceRng([0.0, 0.0]);

      autoBuyForAI(makeAiPlayer("v3-sniper", { money: 50_000 }), 4, {});
      autoBuyForAI(makeAiPlayer("v4-smart", { money: 50_000 }), 4, {});
      autoBuyForAI(
        makePlayer({ isHuman: true, money: 50_000, inventory: {} }),
        4,
        {},
      );

      expect(rng.getDrawCount()).toBe(0);
    });

    it("preserves existing NUKE stock (1 or 2) without confiscation and uses the sole roll for THERMONUCLEAR", () => {
      for (const nukeStock of [1, 2]) {
        const rng = installFixedSequenceRng([0.04]);
        const player = makeAiPlayer("v2-heuristic", {
          money: 3_000,
          inventory: {
            ...fullOrdinaryInventory("v2-heuristic", 2),
            NUKE: nukeStock,
          },
        });

        const result = autoBuyForAI(player, 2, {}, true);

        expect(rng.getDrawCount()).toBe(1);
        expect(result.player.inventory.NUKE).toBe(nukeStock);
        expect(result.player.inventory.THERMONUCLEAR).toBe(1);
        expect(result.player.money).toBe(80);
        expect(result.purchases?.map((p) => p.weaponId ?? p.equipmentId)).toEqual([
          "THERMONUCLEAR", "REINFORCED_SHIELD",
        ]);
      }
    });

    it("respects pre-consumed NUKE/THERMONUCLEAR visit quotas and existing THERMONUCLEAR stock", () => {
      const rngNukeSpent = installFixedSequenceRng([0.04]);
      const nukeSpent = autoBuyForAI(
        makeAiPlayer("v1-random", {
          money: 3_000,
          inventory: fullOrdinaryInventory("v1-random", 2),
        }),
        2,
        { "player-1": { NUKE: 1 } },
      );
      expect(rngNukeSpent.getDrawCount()).toBe(1);
      expect(nukeSpent.player.inventory.NUKE).toBeUndefined();
      expect(nukeSpent.player.inventory.THERMONUCLEAR).toBe(1);

      const rngThermoSpent = installFixedSequenceRng([0.09]);
      const thermoSpent = autoBuyForAI(
        makeAiPlayer("v1-random", {
          money: 3_000,
          inventory: {
            ...fullOrdinaryInventory("v1-random", 2),
            THERMONUCLEAR: 1,
          },
        }),
        2,
        {},
      );
      expect(rngThermoSpent.getDrawCount()).toBe(1);
      expect(thermoSpent.player.inventory.NUKE).toBe(1);
      expect(thermoSpent.player.inventory.THERMONUCLEAR).toBe(1);

      const rngQuotaSpent = installFixedSequenceRng([0.09]);
      const thermoCounterSpent = autoBuyForAI(
        makeAiPlayer("v1-random", {
          money: 3_000,
          inventory: fullOrdinaryInventory("v1-random", 2),
        }),
        2,
        { "player-1": { THERMONUCLEAR: 1 } },
      );
      expect(rngQuotaSpent.getDrawCount()).toBe(1);
      expect(thermoCounterSpent.player.inventory.NUKE).toBe(1);
      expect(thermoCounterSpent.player.inventory.THERMONUCLEAR).toBeUndefined();
    });

    it("blocks only the weapon with illegal stock or counter and blocks both on illegal money", () => {
      for (const badNuke of [-1, 0.5, Number.NaN, 3, Number.MAX_SAFE_INTEGER + 1]) {
        const rng = installFixedSequenceRng([0.04]);
        const player = makeAiPlayer("v1-random", {
          money: 3_000,
          inventory: {
            ...fullOrdinaryInventory("v1-random", 2),
            NUKE: badNuke,
          },
        });

        const result = autoBuyForAI(player, 2, {}, true);

        expect(rng.getDrawCount()).toBe(1);
        if (Number.isNaN(badNuke)) {
          expect(Number.isNaN(result.player.inventory.NUKE)).toBe(true);
        } else {
          expect(result.player.inventory.NUKE).toBe(badNuke);
        }
        expect(result.player.inventory.THERMONUCLEAR).toBe(1);
        expect(result.purchases?.map((p) => p.weaponId ?? p.equipmentId)).toEqual([
          "THERMONUCLEAR", "REINFORCED_SHIELD",
        ]);
      }

      const badCounterRng = installFixedSequenceRng([0.04]);
      const badCounter = autoBuyForAI(
        makeAiPlayer("v2-heuristic", {
          money: 3_000,
          inventory: fullOrdinaryInventory("v2-heuristic", 2),
        }),
        2,
        { "player-1": { NUKE: -1 } },
      );
      expect(badCounterRng.getDrawCount()).toBe(1);
      expect(badCounter.player.inventory.NUKE).toBeUndefined();
      expect(badCounter.player.inventory.THERMONUCLEAR).toBe(1);

      for (const badThermo of [-1, 0.5, Number.NaN, 2]) {
        const rng = installFixedSequenceRng([0.09]);
        const result = autoBuyForAI(
          makeAiPlayer("v1-random", {
            money: 3_000,
            inventory: {
              ...fullOrdinaryInventory("v1-random", 2),
              THERMONUCLEAR: badThermo,
            },
          }),
          2,
          {},
        );
        expect(rng.getDrawCount()).toBe(1);
        expect(result.player.inventory.NUKE).toBe(1);
        if (Number.isNaN(badThermo)) {
          expect(Number.isNaN(result.player.inventory.THERMONUCLEAR)).toBe(
            true,
          );
        } else {
          expect(result.player.inventory.THERMONUCLEAR).toBe(badThermo);
        }
      }

      for (const badMoney of [
        -1,
        0.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        const rng = installFixedSequenceRng([0.0, 0.0]);
        const result = autoBuyForAI(
          makeAiPlayer("v2-heuristic", { money: badMoney }),
          2,
          {},
          true,
        );
        expect(rng.getDrawCount()).toBe(0);
        expect(result.purchases).toEqual([]);
        expect(result.player.inventory).toEqual({});
      }
    });

    it("handles missing inventory, forbidden prototype keys, and keeps secureRandom spyable", () => {
      const spy = vi
        .spyOn(randomModule, "secureRandom")
        .mockReturnValueOnce(0.09)
        .mockReturnValueOnce(0.04);

      const missingInventoryPlayer = {
        ...makeAiPlayer("v1-random", { money: 3_130 }),
        inventory: undefined,
      } as unknown as Player;

      const missingRes = autoBuyForAI(missingInventoryPlayer, 2, {}, true);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(missingRes.player.inventory).toEqual({
        GRENADE: 1,
        CLUSTER: 1,
        NUKE: 1,
        THERMONUCLEAR: 1,
      });

      const maliciousInventory = Object.create(null) as Record<string, unknown>;
      maliciousInventory["__proto__"] = { polluted: true };
      maliciousInventory["prototype"] = { polluted: true };
      maliciousInventory["constructor"] = { polluted: true };
      maliciousInventory["GRENADE"] = 1;
      maliciousInventory["CLUSTER"] = 1;

      const maliciousPlayerCounters = Object.create(null) as Record<
        string,
        unknown
      >;
      maliciousPlayerCounters["__proto__"] = 99;
      maliciousPlayerCounters["prototype"] = 99;
      maliciousPlayerCounters["constructor"] = 99;

      const maliciousCounters = Object.create(null) as Record<string, unknown>;
      maliciousCounters["__proto__"] = { polluted: true };
      maliciousCounters["prototype"] = { polluted: true };
      maliciousCounters["constructor"] = { polluted: true };
      maliciousCounters["player-1"] = maliciousPlayerCounters;

      const rng = installFixedSequenceRng([0.09, 0.04]);
      const safeResult = autoBuyForAI(
        makeAiPlayer("v1-random", {
          money: 2_920,
          inventory: maliciousInventory as unknown as Player["inventory"],
        }),
        2,
        maliciousCounters as unknown as ShopVisitCounters,
      );

      expect(rng.getDrawCount()).toBe(2);
      expect(safeResult.player.inventory).toEqual({
        GRENADE: 1,
        CLUSTER: 1,
        NUKE: 1,
        THERMONUCLEAR: 1,
      });
      for (const forbiddenKey of ["__proto__", "prototype", "constructor"]) {
        expect(
          Object.prototype.hasOwnProperty.call(
            safeResult.player.inventory,
            forbiddenKey,
          ),
        ).toBe(false);
        expect(
          Object.prototype.hasOwnProperty.call(safeResult.counters, forbiddenKey),
        ).toBe(false);
        expect(
          Object.prototype.hasOwnProperty.call(
            safeResult.counters["player-1"] ?? {},
            forbiddenKey,
          ),
        ).toBe(false);
      }
      expect(
        (Object.prototype as unknown as Record<string, unknown>).polluted,
      ).toBeUndefined();

      const protoIdRng = installFixedSequenceRng([0.0, 0.0]);
      const protoIdPlayer = makeAiPlayer("v1-random", {
        id: "__proto__",
        money: 5_000,
      });
      const protoIdRes = autoBuyForAI(protoIdPlayer, 2, {});
      expect(protoIdRng.getDrawCount()).toBe(0);
      expect(protoIdRes.player).toBe(protoIdPlayer);

      const missingCountersRng = installFixedSequenceRng([0.09, 0.04]);
      const missingCountersRes = autoBuyForAI(
        makeAiPlayer("v1-random", { money: 3_130 }),
        2,
        undefined as unknown as ShopVisitCounters,
      );
      expect(missingCountersRng.getDrawCount()).toBe(2);
      expect(missingCountersRes.player.inventory.NUKE).toBe(1);
      expect(missingCountersRes.player.inventory.THERMONUCLEAR).toBe(1);
    });

    it("keeps currentWeapon untouched even when buying NUKE and THERMONUCLEAR", () => {
      installFixedSequenceRng([0.09, 0.04]);
      const base = makeAiPlayer("v2-heuristic", {
        money: 3_000,
        inventory: fullOrdinaryInventory("v2-heuristic", 2),
      });
      base.tank.currentWeapon = "GRENADE";

      const result = autoBuyForAI(base, 2, {});

      expect(result.player.inventory.NUKE).toBe(1);
      expect(result.player.inventory.THERMONUCLEAR).toBe(1);
      expect(result.player.tank.currentWeapon).toBe("GRENADE");
    });
  });
});
