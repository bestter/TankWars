import { afterEach, describe, expect, it, vi } from "vitest";
import { flatTerrain, makePlayer, makeTank } from "../../../__tests__/helpers";
import type { GameState } from "../../../../types/game";
import { WEAPON_REGISTRY } from "../../../../types/weapon";
import { TERRAIN_MATERIAL } from "../../../../types/terrain";
import { calculateShotAdvice, createIdealExpertAim, type AdvisorSnapshot } from "../shotAdvisor";
import { chooseExpertPlan, ordinaryExpertTarget, possibleExpertThreatWeapons } from "../expertPlanner";
import * as evaluator from "../expertShotEvaluator";
import * as aimSolver from "../expertAim";
import * as physical from "../physicalShotForecast";
import * as random from "../../../../utils/random";
import * as rewards from "../../../economy/shotRewards";
import { compareAdvisorOutcomes } from "../expertPolicy";

function advisorFixture() {
  const self = makePlayer({ id: "self", isHuman: true, inventory: { NUKE: 2, DRILLER: 1 },
    tank: makeTank("self", 100, 336) });
  const enemy = makePlayer({ id: "enemy", isHuman: false, aiProfile: "v1-random",
    tank: makeTank("enemy", 400, 336) });
  const state: GameState = { phase: "COMBAT", players: [self, enemy], currentPlayerIndex: 0,
    turn: 1, roundNumber: 1, windForce: 0, gravity: 260,
    localShotContext: { playerCountAtMatchStart: 2, isFirstShotOfRound: true } };
  const terrain = flatTerrain(800, 480);
  const snapshot: AdvisorSnapshot = { state, width: 800, height: 480,
    heights: [...terrain.getHeightmap()], materials: [...terrain.getMaterials()] };
  return { self, enemy, state, terrain, snapshot };
}

const consequences = { humanDestroyedCount: 0, humanDamageMilli: 0, aiDestroyedCount: 0, aiDamageMilli: 0 };
const invalid: evaluator.ExpertShotResult = { destination: -1, profit: 0, destroyedIds: new Set(),
  shooterDestroyed: false, pointOrder: -1 };
function valid(profit: number, shooterDestroyed = false, kills = 1): evaluator.ValidExpertShotResult {
  return { ...consequences, aiDestroyedCount: kills, kind: "evaluated", primaryTargetId: "enemy",
    offset: 0, attempts: 0, command: { angle: 45, power: 50 }, rawCommand: { angle: 45, power: 50 },
    requestedPoint: { x: 400, y: 328.5 }, destination: { x: 400, y: 328.5, kind: "tank" },
    policy: { variant: "full", penalizeProximity: false }, pointOrder: 0,
    profit, shooterDestroyed, destroyedIds: new Set(["enemy"]) };
}
function complete(suicide = false): Extract<physical.PhysicalResolution, { complete: true }> {
  return { ...consequences, complete: true, survivors: suicide ? ["enemy"] : ["self", "enemy"],
    hits: [{ shotId: 1, munitionId: 0, weaponId: "NUKE", x: 400, y: 330, directTargetId: "enemy" }],
    damage: [{ shotId: 1, munitionId: 0, shooterId: "self", victimId: "enemy", weaponId: "NUKE",
      source: "projectile", classification: "direct", shieldAbsorbedMilli: 0, shieldLostMilli: 0, healthDamageMilli: 1000 }],
    destruction: [], support: [], steps: 1 };
}
afterEach(() => vi.restoreAllMocks());

describe("local advisor shared policies #273", () => {
  it("SURVIE neutralizes without a roll and without using profit (EXPERT keeps profit)", () => {
    const f = advisorFixture();
    const evaluate: typeof evaluator.evaluateExpertShot = (_s, _t, shooter, weapon, _targets, _kill, _first, _cache, context) => {
      if (shooter.id !== "self") return weapon === "MISSILE" ? valid(5) : invalid;
      if (context?.mode === "own" && context.advisor) expect(context.advisor).toEqual({ objective: "SURVIE", neutralize: true });
      return weapon === "NUKE" ? valid(-200, false, 2) : weapon === "MISSILE" ? valid(80) : invalid;
    };
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(chooseExpertPlan(f.self, f.state, f.terrain, createIdealExpertAim(), evaluate,
      undefined, evaluator.createExpertForecastCache(), "SURVIE")?.weaponId).toBe("NUKE");
    expect(rng).not.toHaveBeenCalled();
    expect(chooseExpertPlan(f.self, f.state, f.terrain, createIdealExpertAim(), evaluate)?.weaponId).toBe("MISSILE");
    expect(rng).toHaveBeenCalledTimes(1);
  });

  it.each([
    { objective: "SURVIE" as const, nukeProfit: 100, missileProfit: 80, suicide: true, expected: "MISSILE" },
    { objective: "OPTIMISER_PROFIT" as const, nukeProfit: 100, missileProfit: 80, suicide: true, expected: "NUKE" },
    { objective: "OPTIMISER_PROFIT" as const, nukeProfit: 100, missileProfit: 100, suicide: true, expected: "MISSILE" },
    { objective: "SURVIE" as const, nukeProfit: -1, missileProfit: 0, suicide: false, expected: "MISSILE" },
    { objective: "OPTIMISER_PROFIT" as const, nukeProfit: 0, missileProfit: 0, suicide: false, expected: "NUKE" },
  ])("ranks groups and weapons with $objective / $nukeProfit / $missileProfit", (scenario) => {
    const f = advisorFixture();
    const evaluate: typeof evaluator.evaluateExpertShot = (_s, _t, shooter, weapon, _targets, _kill, _first, _cache, context) => {
      if (shooter.id !== "self") return invalid;
      expect(context).toMatchObject({ mode: "own", advisor: { objective: scenario.objective } });
      return weapon === "NUKE" ? valid(scenario.nukeProfit, scenario.suicide, 2) :
        weapon === "MISSILE" ? valid(scenario.missileProfit) : invalid;
    };
    expect(chooseExpertPlan(f.self, f.state, f.terrain, createIdealExpertAim(), evaluate,
      undefined, evaluator.createExpertForecastCache(), scenario.objective)?.weaponId).toBe(scenario.expected);
  });

  it("neutral consequences sum humans and AIs without phantom damage", () => {
    const a = { ...valid(0), humanDestroyedCount: 1, aiDestroyedCount: 0, humanDamageMilli: 1000 };
    const b = { ...valid(0), humanDestroyedCount: 0, aiDestroyedCount: 1, aiDamageMilli: 1000 };
    expect(compareAdvisorOutcomes(a, b, { objective: "SURVIE" })).toBe(0);
    expect(compareAdvisorOutcomes({ ...a, aiDamageMilli: 1 }, b, { objective: "SURVIE" })).toBeLessThan(0);
    expect(compareAdvisorOutcomes({ ...a, humanDestroyedCount: 2, humanDamageMilli: 0 }, b, { objective: "SURVIE" })).toBeLessThan(0);
  });

  it("fallback targets ignore memory and human/AI preference, retaining HP and roster order", () => {
    const f = advisorFixture();
    const human = makePlayer({ id: "human", isHuman: true, tank: makeTank("human", 600, 336, { health: 10 }) });
    f.state.players.push(human);
    expect(ordinaryExpertTarget(f.self, f.state.players, { currentTargetAttempts: 9, currentTargetId: "enemy" }, true)?.id).toBe("human");
    expect(ordinaryExpertTarget(f.self, f.state.players, { currentTargetAttempts: 9, currentTargetId: "enemy" })?.id).toBe("enemy");
    human.tank.health = f.enemy.tank.health;
    expect(ordinaryExpertTarget(f.self, f.state.players, { currentTargetAttempts: 0 }, true)?.id).toBe("enemy");
  });

  it("enemy nuclear weapons stay unknown while own stocks remain candidates", () => {
    const f = advisorFixture();
    f.enemy.isHuman = true;
    f.enemy.inventory = { NUKE: 9, THERMONUCLEAR: 9 };
    f.enemy.tank.currentWeapon = "NUKE";
    expect(possibleExpertThreatWeapons(f.enemy)).toEqual(["MISSILE"]);
  });

  it.each(["SURVIE", "OPTIMISER_PROFIT"] as const)("isolates real physics, RNG, reactions and repeated %s calculations", (objective) => {
    const f = advisorFixture();
    f.self.inventory = {};
    f.self.tank.hitReaction = { wasDirectHit: true, fallDistance: 90 };
    const before = structuredClone(f.snapshot);
    const rng = vi.spyOn(random, "secureRandom").mockImplementation(() => { throw new Error("LIVE_RNG_USED"); });
    const advice = calculateShotAdvice(f.snapshot, objective);
    expect(advice).not.toBeNull();
    expect(calculateShotAdvice(f.snapshot, objective)).toEqual(advice);
    expect(f.snapshot).toEqual(before);
    expect(rng).not.toHaveBeenCalled();
    expect(advice?.forecast.complete).toBe(true);
    expect(advice?.command).toEqual({ ...advice?.command, weaponId: "MISSILE" });
  });

  it("rejects absent and invalid economics before searching", () => {
    const f = advisorFixture();
    delete f.state.localShotContext;
    expect(() => calculateShotAdvice(f.snapshot, "SURVIE")).toThrow("INVALID_ADVISOR_ECONOMY");
    f.state.localShotContext = { playerCountAtMatchStart: 1, isFirstShotOfRound: true };
    expect(() => calculateShotAdvice(f.snapshot, "SURVIE")).toThrow("INVALID_ADVISOR_ECONOMY");
  });

  it("shared point/arc filter keeps a safe lower-profit arc of the same weapon", () => {
    const f = advisorFixture();
    vi.spyOn(aimSolver, "solveExpertAim").mockImplementation((_self, _x, _y, _w, _g, _t, _id, policy) => ({
      command: { angle: policy?.variant === "full" ? 45 : 60.4, power: 50.4 }, complete: true,
    }));
    vi.spyOn(physical, "resolvePhysicalShot").mockImplementation((_s, _t, _self, _id, command) => complete(command.angle === 45));
    const realRewards = rewards.calculateShotRewards;
    vi.spyOn(rewards, "calculateShotRewards").mockImplementation((input) => ({ ...realRewards(input),
      awards: [{ playerId: "self", amount: WEAPON_REGISTRY.NUKE.price + (input.survivorsAfterShot.includes("self") ? 80 : 100), components: [] }],
    }));
    const evaluate = (objective: "SURVIE" | "OPTIMISER_PROFIT") => evaluator.evaluateExpertShot(f.state, f.terrain,
      f.self, "NUKE", [f.enemy], false, true, evaluator.createExpertForecastCache(),
      { mode: "own", aim: createIdealExpertAim().forTarget("enemy"), selectionPolicy: "OPTIMISER_PROFIT", advisor: { objective } });
    expect(evaluate("SURVIE")).toMatchObject({ shooterDestroyed: false, profit: 80, command: { angle: 60.4, power: 50 } });
    expect(evaluate("OPTIMISER_PROFIT")).toMatchObject({ shooterDestroyed: true, profit: 100, command: { angle: 45, power: 50 } });
  });

  it("a changed shared physical evaluation changes the advisor without UI changes", () => {
    const f = advisorFixture();
    vi.spyOn(aimSolver, "solveExpertAim").mockReturnValue({ command: { angle: 45, power: 50 }, complete: true });
    const physics = vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(complete());
    expect(calculateShotAdvice(f.snapshot, "SURVIE")).not.toBeNull();
    physics.mockReturnValue({ complete: false, survivors: [], hits: [], damage: [], destruction: [], support: [], steps: 2400 });
    expect(calculateShotAdvice(f.snapshot, "SURVIE")).toBeNull();
    expect(calculateShotAdvice(f.snapshot, "OPTIMISER_PROFIT")).toBeNull();
  });

  it("neutralization ignores profit at point/arc level, while the second search uses profit", () => {
    const f = advisorFixture();
    vi.spyOn(aimSolver, "solveExpertAim").mockImplementation((_self, _x, _y, _w, _g, _t, _id, policy) => ({
      command: { angle: policy?.variant === "full" ? 45 : 60, power: 50 }, complete: true,
    }));
    vi.spyOn(physical, "resolvePhysicalShot").mockImplementation((_s, _t, _self, _id, command) => ({
      ...complete(), aiDestroyedCount: command.angle === 60 ? 2 : 1,
      damage: complete().damage.map((event) => ({ ...event, healthDamageMilli: command.angle === 60 ? 1000 : 2000 })),
      destruction: [{ shotId: 1, shooterId: "self", victimId: "enemy", weaponId: "NUKE", cause: "health-zero" }],
      support: [{ playerId: "marker", x: command.angle, before: 1, after: 1 }],
    }));
    vi.spyOn(rewards, "calculateShotRewards").mockImplementation((input) => ({
      shotId: input.shotId,
      awards: [{ playerId: "self", amount: WEAPON_REGISTRY.NUKE.price +
        (input.damageEvents[0].healthDamageMilli === 1000 ? -200 : 80), components: [] }],
      damageDealtMilliByPlayer: {}, hasEarnings: true,
      roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
    }));
    const evaluate = (neutralize: boolean) => evaluator.evaluateExpertShot(f.state, f.terrain,
      f.self, "NUKE", [f.enemy], neutralize, true, evaluator.createExpertForecastCache(),
      { mode: "own", aim: createIdealExpertAim().forTarget("enemy"), advisor: { objective: "SURVIE", neutralize } });
    expect(evaluate(true)).toMatchObject({ profit: -200, aiDestroyedCount: 2, command: { angle: 60 } });
    expect(evaluate(false)).toMatchObject({ profit: 80, command: { angle: 45 } });
  });

  it.each([
    { objective: "SURVIE" as const, profit: 100, missile: 80, suicide: true, expected: "MISSILE" },
    { objective: "OPTIMISER_PROFIT" as const, profit: 100, missile: 80, suicide: true, expected: "NUKE" },
    { objective: "OPTIMISER_PROFIT" as const, profit: 100, missile: 100, suicide: true, expected: "MISSILE" },
    { objective: "OPTIMISER_PROFIT" as const, profit: -1, missile: 0, suicide: false, expected: "MISSILE" },
    { objective: "SURVIE" as const, profit: 0, missile: 0, suicide: false, expected: "NUKE" },
  ])("fallback shares $objective filtering, profit and safety ($profit/$missile)", (scenario) => {
    const f = advisorFixture();
    vi.spyOn(aimSolver, "solveExpertAim").mockReturnValue({ command: { angle: 45, power: 50 }, complete: true });
    vi.spyOn(physical, "resolvePhysicalShot").mockImplementation((_s, _t, _self, weapon) =>
      weapon === "MISSILE" ? { ...complete(), damage: [], hits: [] } : { ...complete(scenario.suicide), aiDamageMilli: 1000 });
    const realRewards = rewards.calculateShotRewards;
    vi.spyOn(rewards, "calculateShotRewards").mockImplementation((input) => ({ ...realRewards(input),
      awards: [{ playerId: "self", amount: input.weaponId === "MISSILE" ? scenario.missile :
        WEAPON_REGISTRY[input.weaponId].price + scenario.profit, components: [] }],
    }));
    const fallback = evaluator.chooseExpertFallback(f.state, f.terrain, f.self, f.enemy, "NUKE",
      evaluator.createExpertForecastCache(), createIdealExpertAim().forTarget("enemy"), { objective: scenario.objective });
    expect(fallback).toMatchObject({ kind: "evaluated", weaponId: scenario.expected });
    if (scenario.expected === "MISSILE") expect(fallback.useful).toBe(false);
  });

  it("SURVIE fallback filters suicide at every arc and returns no advice if none is safe", () => {
    const f = advisorFixture();
    vi.spyOn(aimSolver, "solveExpertAim").mockImplementation((_self, _x, _y, _w, _g, _t, _id, policy) => ({
      command: { angle: policy?.variant === "full" ? 45 : 60, power: 50 }, complete: true,
    }));
    const physics = vi.spyOn(physical, "resolvePhysicalShot").mockImplementation((_s, _t, _self, _id, command) =>
      ({ ...complete(command.angle === 45), hits: [], damage: [] }));
    const choice = evaluator.chooseExpertFallback(f.state, f.terrain, f.self, f.enemy, "MISSILE",
      evaluator.createExpertForecastCache(), createIdealExpertAim().forTarget("enemy"), { objective: "SURVIE" });
    expect(choice).toMatchObject({ kind: "evaluated", command: { angle: 60 } });
    physics.mockReturnValue({ ...complete(true), hits: [], damage: [] });
    expect(calculateShotAdvice(f.snapshot, "SURVIE")).toBeNull();
  });

  it("carries exact first-shot economics and returns the normalized command physically evaluated", () => {
    const f = advisorFixture(); f.self.inventory = {};
    f.state.localShotContext = { playerCountAtMatchStart: 4, isFirstShotOfRound: true };
    vi.spyOn(aimSolver, "solveExpertAim").mockReturnValue({ command: { angle: 60.43, power: 50.7 }, complete: true });
    const physics = vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(complete());
    const reward = vi.spyOn(rewards, "calculateShotRewards");
    const advice = calculateShotAdvice(f.snapshot, "OPTIMISER_PROFIT");
    expect(advice?.command).toEqual({ angle: 60.4, power: 51, weaponId: "MISSILE" });
    expect(physics).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), "MISSILE", { angle: 60.4, power: 51 }, { captureAfterState: true });
    expect(reward).toHaveBeenCalledWith(expect.objectContaining({ playerCountAtMatchStart: 4, isFirstShotOfRound: true }));
  });

  it.each(["SURVIE", "OPTIMISER_PROFIT"] as const)("filters two-target groups under %s before ranking weapons", (objective) => {
    const f = advisorFixture();
    const other = makePlayer({ id: "other", isHuman: true, tank: makeTank("other", 430, 336) });
    f.state.players.push(other);
    f.state.localShotContext!.playerCountAtMatchStart = 3;
    const pairs: string[][] = [];
    const evaluate: typeof evaluator.evaluateExpertShot = (_s, _t, shooter, weapon, targets, _kill, _first, _cache, context) => {
      if (shooter.id !== "self") return invalid;
      if (targets.length === 2) {
        pairs.push(targets.map((p) => p.id));
        expect(context).toMatchObject({ mode: "own", advisor: { objective } });
        if (weapon === "NUKE") return valid(100, true, 2);
      }
      return weapon === "MISSILE" ? valid(80) : invalid;
    };
    const plan = chooseExpertPlan(f.self, f.state, f.terrain, createIdealExpertAim(), evaluate,
      undefined, evaluator.createExpertForecastCache(), objective);
    expect(pairs).toContainEqual(["enemy", "other"]);
    expect(plan?.weaponId).toBe(objective === "SURVIE" ? "MISSILE" : "NUKE");
    if (objective === "OPTIMISER_PROFIT") expect(plan?.targetIds).toEqual(["enemy", "other"]);
  });

  it("keeps stochastic GRENADE/CLUSTER forecasts deterministic without consuming the live RNG", () => {
    const f = advisorFixture();
    f.self.inventory = { GRENADE: 1, CLUSTER: 1 };
    const before = structuredClone(f.snapshot);
    const rng = vi.spyOn(random, "secureRandom").mockImplementation(() => { throw new Error("LIVE_RNG_USED"); });
    const first = calculateShotAdvice(f.snapshot, "OPTIMISER_PROFIT");
    expect(calculateShotAdvice(f.snapshot, "OPTIMISER_PROFIT")).toEqual(first);
    expect(f.snapshot).toEqual(before);
    expect(rng).not.toHaveBeenCalled();
  });

  it.each(["NUKE", "THERMONUCLEAR"] as const)(
    "naturally evaluates %s ROCK excavation and pre-fall blast in local advisor without consuming live RNG (#302)",
    (weaponId) => {
      const f = advisorFixture();
      f.self.inventory = { [weaponId]: 1 };
      f.self.tank.health = 10;
      f.enemy.tank.health = 100;
      const snapshot: AdvisorSnapshot = {
        ...f.snapshot,
        materials: new Array(800).fill(TERRAIN_MATERIAL.ROCK),
      };
      const before = structuredClone(snapshot);
      const rng = vi.spyOn(random, "secureRandom").mockImplementation(() => {
        throw new Error("LIVE_RNG_USED");
      });

      const advice = calculateShotAdvice(snapshot, "SURVIE");
      expect(advice).not.toBeNull();
      expect(advice?.command.weaponId).toBe(weaponId);
      expect(advice?.forecast.complete).toBe(true);
      expect(advice?.forecast.support.some((s) => s.playerId === "enemy" && s.after > s.before)).toBe(true);
      expect(snapshot).toEqual(before);
      expect(rng).not.toHaveBeenCalled();
    },
  );
});
