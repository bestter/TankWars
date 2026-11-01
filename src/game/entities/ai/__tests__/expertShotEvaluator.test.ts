import { describe, expect, it, vi, afterEach } from "vitest";
import { flatTerrain, makePlayer, makeTank } from "../../../__tests__/helpers";
import * as evaluator from "../expertShotEvaluator";
import type { GameState } from "../../../../types/game";
import * as physical from "../physicalShotForecast";
import * as rewards from "../../../economy/shotRewards";

afterEach(() => {
  vi.restoreAllMocks();
});

function fixture() {
  const terrain = flatTerrain(800, 480);
  const self = makePlayer({ id: "self", isHuman: false, aiProfile: "v4-smart", tank: makeTank("self", 100, 336), inventory: { MISSILE: 99, DRILLER: 5, GRENADE: 5, NUKE: 2 } });
  const target = makePlayer({ id: "target", isHuman: true, tank: makeTank("target", 400, 336), inventory: {} });
  const state: GameState = { phase: "COMBAT", players: [self, target], currentPlayerIndex: 0, turn: 2, roundNumber: 1, windForce: 0, gravity: 260, localShotContext: { playerCountAtMatchStart: 2, isFirstShotOfRound: true } };
  return { terrain, self, target, state };
}

describe("evaluateExpertShot", () => {
  it("rejects BULLDOZER weapon", () => {
    const f = fixture();
    const cache = evaluator.createExpertForecastCache();
    const result = evaluator.evaluateExpertShot(f.state, f.terrain, f.self, "BULLDOZER", [f.target], false, false, cache);
    expect(evaluator.isValidExpertShot(result)).toBe(false);
  });

  it("rejects empty inventory (non-MISSILE)", () => {
    const f = fixture();
    const cache = evaluator.createExpertForecastCache();
    f.self.inventory.DRILLER = 0;
    const result = evaluator.evaluateExpertShot(f.state, f.terrain, f.self, "DRILLER", [f.target], false, false, cache);
    expect(evaluator.isValidExpertShot(result)).toBe(false);
  });

  it("rejects if no localShotContext", () => {
    const f = fixture();
    const cache = evaluator.createExpertForecastCache();
    delete f.state.localShotContext;
    const result = evaluator.evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [f.target], false, false, cache);
    expect(evaluator.isValidExpertShot(result)).toBe(false);
  });

  it("rejects invalid target lengths", () => {
    const f = fixture();
    const cache = evaluator.createExpertForecastCache();

    // 0 targets
    expect(evaluator.isValidExpertShot(evaluator.evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [], false, false, cache))).toBe(false);

    // 3 targets
    const target2 = makePlayer({ id: "target2", isHuman: true, tank: makeTank("target2", 500, 336), inventory: {} });
    const target3 = makePlayer({ id: "target3", isHuman: true, tank: makeTank("target3", 600, 336), inventory: {} });
    expect(evaluator.isValidExpertShot(evaluator.evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [f.target, target2, target3], false, false, cache))).toBe(false);
  });

  it("rejects DRILLER on ROCK in own mode", () => {
    const f = fixture();
    const cache = evaluator.createExpertForecastCache();
    f.terrain.setMaterialRange(300, 500, "ROCK");
    const result = evaluator.evaluateExpertShot(f.state, f.terrain, f.self, "DRILLER", [f.target], false, false, cache, { mode: "own", aim: { kind: "tank", currentTargetAttempts: 0, primaryTargetId: "target", attempts: 1, offset: 0 } as unknown as evaluator.ExpertEvaluatedAim });
    expect(evaluator.isValidExpertShot(result)).toBe(false);
  });
});

describe("evaluateExpertShot evaluation loops", () => {
  const aim = { primaryTargetId: "target", attempts: 1, offset: 0, kind: "tank", currentTargetAttempts: 0 } as unknown as evaluator.ExpertEvaluatedAim;

  it("filters out missing enemy effects", () => {
    const f = fixture();
    const cache = evaluator.createExpertForecastCache();

    vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue({
      complete: true,
      survivors: ["self", "target"],
      hits: [{ x: 400, y: 336, directTargetId: "target", shotId: physical.FORECAST_SHOT_ID, munitionId: 0, weaponId: "NUKE" }],
      damage: [], // NO DAMAGE
      destruction: [],
      humanDestroyedCount: 0,
      humanDamageMilli: 0,
      aiDestroyedCount: 0,
      aiDamageMilli: 0,
      steps: 1,
      support: []
    } as unknown as physical.DecisionForecast);

    vi.spyOn(rewards, "calculateShotRewards").mockReturnValue({
      awards: [{ playerId: "self", amount: 500, components: [] }],
      humanDestroyedCount: 0,
      aiDestroyedCount: 0,
      humanDamageMilli: 0,
      aiDamageMilli: 0,
      netProfit: 500
    });

    const result = evaluator.evaluateExpertShot(f.state, f.terrain, f.self, "NUKE", [f.target], false, false, cache, { mode: "own", aim });
    expect(evaluator.isValidExpertShot(result)).toBe(false);
  });

  it("requires target destruction when requireTargetDestruction is true", () => {
    const f = fixture();
    const cache = evaluator.createExpertForecastCache();

    let callCount = 0;
    vi.spyOn(physical, "resolvePhysicalShot").mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          complete: true,
          survivors: ["self", "target"],
          hits: [{ x: 400, y: 336, directTargetId: "target", shotId: physical.FORECAST_SHOT_ID, munitionId: 0, weaponId: "NUKE" }],
          damage: [{ victimId: "target", shooterId: "self", shieldAbsorbedMilli: 0, healthDamageMilli: 1000, shotId: physical.FORECAST_SHOT_ID, munitionId: 0, weaponId: "NUKE", source: "projectile", classification: "direct", shieldLostMilli: 0 }],
          destruction: [],
          humanDestroyedCount: 0,
          humanDamageMilli: 1000,
          aiDestroyedCount: 0,
          aiDamageMilli: 0,
          steps: 1,
          support: []
        } as unknown as physical.DecisionForecast;
      }
      return {
        complete: true,
        survivors: ["self"],
        hits: [{ x: 400, y: 336, directTargetId: "target", shotId: physical.FORECAST_SHOT_ID, munitionId: 0, weaponId: "NUKE" }],
        damage: [{ victimId: "target", shooterId: "self", shieldAbsorbedMilli: 0, healthDamageMilli: 1000, shotId: physical.FORECAST_SHOT_ID, munitionId: 0, weaponId: "NUKE", source: "projectile", classification: "direct", shieldLostMilli: 0 }],
        destruction: [{ shotId: physical.FORECAST_SHOT_ID, shooterId: "self", victimId: "target", weaponId: "NUKE", cause: "health-zero" }],
        humanDestroyedCount: 1,
        humanDamageMilli: 1000,
        aiDestroyedCount: 0,
        aiDamageMilli: 0,
        steps: 1,
        support: []
      } as unknown as physical.DecisionForecast;
    });

    vi.spyOn(rewards, "calculateShotRewards").mockReturnValue({
      awards: [{ playerId: "self", amount: 500, components: [] }],
      humanDestroyedCount: 0,
      aiDestroyedCount: 0,
      humanDamageMilli: 0,
      aiDamageMilli: 0,
      netProfit: 500
    });

    const resultFalse = evaluator.evaluateExpertShot(f.state, f.terrain, f.self, "NUKE", [f.target], false, false, cache, { mode: "own", aim });
    expect(evaluator.isValidExpertShot(resultFalse)).toBe(true);

    cache.physics.clear();
    cache.search.clear();
    callCount = 0;
    const resultTrue = evaluator.evaluateExpertShot(f.state, f.terrain, f.self, "NUKE", [f.target], true, false, cache, { mode: "own", aim });
    expect(evaluator.isValidExpertShot(resultTrue)).toBe(true);
    if (evaluator.isValidExpertShot(resultTrue)) {
      expect(resultTrue.destroyedIds.has("target")).toBe(true);
    }
  });

  it("evaluates multiple variants and picks highest profit when OPTIMISER_PROFIT is set", () => {
    const f = fixture();
    const cache = evaluator.createExpertForecastCache();

    let callCount = 0;
    vi.spyOn(physical, "resolvePhysicalShot").mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          complete: true,
          survivors: ["self"],
          hits: [{ x: 400, y: 336, directTargetId: "target", shotId: physical.FORECAST_SHOT_ID, munitionId: 0, weaponId: "NUKE" }],
          damage: [{ victimId: "target", shooterId: "self", shieldAbsorbedMilli: 0, healthDamageMilli: 1000, shotId: physical.FORECAST_SHOT_ID, munitionId: 0, weaponId: "NUKE", source: "projectile", classification: "direct", shieldLostMilli: 0 }],
          destruction: [{ shotId: physical.FORECAST_SHOT_ID, shooterId: "self", victimId: "target", weaponId: "NUKE", cause: "health-zero" }],
          humanDestroyedCount: 1,
          humanDamageMilli: 1000,
          aiDestroyedCount: 0,
          aiDamageMilli: 0,
          steps: 1,
          support: []
        } as unknown as physical.DecisionForecast;
      } else {
        return {
          complete: true,
          survivors: [],
          hits: [{ x: 400, y: 336, directTargetId: "target", shotId: physical.FORECAST_SHOT_ID, munitionId: 0, weaponId: "NUKE" }],
          damage: [{ victimId: "target", shooterId: "self", shieldAbsorbedMilli: 0, healthDamageMilli: 1000, shotId: physical.FORECAST_SHOT_ID, munitionId: 0, weaponId: "NUKE", source: "projectile", classification: "direct", shieldLostMilli: 0 }],
          destruction: [
            { shotId: physical.FORECAST_SHOT_ID, shooterId: "self", victimId: "target", weaponId: "NUKE", cause: "health-zero" },
            { shotId: physical.FORECAST_SHOT_ID, shooterId: "self", victimId: "self", weaponId: "NUKE", cause: "health-zero" }
          ],
          humanDestroyedCount: 1,
          humanDamageMilli: 1000,
          aiDestroyedCount: 1,
          aiDamageMilli: 1000,
          steps: 1,
          support: []
        } as unknown as physical.DecisionForecast;
      }
    });

    const origRewards = rewards.calculateShotRewards;
    vi.spyOn(rewards, "calculateShotRewards").mockImplementation((input) => {
      if (callCount === 1) {
        return {
          ...origRewards(input),
          awards: [{ playerId: "self", amount: 520, components: [] }]
        };
      }
      return {
        ...origRewards(input),
        awards: [{ playerId: "self", amount: 920, components: [] }]
      };
    });

    const resultSurvive = evaluator.evaluateExpertShot(f.state, f.terrain, f.self, "NUKE", [f.target], true, false, cache, { mode: "own", aim });
    expect(evaluator.isValidExpertShot(resultSurvive)).toBe(true);
    if (evaluator.isValidExpertShot(resultSurvive)) {
      expect(resultSurvive.profit).toBe(100);
    }

    cache.physics.clear();
    cache.search.clear();
    callCount = 0;
    const resultProfit = evaluator.evaluateExpertShot(f.state, f.terrain, f.self, "NUKE", [f.target], true, false, cache, { mode: "own", selectionPolicy: "OPTIMISER_PROFIT", aim });
    expect(evaluator.isValidExpertShot(resultProfit)).toBe(true);
    if (evaluator.isValidExpertShot(resultProfit)) {
      expect(resultProfit.profit).toBe(500);
      expect(resultProfit.shooterDestroyed).toBe(true);
    }
  });

  it("filters out null profit via search complete state", () => {
    const f = fixture();
    const cache = evaluator.createExpertForecastCache();

    vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue({
      complete: false
    } as unknown as physical.DecisionForecast);

    const result = evaluator.evaluateExpertShot(f.state, f.terrain, f.self, "NUKE", [f.target], false, false, cache, { mode: "own", aim });
    expect(evaluator.isValidExpertShot(result)).toBe(false);
  });
});
