import { afterEach, describe, expect, it, vi } from "vitest";
import { flatTerrain, makePlayer, makeTank } from "../../../__tests__/helpers";
import type { GameState } from "../../../../types/game";
import { WEAPON_REGISTRY, type WeaponId } from "../../../../types/weapon";
import * as random from "../../../../utils/random";
import * as rewards from "../../../economy/shotRewards";
import * as ballistics from "../BallisticsSimulator";
import * as physical from "../physicalShotForecast";
import * as evaluator from "../expertShotEvaluator";
import { chooseExpertPlan, type ExpertDecisionTrace } from "../expertPlanner";
import { createExpertDecisionAim } from "../expertDecisionAim";
import { AISmartStrategy } from "../AISmartStrategy";
import { MATERIAL_AIM_VARIANTS, ORDINARY_AIM_POLICY } from "../aimSearch";

const aim = { primaryTargetId: "target", attempts: 2, offset: 0 };
const consequences = { humanDestroyedCount: 0, humanDamageMilli: 0, aiDestroyedCount: 0, aiDamageMilli: 0 };
const invalid: evaluator.ExpertShotResult = { destination: -1, profit: 0,
  destroyedIds: new Set(), shooterDestroyed: false, pointOrder: -1 };

function fixture() {
  const self = makePlayer({ id: "self", isHuman: false, aiProfile: "v4-smart",
    tank: makeTank("self", 100, 336), inventory: { NUKE: 2, GRENADE: 1, CLUSTER: 1, DRILLER: 1, BULLDOZER: 1 } });
  const target = makePlayer({ id: "target", isHuman: false, aiProfile: "v4-smart",
    tank: makeTank("target", 400, 336) });
  const state: GameState = { phase: "COMBAT", players: [self, target], currentPlayerIndex: 0,
    turn: 15, roundNumber: 6, windForce: 0, gravity: 260,
    localShotContext: { playerCountAtMatchStart: 2, isFirstShotOfRound: false } };
  return { self, target, state, terrain: flatTerrain(800, 480) };
}

function valid(profit: number, shooterDestroyed = false): evaluator.ValidExpertShotResult {
  return { ...aim, ...consequences, kind: "evaluated", destination: { x: 400, y: 328.5, kind: "tank" },
    requestedPoint: { x: 400, y: 328.5 }, policy: { variant: "full", penalizeProximity: false },
    rawCommand: { angle: 45, power: 50 }, command: { angle: 45, power: 50 },
    profit, shooterDestroyed, destroyedIds: new Set(shooterDestroyed ? ["target", "self"] : ["target"]), pointOrder: 0 };
}

type Complete = Extract<physical.PhysicalResolution, { complete: true }>;
function complete(overrides: Partial<Complete> = {}): Complete {
  return { complete: true, ...consequences, survivors: ["self", "target"], hits: [], damage: [],
    destruction: [], support: [], steps: 1, ...overrides };
}
function effect(weaponId: WeaponId) {
  return { shotId: 1, munitionId: 0, shooterId: "self", victimId: "target", weaponId,
    source: "projectile" as const, classification: "direct" as const,
    shieldAbsorbedMilli: 0, shieldLostMilli: 0, healthDamageMilli: 1000 };
}

function fallbackFixture(weapon: WeaponId, profit: number, suicide: boolean, missileProfit: number,
  missileComplete = true) {
  const f = fixture();
  vi.spyOn(ballistics, "searchBallisticSolution").mockReturnValue({ angle: 45, power: 50, err: 0, complete: true });
  vi.spyOn(physical, "resolvePhysicalShot").mockImplementation((_state, _terrain, _self, id) => {
    if (id === "MISSILE" && !missileComplete) return { complete: false, survivors: [], hits: [],
      damage: [], destruction: [], support: [], steps: 2400 };
    return complete({ survivors: id === weapon && suicide ? ["target"] : ["self", "target"],
      damage: id === weapon ? [effect(id)] : [], aiDamageMilli: id === weapon ? 1000 : 0 });
  });
  const real = rewards.calculateShotRewards;
  vi.spyOn(rewards, "calculateShotRewards").mockImplementation((input) => ({ ...real(input),
    awards: [{ playerId: "self", amount: input.weaponId === "MISSILE"
      ? missileProfit : WEAPON_REGISTRY[input.weaponId].price + profit, components: [] }],
  }));
  return { ...f, choose: () => evaluator.chooseExpertFallback(f.state, f.terrain, f.self, f.target,
    weapon, evaluator.createExpertForecastCache(), aim) };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("EXPERT immediate net profit policy #288", () => {
  it.each([
    { suicideProfit: 100, safeProfit: 80, winner: "NUKE", reason: "profit net supérieur" },
    { suicideProfit: 100, safeProfit: 100, winner: "MISSILE", reason: "EXPERT survit, contrairement au suivant" },
  ] as const)("ranks profit then survival across weapons ($suicideProfit/$safeProfit)", (scenario) => {
    const f = fixture();
    const evaluate: typeof evaluator.evaluateExpertShot = (_s, _t, shooter, weapon, _targets, _kill, _first, _cache, context) => {
      if (shooter.id !== "self") { expect(context).toEqual({ mode: "adverse" }); return invalid; }
      expect(context).toMatchObject({ mode: "own", selectionPolicy: "OPTIMISER_PROFIT" });
      return weapon === "NUKE" ? valid(scenario.suicideProfit, true) :
        weapon === "MISSILE" ? valid(scenario.safeProfit) : invalid;
    };
    const trace = vi.fn<(decision: ExpertDecisionTrace) => void>();
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const plan = chooseExpertPlan(f.self, f.state, f.terrain,
      createExpertDecisionAim({ currentTargetAttempts: 0 }, 6), evaluate, trace);
    expect(plan?.weaponId).toBe(scenario.winner);
    expect(trace.mock.calls[0][0]).toMatchObject({ phase: "OPTIMISER_PROFIT", selectionReason: scenario.reason });
    expect(rng).toHaveBeenCalledTimes(2);
  });

  it.each([-340, 0, 100])("rejects only strictly negative paid main plans (profit %s)", (profit) => {
    const f = fixture();
    const evaluate: typeof evaluator.evaluateExpertShot = (_s, _t, shooter, weapon) =>
      shooter.id === "self" && weapon === "NUKE" ? valid(profit) : invalid;
    const cache = evaluator.createExpertForecastCache();
    const plan = chooseExpertPlan(f.self, f.state, f.terrain,
      createExpertDecisionAim({ currentTargetAttempts: 0 }, 6), evaluate, undefined, cache);
    if (profit < 0) {
      expect(plan).toBeNull();
      expect(cache.diagnostics?.rejectedUnprofitableShots).toEqual([
        { weaponId: "NUKE", targetIds: ["target"], profit: -340, shooterDestroyed: false },
      ]);
    } else expect(plan?.weaponId).toBe("NUKE");
  });

  it.each([false, true])("SURVIE preserves a negative-profit NUKE only if EXPERT survives (suicide %s)", (suicide) => {
    const f = fixture();
    const evaluate: typeof evaluator.evaluateExpertShot = (_s, _t, shooter, weapon, _targets, kill, _first, _cache, context) => {
      if (shooter.id !== "self") return weapon === "MISSILE" ? valid(1) : invalid;
      expect(context).toMatchObject({ selectionPolicy: kill ? "SURVIE" : "OPTIMISER_PROFIT" });
      return weapon === "NUKE" ? valid(-293, suicide) : invalid;
    };
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const plan = chooseExpertPlan(f.self, f.state, f.terrain,
      createExpertDecisionAim({ currentTargetAttempts: 0 }, 6), evaluate);
    expect(plan?.weaponId ?? null).toBe(suicide ? null : "NUKE");
    expect(rng).toHaveBeenCalledTimes(2);
  });

  it.each([
    { mode: "own", selectionPolicy: "OPTIMISER_PROFIT", safeProfit: 80, suicideProfit: 100, expected: 1 },
    { mode: "own", selectionPolicy: "OPTIMISER_PROFIT", safeProfit: 100, suicideProfit: 100, expected: 0 },
    { mode: "own", selectionPolicy: "OPTIMISER_PROFIT", safeProfit: -340, suicideProfit: 0, expected: 1 },
    { mode: "own", selectionPolicy: "SURVIE", safeProfit: -293, suicideProfit: 100, expected: 0 },
    { mode: "adverse", safeProfit: 80, suicideProfit: 100, expected: 0 },
  ] as const)("chooses the point/arc using $mode $selectionPolicy ($safeProfit/$suicideProfit)", (scenario) => {
    const f = fixture();
    const cache = evaluator.createExpertForecastCache();
    const own = scenario.mode === "own";
    const points = evaluator.expertTacticalPoints(f.self, [f.target], "NUKE", f.terrain, f.state.players, scenario.mode);
    for (const [index, point] of points.entries()) {
      for (const [arc, variant] of (own ? MATERIAL_AIM_VARIANTS : ["full"] as const).entries()) {
        const command = { angle: 30 + index * 3 + arc, power: 50 };
        const selectedIndex = own ? arc : index;
        cache.search.set(JSON.stringify(["self", "NUKE", point.x, point.y, 0, 260,
          { variant, penalizeProximity: !own }]), { command, complete: index === 0 && arc < 2 || !own && index < 2 });
        cache.physics.set(JSON.stringify(["self", "NUKE", command.angle, command.power, 0, 260, 2, false]), {
          ...complete({ hits: [{ shotId: 1, munitionId: 0, weaponId: "NUKE", x: point.x, y: point.y, directTargetId: "target" }],
            damage: [effect("NUKE")], survivors: selectedIndex === 0 ? ["self"] : [],
            destruction: [{ shotId: 1, shooterId: "self", victimId: "target", weaponId: "NUKE", cause: "health-zero" },
              ...(selectedIndex === 0 ? [] : [{ shotId: 1, shooterId: "self", victimId: "self", weaponId: "NUKE" as const, cause: "health-zero" as const }])] }),
          profit: selectedIndex === 0 ? scenario.safeProfit : scenario.suicideProfit,
        });
      }
    }
    const context: evaluator.ExpertEvaluationContext = scenario.mode === "adverse"
      ? { mode: "adverse" } : { mode: "own", aim, selectionPolicy: scenario.selectionPolicy };
    const result = evaluator.evaluateExpertShot(f.state, f.terrain, f.self, "NUKE", [f.target], true, false, cache, context);
    expect(result).toMatchObject({ profit: scenario.expected === 0 ? scenario.safeProfit : scenario.suicideProfit,
      shooterDestroyed: scenario.expected === 1 });
    if (evaluator.isValidExpertShot(result)) {
      expect(own ? MATERIAL_AIM_VARIANTS.indexOf(result.policy.variant) : result.pointOrder).toBe(scenario.expected);
    }
  });
});

describe("EXPERT economic fallback #288", () => {
  it.each(["GRENADE", "CLUSTER", "DRILLER", "BULLDOZER"] as const)(
    "%s selects suicidal +100 over surviving +80, but preserves survival at equal profit", (weapon) => {
      const f = fallbackFixture(weapon, 100, true, 80);
      expect(f.choose()).toMatchObject({ kind: "evaluated", weaponId: weapon, forecast: { profit: 100, survivors: ["target"] } });
      // Change only the economic reward; physics and the production policy stay identical.
      const previousReward = vi.mocked(rewards.calculateShotRewards).getMockImplementation()!;
      vi.mocked(rewards.calculateShotRewards).mockImplementation((input) => ({
        ...previousReward(input), awards: [{ playerId: "self", amount: input.weaponId === "MISSILE"
          ? 100 : WEAPON_REGISTRY[input.weaponId].price + 100, components: [] }],
      }));
      expect(f.choose()).toMatchObject({ weaponId: "MISSILE", forecast: { profit: 100, survivors: ["self", "target"] } });
    });

  it.each(["GRENADE", "CLUSTER", "DRILLER", "BULLDOZER"] as const)(
    "%s rejects paid loss, retains zero-profit useful shots, and keeps a sole suicidal complete forecast", (weapon) => {
      const negative = fallbackFixture(weapon, -1, false, 0);
      expect(negative.choose()).toMatchObject({ weaponId: "MISSILE", useful: false, forecast: { profit: 0 } });
      vi.restoreAllMocks();
      const zero = fallbackFixture(weapon, 0, false, 0);
      expect(zero.choose()).toMatchObject({ weaponId: weapon, useful: true, forecast: { profit: 0 } });
      vi.restoreAllMocks();
      const sole = fallbackFixture(weapon, 0, true, 0, false);
      expect(sole.choose()).toMatchObject({ kind: "evaluated", weaponId: weapon, forecast: { profit: 0 } });
    });

  it.each([false, true])("keeps the last ordinary MISSILE bounded and uncertified (DEV %s)", (dev) => {
    vi.stubEnv("DEV", dev);
    const f = fallbackFixture("GRENADE", -1, true, 0, false);
    vi.mocked(ballistics.searchBallisticSolution).mockReturnValue({ angle: 200, power: 1000, err: 99, complete: true });
    const choice = f.choose();
    expect(choice).toMatchObject({ kind: "ordinary", weaponId: "MISSILE", command: { angle: 174, power: 95 },
      policy: ORDINARY_AIM_POLICY });
    expect(choice.forecast).toBeUndefined();
    expect(choice.selectionReason).toBe(dev ? "dernier MISSILE ordinaire non certifié" : undefined);
  });

  it("without economic context preserves physical safety and unknown profit", () => {
    const f = fallbackFixture("GRENADE", 100, true, 80);
    delete f.state.localShotContext;
    expect(f.choose()).toMatchObject({ weaponId: "MISSILE", forecast: { profit: null } });
    expect(rewards.calculateShotRewards).not.toHaveBeenCalled();
  });

  it("uses consequences then stable order at equal profit, without a free-ammunition preference", () => {
    const f = fallbackFixture("GRENADE", 0, false, 0);
    vi.mocked(physical.resolvePhysicalShot).mockImplementation((_state, _terrain, _self, weapon) =>
      complete({ damage: weapon === "GRENADE" ? [effect(weapon)] : [],
        humanDamageMilli: weapon === "GRENADE" ? 1000 : 0 }));
    expect(f.choose().weaponId).toBe("MISSILE");
    vi.mocked(physical.resolvePhysicalShot).mockReturnValue(complete());
    expect(f.choose().weaponId).toBe("GRENADE");
  });

  it.each([false, true])("a profitable ordinary fallback has a profit reason after main-plan losses (DEV %s)", async (dev) => {
    vi.stubEnv("DEV", dev);
    const f = fallbackFixture("GRENADE", 100, true, 80);
    const height = f.terrain.getHeightAt.bind(f.terrain);
    vi.spyOn(f.terrain, "getHeightAt").mockImplementation((x) => x > 150 && x < 350 ? 50 : height(x));
    vi.spyOn(evaluator, "evaluateExpertShot").mockImplementation((_s, _t, shooter, weapon) =>
      shooter.id === "self" && weapon === "NUKE" ? valid(-340) : invalid);
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await new AISmartStrategy().executeTurn("self", f.state, f.terrain))
      .toEqual({ angle: 45, power: 50, weaponId: "GRENADE" });
    if (dev) {
      const trace: unknown = JSON.parse(String(log.mock.calls[0][1]));
      expect(trace).toMatchObject({ selectionReason: "profit net supérieur", fallbackSelectionReason: "profit net supérieur" });
      expect(trace).not.toHaveProperty("conservationReason");
    } else expect(log).not.toHaveBeenCalled();
  });

  it.each([
    { profit: 0, suicide: false, missileProfit: 80, humanDamage: 0, reason: "profit net supérieur" },
    { profit: 0, suicide: true, missileProfit: 0, humanDamage: 0, reason: "EXPERT survit, contrairement au suivant" },
    { profit: 0, suicide: false, missileProfit: 0, humanDamage: 1000, reason: "conséquences physiques préférées" },
    { profit: -1, suicide: false, missileProfit: 80, humanDamage: 0, reason: "seul candidat admissible" },
  ])("preserves the MISSILE fallback reason after rejected losses: $reason ($profit)", async (scenario) => {
    const f = fallbackFixture("GRENADE", scenario.profit, scenario.suicide, scenario.missileProfit);
    const height = f.terrain.getHeightAt.bind(f.terrain);
    vi.spyOn(f.terrain, "getHeightAt").mockImplementation((x) => x > 150 && x < 350 ? 50 : height(x));
    const resolve = vi.mocked(physical.resolvePhysicalShot).getMockImplementation()!;
    vi.mocked(physical.resolvePhysicalShot).mockImplementation((...args) => ({
      ...resolve(...args), humanDamageMilli: args[3] === "GRENADE" ? scenario.humanDamage : 0,
    }));
    vi.spyOn(evaluator, "evaluateExpertShot").mockImplementation((_s, _t, shooter, weapon) =>
      shooter.id === "self" && weapon === "NUKE" ? valid(-340) : invalid);
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await new AISmartStrategy().executeTurn("self", f.state, f.terrain))
      .toEqual({ angle: 45, power: 50, weaponId: "MISSILE" });
    const trace: unknown = JSON.parse(String(log.mock.calls[0][1]));
    expect(trace).toMatchObject({ selectionReason: scenario.reason, fallbackSelectionReason: scenario.reason });
    expect(trace).not.toHaveProperty("conservationReason");
  });

  it.each([false, true])("preserves the production choice and compact conservation trace (DEV %s)", async (dev) => {
    vi.stubEnv("DEV", dev);
    const f = fallbackFixture("GRENADE", -1, false, 0);
    vi.spyOn(evaluator, "evaluateExpertShot").mockImplementation((_s, _t, shooter, weapon) =>
      shooter.id === "self" && weapon === "NUKE" ? valid(-340) : invalid);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const before = structuredClone(f.self.inventory);
    const command = await new AISmartStrategy().executeTurn("self", f.state, f.terrain);
    expect(command).toEqual({ angle: 45, power: 50, weaponId: "MISSILE" });
    expect(f.self.inventory).toEqual(before);
    expect(rng).toHaveBeenCalledTimes(3);
    if (dev) {
      const json = String(log.mock.calls[0][1]);
      expect(JSON.parse(json)).toMatchObject({ conservationReason: expect.stringContaining("conservation"),
        rejectedUnprofitableShots: [{ weaponId: "NUKE", targetIds: ["target"], profit: -340, shooterDestroyed: false }],
        realAim: { choiceKind: "evaluated", materialFallback: { profit: 0, useful: false } } });
      expect(json.indexOf("conservationReason")).toBeLessThan(json.indexOf("roster"));
      expect(json.slice(0, 5000)).toContain('"profit":-340');
    } else expect(log).not.toHaveBeenCalled();
  });
});
