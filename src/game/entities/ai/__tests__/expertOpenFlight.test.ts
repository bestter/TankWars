import { afterEach, describe, expect, it, vi } from "vitest";
import { flatTerrain, makePlayer, makeTank } from "../../../__tests__/helpers";
import type { GameState } from "../../../../types/game";
import type { WeaponId } from "../../../../types/weapon";
import {
  BALLISTICS_MAX_STEPS,
  EXPERT_OWN_OPEN_FLIGHT_MAX_STEPS,
  simulateDirectBulldozerTrajectory,
} from "../BallisticsSimulator";
import * as ballistics from "../BallisticsSimulator";
import { aimSearchPolicyCacheToken } from "../aimSearch";
import { solveExpertAim } from "../expertAim";
import { solveHeuristicAim } from "../heuristicShot";
import { solveSniperAim } from "../sniperAim";
import type { ExpertTargetAim } from "../expertDecisionAim";
import {
  chooseExpertFallback,
  createExpertForecastCache,
  evaluateExpertShot,
} from "../expertShotEvaluator";

const aim: ExpertTargetAim = { primaryTargetId: "enemy", attempts: 0, offset: 0 };

function fixture() {
  const terrain = flatTerrain(800, 480);
  const self = makePlayer({ id: "self", isHuman: false, aiProfile: "v4-smart",
    tank: makeTank("self", 100, 336), inventory: {} });
  const enemy = makePlayer({ id: "enemy", isHuman: true,
    tank: makeTank("enemy", 400, 336), inventory: {} });
  const state: GameState = { phase: "COMBAT", players: [self, enemy], currentPlayerIndex: 0,
    turn: 2, roundNumber: 1, windForce: 0, gravity: 260,
    localShotContext: { playerCountAtMatchStart: 2, isFirstShotOfRound: false } };
  return { terrain, self, enemy, state };
}

function forecast(profit: number, healthDamageMilli: number) {
  return {
    complete: true as const,
    survivors: ["self", "enemy"],
    hits: [{ shotId: 1, munitionId: 0, x: 400, y: 330, weaponId: "MISSILE" as WeaponId, directTargetId: "enemy" }],
    damage: [{ shotId: 1, munitionId: 0, shooterId: "self", victimId: "enemy", weaponId: "MISSILE" as WeaponId,
      source: "projectile" as const, classification: "direct" as const, shieldAbsorbedMilli: 0,
      shieldLostMilli: 0, healthDamageMilli }],
    destruction: [],
    support: [],
    steps: profit === 80 ? 900 : 40,
    humanDestroyedCount: 0,
    humanDamageMilli: healthDamageMilli,
    aiDestroyedCount: 0,
    aiDamageMilli: 0,
    profit,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("EXPERT own-shot open flight #361", () => {
  it("ranks a long resolved shot with another useful proposal and drops a truncated one", () => {
    const f = fixture();
    const cache = createExpertForecastCache(true);
    const short = forecast(10, 1_000);
    const long = forecast(80, 5_000);
    cache.physics.set(JSON.stringify(["self", "MISSILE", 40, 45, 0, 260, 2, false]), short);
    cache.physics.set(JSON.stringify(["self", "MISSILE", 80, 70, 0, 260, 2, false]), long);
    const search = vi.spyOn(ballistics, "searchBallisticSolution").mockImplementation((config) => {
      expect(config.maxSteps).toBe(EXPERT_OWN_OPEN_FLIGHT_MAX_STEPS);
      const turn = search.mock.calls.length;
      if (turn % 3 === 1) return { angle: 12, power: 20, err: 0, complete: false };
      if (turn % 3 === 2) return { angle: 40, power: 45, err: 3, complete: true };
      return { angle: 80, power: 70, err: 1, complete: true };
    });

    const result = evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [f.enemy], false, false, cache, {
      mode: "own", aim, selectionPolicy: "OPTIMISER_PROFIT",
    });

    expect(search.mock.calls.length).toBeGreaterThan(1);
    expect(result).toMatchObject({ command: { angle: 80, power: 70 }, profit: 80 });
    const statuses = cache.diagnostics?.proposals.map((proposal) => proposal.status) ?? [];
    expect(statuses).toContain("search-incomplete");
    expect(statuses).toContain("ranked-candidate");
  });

  it("reports an unsuccessful search when every own trajectory stays incomplete", () => {
    const f = fixture();
    const cache = createExpertForecastCache(true);
    const search = vi.spyOn(ballistics, "searchBallisticSolution")
      .mockReturnValue({ angle: 55, power: 60, err: 999999, complete: false });
    const choice = chooseExpertFallback(f.state, f.terrain, f.self, f.enemy, "MISSILE", cache, aim);
    const budgets = search.mock.calls.map(([config]) => config.maxSteps);
    const statuses = cache.diagnostics?.proposals.map((proposal) => proposal.status) ?? [];

    expect(choice).toMatchObject({ kind: "ordinary", searchComplete: false,
      selectionReason: "dernier MISSILE ordinaire non certifié" });
    expect(budgets.some((budget) => budget === EXPERT_OWN_OPEN_FLIGHT_MAX_STEPS)).toBe(true);
    expect(budgets.at(-1)).toBe(BALLISTICS_MAX_STEPS);
    expect(statuses).toContain("search-incomplete");
    expect(statuses.at(-1)).toBe("uncertified-ordinary-fallback");
  });

  it("keeps the 420-step budget for the advisor, threats, other profiles and direct BULLDOZER", () => {
    const f = fixture();
    const search = vi.spyOn(ballistics, "searchBallisticSolution")
      .mockReturnValue({ angle: 45, power: 50, err: 1, complete: false });
    solveSniperAim(f.self, 400, 330, 0, 260, f.terrain, "MISSILE");
    solveHeuristicAim(f.self, 400, 330, 0, 260, f.terrain, "MISSILE");
    solveExpertAim(f.self, 400, 330, 0, 260, f.terrain, "MISSILE");
    evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [f.enemy], false, false,
      createExpertForecastCache(), { mode: "adverse" });
    evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [f.enemy], false, false,
      createExpertForecastCache(), { mode: "own", aim, selectionPolicy: "OPTIMISER_PROFIT",
        advisor: { objective: "OPTIMISER_PROFIT" } });
    expect(search.mock.calls.every(([config]) => config.maxSteps !== EXPERT_OWN_OPEN_FLIGHT_MAX_STEPS)).toBe(true);

    search.mockClear();
    evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [f.enemy], false, false,
      createExpertForecastCache(), { mode: "own", aim, selectionPolicy: "OPTIMISER_PROFIT" });
    expect(search.mock.calls.length).toBeGreaterThan(0);
    expect(search.mock.calls.every(([config]) => config.maxSteps === EXPERT_OWN_OPEN_FLIGHT_MAX_STEPS)).toBe(true);
    expect(simulateDirectBulldozerTrajectory({
      shooter: f.self, target: f.enemy, players: [f.self, f.enemy],
      terrain: f.terrain, wind: 0, gravity: 0,
    }, { angle: 90, power: 25 })).toMatchObject({ terminal: "incomplete", steps: BALLISTICS_MAX_STEPS });
  });

  it("ne réutilise pas une solution à 600 pas quand la politique équivaut à 420", () => {
    const extended = aimSearchPolicyCacheToken({
      penalizeProximity: false, extendOpenFlight: true, variant: "full",
    });
    const ordinary = aimSearchPolicyCacheToken({ penalizeProximity: false, variant: "full" });
    expect(extended).toEqual({ variant: "full", penalizeProximity: false, extendOpenFlight: true });
    expect(ordinary).toEqual({ variant: "full", penalizeProximity: false, extendOpenFlight: false });
    expect(JSON.stringify(extended)).toBe(JSON.stringify(
      aimSearchPolicyCacheToken({ variant: "full", extendOpenFlight: true, penalizeProximity: false })));

    const f = fixture();
    const search = vi.spyOn(ballistics, "searchBallisticSolution")
      .mockReturnValue({ angle: 45, power: 50, err: 1, complete: false });
    const cache = createExpertForecastCache();
    const own = { mode: "own" as const, aim, selectionPolicy: "OPTIMISER_PROFIT" as const };
    evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [f.enemy], false, false, cache, own);
    const ownCalls = search.mock.calls.length;
    const ownKeys = new Set(cache.search.keys());
    expect(ownCalls).toBeGreaterThan(0);
    expect(search.mock.calls.every(([config]) => config.maxSteps === EXPERT_OWN_OPEN_FLIGHT_MAX_STEPS)).toBe(true);
    expect([...ownKeys].every((key) => key.includes('"extendOpenFlight":true'))).toBe(true);

    search.mockClear();
    evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [f.enemy], false, false, cache, own);
    expect(search).not.toHaveBeenCalled();

    search.mockClear();
    evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [f.enemy], false, false, cache, {
      ...own, advisor: { objective: "OPTIMISER_PROFIT" },
    });
    const advisorKeys = [...cache.search.keys()].filter((key) => !ownKeys.has(key));
    expect(search.mock.calls.length).toBe(ownCalls);
    expect(search.mock.calls.every(([config]) => config.maxSteps === BALLISTICS_MAX_STEPS)).toBe(true);
    expect(advisorKeys).toHaveLength(ownKeys.size);
    expect(advisorKeys.every((key) => key.includes('"extendOpenFlight":false'))).toBe(true);
  });
});
