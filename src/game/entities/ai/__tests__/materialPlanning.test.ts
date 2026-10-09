import { afterEach, describe, expect, it, vi } from "vitest";
import { flatTerrain, makePlayer, makeTank } from "../../../__tests__/helpers";
import type { GameState } from "../../../../types/game";
import { TERRAIN_MATERIAL } from "../../../../types/terrain";
import { DRILLER_SHAFT_DEPTH, WEAPON_REGISTRY } from "../../../../types/weapon";
import { TANK_HITBOX_WIDTH } from "../../../combatConstants";
import * as physical from "../physicalShotForecast";
import * as economics from "../../../economy/shotRewards";
import * as random from "../../../../utils/random";
import * as ballistics from "../BallisticsSimulator";
import { materialBoundaryPoints, localMaterialPoints } from "../materialCandidates";
import * as candidates from "../materialCandidates";
import { chooseLocalMaterialShot, hasPhysicalEffect, LOCAL_MATERIAL_MAX_PROPOSALS, type MaterialSolver } from "../localMaterialPlanner";
import { chooseExpertFallback, createExpertForecastCache, evaluateExpertShot, expertTacticalPoints } from "../expertShotEvaluator";
import { aimCone, ORDINARY_AIM_POLICY } from "../aimSearch";
import { solveExpertAim } from "../expertAim";
import { solveHeuristicAim } from "../heuristicShot";
import { solveSniperAim } from "../sniperAim";
import { AISimpleStrategy } from "../AISimpleStrategy";
import { chooseExpertPlan } from "../expertPlanner";
import { createExpertDecisionAim } from "../expertDecisionAim";
import * as expertPlanner from "../expertPlanner";
import * as expertEvaluator from "../expertShotEvaluator";
import * as localPlanner from "../localMaterialPlanner";
import * as fallible from "../fallibleAim";
import * as aimMemory from "../aimMemory";
import { AIHeuristicStrategy } from "../AIHeuristicStrategy";
import { AISniperStrategy } from "../AISniperStrategy";
import { AISmartStrategy } from "../AISmartStrategy";
import { AIByProfileStrategy } from "../AIByProfileStrategy";
import { PhysicsEngine, type ProjectileHitEvent } from "../../../engine/PhysicsEngine";
import { TerrainManager } from "../../../engine/Terrain";
import { TankManager } from "../../TankManager";
import type { CombatDamageEvent, CombatDestructionEvent } from "../../../economy/shotRewards";
import type { Player } from "../../../../types/player";
import type { WeaponId } from "../../../../types/weapon";

const zeroAim = { primaryTargetId: "target", attempts: 2, offset: 0 };
// Isolate the existing material/physics guarantees from the new offset sampling.
function chooseIdealExpertFallback(state: GameState, terrain: TerrainManager,
  self: Player, target: Player, weapon: WeaponId, cache: expertEvaluator.ExpertForecastCache) {
  return chooseExpertFallback(state, terrain, self, target, weapon, cache, zeroAim);
}

function fixture() {
  const terrain = flatTerrain(800, 480);
  const self = makePlayer({ id: "self", isHuman: false, aiProfile: "v4-smart",
    tank: makeTank("self", 100, 336), inventory: { DRILLER: 1, BULLET: 1, GRENADE: 1, BULLDOZER: 1 } });
  const target = makePlayer({ id: "target", isHuman: true, tank: makeTank("target", 400, 336) });
  const state: GameState = { phase: "COMBAT", players: [self, target], currentPlayerIndex: 0,
    turn: 1, roundNumber: 1, windForce: 0, gravity: 260,
    localShotContext: { playerCountAtMatchStart: 2, isFirstShotOfRound: false } };
  return { terrain, self, target, state };
}

type Complete = Extract<physical.PhysicalResolution, { complete: true }>;
function forecast(overrides: Partial<Complete> = {}): Complete {
  return { complete: true, survivors: ["self", "target"], hits: [], damage: [], destruction: [],
    support: [{ playerId: "target", x: 400, before: 336, after: 390 }], steps: 1,
    humanDamageMilli: 0, humanDestroyedCount: 0, aiDamageMilli: 0, aiDestroyedCount: 0, ...overrides };
}
function damage(victimId = "target", amount = 1000) {
  return { shotId: 1, munitionId: 0, shooterId: "self", victimId, weaponId: "MISSILE" as const,
    source: "projectile" as const, classification: "direct" as const,
    shieldLostMilli: amount, shieldAbsorbedMilli: 0, healthDamageMilli: 0 };
}
function solver(): MaterialSolver & ReturnType<typeof vi.fn<MaterialSolver>> {
  let angle = 30;
  return vi.fn<MaterialSolver>(() => ({ command: { angle: angle++, power: 50 }, complete: true }));
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const physicalEffectCases = [
  { name: "physical shield loss only", event: damage(), own: true, adverse: false },
  { name: "economic absorption only", event: { ...damage(), shieldLostMilli: 0, shieldAbsorbedMilli: 1000 }, own: false, adverse: true },
  { name: "health damage", event: { ...damage(), shieldLostMilli: 0, healthDamageMilli: 1000 }, own: true, adverse: true },
  { name: "self damage", event: damage("self"), own: false, adverse: false },
  { name: "foreign shooter", event: { ...damage(), shooterId: "other", shieldAbsorbedMilli: 1000 }, own: false, adverse: false },
  { name: "foreign shot", event: { ...damage(), shotId: 99, shieldAbsorbedMilli: 1000 }, own: false, adverse: true },
  { name: "inadmissible victim", event: damage("other"), own: false, adverse: false },
];

describe("applied physical effects and preserved adverse criteria", () => {
  it.each(physicalEffectCases)("separates $name from economic absorption", ({ event, own }) => {
    const f = fixture();
    // Include self in the supplied set to verify the predicate's explicit exclusion.
    expect(hasPhysicalEffect(forecast({ damage: [event] }), f.self, new Set(["target", "self"]))).toBe(own);
  });

  it.each(physicalEffectCases)("uses $name for own tank points and preserves adverse results", ({ event, own, adverse }) => {
    const f = fixture();
    vi.spyOn(ballistics, "searchBallisticSolution").mockReturnValue({ angle: 45, power: 50, err: 0, complete: true });
    vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(forecast({ damage: [event] }));
    if (event.shotId !== 1) {
      const reward = economics.calculateShotRewards;
      vi.spyOn(economics, "calculateShotRewards").mockImplementation((input) => reward({ ...input, damageEvents: [] }));
    }
    for (const [mode, valid] of [["own", own], ["adverse", adverse]] as const) {
      const result = evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [f.target], false, false,
        createExpertForecastCache(), mode === "own" ? { mode, aim: zeroAim } : { mode });
      expect(result.destination !== -1).toBe(valid);
    }
    expect(chooseIdealExpertFallback(f.state, f.terrain, f.self, f.target, "MISSILE", createExpertForecastCache()).useful)
      .toBe(own);
  });

  it("requires own damage to the tank point even when collateral damage is useful", () => {
    const f = fixture();
    f.state.players.push(makePlayer({ id: "other", tank: makeTank("other", 650, 336) }));
    vi.spyOn(ballistics, "searchBallisticSolution").mockReturnValue({ angle: 45, power: 50, err: 0, complete: true });
    vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(forecast({ damage: [damage("other"),
      { ...damage(), shieldLostMilli: 0, shieldAbsorbedMilli: 1000 }] }));
    expect(evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [f.target], false, false,
      createExpertForecastCache(), { mode: "own", aim: zeroAim }).destination).toBe(-1);
    expect(evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [f.target], false, false,
      createExpertForecastCache(), { mode: "adverse" }).destination).not.toBe(-1);
  });

  it.each([
    { shotId: 1, shooterId: "self", victimId: "target", expected: true },
    { shotId: 99, shooterId: "self", victimId: "target", expected: false },
    { shotId: 1, shooterId: "other", victimId: "target", expected: false },
    { shotId: 1, shooterId: "self", victimId: "self", expected: false },
  ])("checks elimination attribution $shotId/$shooterId/$victimId", ({ expected, ...attribution }) => {
    const f = fixture();
    const result = forecast({ destruction: [{ ...attribution, weaponId: "MISSILE", cause: "out-of-bounds" }] });
    expect(hasPhysicalEffect(result, f.self, new Set(["self", "target"]))).toBe(expected);
    vi.spyOn(ballistics, "searchBallisticSolution").mockReturnValue({ angle: 45, power: 50, err: 0, complete: true });
    vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(result);
    if (attribution.shotId !== 1) {
      const reward = economics.calculateShotRewards;
      vi.spyOn(economics, "calculateShotRewards").mockImplementation((input) => reward({ ...input, destructionEvents: [] }));
    }
    expect(evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [f.target], true, false,
      createExpertForecastCache(), { mode: "own", aim: zeroAim }).destination !== -1).toBe(expected);
  });
});

describe("enforced local proposal budgets", () => {
  function longList() {
    return Array.from({ length: 20 }, (_, index) => ({ x: 400 + index, y: 330, kind: "tank" as const }));
  }

  it.each(["v2-heuristic", "v3-sniper"] as const)("bounds %s independently of DEV, completeness and command deduplication", (profile) => {
    vi.stubEnv("DEV", false);
    const f = fixture();
    vi.spyOn(candidates, "localMaterialPoints").mockReturnValue(longList());
    const resolve = vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(forecast());
    for (const mode of ["unique", "duplicate", "incomplete"] as const) {
      resolve.mockClear();
      let index = 0;
      const solve = vi.fn<MaterialSolver>(() => ({ command: { angle: mode === "unique" ? 30 + index++ : 45, power: 50 },
        complete: mode !== "incomplete" }));
      expect(chooseLocalMaterialShot(profile, f.self, f.target, f.state, f.terrain, "MISSILE", 2, solve))
        .toMatchObject({ weaponId: "MISSILE", reason: mode === "incomplete" ? "ordinary" : "surviving" });
      expect(solve).toHaveBeenCalledTimes(12);
      expect(resolve).toHaveBeenCalledTimes(mode === "unique" ? 12 : mode === "duplicate" ? 1 : 0);
      expect(solve.mock.calls.map(([point, , variant]) => [point.x, variant])).toEqual(
        longList().slice(0, 6).flatMap((point) => [[point.x, "full"], [point.x, "high"]]));
    }
  });

  it("stops immediately on the first useful surviving proposal", () => {
    const f = fixture();
    vi.spyOn(candidates, "localMaterialPoints").mockReturnValue(longList());
    const resolve = vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(forecast({ damage: [damage()] }));
    const solve = solver();
    expect(chooseLocalMaterialShot("v3-sniper", f.self, f.target, f.state, f.terrain, "MISSILE", 2, solve).reason)
      .toBe("useful");
    expect(solve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it.each([AIHeuristicStrategy, AISniperStrategy])("bounds the complete %s turn to 12 ideal searches and one final search", async (Strategy) => {
    const f = fixture();
    f.self.inventory = {};
    vi.spyOn(candidates, "localMaterialPoints").mockReturnValue(longList());
    let angle = 30;
    const search = vi.spyOn(ballistics, "searchBallisticSolution").mockImplementation(() =>
      ({ angle: angle++, power: 50, err: 0, complete: true }));
    const resolve = vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(forecast());
    vi.spyOn(fallible, "maybeGaffe").mockReturnValue(false);
    vi.spyOn(fallible, "signedImpactOffset").mockReturnValue(0);
    const rng = vi.spyOn(random, "secureRandom");
    await new Strategy().executeTurn("self", f.state, f.terrain);
    expect(search).toHaveBeenCalledTimes(13);
    expect(resolve).toHaveBeenCalledTimes(12);
    expect(rng).not.toHaveBeenCalled();
  });

  it.each([true, false])("bounds a complete EXPERT turn and reuses main forecasts in fallback (useful=%s)", async (useful) => {
    const f = fixture();
    f.self.inventory = { DRILLER: 1 };
    f.terrain.setMaterialRange(390, 409, TERRAIN_MATERIAL.SOFT);
    const search = vi.spyOn(ballistics, "searchBallisticSolution").mockReturnValue({ angle: 45, power: 50, err: 0, complete: true });
    const resolve = vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(forecast({ damage: useful ? [damage()] : [],
      hits: useful ? [{ shotId: 1, munitionId: 0, x: 400, y: 330, weaponId: "MISSILE", directTargetId: "target" }] : [] }));
    const fallback = vi.spyOn(expertEvaluator, "chooseExpertFallback");
    vi.spyOn(fallible, "maybeGaffe").mockReturnValue(false);
    vi.spyOn(fallible, "signedImpactOffset").mockReturnValue(0);
    const rng = vi.spyOn(random, "secureRandom");
    await new AISmartStrategy().executeTurn("self", f.state, f.terrain);
    const ownSearches = search.mock.calls.filter(([config]) => config.sx === 100);
    // Seven MISSILE points and eight DRILLER points, three arcs; no final re-solve.
    expect(ownSearches).toHaveLength(45);
    expect(ownSearches.filter(([config]) => config.weaponId === "DRILLER")).toHaveLength(24);
    expect(ownSearches.filter(([config]) => config.weaponId === "MISSILE")).toHaveLength(21);
    expect(resolve.mock.calls.filter(([, , shooter]) => shooter.id === "self")).toHaveLength(2);
    expect(fallback).toHaveBeenCalledTimes(useful ? 0 : 1);
    if (!useful) {
      const cache = fallback.mock.calls[0][5];
      expect(cache.diagnostics?.ownProposals).toBe(90);
      expect(cache.diagnostics && cache.diagnostics.ownProposals - 45).toBeLessThanOrEqual(48);
    }
    expect(rng).toHaveBeenCalledTimes(2);
  });
});

describe("material candidate geometry and profile search contracts", () => {
  it.each([
    [true, "full", 15, 85], [true, "low", 15, 50], [true, "high", 50, 85],
    [false, "full", 95, 165], [false, "low", 130, 165], [false, "high", 95, 130],
  ] as const)("keeps the %s/%s cone", (right, variant, aMin, aMax) => {
    expect(aimCone(right, right ? 15 : 95, right ? 85 : 165, variant)).toEqual({ aMin, aMax });
  });

  it("uses exact side points, excludes map edges and gives BULLET/BULLDOZER no ground point", () => {
    const f = fixture();
    expect(localMaterialPoints(f.self, f.target, "DRILLER", f.terrain)).toEqual([
      { x: 400, y: 330, kind: "tank" }, { x: 381, y: 336, kind: "terrain" },
    ]);
    f.self.tank.position.x = 600;
    expect(localMaterialPoints(f.self, f.target, "DRILLER", f.terrain)[1].x).toBe(419);
    for (const weapon of ["BULLET", "BULLDOZER"] as const) {
      expect(localMaterialPoints(f.self, f.target, weapon, f.terrain)).toHaveLength(1);
    }
    f.self.tank.position.x = 0;
    f.target.tank.position.x = 1;
    expect(localMaterialPoints(f.self, f.target, "DRILLER", f.terrain)).toHaveLength(1);
  });

  it("orders two equally close boundaries by column and appends exact adjacent centers", () => {
    const f = fixture();
    f.terrain.setMaterialRange(390, 409, TERRAIN_MATERIAL.SOFT);
    expect(materialBoundaryPoints([f.target], "MISSILE", f.terrain, f.state.players).map((p) => p.x))
      .toEqual([389.5, 390.5, 409.5, 410.5]);
    const historical = expertTacticalPoints(f.self, [f.target], "DRILLER", f.terrain, f.state.players);
    const own = expertTacticalPoints(f.self, [f.target], "DRILLER", f.terrain, f.state.players, "own");
    expect(own.slice(0, historical.length)).toEqual(historical);
    expect(own).toHaveLength(8);
  });

  it("reserves a distinct nearest boundary for each duo member in roster order", () => {
    const f = fixture();
    const other = makePlayer({ id: "other", tank: makeTank("other", 650, 336) });
    f.state.players.push(other);
    f.terrain.setMaterialRange(390, 419, TERRAIN_MATERIAL.SOFT);
    f.terrain.setMaterialRange(640, 659, TERRAIN_MATERIAL.ROCK);
    expect(materialBoundaryPoints([other, f.target], "MISSILE", f.terrain, f.state.players).map((p) => p.x))
      .toEqual([389.5, 390.5, 639.5, 640.5]);
  });

  it("searches only the derived local window and does not invent a transition", () => {
    const f = fixture();
    expect(materialBoundaryPoints([f.target], "MISSILE", f.terrain, f.state.players)).toEqual([]);
    const missileReach = TANK_HITBOX_WIDTH / 2 + 2.5 * WEAPON_REGISTRY.MISSILE.blastRadius;
    f.terrain.setMaterialRange(Math.floor(400 + missileReach) + 1, 799, TERRAIN_MATERIAL.ROCK);
    expect(materialBoundaryPoints([f.target], "MISSILE", f.terrain, f.state.players)).toEqual([]);
    f.terrain.setMaterialRange(0, 799, TERRAIN_MATERIAL.DIRT);
    const drillerReach = TANK_HITBOX_WIDTH / 2 + 2.5 * WEAPON_REGISTRY.DRILLER.blastRadius +
      Math.max(0, DRILLER_SHAFT_DEPTH - WEAPON_REGISTRY.DRILLER.blastRadius);
    const boundary = Math.floor(400 + drillerReach);
    f.terrain.setMaterialRange(boundary, 799, TERRAIN_MATERIAL.SOFT);
    expect(materialBoundaryPoints([f.target], "DRILLER", f.terrain, f.state.players).map((p) => p.x))
      .toEqual([boundary - 0.5, boundary + 0.5]);
  });

  it("keeps weapon-aware GRENADE searches and profile parameters including equal-X left direction", () => {
    const f = fixture();
    const search = vi.spyOn(ballistics, "searchBallisticSolution").mockReturnValue({ angle: 100, power: 50, err: 0 });
    solveHeuristicAim(f.self, 100, 330, 0, 260, f.terrain, "GRENADE", "high");
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ weaponId: "GRENADE", isRight: false,
      aMin: 98, aMax: 128, coarseStep: 3.5, powerIterations: 7 }));
    solveSniperAim(f.self, 400, 330, 0, 260, f.terrain, "BULLET", "high");
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ weaponId: "BULLET", aMin: 50, aMax: 85,
      fineStep: 1, earlyExitError: 2 }));
    solveExpertAim(f.self, 400, 330, 0, 260, f.terrain, "MISSILE", { variant: "low", penalizeProximity: false });
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ aMin: 15, aMax: 50, selfHarmPenalty: undefined }));
    solveExpertAim(f.self, 400, 330, 0, 260, f.terrain, "MISSILE");
    expect(search.mock.lastCall?.[0].selfHarmPenalty?.(100, 336)).toBe(50000);
  });

  it.each([true, false])("projects incomplete restricted fallback into the cone (right=%s)", (right) => {
    const f = fixture();
    const result = ballistics.searchBallisticSolution({ sx: 100, sy: 336, tx: 400, ty: 330,
      wind: 0, gravity: 260, terrain: f.terrain, isRight: right,
      aMin: right ? 15 : 130, aMax: right ? 50 : 165, coarseStep: 5, fineStep: 1,
      fineWindow: 4, powerLo: 20, powerHi: 95, powerIterations: 0, projectFallbackToCone: true });
    expect(result.angle).toBe(right ? 50 : 130);
    expect(result.complete).toBe(false);
  });
});

describe("selected material aim is transported once to the real shot", () => {
  it("EXPERT transports fallback policy and advances memory only after choosing", async () => {
    const f = fixture();
    vi.spyOn(expertPlanner, "chooseExpertPlan").mockReturnValue(null);
    const record = vi.spyOn(aimMemory, "recordAimAttempt");
    vi.spyOn(expertEvaluator, "chooseExpertFallback").mockImplementation((_state, _terrain, _self, _target, _weapon, _cache, aim) => {
      expect(record).not.toHaveBeenCalled();
      return { kind: "evaluated", ...aim, weaponId: "DRILLER", point: { x: 350, y: 300, kind: "terrain" },
        requestedPoint: { x: 350 + aim.offset, y: 300 }, rawCommand: { angle: 70, power: 50 },
        command: { angle: 70, power: 50 }, forecast: { ...forecast(), profit: 0 },
        policy: { variant: "high", penalizeProximity: false }, useful: true };
    });
    vi.spyOn(fallible, "signedImpactOffset").mockReturnValue(12);
    vi.spyOn(fallible, "maybeGaffe").mockReturnValue(false);
    const search = vi.spyOn(ballistics, "searchBallisticSolution").mockReturnValue({ angle: 70, power: 50, err: 0, complete: true });
    const rng = vi.spyOn(random, "secureRandom");
    expect(await new AISmartStrategy().executeTurn("self", f.state, f.terrain)).toEqual({ angle: 70, power: 50, weaponId: "DRILLER" });
    expect(record).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();
    expect(rng).toHaveBeenCalledTimes(2);
  });

  it("EXPERT reports an absent choice before changing attempts, weapon, reaction or searching again", async () => {
    const f = fixture();
    const strategy = new AISmartStrategy();
    vi.spyOn(expertPlanner, "chooseExpertPlan").mockReturnValue(null);
    const ordinary = { kind: "ordinary" as const, ...zeroAim, weaponId: "MISSILE" as const,
      requestedPoint: { x: 400, y: 330 }, rawCommand: { angle: 45, power: 50 },
      command: { angle: 45, power: 50 }, searchComplete: false,
      point: { x: 400, y: 330, kind: "tank" as const }, policy: ORDINARY_AIM_POLICY, useful: false };
    const fallback = vi.spyOn(expertEvaluator, "chooseExpertFallback").mockReturnValue(ordinary);
    vi.spyOn(fallible, "maybeGaffe").mockReturnValue(false);
    const search = vi.spyOn(ballistics, "searchBallisticSolution").mockReturnValue({ angle: 45, power: 50, err: 0 });
    await strategy.executeTurn("self", f.state, f.terrain);
    // Simulate a broken collaborator contract to exercise the defensive runtime guard.
    fallback.mockReturnValue(undefined as unknown as expertEvaluator.ExpertFallbackChoice);
    const before = structuredClone(f.state);
    const record = vi.spyOn(aimMemory, "recordAimAttempt");
    const offset = vi.spyOn(fallible, "signedImpactOffset");
    const rng = vi.spyOn(random, "secureRandom");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    search.mockClear();
    expect(await strategy.executeTurn("self", f.state, f.terrain)).toEqual({ angle: 45, power: 50, weaponId: "MISSILE" });
    expect(error).toHaveBeenCalledExactlyOnceWith("[AI EXPERT] Aucun choix de tir",
      { shooterId: "self", round: 1, turn: 1 });
    expect(record).not.toHaveBeenCalled();
    expect(offset).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(rng).toHaveBeenCalledTimes(2);
    expect(f.state).toEqual(before);
    fallback.mockReturnValue(ordinary);
    await strategy.executeTurn("self", f.state, f.terrain);
    expect(fallback.mock.lastCall?.[6].attempts).toBe(2);
    expect(offset).not.toHaveBeenCalled();
  });

  it.each([
    { profile: "v2-heuristic", create: () => new AIHeuristicStrategy(), aMin: 52, aMax: 82 },
    { profile: "v3-sniper", create: () => new AISniperStrategy(), aMin: 50, aMax: 85 },
  ])("$profile keeps point Y, high arc, one offset and one memory attempt", async ({ create, aMin, aMax }) => {
    const f = fixture();
    const selection = vi.spyOn(localPlanner, "chooseLocalMaterialShot").mockReturnValue({
      weaponId: "MISSILE", point: { x: 350, y: 300, kind: "terrain" }, variant: "high", reason: "useful",
    });
    const offset = vi.spyOn(fallible, "signedImpactOffset").mockReturnValue(12);
    const memory = vi.spyOn(aimMemory, "recordAimAttempt");
    vi.spyOn(fallible, "maybeGaffe").mockReturnValue(false);
    const search = vi.spyOn(ballistics, "searchBallisticSolution").mockReturnValue({ angle: 70, power: 50, err: 0 });
    const resolve = vi.spyOn(physical, "resolvePhysicalShot");
    await create().executeTurn("self", f.state, f.terrain);
    expect(selection).toHaveBeenCalledTimes(1);
    expect(offset).toHaveBeenCalledTimes(1);
    expect(memory).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tx: 362, ty: 300, aMin, aMax }));
    expect(resolve).not.toHaveBeenCalled();
  });

  it("EXPERT carries its evaluated command and policy without a final search or fallback for a main plan", async () => {
    const f = fixture();
    const policy = { variant: "low" as const, penalizeProximity: false };
    const selection = vi.spyOn(expertPlanner, "chooseExpertPlan").mockReturnValue({ kind: "evaluated",
      ...zeroAim, offset: 12, weaponId: "MISSILE", requestedPoint: { x: 362, y: 300 },
      rawCommand: { angle: 70.04, power: 55.5224609375 }, command: { angle: 70, power: 56 },
      point: { x: 350, y: 300 }, policy });
    const fallback = vi.spyOn(expertEvaluator, "chooseExpertFallback");
    vi.spyOn(fallible, "signedImpactOffset").mockReturnValue(12);
    vi.spyOn(fallible, "maybeGaffe").mockReturnValue(false);
    const search = vi.spyOn(ballistics, "searchBallisticSolution").mockReturnValue({ angle: 50, power: 60, err: 999, complete: false });
    expect(await new AISmartStrategy().executeTurn("self", f.state, f.terrain))
      .toEqual({ angle: 70, power: 56, weaponId: "MISSILE" });
    expect(selection).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("OK preserves its single NUKE opportunity roll before material exploration", async () => {
    const f = fixture();
    f.target.tank.position.x = 600;
    f.self.inventory = { NUKE: 1 };
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0.1);
    vi.spyOn(fallible, "signedImpactOffset").mockReturnValue(0);
    vi.spyOn(fallible, "maybeGaffe").mockReturnValue(false);
    vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(forecast());
    const selection = vi.spyOn(localPlanner, "chooseLocalMaterialShot");
    await new AIHeuristicStrategy().executeTurn("self", f.state, f.terrain);
    expect(rng).toHaveBeenCalledTimes(1);
    expect(selection.mock.calls[0][5]).toBe("NUKE");
  });

  it("SNIPER consumes the existing BULLET roll only once after the first attempt", async () => {
    const f = fixture();
    f.self.inventory = { BULLET: 1, DRILLER: 1 };
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0.1);
    vi.spyOn(fallible, "signedImpactOffset").mockReturnValue(0);
    vi.spyOn(fallible, "maybeGaffe").mockReturnValue(false);
    vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(forecast());
    const selection = vi.spyOn(localPlanner, "chooseLocalMaterialShot");
    const strategy = new AISniperStrategy();
    await strategy.executeTurn("self", f.state, f.terrain);
    expect(rng).not.toHaveBeenCalled();
    await strategy.executeTurn("self", f.state, f.terrain);
    expect(rng).toHaveBeenCalledTimes(1);
    expect(selection.mock.calls.map((call) => call[5])).toEqual(["MISSILE", "BULLET"]);
  });
});

describe("OK/SNIPER useful, safe, fixed-order selection", () => {
  it.each([
    { safe: true, useful: true, support: true, expected: "DRILLER" },
    { safe: true, useful: false, support: true, expected: "MISSILE" },
    { safe: true, useful: true, support: false, expected: "MISSILE" },
    { safe: false, useful: true, support: true, expected: "MISSILE" },
  ])("promotes SOFT only with useful safe support excavation: %j", ({ safe, useful, support, expected }) => {
    const f = fixture();
    f.terrain.setMaterialRange(0, 799, TERRAIN_MATERIAL.SOFT);
    vi.spyOn(physical, "resolvePhysicalShot").mockImplementation((_state, _terrain, _self, weapon) =>
      forecast({ survivors: weapon === "DRILLER" && !safe ? ["target"] : ["self", "target"],
        damage: useful || weapon === "MISSILE" ? [damage()] : [],
        support: [{ playerId: "target", x: 400, before: 336, after: support ? 390 : 336 }] }));
    const choice = chooseLocalMaterialShot("v2-heuristic", f.self, f.target, f.state, f.terrain, "MISSILE", 1, solver());
    expect(choice.weaponId).toBe(expected);
  });

  it("rejects DRILLER/ROCK before any forecast for either profile", () => {
    const f = fixture();
    f.terrain.setMaterialRange(400, 400, TERRAIN_MATERIAL.ROCK);
    const resolve = vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(forecast());
    for (const profile of ["v2-heuristic", "v3-sniper"] as const) {
      chooseLocalMaterialShot(profile, f.self, f.target, f.state, f.terrain, "DRILLER", 2, solver());
    }
    expect(resolve.mock.calls.every((call) => call[3] === "MISSILE")).toBe(true);
  });

  it("keeps first-attempt SNIPER MISSILE only on SOFT", () => {
    const f = fixture();
    f.terrain.setMaterialRange(0, 799, TERRAIN_MATERIAL.SOFT);
    vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(forecast());
    const solve = solver();
    chooseLocalMaterialShot("v3-sniper", f.self, f.target, f.state, f.terrain, "MISSILE", 1, solve);
    expect(solve.mock.calls.every((call) => call[1] === "MISSILE")).toBe(true);
    expect(solve).toHaveBeenCalledTimes(4);
  });

  it("takes the first useful safe candidate rather than maximizing damage or profit", () => {
    const f = fixture();
    const resolve = vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(forecast({ damage: [damage()] }));
    const reward = vi.spyOn(economics, "calculateShotRewards");
    const choice = chooseLocalMaterialShot("v2-heuristic", f.self, f.target, f.state, f.terrain, "GRENADE", 1, solver());
    expect(choice).toMatchObject({ weaponId: "GRENADE", variant: "full", reason: "useful" });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(reward).not.toHaveBeenCalled();
  });

  it("continues past a safe useless candidate and rejects collateral-only utility", () => {
    const f = fixture();
    vi.spyOn(physical, "resolvePhysicalShot")
      .mockReturnValueOnce(forecast({ damage: [damage("collateral")] }))
      .mockReturnValue(forecast({ damage: [damage()] }));
    expect(chooseLocalMaterialShot("v2-heuristic", f.self, f.target, f.state, f.terrain, "MISSILE", 1, solver()))
      .toMatchObject({ variant: "high", reason: "useful" });
  });

  it("BULLET utility requires the retained target's direct hit", () => {
    const f = fixture();
    vi.spyOn(physical, "resolvePhysicalShot").mockImplementation((_s, _t, _p, weapon) => forecast({
      damage: [damage()], hits: weapon === "DRILLER" ? [{ shotId: 1, munitionId: 0,
        x: 400, y: 330, weaponId: weapon, directTargetId: "target" }] : [],
    }));
    expect(chooseLocalMaterialShot("v3-sniper", f.self, f.target, f.state, f.terrain, "BULLET", 2, solver()))
      .toMatchObject({ weaponId: "DRILLER", reason: "useful" });
  });

  it("does not introduce BULLET, NUKE or GRENADE when the ordinary choice did not select them", () => {
    const f = fixture();
    f.self.inventory.NUKE = 1;
    vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(forecast());
    const solve = solver();
    chooseLocalMaterialShot("v3-sniper", f.self, f.target, f.state, f.terrain, "DRILLER", 2, solve);
    expect([...new Set(solve.mock.calls.map((call) => call[1]))]).toEqual(["DRILLER", "MISSILE"]);
  });

  it("returns the first safe useless candidate only after exploring the full list", () => {
    const f = fixture();
    vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(forecast());
    const solve = solver();
    expect(chooseLocalMaterialShot("v2-heuristic", f.self, f.target, f.state, f.terrain, "GRENADE", 1, solve))
      .toMatchObject({ weaponId: "GRENADE", reason: "surviving", variant: "full" });
    expect(solve).toHaveBeenCalledTimes(8);
  });

  it("never treats incomplete physics as safe and preserves ordinary SNIPER DRILLER", () => {
    const f = fixture();
    vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue({ complete: false, survivors: ["self"],
      hits: [], damage: [], destruction: [], support: [], steps: 2400 });
    expect(chooseLocalMaterialShot("v3-sniper", f.self, f.target, f.state, f.terrain, "DRILLER", 2, solver()))
      .toMatchObject({ weaponId: "DRILLER", reason: "ordinary", variant: "full" });
    f.terrain.setMaterialRange(0, 799, TERRAIN_MATERIAL.SOFT);
    expect(chooseLocalMaterialShot("v2-heuristic", f.self, f.target, f.state, f.terrain, "MISSILE", 1, solver()))
      .toMatchObject({ weaponId: "MISSILE", reason: "ordinary" });
  });

  it("deduplicates normalized commands and never consumes the live RNG", () => {
    const f = fixture();
    const rng = vi.spyOn(random, "secureRandom");
    const resolve = vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(forecast());
    const solve = vi.fn<MaterialSolver>().mockReturnValue({ command: { angle: 40.04, power: 50.2 }, complete: true });
    chooseLocalMaterialShot("v2-heuristic", f.self, f.target, f.state, f.terrain, "MISSILE", 1, solve);
    expect(solve).toHaveBeenCalledTimes(4);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(f.state, f.terrain, f.self, "MISSILE", { angle: 40, power: 50 });
    expect(rng).not.toHaveBeenCalled();
  });

  it("bounds the full OK list to 12 searches with stable weapon/point/variant order", () => {
    const f = fixture();
    f.terrain.setMaterialRange(0, 799, TERRAIN_MATERIAL.SOFT);
    vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(forecast());
    const solve = solver();
    chooseLocalMaterialShot("v2-heuristic", f.self, f.target, f.state, f.terrain, "GRENADE", 1, solve);
    expect(solve).toHaveBeenCalledTimes(LOCAL_MATERIAL_MAX_PROPOSALS);
    expect(solve.mock.calls.map((call) => [call[1], call[0].kind, call[2]])).toEqual(
      ["GRENADE", "DRILLER", "MISSILE"].flatMap((weapon) => ["tank", "terrain"].flatMap((kind) =>
        ["full", "high"].map((variant) => [weapon, kind, variant]))));
  });

  it("counts attributed fall/environment elimination as utility but excludes self damage", () => {
    const f = fixture();
    const victims = new Set(["target"]);
    expect(hasPhysicalEffect(forecast({ damage: [damage("self")] }), f.self, victims)).toBe(false);
    expect(hasPhysicalEffect(forecast({ destruction: [{ shotId: 1, shooterId: "self", victimId: "target",
      weaponId: "MISSILE", cause: "out-of-bounds" }] }), f.self, victims)).toBe(true);
  });
});

describe("physical parity and EXPERT fallback ranking", () => {
  it.each(Object.values(TERRAIN_MATERIAL).flatMap((material) =>
    (["GRENADE", "DRILLER", "CLUSTER", "BULLET", "BULLDOZER"] as const).map((weapon) => ({ material, weapon }))))(
    "matches the delivered engine for $weapon on $material without live mutations or RNG", ({ material, weapon }) => {
      const f = fixture();
      f.terrain.setMaterialRange(0, 799, material);
      const before = structuredClone(f.state);
      const heights = [...f.terrain.getHeightmap()];
      const materials = [...f.terrain.getMaterials()];
      const command = { angle: 35, power: 55 };
      const reward = vi.spyOn(economics, "calculateShotRewards");
      const rng = vi.spyOn(random, "secureRandom");
      const result = physical.resolvePhysicalShot(f.state, f.terrain, f.self, weapon, command);
      const terrain = new TerrainManager(800, 480);
      terrain.loadHeights(heights, materials);
      const tanks = new TankManager();
      tanks.setPlayers(structuredClone(f.state.players));
      tanks.beginShotAttribution(1, "self", weapon);
      const engine = new PhysicsEngine(() => 0.5, false);
      const hits: ProjectileHitEvent[] = [];
      const damageEvents: CombatDamageEvent[] = [];
      const destruction: CombatDestructionEvent[] = [];
      engine.onProjectileHit = (hit) => hits.push(hit);
      tanks.onDamageApplied = (event) => damageEvents.push(event);
      tanks.onTankDestroyed = (event) => destruction.push(event);
      const radians = command.angle * Math.PI / 180;
      engine.launchProjectile(100 + Math.cos(radians) * 20, 336 - 13 - Math.sin(radians) * 20,
        command.angle, command.power, weapon, "self", f.self.tank.color, { shotId: 1, munitionId: 0 });
      let steps = 0;
      while (steps < 2400) {
        steps++;
        engine.updateProjectiles(1 / 120, 260, 0, terrain, tanks);
        tanks.applyGravity(1 / 120, terrain);
        tanks.checkTankBurial(terrain);
        if (!engine.hasActiveProjectiles() && !tanks.anyTankIsFalling()) break;
      }
      expect(result.complete).toBe(true);
      expect(result.steps).toBe(steps);
      expect(result.hits).toEqual(hits);
      expect(result.damage).toEqual(damageEvents);
      expect(result.destruction).toEqual(destruction);
      expect(result.survivors).toEqual(tanks.getAlivePlayers().map((player) => player.id));
      expect(f.state).toEqual(before);
      expect(f.terrain.getHeightmap()).toEqual(heights);
      expect(f.terrain.getMaterials()).toEqual(materials);
      expect(rng).not.toHaveBeenCalled();
      expect(reward).not.toHaveBeenCalled();
    },
  );

  it("prioritizes economic profit over utility in fallback", () => {
    const f = fixture();
    vi.spyOn(ballistics, "searchBallisticSolution").mockReturnValue({ angle: 45, power: 50, err: 0, complete: true });
    vi.spyOn(physical, "resolvePhysicalShot").mockImplementation((_s, _t, _p, weapon) =>
      forecast({ damage: weapon === "GRENADE" ? [damage()] : [] }));
    // Economic fallback keeps the profitable free shot despite its lack of physical utility.
    const realReward = economics.calculateShotRewards;
    vi.spyOn(economics, "calculateShotRewards").mockImplementation((input) => ({ ...realReward(input),
      awards: [{ playerId: "self", amount: input.weaponId === "MISSILE" ? 10000 : 1, components: [] }],
    }));
    expect(chooseIdealExpertFallback(f.state, f.terrain, f.self, f.target, "GRENADE", createExpertForecastCache()))
      .toMatchObject({ weaponId: "MISSILE", useful: false });
  });

  it("uses net profit inside the same fallback category", () => {
    const f = fixture();
    vi.spyOn(ballistics, "searchBallisticSolution").mockReturnValue({ angle: 45, power: 50, err: 0, complete: true });
    vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(forecast({ damage: [damage()] }));
    expect(chooseIdealExpertFallback(f.state, f.terrain, f.self, f.target, "GRENADE", createExpertForecastCache()))
      .toMatchObject({ weaponId: "MISSILE", useful: true });
  });

  it("without economics prefers fewer human losses, then stable order", () => {
    const f = fixture();
    delete f.state.localShotContext;
    vi.spyOn(ballistics, "searchBallisticSolution").mockReturnValue({ angle: 45, power: 50, err: 0, complete: true });
    const resolve = vi.spyOn(physical, "resolvePhysicalShot").mockImplementation((_s, _t, _p, weapon) =>
      forecast({ damage: [damage()], humanDamageMilli: weapon === "GRENADE" ? 1000 : 500 }));
    expect(chooseIdealExpertFallback(f.state, f.terrain, f.self, f.target, "GRENADE", createExpertForecastCache()).weaponId)
      .toBe("MISSILE");
    resolve.mockReturnValue(forecast({ damage: [damage()], humanDamageMilli: 1000 }));
    expect(chooseIdealExpertFallback(f.state, f.terrain, f.self, f.target, "GRENADE", createExpertForecastCache()).weaponId)
      .toBe("GRENADE");
  });

  it("permits attributed collateral utility in EXPERT fallback", () => {
    const f = fixture();
    delete f.state.localShotContext;
    f.state.players.push(makePlayer({ id: "collateral", tank: makeTank("collateral", 450, 336) }));
    vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(forecast({ damage: [damage("collateral")] }));
    expect(chooseIdealExpertFallback(f.state, f.terrain, f.self, f.target, "MISSILE", createExpertForecastCache()).useful)
      .toBe(true);
  });

  it("never uses an incomplete forecast to certify fallback survival", () => {
    const f = fixture();
    delete f.state.localShotContext;
    vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue({ complete: false, survivors: ["self"],
      hits: [], damage: [], destruction: [], support: [], steps: 2400 });
    expect(chooseIdealExpertFallback(f.state, f.terrain, f.self, f.target, "GRENADE", createExpertForecastCache()))
      .toMatchObject({ weaponId: "MISSILE", policy: ORDINARY_AIM_POLICY });
  });

  it("bounds a two-weapon fallback to 48 proposals without new target groups", () => {
    const f = fixture();
    delete f.state.localShotContext;
    f.terrain.setMaterialRange(390, 409, TERRAIN_MATERIAL.SOFT);
    const cache = createExpertForecastCache();
    const search = vi.spyOn(ballistics, "searchBallisticSolution");
    chooseIdealExpertFallback(f.state, f.terrain, f.self, f.target, "DRILLER", cache);
    // DRILLER has eight points and MISSILE seven: 45 is below the adopted 48 ceiling.
    expect(search).toHaveBeenCalledTimes(45);
    expect(cache.diagnostics?.ownProposals).toBe(45);
    expect(search.mock.calls.every(([config]) => config.weaponId === "DRILLER" || config.weaponId === "MISSILE"))
      .toBe(true);
  });

  it.each([undefined, "unknown"])("missing/unknown profile %s routes to unchanged SIMPLE without advanced loads", async (profile) => {
    const f = fixture();
    f.self.tank.currentWeapon = "MISSILE";
    // Runtime data may contain an unknown profile; production routing must still use SIMPLE.
    Object.assign(f.self, { aiProfile: profile });
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const expected = await new AISimpleStrategy().executeTurn("self", f.state, f.terrain);
    const count = rng.mock.calls.length;
    rng.mockClear();
    const router = new AIByProfileStrategy();
    expect(await router.executeTurn("self", f.state, f.terrain)).toEqual(expected);
    expect(rng).toHaveBeenCalledTimes(count);
    expect(router).toMatchObject({ heuristic: null, sniper: null, smart: null });
  });
});

describe("EXPERT own/adverse boundary and material fallback", () => {
  it("vetoes own DRILLER on a mixed ROCK duo but still evaluates the individual off ROCK and adverse shots", () => {
    const f = fixture();
    const other = makePlayer({ id: "other", tank: makeTank("other", 650, 336) });
    f.state.players.push(other);
    f.state.localShotContext!.playerCountAtMatchStart = 3;
    f.terrain.setMaterialRange(650, 650, TERRAIN_MATERIAL.ROCK);
    const search = vi.spyOn(ballistics, "searchBallisticSolution");
    const cache = createExpertForecastCache();
    expect(evaluateExpertShot(f.state, f.terrain, f.self, "DRILLER", [f.target, other], false, false, cache, { mode: "own", aim: zeroAim }).destination)
      .toBe(-1);
    expect(search).not.toHaveBeenCalled();
    evaluateExpertShot(f.state, f.terrain, f.self, "DRILLER", [f.target], false, false, cache, { mode: "own", aim: zeroAim });
    expect(search).toHaveBeenCalled();
    search.mockClear();
    evaluateExpertShot(f.state, f.terrain, f.self, "DRILLER", [other], false, false, cache, { mode: "adverse" });
    expect(search).toHaveBeenCalled();
    expect(search.mock.calls.every(([config]) => config.selfHarmPenalty !== undefined)).toBe(true);
  });

  it("keeps adverse points and policy even when the opponent is EXPERT", () => {
    const f = fixture();
    f.terrain.setMaterialRange(390, 409, TERRAIN_MATERIAL.SOFT);
    f.target.aiProfile = "v4-smart";
    const cache = createExpertForecastCache();
    evaluateExpertShot(f.state, f.terrain, f.target, "MISSILE", [f.self], false, false, cache, { mode: "adverse" });
    expect(cache.search.size).toBe(3);
    expect([...cache.search.keys()].every((key) => key.includes('"penalizeProximity":true'))).toBe(true);
  });

  it("bounds eight own points to 24 proposals and separates policy caches", () => {
    const f = fixture();
    f.terrain.setMaterialRange(390, 409, TERRAIN_MATERIAL.SOFT);
    const search = vi.spyOn(ballistics, "searchBallisticSolution");
    const cache = createExpertForecastCache();
    evaluateExpertShot(f.state, f.terrain, f.self, "DRILLER", [f.target], false, false, cache, { mode: "own", aim: zeroAim });
    expect(search).toHaveBeenCalledTimes(24);
    expect(cache.search.size).toBe(24);
    search.mockClear();
    evaluateExpertShot(f.state, f.terrain, f.self, "DRILLER", [f.target], false, false, cache, { mode: "adverse" });
    expect(search).toHaveBeenCalledTimes(4);
  });

  it("reuses complete useless main forecasts in fallback, without a second main attempt", () => {
    const f = fixture();
    vi.spyOn(ballistics, "searchBallisticSolution").mockReturnValue({ angle: 90, power: 30, err: 0, complete: true });
    const resolve = vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(forecast());
    const cache = createExpertForecastCache();
    expect(evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [f.target], false, false, cache, { mode: "own", aim: zeroAim }).destination)
      .toBe(-1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(chooseIdealExpertFallback(f.state, f.terrain, f.self, f.target, "MISSILE", cache))
      .toMatchObject({ weaponId: "MISSILE", useful: false, policy: { penalizeProximity: false } });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("without economic context validates physics and explicitly keeps profit unavailable", () => {
    const f = fixture();
    delete f.state.localShotContext;
    const reward = vi.spyOn(economics, "calculateShotRewards");
    expect(chooseExpertPlan(f.self, f.state, f.terrain,
      createExpertDecisionAim({ currentTargetAttempts: 0 }, f.state.roundNumber))).toBeNull();
    const choice = chooseIdealExpertFallback(f.state, f.terrain, f.self, f.target, "MISSILE", createExpertForecastCache());
    expect(choice.forecast).toMatchObject({ complete: true, profit: null });
    expect(reward).not.toHaveBeenCalled();
  });

  it("falls back to ordinary MISSILE with proximity penalty if no complete shot proves survival", () => {
    const f = fixture();
    delete f.state.localShotContext;
    vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(forecast({ survivors: ["target"] }));
    const choice = chooseIdealExpertFallback(f.state, f.terrain, f.self, f.target, "DRILLER", createExpertForecastCache());
    expect(choice).toMatchObject({ kind: "ordinary", weaponId: "MISSILE", point: { x: 400, y: 330, kind: "tank" },
      policy: ORDINARY_AIM_POLICY, useful: false });
  });

  it("bounds ordinary BULLDOZER fallback to three direct-center proposals", () => {
    const f = fixture();
    delete f.state.localShotContext;
    const search = vi.spyOn(ballistics, "searchBallisticSolution");
    chooseIdealExpertFallback(f.state, f.terrain, f.self, f.target, "BULLDOZER", createExpertForecastCache());
    const bulldozer = search.mock.calls.filter(([config]) => config.weaponId === "BULLDOZER");
    expect(bulldozer).toHaveLength(3);
    expect(bulldozer.every(([config]) => config.tx === 400 && config.ty === 328.5)).toBe(true);
  });

  it("preserves SIMPLE commands and live RNG counts across all three materials", async () => {
    const commands: unknown[] = [];
    const calls: number[] = [];
    for (const material of Object.values(TERRAIN_MATERIAL)) {
      const f = fixture();
      f.self.aiProfile = "v1-random";
      f.self.tank.currentWeapon = "MISSILE";
      f.terrain.setMaterialRange(0, 799, material);
      const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
      commands.push(await new AISimpleStrategy().executeTurn("self", f.state, f.terrain));
      calls.push(rng.mock.calls.length);
      rng.mockRestore();
    }
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[2]).toEqual(commands[0]);
    expect(calls[1]).toBe(calls[0]);
    expect(calls[2]).toBe(calls[0]);
  });
});
