import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flatTerrain, makePlayer, makeTank } from "../../../__tests__/helpers";
import type { GameState } from "../../../../types/game";
import { TERRAIN_MATERIAL } from "../../../../types/terrain";
import * as random from "../../../../utils/random";
import * as ballistics from "../BallisticsSimulator";
import * as physical from "../physicalShotForecast";
import * as planner from "../expertPlanner";
import * as evaluator from "../expertShotEvaluator";
import * as aimMemory from "../aimMemory";
import { createExpertDecisionAim } from "../expertDecisionAim";
import * as fallibleAim from "../fallibleAim";
import { finalizeAdvancedAim } from "../aimCorruption";
import { AISmartStrategy } from "../AISmartStrategy";
import { solveExpertAim } from "../expertAim";
import { ORDINARY_AIM_POLICY } from "../aimSearch";

function fixture() {
  const terrain = flatTerrain(800, 480);
  const self = makePlayer({ id: "self", isHuman: false, aiProfile: "v4-smart",
    tank: makeTank("self", 100, 336), inventory: {} });
  const target = makePlayer({ id: "target", isHuman: true, tank: makeTank("target", 400, 336) });
  const state: GameState = { phase: "COMBAT", players: [self, target], currentPlayerIndex: 0,
    turn: 4, roundNumber: 1, windForce: 0, gravity: 260,
    localShotContext: { playerCountAtMatchStart: 2, isFirstShotOfRound: false } };
  return { terrain, self, target, state };
}

const selectedAim: evaluator.ExpertEvaluatedAim = {
  kind: "evaluated", primaryTargetId: "target", attempts: 1, offset: 50,
  requestedPoint: { x: 450, y: 328.5 }, policy: { variant: "high", penalizeProximity: false },
  rawCommand: { angle: 65.54, power: 55.5224609375 }, command: { angle: 65.5, power: 56 },
};
const invalid: evaluator.ExpertShotResult = { destination: -1, profit: 0,
  destroyedIds: new Set(), shooterDestroyed: false, pointOrder: -1 };
function valid(destroyedIds: string[] = [], profit = 10): evaluator.ValidExpertShotResult {
  return { ...selectedAim, destination: { x: 400, y: 328.5, kind: "tank" }, profit,
    destroyedIds: new Set(destroyedIds), shooterDestroyed: destroyedIds.includes("self"), pointOrder: 0,
    humanDestroyedCount: 0, humanDamageMilli: 0, aiDestroyedCount: 0, aiDamageMilli: 0 };
}
function complete(overrides: Partial<Extract<physical.PhysicalResolution, { complete: true }>> = {}) {
  return { complete: true as const, survivors: ["self", "target"], hits: [], damage: [], destruction: [],
    support: [], steps: 1, humanDestroyedCount: 0, humanDamageMilli: 0,
    aiDestroyedCount: 0, aiDamageMilli: 0, ...overrides };
}

beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => {}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(() => {
  expect(fallibleAim.SHOTS_TO_HIT["v4-smart"]).toBe(2);
});

describe("EXPERT shared offset primitives and virtual attempts", () => {
  it.each([
    [1, 1, 0, 0.499, -45], [1, 1, 1, 0.5, 57], [5, 1, 0.25, 0.75, 39.75],
    [1, 1.5, 0.25, 0.75, 30], [8, 1.5, 0.5, 0.1, -21.5],
    [1, 2, 0.25, 0.75, 12], [5, 20, 0.9, 0.1, -6], [12, 2, 0.25, 0.75, 0],
  ])("reserves amplitude/side for round %s attempt %s, including the plateau", (round, attempt, amplitude, side, offset) => {
    const memory = { currentTargetId: "A", currentTargetAttempts: attempt - 1, lastRoundNumber: round };
    const before = { ...memory };
    const rng = vi.spyOn(random, "secureRandom").mockReturnValueOnce(amplitude).mockReturnValueOnce(side);
    const aim = createExpertDecisionAim(memory, round);
    expect(rng).not.toHaveBeenCalled();
    aim.reserve();
    expect(aim.forTarget("A")).toEqual({ primaryTargetId: "A", attempts: attempt, offset });
    aim.reserve();
    aim.forTarget("A");
    expect(rng).toHaveBeenCalledTimes(2);
    expect(memory).toEqual(before);
  });

  it("interpole le deuxième tir avec un seuil explicite de trois, avec seulement deux tirages", () => {
    const calculate = fallibleAim.calculateImpactOffsetMagnitude;
    vi.spyOn(fallibleAim, "calculateImpactOffsetMagnitude").mockImplementation(
      (attempts, profile, round, amplitude) => calculate(attempts, profile, round, amplitude, 3),
    );
    const memory = { currentTargetId: "A", currentTargetAttempts: 1, lastRoundNumber: 1 };
    const rng = vi.spyOn(random, "secureRandom").mockReturnValueOnce(0.25).mockReturnValueOnce(0.75);
    const aim = createExpertDecisionAim(memory, 1);
    expect(aim.forTarget("A")).toEqual({ primaryTargetId: "A", attempts: 2, offset: 30 });
    expect(aim.forTarget("B")).toEqual({ primaryTargetId: "B", attempts: 1, offset: 48 });
    expect(aim.forTarget("A").offset).toBe(30);
    expect(rng).toHaveBeenCalledTimes(2);
    expect(memory).toEqual({ currentTargetId: "A", currentTargetAttempts: 1, lastRoundNumber: 1 });
    expect(fallibleAim.SHOTS_TO_HIT["v4-smart"]).toBe(2);
  });

  it("shares distinct primitives between converged A and new B without mutating either attempt", () => {
    const memory = { currentTargetId: "A", currentTargetAttempts: 1, lastRoundNumber: 1 };
    const rng = vi.spyOn(random, "secureRandom").mockReturnValueOnce(0.25).mockReturnValueOnce(0.75);
    const aim = createExpertDecisionAim(memory, 1);
    expect(aim.forTarget("A")).toMatchObject({ attempts: 2, offset: 12 });
    memory.currentTargetAttempts = 99; // The decision keeps its immutable memory snapshot.
    expect(aim.forTarget("B")).toMatchObject({ attempts: 1, offset: 48 });
    expect(aim.forTarget("A")).toMatchObject({ attempts: 2, offset: 12 });
    expect(rng).toHaveBeenCalledTimes(2);
    expect(createExpertDecisionAim(memory, 2).forTarget("A").attempts).toBe(1);
  });

  it.each([true, false])("rolls SURVIE first and uses the pair's weaker primary through the phases (survival=%s)", (survival) => {
    const f = fixture();
    const other = makePlayer({ id: "other", tank: makeTank("other", 450, 336, { health: 1 }) });
    f.state.players.push(other);
    const memory = { currentTargetId: "other", currentTargetAttempts: 1, lastRoundNumber: 1 };
    const rng = vi.spyOn(random, "secureRandom").mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.25).mockReturnValueOnce(0.75);
    const evaluate: typeof evaluator.evaluateExpertShot = (_s, _t, shooter, _weapon, targets, requireKill, _first, _cache, context) => {
      if (context?.mode === "adverse") {
        expect(rng).not.toHaveBeenCalled();
        return shooter.id === "target" ? valid(["self"]) : invalid;
      }
      expect(rng).toHaveBeenCalledTimes(3);
      expect(context).toEqual({ mode: "own", selectionPolicy: requireKill ? "SURVIE" : "OPTIMISER_PROFIT",
        aim: { primaryTargetId: targets.length === 2 || targets[0].id === "other" ? "other" : "target",
        attempts: targets.length === 2 || targets[0].id === "other" ? 2 : 1,
        offset: targets.length === 2 || targets[0].id === "other" ? 12 : 48 } });
      // Mandatory victim remains the threat, independently of the primary target.
      if (requireKill) { expect(targets[0].id).toBe("target"); return survival && targets.length === 2 ? valid(["target"], -20) : invalid; }
      return targets.length === 2 ? valid([], 20) : invalid;
    };
    const trace = vi.fn();
    const plan = planner.chooseExpertPlan(f.self, f.state, f.terrain, createExpertDecisionAim(memory, 1),
      evaluate, trace, evaluator.createExpertForecastCache());
    expect(plan).toMatchObject({ primaryTargetId: "other", attempts: 2, offset: 12 });
    expect(trace.mock.calls[0][0]).toMatchObject({ phase: survival ? "SURVIE" : "OPTIMISER_PROFIT",
      survivalRoll: 0.1, survivalCandidateCount: survival ? 1 : 0 });
    if (survival) expect(trace.mock.calls[0][0].selected.destroyedIds).toEqual(["target"]);
    expect(memory).toEqual({ currentTargetId: "other", currentTargetAttempts: 1, lastRoundNumber: 1 });
  });
});

describe("EXPERT real decision budgets after offset", () => {
  it.each([true, false])("keeps four-player full-stock decisions deterministic with boundaries and mixed attempts (economics=%s)", async (economics) => {
    const f = fixture();
    const stock = { GRENADE: 2, CLUSTER: 2, NUKE: 2, THERMONUCLEAR: 2, DRILLER: 2, BULLET: 2, BULLDOZER: 2 };
    f.self.inventory = { ...stock };
    f.target.inventory = { ...stock };
    f.state.players.push(makePlayer({ id: "third", isHuman: false, aiProfile: "v3-sniper",
      tank: makeTank("third", 550, 336), inventory: { ...stock } }),
    makePlayer({ id: "fourth", isHuman: false, aiProfile: "v2-heuristic",
      tank: makeTank("fourth", 700, 336), inventory: { ...stock } }));
    f.terrain.setMaterialRange(390, 409, TERRAIN_MATERIAL.ROCK);
    f.terrain.setMaterialRange(540, 559, TERRAIN_MATERIAL.SOFT);
    f.state.localShotContext = economics ? { playerCountAtMatchStart: 4, isFirstShotOfRound: false } : undefined;
    const before = structuredClone(f.state);
    const heights = [...f.terrain.getHeightmap()];
    const materials = [...f.terrain.getMaterials()];
    const choose = vi.spyOn(planner, "chooseExpertPlan");
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const run = async () => {
      const strategy = new AISmartStrategy();
      const memories = (strategy as unknown as { memories: Map<string, aimMemory.AimMemory> }).memories;
      memories.set("self", { currentTargetId: "target", currentTargetAttempts: 1, lastRoundNumber: 1 });
      const start = performance.now();
      const shot = await strategy.executeTurn("self", f.state, f.terrain);
      expect(performance.now() - start).toBeLessThan(10_000);
      const cache = choose.mock.lastCall![6]!;
      expect(cache.diagnostics!.ownProposals).toBeLessThanOrEqual(economics ? 1512 : 48);
      expect(cache.physics.size).toBeLessThanOrEqual(cache.search.size);
      return { shot, searches: cache.search.size, physics: cache.physics.size, diagnostics: { ...cache.diagnostics } };
    };
    const first = await run();
    f.self.tank.currentWeapon = before.players[0].tank.currentWeapon;
    expect(await run()).toEqual(first);
    // The only lethal threats here were nuclear: no SURVIE roll remains (#287).
    // Each decision still draws amplitude, side and the ordinary gaffe check.
    expect(rng).toHaveBeenCalledTimes(6);
    f.self.tank.currentWeapon = before.players[0].tank.currentWeapon;
    expect(f.state).toEqual(before);
    expect([...f.terrain.getHeightmap()]).toEqual(heights);
    expect([...f.terrain.getMaterials()]).toEqual(materials);
  }, 10_000);
});

describe("EXPERT evaluated command transport in DEV and production", () => {
  it("retains a suicidal but admissible main plan as the last profit choice without opening fallback", async () => {
    const f = fixture();
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    vi.spyOn(evaluator, "evaluateExpertShot").mockImplementation((_s, _t, shooter) =>
      shooter.id === "self" ? valid(["self"], 100) : invalid);
    const fallback = vi.spyOn(evaluator, "chooseExpertFallback");
    const shot = await new AISmartStrategy().executeTurn("self", f.state, f.terrain);
    expect(shot).toEqual({ ...selectedAim.command, weaponId: "MISSILE" });
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each([true, false])("shares offset through every failed phase to the last ordinary MISSILE (economics=%s)", async (economics) => {
    const f = fixture();
    if (!economics) delete f.state.localShotContext;
    const values = [...(economics ? [0.1] : []), 0.25, 0.75, 0.99];
    const rng = vi.spyOn(random, "secureRandom").mockImplementation(() => values.shift() ?? 0.99);
    const evaluate = vi.spyOn(evaluator, "evaluateExpertShot").mockImplementation((_s, _t, shooter) =>
      shooter.id === "self" ? invalid : valid(["self"]));
    const fallback = vi.spyOn(evaluator, "chooseExpertFallback");
    vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue({ complete: false,
      survivors: [], hits: [], damage: [], destruction: [], support: [], steps: 2400 });
    const search = vi.spyOn(ballistics, "searchBallisticSolution").mockReturnValue({ angle: 65.54, power: 55.5224609375, err: 999, complete: false });
    const record = vi.spyOn(aimMemory, "recordAimAttempt");
    const shot = await new AISmartStrategy().executeTurn("self", f.state, f.terrain);
    expect(shot).toEqual({ ...selectedAim.command, weaponId: "MISSILE" });
    expect(fallback).toHaveBeenCalledOnce();
    expect(fallback.mock.calls[0][6]).toEqual({ primaryTargetId: "target", attempts: 1, offset: 48 });
    if (economics) {
      expect(evaluate.mock.calls.filter((args) => args[8]?.mode === "own").map((args) => args[8]))
        .toEqual(["SURVIE", "OPTIMISER_PROFIT"].map((selectionPolicy) => ({ mode: "own", selectionPolicy,
          aim: { primaryTargetId: "target", attempts: 1, offset: 48 } })));
    } else expect(evaluate).not.toHaveBeenCalled();
    expect(search.mock.lastCall?.[0]).toMatchObject({ tx: 448, ty: 330, aMin: 15, aMax: 85 });
    expect(search.mock.calls.filter(([config]) => config.selfHarmPenalty)).toHaveLength(1);
    expect(record).toHaveBeenCalledOnce();
    expect(rng).toHaveBeenCalledTimes(economics ? 4 : 3);
    expect(values).toEqual([]);
    const trace = JSON.parse(String(vi.mocked(console.info).mock.calls[0][1])) as { realAim: { choiceKind: string; predictedCommand?: object } };
    expect(trace.realAim.choiceKind).toBe("ordinary");
    expect(trace.realAim.predictedCommand).toBeUndefined();
  });

  it.each([true, false])("fires the exact normalized simulation without another search (DEV=%s)", async (dev) => {
    vi.stubEnv("DEV", dev);
    const f = fixture();
    f.self.inventory.NUKE = 1;
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const log = vi.mocked(console.info);
    const strategy = new AISmartStrategy();
    // Let the first free shot establish aim memory; the second has a useful main forecast.
    await strategy.executeTurn("self", f.state, f.terrain);
    rng.mockClear();
    log.mockClear();
    const search = vi.spyOn(ballistics, "searchBallisticSolution");
    const choose = vi.spyOn(planner, "chooseExpertPlan");
    const record = vi.spyOn(aimMemory, "recordAimAttempt");
    const shot = await strategy.executeTurn("self", f.state, f.terrain);
    const plan = choose.mock.results[0].value as planner.ExpertPlan;
    expect(plan.kind).toBe("evaluated");
    expect(shot).toEqual({ ...plan.command, weaponId: plan.weaponId });
    expect(search.mock.calls).toHaveLength(choose.mock.calls[0][6]!.search.size);
    expect(rng).toHaveBeenCalledTimes(3); // amplitude, side, gaffe; no lethal threat here.
    expect(record).toHaveBeenCalledExactlyOnceWith(expect.any(Object), plan.primaryTargetId);
    if (dev) {
      const trace = JSON.parse(String(log.mock.calls[0][1])) as {
        selected: { predictedCommand: object }; realAim: { predictedCommand: object; finalCommand: object };
      };
      expect(trace.selected.predictedCommand).toEqual(plan.command);
      expect(trace.realAim.predictedCommand).toEqual(plan.command);
      expect(trace.realAim.finalCommand).toEqual(plan.command);
    } else expect(log).not.toHaveBeenCalled();
  });

  it.each(["reaction", "gaffe", "both"] as const)("normalizes once from the retained raw command after %s", async (perturbation) => {
    const f = fixture();
    if (perturbation !== "gaffe") f.self.tank.hitReaction = { wasDirectHit: true, fallDistance: 0 };
    vi.spyOn(planner, "chooseExpertPlan").mockReturnValue({ ...selectedAim, weaponId: "MISSILE", point: { x: 400, y: 328.5 } });
    const values = [...(perturbation !== "gaffe" ? [0.1, 0.1] : []),
      perturbation === "reaction" ? 0.99 : 0, ...(perturbation !== "reaction" ? [0.75, 0.75] : [])];
    const rng = vi.spyOn(random, "secureRandom").mockImplementation(() => values.shift() ?? 0.99);
    const shot = await new AISmartStrategy().executeTurn("self", f.state, f.terrain);
    const expected = finalizeAdvancedAim({ angle: 65.54 - (perturbation !== "gaffe" ? 1 : 0) + (perturbation !== "reaction" ? 10 : 0),
      power: 55.5224609375 - (perturbation !== "gaffe" ? 0.5 : 0) + (perturbation !== "reaction" ? 5 : 0) });
    expect(shot).toEqual({ ...expected, weaponId: "MISSILE" });
    if (perturbation === "reaction") expect(shot.power).toBe(55); // Rounding 56 first would incorrectly give 56.
    expect(rng).toHaveBeenCalledTimes(perturbation === "both" ? 5 : 3);
    expect(f.self.tank.hitReaction).toEqual(perturbation === "gaffe" ? undefined : { wasDirectHit: false, fallDistance: 0 });
    expect(values).toEqual([]);
  });
});

describe("EXPERT offset geometry and proposal-specific caches", () => {
  it.each([true, false])("validates offset BULLDOZER only in fallback, with profit null absent economics (%s)", (economics) => {
    const f = fixture();
    if (!economics) delete f.state.localShotContext;
    f.self.inventory.BULLDOZER = 1;
    vi.spyOn(physical, "resolvePhysicalShot").mockImplementation((_s, _t, _self, weapon) =>
      complete({ survivors: weapon === "BULLDOZER" ? ["self"] : ["target"],
        destruction: [{ shotId: 1, shooterId: "self", victimId: "target", weaponId: weapon, cause: "out-of-bounds" }] }));
    const search = vi.spyOn(ballistics, "searchBallisticSolution").mockReturnValue({ angle: 45, power: 60, err: 0, complete: true });
    const aim = { primaryTargetId: "target", attempts: 1, offset: 50 };
    const choice = evaluator.chooseExpertFallback(f.state, f.terrain, f.self, f.target, "BULLDOZER", evaluator.createExpertForecastCache(), aim);
    expect(choice).toMatchObject({ kind: "evaluated", weaponId: "BULLDOZER", useful: true, requestedPoint: { x: 450, y: 328.5 } });
    expect(choice.forecast?.profit === null).toBe(!economics);
    expect(search.mock.calls.filter(([config]) => config.weaponId === "BULLDOZER")).toHaveLength(3);
    expect(evaluator.evaluateExpertShot(f.state, f.terrain, f.self, "BULLDOZER", [f.target], false, false,
      evaluator.createExpertForecastCache(), { mode: "own", aim }).destination).toBe(-1);
  });

  it.each([[0, 28, true], [0, 28.001, false], [16.8, 22.4, true], [50, 0, false]])(
    "keeps the inclusive Euclidean filter at the original point (%s,%s)", (dx, dy, accepted) => {
      const f = fixture();
      f.state.players.push(makePlayer({ id: "collateral", tank: makeTank("collateral", 440, 336) }));
      vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(complete({
        hits: [{ shotId: 1, munitionId: 0, x: 386 + dx, y: 336 + dy, weaponId: "MISSILE" }],
        destruction: [{ shotId: 1, shooterId: "self", victimId: "collateral", weaponId: "MISSILE", cause: "health-zero" }],
      }));
      vi.spyOn(ballistics, "searchBallisticSolution").mockImplementation(({ tx, ty }) => ({
        angle: 45, power: 60, err: 0, complete: tx === 436 && ty === 336,
      }));
      const result = evaluator.evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [f.target], false, false,
        evaluator.createExpertForecastCache(), { mode: "own", aim: selectedAim });
      expect(evaluator.isValidExpertShot(result)).toBe(accepted);
    });

  it.each([-50, -300, 500])("keeps Y and unclamped X for all material points/arcs (offset=%s)", (offset) => {
    const f = fixture();
    f.target.tank.position.x = 140;
    f.terrain.setMaterialRange(135, 145, TERRAIN_MATERIAL.SOFT);
    const search = vi.spyOn(ballistics, "searchBallisticSolution").mockReturnValue({ angle: 45, power: 50, err: 0, complete: false });
    const aim = { primaryTargetId: "target", attempts: 1, offset };
    evaluator.evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [f.target], false, false,
      evaluator.createExpertForecastCache(), { mode: "own", aim });
    const points = evaluator.expertTacticalPoints(f.self, [f.target], "MISSILE", f.terrain, f.state.players, "own");
    expect(search).toHaveBeenCalledTimes(points.length * 3);
    for (const [index, point] of points.entries()) {
      const configs = search.mock.calls.slice(index * 3, index * 3 + 3).map(([config]) => config);
      expect(configs.map(({ tx, ty }) => ({ x: tx, y: ty }))).toEqual(Array(3).fill({ x: point.x + offset, y: point.y }));
      const right = point.x + offset > 100;
      expect(configs.map(({ aMin, aMax }) => [aMin, aMax])).toEqual(right ? [[15, 85], [15, 50], [50, 85]] : [[95, 165], [130, 165], [95, 130]]);
    }
  });

  it("uses the left cone at equal shooter/requested X", () => {
    const f = fixture();
    const search = vi.spyOn(ballistics, "searchBallisticSolution").mockReturnValue({ angle: 135, power: 50, err: 0, complete: false });
    solveExpertAim(f.self, 100, 328.5, 0, 260, f.terrain, "MISSILE", { variant: "low", penalizeProximity: false });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ isRight: false, aMin: 130, aMax: 165 }));
  });

  it.each([[28, 1], [28.001, 2], [0, 1]])("rechecks original radial filters around shared physics at distance %s", async (distance, pointOrder) => {
    const f = fixture();
    f.state.players.push(makePlayer({ id: "collateral", tank: makeTank("collateral", 440, 336) }));
    const resolve = vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(complete({
      hits: [{ shotId: 1, munitionId: 0, x: 386 + distance, y: 336, weaponId: "MISSILE" }],
      damage: [{ shotId: 1, munitionId: 0, shooterId: "self", victimId: "collateral", weaponId: "MISSILE",
        source: "projectile", classification: "indirect", shieldLostMilli: 0, shieldAbsorbedMilli: 0, healthDamageMilli: 1000 }],
    }));
    vi.spyOn(ballistics, "searchBallisticSolution").mockImplementation(({ tx }) => ({ angle: 45.02,
      power: tx === 464 ? 55.5224609375 : 56.4, err: 0, complete: true }));
    const cache = evaluator.createExpertForecastCache();
    const result = evaluator.evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [f.target], false, false, cache,
      { mode: "own", aim: selectedAim });
    expect(result).toMatchObject({ pointOrder, command: { angle: 45, power: 56 },
      rawCommand: { power: pointOrder === 2 ? 55.5224609375 : 56.4 } });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(cache.search.size).toBe(9);
    if (pointOrder === 2 && evaluator.isValidExpertShot(result)) {
      expect(result.requestedPoint).toEqual({ x: 464, y: 336 });
      expect(result.destination).toEqual({ x: 414, y: 336, kind: "terrain" });
      vi.spyOn(planner, "chooseExpertPlan").mockReturnValue({ ...result, weaponId: "MISSILE", point: result.destination });
      f.self.tank.hitReaction = { wasDirectHit: true, fallDistance: 0 };
      vi.spyOn(random, "secureRandom").mockReturnValueOnce(0.1).mockReturnValueOnce(0.1).mockReturnValue(0.99);
      expect(await new AISmartStrategy().executeTurn("self", f.state, f.terrain))
        .toEqual({ angle: 44, power: 55, weaponId: "MISSILE" });
      // The earlier raw 56.4 command would produce power 56 after the same reaction.
    }
  });

  it.each([true, false])("performs only one uncertified last MISSILE search after incomplete proposals (complete=%s)", (lastComplete) => {
    const f = fixture();
    delete f.state.localShotContext;
    const search = vi.spyOn(ballistics, "searchBallisticSolution").mockImplementation(({ selfHarmPenalty }) => ({
      angle: 55.54, power: 60.49, err: 999, complete: selfHarmPenalty ? lastComplete : false,
    }));
    const resolve = vi.spyOn(physical, "resolvePhysicalShot");
    const choice = evaluator.chooseExpertFallback(f.state, f.terrain, f.self, f.target, "MISSILE", evaluator.createExpertForecastCache(), selectedAim);
    expect(choice).toMatchObject({ kind: "ordinary", searchComplete: lastComplete, command: { angle: 55.5, power: 60 },
      point: { x: 400, y: 330 }, requestedPoint: { x: 450, y: 330 }, policy: ORDINARY_AIM_POLICY });
    expect(choice.forecast).toBeUndefined();
    expect(search).toHaveBeenCalledTimes(10);
    expect(search.mock.calls.filter(([config]) => config.selfHarmPenalty !== undefined)).toHaveLength(1);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("EXPERT NUKE on ROCK after offset", () => {
  it("rejects an ideal direct kill that becomes indirect and nonlethal after the first offset", () => {
    const f = fixture();
    f.self.inventory.NUKE = 1;
    f.target.tank.shield = 100;
    f.target.tank.health = 50;
    f.terrain.setMaterialRange(0, 799, TERRAIN_MATERIAL.ROCK);
    const point = { x: 400, y: 328.5 };
    const ideal = evaluator.forecastPhysicalShot(f.state, f.terrain, f.self, "NUKE",
      finalizeAdvancedAim(solveExpertAim(f.self, point.x, point.y, 0, 260, f.terrain, "NUKE").command), false);
    const shifted = evaluator.forecastPhysicalShot(f.state, f.terrain, f.self, "NUKE",
      finalizeAdvancedAim(solveExpertAim(f.self, point.x + 49.0234363384, point.y, 0, 260, f.terrain, "NUKE").command), false);
    expect(ideal.complete).toBe(true);
    expect(ideal.destruction.map(({ victimId }) => victimId)).toContain("target");
    expect(shifted.complete).toBe(true);
    expect(shifted.hits.some(({ directTargetId }) => directTargetId === "target")).toBe(false);
    expect(shifted.survivors).toContain("target");
    expect(shifted.damage).toContainEqual(expect.objectContaining({ victimId: "target", classification: "indirect", healthDamageMilli: 0 }));
    // Isolate the bad post-offset full arc, rather than forbidding a different safe proposal.
    const realSearch = ballistics.searchBallisticSolution;
    const search = vi.spyOn(ballistics, "searchBallisticSolution").mockImplementation((config) => ({
      ...realSearch(config), complete: config.tx === point.x + 49.0234363384 && config.ty === point.y && config.aMin === 15 && config.aMax === 85,
    }));
    const cache = evaluator.createExpertForecastCache();
    const aim = { primaryTargetId: "target", attempts: 1, offset: 49.0234363384 };
    const result = evaluator.evaluateExpertShot(f.state, f.terrain, f.self, "NUKE", [f.target], true, false, cache, { mode: "own", aim });
    expect(result.destination).toBe(-1);
    search.mockRestore();
    const safe = evaluator.evaluateExpertShot(f.state, f.terrain, f.self, "NUKE", [f.target], true, false,
      evaluator.createExpertForecastCache(), { mode: "own", aim });
    expect(evaluator.isValidExpertShot(safe)).toBe(true);
    if (!evaluator.isValidExpertShot(safe)) throw new Error("Expected a complete alternative");
    expect(safe.command).not.toEqual(finalizeAdvancedAim(solveExpertAim(f.self, point.x + aim.offset, point.y, 0, 260, f.terrain, "NUKE").command));
    expect(safe.forecast).toEqual(evaluator.forecastPhysicalShot(f.state, f.terrain, f.self, "NUKE", safe.command, false));
    expect(safe.destroyedIds.has("target")).toBe(true);
    expect(safe.shooterDestroyed).toBe(false);
    expect(safe.profit).toBeLessThan(0); // The NUKE price is still charged in SURVIE.
  });
});
