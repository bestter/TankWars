import { describe, expect, it } from "vitest";
import type { Player } from "../../../types/player";
import { getShopPolicy } from "../shopPolicy";
import { guardShopAction, guardShopEnter } from "../shopSessionGuard";
import {
  applyShopTransaction,
  consumeWeaponForFire,
  normalizeInventoryAtShopOpen,
  type ShopVisitCounters,
} from "../shopTransaction";

function createPlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: "player-1",
    name: "Joueur",
    isHuman: true,
    money: 5_000,
    inventory: {},
    tank: {
      id: "tank-1",
      position: { x: 100, y: 300 },
      angle: 45,
      power: 50,
      health: 100,
      maxHealth: 100,
      shield: 40,
      maxShield: 40,
      isDead: false,
      color: "#5555FF",
      currentWeapon: "MISSILE",
    },
    ...overrides,
  };
}

describe("politique boutique", () => {
  it("définit les plafonds globaux sans vendre MISSILE", () => {
    expect(getShopPolicy("NUKE")).toEqual({
      maxStock: 2,
      maxPurchasesPerVisit: 1,
    });
    expect(getShopPolicy("THERMONUCLEAR")).toEqual({
      maxStock: 1,
      maxPurchasesPerVisit: 1,
    });
    expect(getShopPolicy("GRENADE")).toEqual({
      maxStock: Number.POSITIVE_INFINITY,
      maxPurchasesPerVisit: 12,
    });
    expect(getShopPolicy("MISSILE")).toEqual({
      maxStock: Number.POSITIVE_INFINITY,
      maxPurchasesPerVisit: 12,
    });
  });
});

describe("transactions boutique", () => {
  it.each([0, 2, -2, Number.NaN])(
    "refuse le delta runtime invalide %s sans mutation",
    (delta) => {
      const player = createPlayer({ money: 500, inventory: { GRENADE: 1 } });
      const counters: ShopVisitCounters = {};
      const result = applyShopTransaction({
        player,
        counters,
        weaponId: "GRENADE",
        delta: delta as 1 | -1,
      });

      expect(result).toMatchObject({ ok: false, reason: "MALFORMED" });
      expect(result.player).toBe(player);
      expect(result.counters).toBe(counters);
    },
  );

  it("achète et vend immuablement avec le prix serveur", () => {
    const original = createPlayer({ money: 500, inventory: { GRENADE: 1 } });
    const bought = applyShopTransaction({
      player: original,
      counters: {},
      weaponId: "GRENADE",
      delta: 1,
    });
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;
    expect(bought.player.money).toBe(425);
    expect(bought.player.inventory.GRENADE).toBe(2);
    expect(bought.counters[original.id]?.GRENADE).toBe(1);
    expect(original).toEqual(createPlayer({ money: 500, inventory: { GRENADE: 1 } }));

    const sold = applyShopTransaction({
      player: bought.player,
      counters: bought.counters,
      weaponId: "GRENADE",
      delta: -1,
    });
    expect(sold.ok).toBe(true);
    if (!sold.ok) return;
    expect(sold.player.money).toBe(500);
    expect(sold.player.inventory.GRENADE).toBe(1);
    expect(sold.counters[original.id]?.GRENADE).toBe(1);
  });

  it("applique l'ordre STOCK_CAP, PURCHASE_LIMIT, puis fonds", () => {
    const capped = applyShopTransaction({
      player: createPlayer({ money: 0, inventory: { NUKE: 2 } }),
      counters: {},
      weaponId: "NUKE",
      delta: 1,
    });
    expect(capped).toMatchObject({ ok: false, reason: "STOCK_CAP" });

    const limited = applyShopTransaction({
      player: createPlayer({ money: 0, inventory: { NUKE: 1 } }),
      counters: { "player-1": { NUKE: 1 } },
      weaponId: "NUKE",
      delta: 1,
    });
    expect(limited).toMatchObject({ ok: false, reason: "PURCHASE_LIMIT" });

    const poor = applyShopTransaction({
      player: createPlayer({ money: 419, inventory: { NUKE: 1 } }),
      counters: {},
      weaponId: "NUKE",
      delta: 1,
    });
    expect(poor).toMatchObject({ ok: false, reason: "INSUFFICIENT_FUNDS" });
  });

  it.each([
    {
      weaponId: "NUKE" as const,
      inventory: { NUKE: 1 },
      counters: {},
      expected: { ok: true, stock: 2 },
    },
    {
      weaponId: "THERMONUCLEAR" as const,
      inventory: { THERMONUCLEAR: 1 },
      counters: {},
      expected: { ok: false, reason: "STOCK_CAP" },
    },
    {
      weaponId: "GRENADE" as const,
      inventory: { GRENADE: 2 },
      counters: { "player-1": { GRENADE: 12 } },
      expected: { ok: false, reason: "PURCHASE_LIMIT" },
    },
    {
      weaponId: "MISSILE" as const,
      inventory: {},
      counters: {},
      expected: { ok: false, reason: "NOT_SOLD" },
    },
  ])("applique la matrice boutique $weaponId", ({
    weaponId,
    inventory,
    counters,
    expected,
  }) => {
    const result = applyShopTransaction({
      player: createPlayer({ inventory }),
      counters,
      weaponId,
      delta: 1,
    });

    expect(result).toMatchObject(
      expected.ok
        ? {
            ok: true,
            player: { inventory: { [weaponId]: expected.stock } },
          }
        : { ok: false, reason: expected.reason },
    );
  });

  it("permet vente puis rachat sans restaurer un quota déjà consommé", () => {
    const player = createPlayer({ inventory: { NUKE: 2 } });
    const sold = applyShopTransaction({
      player,
      counters: {},
      weaponId: "NUKE",
      delta: -1,
    });
    expect(sold.ok).toBe(true);
    if (!sold.ok) return;
    const rebought = applyShopTransaction({
      player: sold.player,
      counters: sold.counters,
      weaponId: "NUKE",
      delta: 1,
    });
    expect(rebought).toMatchObject({ ok: true });

    const soldAfterPurchase = applyShopTransaction({
      player: createPlayer({ inventory: { NUKE: 1 } }),
      counters: { "player-1": { NUKE: 1 } },
      weaponId: "NUKE",
      delta: -1,
    });
    expect(soldAfterPurchase.ok).toBe(true);
    if (!soldAfterPurchase.ok) return;
    const denied = applyShopTransaction({
      player: soldAfterPurchase.player,
      counters: soldAfterPurchase.counters,
      weaponId: "NUKE",
      delta: 1,
    });
    expect(denied).toMatchObject({ ok: false, reason: "PURCHASE_LIMIT" });
  });

  it("refuse seulement l'arme dont le stock est illégal", () => {
    const player = createPlayer({ inventory: { NUKE: 3, GRENADE: 1 } });
    const nuke = applyShopTransaction({
      player,
      counters: {},
      weaponId: "NUKE",
      delta: -1,
    });
    expect(nuke).toMatchObject({ ok: false, reason: "ILLEGAL_INVENTORY" });

    const grenade = applyShopTransaction({
      player,
      counters: {},
      weaponId: "GRENADE",
      delta: 1,
    });
    expect(grenade).toMatchObject({ ok: true });
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "refuse le compteur corrompu %s avec MALFORMED",
    (count) => {
      const counters = {
        "player-1": { GRENADE: count },
      } as ShopVisitCounters;
      const result = applyShopTransaction({
        player: createPlayer({ inventory: { GRENADE: 1 } }),
        counters,
        weaponId: "GRENADE",
        delta: -1,
      });
      expect(result).toMatchObject({ ok: false, reason: "MALFORMED" });
    },
  );

  it("refuse les débordements de stock avec MALFORMED", () => {
    const result = applyShopTransaction({
      player: createPlayer({
        inventory: { GRENADE: Number.MAX_SAFE_INTEGER },
      }),
      counters: {},
      weaponId: "GRENADE",
      delta: 1,
    });
    expect(result).toMatchObject({ ok: false, reason: "MALFORMED" });
  });

  it("refuse MISSILE, le stock nul et l'overflow à la vente", () => {
    expect(
      applyShopTransaction({
        player: createPlayer(),
        counters: {},
        weaponId: "MISSILE",
        delta: -1,
      }),
    ).toMatchObject({ ok: false, reason: "NOT_SOLD" });
    expect(
      applyShopTransaction({
        player: createPlayer(),
        counters: {},
        weaponId: "GRENADE",
        delta: -1,
      }),
    ).toMatchObject({ ok: false, reason: "NO_STOCK" });
    expect(
      applyShopTransaction({
        player: createPlayer({
          money: Number.MAX_SAFE_INTEGER,
          inventory: { GRENADE: 1 },
        }),
        counters: {},
        weaponId: "GRENADE",
        delta: -1,
      }),
    ).toMatchObject({ ok: false, reason: "MALFORMED" });
  });

  it.each([
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("refuse le solde initial illégal %s à la vente", (money) => {
    const player = createPlayer({ money, inventory: { GRENADE: 1 } });
    const counters: ShopVisitCounters = {};
    const result = applyShopTransaction({
      player,
      counters,
      weaponId: "GRENADE",
      delta: -1,
    });

    expect(result).toMatchObject({ ok: false, reason: "MALFORMED" });
    expect(result.player).toBe(player);
    expect(result.counters).toBe(counters);
  });

  it.each([
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("refuse le stock non sûr %s sans toucher aux autres armes", (stock) => {
    const player = createPlayer({
      inventory: { NUKE: stock, GRENADE: 1 },
    });
    const result = applyShopTransaction({
      player,
      counters: {},
      weaponId: "NUKE",
      delta: -1,
    });

    expect(result).toMatchObject({ ok: false, reason: "ILLEGAL_INVENTORY" });
    expect(player.inventory.GRENADE).toBe(1);
  });
});

describe("normalisation et consommation", () => {
  it("normalise les stocks non sûrs, clamp les armes lourdes et garde l'argent", () => {
    const normalized = normalizeInventoryAtShopOpen(
      createPlayer({
        money: -1,
        inventory: {
          NUKE: 3,
          THERMONUCLEAR: 4,
          GRENADE: Number.NaN,
          CLUSTER: -1,
        },
      }),
    );
    expect(normalized.money).toBe(-1);
    expect(normalized.inventory).toMatchObject({
      NUKE: 2,
      THERMONUCLEAR: 1,
      GRENADE: 0,
      CLUSTER: 0,
    });
  });

  it("consomme l'arme demandée et revient à MISSILE à la dernière munition", () => {
    const first = consumeWeaponForFire(
      createPlayer({ inventory: { NUKE: 2 } }),
      "NUKE",
    );
    expect(first).toMatchObject({
      ok: true,
      player: { inventory: { NUKE: 1 }, tank: { currentWeapon: "NUKE" } },
    });
    if (!first.ok) return;
    const second = consumeWeaponForFire(first.player, "NUKE");
    expect(second).toMatchObject({
      ok: true,
      player: { inventory: { NUKE: 0 }, tank: { currentWeapon: "MISSILE" } },
    });
  });

  it("isole les refus FIRE à l'arme demandée", () => {
    const illegalNuke = createPlayer({ inventory: { NUKE: 3, GRENADE: 1 } });
    expect(consumeWeaponForFire(illegalNuke, "NUKE")).toMatchObject({
      ok: false,
      reason: "ILLEGAL_INVENTORY",
    });
    expect(consumeWeaponForFire(illegalNuke, "MISSILE")).toMatchObject({ ok: true });
    expect(consumeWeaponForFire(illegalNuke, "GRENADE")).toMatchObject({ ok: true });
    expect(consumeWeaponForFire(createPlayer(), "NUKE")).toMatchObject({
      ok: false,
      reason: "NO_AMMO",
    });
  });
});

describe("gardes de session", () => {
  it("distingue création, reprise et boutique indisponible", () => {
    const base = {
      isHumanSlot: true,
      roundEnded: true,
      shotInFlight: false,
      zeusStrikeActive: false,
      serverRoundNumber: 2,
      requestedRoundNumber: 2,
      session: null,
    } as const;
    expect(guardShopEnter(base)).toEqual({ ok: true, mode: "CREATE" });
    expect(
      guardShopEnter({
        ...base,
        session: { epoch: 4, roundNumber: 2, readySlots: [] },
      }),
    ).toEqual({ ok: true, mode: "RESUME" });
    expect(guardShopEnter({ ...base, requestedRoundNumber: 3 })).toEqual({
      ok: false,
      reason: "SHOP_NOT_AVAILABLE",
    });
  });

  it("distingue boutique fermée, epoch périmée et joueur prêt", () => {
    const base = {
      isHumanSlot: true,
      slot: 0,
      actionId: "action-1",
      requestedEpoch: 3,
      session: null,
    } as const;
    expect(guardShopAction(base)).toEqual({ ok: false, reason: "SHOP_CLOSED" });
    const session = { epoch: 3, roundNumber: 2, readySlots: [0] };
    expect(
      guardShopAction({ ...base, requestedEpoch: 2, session }),
    ).toEqual({ ok: false, reason: "STALE_SHOP_EPOCH" });
    expect(guardShopAction({ ...base, session })).toEqual({
      ok: false,
      reason: "ALREADY_READY",
    });
  });

  it("refuse un actionId de plus de 64 caractères avant les autres gardes", () => {
    expect(
      guardShopAction({
        isHumanSlot: true,
        slot: 0,
        actionId: "x".repeat(65),
        requestedEpoch: 3,
        session: null,
      }),
    ).toEqual({ ok: false, reason: "MALFORMED" });
  });
});
