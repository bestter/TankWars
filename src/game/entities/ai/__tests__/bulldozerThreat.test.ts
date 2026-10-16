import { afterEach, describe, expect, it, vi } from "vitest";
import { flatTerrain, makePlayer, makeTank } from "../../../__tests__/helpers";
import type { GameState } from "../../../../types/game";
import type { Player } from "../../../../types/player";
import { TERRAIN_MATERIAL } from "../../../../types/terrain";
import { MAX_BULLDOZER_PUSH, WEAPON_REGISTRY } from "../../../../types/weapon";
import * as random from "../../../../utils/random";
import { PhysicsEngine } from "../../../engine/PhysicsEngine";
import { TerrainManager } from "../../../engine/Terrain";
import { TankManager } from "../../TankManager";
import { calculateShotRewards, type CombatDamageEvent, type CombatDestructionEvent } from "../../../economy/shotRewards";
import { canThreatenWithBulldozer, evaluateBulldozerThreat, isBulldozerCorridorSafe } from "../bulldozerThreat";
import * as ballistics from "../BallisticsSimulator";
import * as physical from "../physicalShotForecast";
import { createExpertForecastCache, evaluateExpertShot, type ExpertShotResult } from "../expertShotEvaluator";
import { chooseExpertPlan, type ExpertDecisionTrace } from "../expertPlanner";
import { createExpertDecisionAim } from "../expertDecisionAim";

afterEach(() => vi.restoreAllMocks());

function fixture(selfX = 780, shooterX = 500) {
  const terrain = flatTerrain(800, 480, 300 / 480);
  const self = makePlayer({ id: "self", isHuman: false, aiProfile: "v4-smart", inventory: {},
    tank: makeTank("self", selfX, 300) });
  const shooter = makePlayer({ id: "shooter", isHuman: false, aiProfile: "v4-smart", inventory: { BULLDOZER: 2 },
    tank: makeTank("shooter", shooterX, 300) });
  const state: GameState = { phase: "COMBAT", players: [self, shooter], currentPlayerIndex: 0,
    turn: 2, roundNumber: 1, windForce: 0, gravity: 260,
    localShotContext: { playerCountAtMatchStart: 2, isFirstShotOfRound: true } };
  return { terrain, self, shooter, state };
}

function hit(targetId = "self", vx = 200): ballistics.DirectBulldozerTrajectory {
  return { terminal: "tank", targetId, x: 300, y: 295, vx, steps: 1, nearDistance: 0 };
}

describe("BULLDOZER adverse eligibility and safety proof", () => {
  it.each([
    [true, undefined, "MISSILE", true], [false, "v4-smart", "MISSILE", true],
    [false, "v2-heuristic", "MISSILE", true], [false, "v3-sniper", "BULLDOZER", false],
    [false, "v1-random", "MISSILE", false], [false, "v1-random", "BULLDOZER", true],
    [false, undefined, "MISSILE", false], [false, undefined, "BULLDOZER", true],
    [false, "unknown", "BULLDOZER", true], [false, "unknown", "MISSILE", false],
  ] as const)("human=%s profile=%s current=%s permits=%s", (isHuman, profile, currentWeapon, permitted) => {
    const f = fixture();
    Object.assign(f.shooter, { isHuman, aiProfile: profile });
    f.shooter.tank.currentWeapon = currentWeapon;
    expect(canThreatenWithBulldozer(f.shooter)).toBe(permitted);
    if (!permitted) expect(evaluateBulldozerThreat(f.state, f.terrain, f.shooter, f.self, createExpertForecastCache()))
      .toEqual({ best: null, simulations: 0 });
    f.shooter.inventory.BULLDOZER = 0;
    expect(evaluateBulldozerThreat(f.state, f.terrain, f.shooter, f.self, createExpertForecastCache()))
      .toEqual({ best: null, simulations: 0 });
    f.shooter.inventory.BULLDOZER = 1;
    f.shooter.tank.isDead = true;
    expect(canThreatenWithBulldozer(f.shooter)).toBe(false);
  });

  it("proves a full flat corridor safe in both directions with no possible recoil interaction", () => {
    const f = fixture(450, 100);
    expect(isBulldozerCorridorSafe(f.self, f.state.players, f.terrain)).toBe(true);
    expect(evaluateBulldozerThreat(f.state, f.terrain, f.shooter, f.self, createExpertForecastCache()))
      .toEqual({ best: null, simulations: 0 });
  });

  it.each(["edge", "slope", "airborne", "other-airborne", "collision", "recoil", "lava", "zero-health"])(
    "does not certify an uncertain %s configuration", (kind) => {
      const f = fixture(450, 100);
      const heights = [...f.terrain.getHeightmap()];
      if (kind === "edge") f.self.tank.position.x = 50;
      if (kind === "slope") heights[460] = 301;
      if (kind === "airborne") f.self.tank.position.y--;
      if (kind === "other-airborne") f.shooter.tank.position.y--;
      if (kind === "collision") f.shooter.tank.position.x = 475;
      if (kind === "recoil") f.shooter.tank.position.x = 240;
      if (kind === "lava") { heights.fill(474); f.self.tank.position.y = 474; }
      if (kind === "zero-health") f.self.tank.health = 0;
      f.terrain.loadHeights(heights);
      expect(isBulldozerCorridorSafe(f.self, f.state.players, f.terrain)).toBe(false);
      expect(evaluateBulldozerThreat(f.state, f.terrain, f.shooter, f.self, createExpertForecastCache()).simulations)
        .toBeGreaterThan(0);
    });

  it("searches a short dangerous pit even when both maximum endpoints are safe", () => {
    const f = fixture(450, 100);
    const heights = [...f.terrain.getHeightmap()];
    for (let x = 460; x <= 480; x++) heights[x] = 480;
    f.terrain.loadHeights(heights);
    expect(f.terrain.getHeightAt(450 - MAX_BULLDOZER_PUSH)).toBe(300);
    expect(f.terrain.getHeightAt(450 + MAX_BULLDOZER_PUSH)).toBe(300);
    expect(isBulldozerCorridorSafe(f.self, f.state.players, f.terrain)).toBe(false);
    expect(evaluateBulldozerThreat(f.state, f.terrain, f.shooter, f.self, createExpertForecastCache()).simulations)
      .toBeGreaterThan(0);
  });
});

describe("isolated impact agrees with combat", () => {
  it.each(["flat", "blocked", "wall", "slope", "survivable-fall", "lethal-fall", "buried", "lava", "edge", "recoil", "zero-vx"])(
    "resolves %s using the engine's displacement, attribution and settlement", (kind) => {
      const f = fixture(300, 100);
      const heights = [...f.terrain.getHeightmap()];
      if (kind === "blocked") f.state.players.push(makePlayer({ id: "block", tank: makeTank("block", 330, 300) }));
      if (kind === "wall") for (let x = 320; x < 390; x++) heights[x] = 200;
      if (kind === "slope") for (let x = 301; x < 390; x++) heights[x] = 300 - (x - 300) * 0.5;
      if (kind.includes("fall")) {
        for (let x = 320; x < 390; x++) heights[x] = 380;
        if (kind === "lethal-fall") f.self.tank.health = 10;
      }
      if (kind === "buried") for (let x = 320; x < 390; x++) heights[x] = 480;
      if (kind === "lava") {
        heights.fill(400);
        f.self.tank.position.y = 400; f.shooter.tank.position.y = 400;
        for (let x = 301; x < 800; x++) heights[x] = Math.min(480, 400 + x - 300);
      }
      if (kind === "edge") { f.self.tank.position.x = 780; }
      if (kind === "recoil") { f.shooter.tank.position.x = 20; f.self.tank.position.x = 780; }
      f.terrain.loadHeights(heights, Array.from({ length: 800 }, () => TERRAIN_MATERIAL.ROCK));
      const impact = { ...hit("self", kind === "zero-vx" ? 0 : kind === "lava" ? 1000 : 200),
        x: f.self.tank.position.x, y: f.self.tank.position.y - 5 };
      const before = structuredClone(f.state);
      const rng = vi.spyOn(random, "secureRandom");
      const launch = vi.spyOn(PhysicsEngine.prototype, "launchProjectile");
      const predicted = physical.resolveBulldozerImpact(f.state, f.terrain, f.shooter, impact);
      expect(launch).not.toHaveBeenCalled();
      expect(rng).not.toHaveBeenCalled();
      expect(f.state).toEqual(before);
      const players: Player[] = structuredClone(f.state.players);
      const tanks = new TankManager(); tanks.setPlayers(players);
      const copiedTerrain = new TerrainManager(800, 480);
      copiedTerrain.loadHeights([...f.terrain.getHeightmap()], [...f.terrain.getMaterials()]);
      const damage: CombatDamageEvent[] = [];
      const destruction: CombatDestructionEvent[] = [];
      tanks.onDamageApplied = (event) => damage.push(event);
      tanks.onTankDestroyed = (event) => destruction.push(event);
      tanks.beginShotAttribution(1, f.shooter.id, "BULLDOZER");
      const engine = new PhysicsEngine(() => { throw new Error("unexpected RNG"); }, false);
      engine.launchProjectile(impact.x - impact.vx / 120, impact.y, 0, 0, "BULLDOZER", f.shooter.id,
        undefined, { shotId: 1, munitionId: 0 });
      engine.getProjectiles()[0].vx = impact.vx / (1 - 0.28 / 120);
      for (let step = 0; step < 2400; step++) {
        engine.updateProjectiles(1 / 120, 0, 0, copiedTerrain, tanks);
        tanks.applyGravity(1 / 120, copiedTerrain); tanks.checkTankBurial(copiedTerrain);
        if (!engine.hasActiveProjectiles() && !tanks.anyTankIsFalling()) break;
      }
      expect(predicted.complete).toBe(true);
      expect(predicted.damage).toEqual(damage);
      expect(predicted.destruction).toEqual(destruction);
      expect(predicted.survivors).toEqual(tanks.getAlivePlayers().map((player) => player.id));
      expect(players.every((player) => !player.tank.hitReaction?.wasDirectHit && !player.tank.lastDirectAttackerId)).toBe(true);
      if (kind === "lethal-fall") expect(damage).toContainEqual(expect.objectContaining({
        victimId: "self", classification: "direct", source: "fall", shieldLostMilli: 0,
      }));
      if (["lethal-fall", "buried", "lava", "edge", "recoil"].includes(kind)) expect(predicted.survivors).not.toContain("self");
      else expect(predicted.survivors).toContain("self");
      if (kind === "recoil") expect(predicted.survivors).not.toContain("shooter");
      if (kind === "lava") expect(predicted.destruction).toContainEqual(expect.objectContaining({ victimId: "self", cause: "lava" }));
    });

  it("rejects a fall that cannot settle within 2400 steps", () => {
    const f = fixture(300, 100);
    f.self.tank.health = 10000;
    const heights = [...f.terrain.getHeightmap()]; heights.fill(900, 320);
    const terrain = new TerrainManager(800, 1500); terrain.loadHeights(heights);
    const result = physical.resolveBulldozerImpact(f.state, terrain, f.shooter, hit());
    expect(result).toMatchObject({ complete: false, steps: 2400, damage: [], destruction: [] });
  });
});

describe("bounded threat search, profit and cache", () => {
  it("caches the absence of economic context without searching, resolving, planning or drawing RNG", () => {
    const f = fixture();
    f.state.localShotContext = undefined;
    const cache = createExpertForecastCache();
    const search = vi.spyOn(ballistics, "searchDirectBulldozerSolutions");
    const resolve = vi.spyOn(physical, "resolveBulldozerImpact");
    const rng = vi.spyOn(random, "secureRandom");
    const evaluate = vi.fn<typeof evaluateExpertShot>();
    const trace = vi.fn();

    const first = evaluateBulldozerThreat(f.state, f.terrain, f.shooter, f.self, cache);
    expect(first).toEqual({ best: null, simulations: 0 });
    expect(cache.bulldozer.get(f.shooter.id)).toBe(first);
    expect(evaluateBulldozerThreat(f.state, f.terrain, f.shooter, f.self, cache)).toBe(first);
    expect(chooseExpertPlan(f.self, f.state, f.terrain,
      createExpertDecisionAim({ currentTargetAttempts: 0 }, 1), evaluate, trace, cache)).toBeNull();
    expect(trace).toHaveBeenCalledOnce();
    expect(trace.mock.calls[0][0]).toEqual({
      phase: "REPLI", transitionReason: "contexte économique absent : plan principal indisponible",
      threats: [], survivalCandidateCount: 0, availableWeapons: [], candidateCount: 0, bestByWeapon: [],
    });
    expect(search).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(rng).not.toHaveBeenCalled();
  });

  it("demonstrates a real edge kill, matches the launched command and leaves all live state untouched", () => {
    const f = fixture();
    const before = structuredClone(f.state);
    const heights = [...f.terrain.getHeightmap()], materials = [...f.terrain.getMaterials()];
    const rng = vi.spyOn(random, "secureRandom");
    const launch = vi.spyOn(PhysicsEngine.prototype, "launchProjectile");
    const logging = vi.spyOn(console, "log");
    const cache = createExpertForecastCache();
    const result = evaluateBulldozerThreat(f.state, f.terrain, f.shooter, f.self, cache);
    expect(result.best).not.toBeNull();
    expect(result.simulations).toBeLessThanOrEqual(512);
    expect(result.best).toMatchObject({ expertDestroyed: true, shooterDestroyed: false });
    expect(rng).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled(); expect(logging).not.toHaveBeenCalled();
    expect(f.state).toEqual(before); expect(f.terrain.getHeightmap()).toEqual(heights); expect(f.terrain.getMaterials()).toEqual(materials);
    expect(evaluateBulldozerThreat(f.state, f.terrain, f.shooter, f.self, cache)).toBe(result);
    const again = evaluateBulldozerThreat(f.state, f.terrain, f.shooter, f.self, createExpertForecastCache());
    expect(again).not.toBe(result); expect(again).toEqual(result);
    const best = result.best!;
    const real = physical.resolvePhysicalShot(f.state, f.terrain, f.shooter, "BULLDOZER", best.command);
    expect(real.complete).toBe(true);
    expect(real.hits).toEqual(best.forecast.hits); expect(real.destruction).toEqual(best.forecast.destruction);
    const rewards = calculateShotRewards({ shotId: 1, shooterId: f.shooter.id, weaponId: "BULLDOZER",
      playerCountAtMatchStart: 2, isFirstShotOfRound: false, aliveBeforeShot: ["self", "shooter"],
      survivorsAfterShot: [...real.survivors], damageEvents: [...real.damage], destructionEvents: [...real.destruction] });
    expect(best.profit).toBe((rewards.awards.find((award) => award.playerId === "shooter")?.amount ?? 0) - WEAPON_REGISTRY.BULLDOZER.price);
    f.state.localShotContext!.isFirstShotOfRound = false;
    expect(evaluateBulldozerThreat(f.state, f.terrain, f.shooter, f.self, createExpertForecastCache()).best?.profit).toBe(best.profit);
  });

  it("caches a negative search without a second trajectory campaign", () => {
    const f = fixture(300, 100);
    const search = vi.spyOn(ballistics, "searchDirectBulldozerSolutions");
    const cache = createExpertForecastCache();
    const first = evaluateBulldozerThreat(f.state, f.terrain, f.shooter, f.self, cache);
    expect(first.best).toBeNull(); expect(first.simulations).toBeGreaterThan(0);
    expect(evaluateBulldozerThreat(f.state, f.terrain, f.shooter, f.self, cache)).toBe(first);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("rejects zero push and incomplete consequences without presuming a death", () => {
    const f = fixture();
    vi.spyOn(ballistics, "searchDirectBulldozerSolutions").mockImplementation(function* () {
      yield { command: { angle: 45, power: 50 }, trajectory: hit("self", 0) };
      yield { command: { angle: 45, power: 51 }, trajectory: hit("self", 200) };
    });
    const resolve = vi.spyOn(physical, "resolveBulldozerImpact").mockReturnValue({ complete: false,
      steps: 2400, hits: [], damage: [], destruction: [], survivors: [], support: [] });
    expect(evaluateBulldozerThreat(f.state, f.terrain, f.shooter, f.self, createExpertForecastCache()))
      .toEqual({ simulations: 2, best: null });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("keeps an earlier demonstrated kill when the ceiling's remaining hits cannot resolve", () => {
    const f = fixture();
    const complete = physical.resolveBulldozerImpact(f.state, f.terrain, f.shooter, { ...hit(), vx: 1000 });
    vi.spyOn(ballistics, "searchDirectBulldozerSolutions").mockImplementation(function* () {
      for (let i = 0; i < 512; i++) yield { command: { angle: 15 + i / 10, power: 50 }, trajectory: hit() };
    });
    const resolve = vi.spyOn(physical, "resolveBulldozerImpact").mockReturnValue({ complete: false,
      steps: 2400, hits: [], damage: [], destruction: [], survivors: [], support: [] }).mockReturnValueOnce(complete);
    const result = evaluateBulldozerThreat(f.state, f.terrain, f.shooter, f.self, createExpertForecastCache());
    expect(result.simulations).toBe(512); expect(resolve).toHaveBeenCalledTimes(512);
    expect(result.best?.command).toEqual({ angle: 15, power: 50 });
  });

  it("continues to the ceiling and ranks shooter survival, profit, then traversal order", () => {
    const f = fixture();
    // Explicit bounded trajectory double: physical/economic ranking is exercised separately from aiming.
    vi.spyOn(ballistics, "searchDirectBulldozerSolutions").mockImplementation(function* () {
      for (let i = 0; i < 512; i++) yield { command: { angle: 15 + i / 10, power: 50 }, trajectory: hit() };
    });
    const resolve = vi.spyOn(physical, "resolveBulldozerImpact");
    const base = physical.resolveBulldozerImpact(f.state, f.terrain, f.shooter, { ...hit(), vx: 1000 });
    if (!base.complete) throw new Error("fixture must resolve");
    resolve.mockImplementationOnce(() => ({ ...base, survivors: [] }))
      .mockImplementationOnce(() => ({ ...base, survivors: ["shooter"], destruction: [] }))
      .mockImplementation(() => ({ ...base, survivors: ["shooter"] }));
    const result = evaluateBulldozerThreat(f.state, f.terrain, f.shooter, f.self, createExpertForecastCache());
    expect(result.simulations).toBe(512);
    expect(result.best?.command.angle).toBe(15.2);
    expect(result.best?.shooterDestroyed).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(513); // one real fixture plus 512 candidate resolutions
  });
});

describe("SURVIE integration", () => {
  const invalid: ExpertShotResult = { destination: -1, profit: 0, destroyedIds: new Set(), shooterDestroyed: false, pointOrder: -1 };
  it.each(["v4-smart", "v2-heuristic", "v1-random", undefined] as const)(
    "a sole BULLDOZER threat uses the existing %s score/roll and own command contract", (profile) => {
      const f = fixture(); f.shooter.aiProfile = profile; f.shooter.tank.currentWeapon = "BULLDOZER";
      const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0);
      let trace: ExpertDecisionTrace | undefined;
      const evaluate = vi.fn<typeof evaluateExpertShot>((_state, _terrain, shooter, weapon, targets, requireKill) => {
        expect(weapon).not.toBe("BULLDOZER");
        if (shooter.id !== "self") return invalid;
        return { kind: "evaluated", primaryTargetId: targets[0].id, attempts: 1, offset: 36,
          requestedPoint: { x: 536, y: 292.5 }, policy: { variant: "full", penalizeProximity: false },
          rawCommand: { angle: 150, power: 52.5 }, command: { angle: 150, power: 53 },
          destination: { x: 500, y: 292.5, kind: "tank" }, profit: requireKill ? -100 : 0,
          destroyedIds: new Set(["shooter"]), shooterDestroyed: false, pointOrder: 0,
          humanDestroyedCount: 0, humanDamageMilli: 0, aiDestroyedCount: 1, aiDamageMilli: 100000 };
      });
      const plan = chooseExpertPlan(f.self, f.state, f.terrain,
        createExpertDecisionAim({ currentTargetAttempts: 0 }, 1), evaluate, (event) => { trace = event; });
      expect(trace).toMatchObject({ phase: "SURVIE", selectedThreatId: "shooter",
        threats: [{ playerId: "shooter", weaponId: "BULLDOZER" }] });
      expect(rng).toHaveBeenCalledTimes(profile === "v4-smart" ? 2 : 3);
      expect(plan?.command).toEqual({ angle: 150, power: 53 });
      expect(plan?.weaponId).toBe("MISSILE");
    });

  it("keeps next living turn priority with concurrent threats and falls back after a refused roll", () => {
    const f = fixture(); f.shooter.aiProfile = "v2-heuristic";
    const other = makePlayer({ id: "other", aiProfile: "v4-smart", isHuman: false, tank: makeTank("other", 100, 300) });
    f.state.players.push(other);
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0.75);
    const trace = vi.fn();
    const evaluate: typeof evaluateExpertShot = (_state, _terrain, shooter) => shooter.id === "other" ? {
      kind: "evaluated", primaryTargetId: "self", attempts: 0, offset: 0,
      requestedPoint: { x: 780, y: 300 }, policy: { variant: "full", penalizeProximity: true },
      rawCommand: { angle: 45, power: 50 }, command: { angle: 45, power: 50 },
      destination: { x: 780, y: 300, kind: "tank" }, profit: 999,
      destroyedIds: new Set(["self"]), shooterDestroyed: false, pointOrder: 0,
      humanDestroyedCount: 0, humanDamageMilli: 0, aiDestroyedCount: 1, aiDamageMilli: 100000,
    } : invalid;
    chooseExpertPlan(f.self, f.state, f.terrain, createExpertDecisionAim({ currentTargetAttempts: 0 }, 1), evaluate, trace);
    expect(trace.mock.calls[0][0]).toMatchObject({ phase: "REPLI", selectedThreatId: "shooter", survivalRoll: 0.75,
      threats: [{ playerId: "shooter", weaponId: "BULLDOZER" }, { playerId: "other", weaponId: "MISSILE" }] });
    expect(rng).toHaveBeenCalledTimes(3);
  });

  it.each([
    { criterion: "BULLDOZER survival", missileProfit: 100, missileSuicide: true,
      grenadeProfit: 200, grenadeSuicide: true, bulldozerSuicide: false, expected: "BULLDOZER", profit: 0 },
    { criterion: "ordinary survival", missileProfit: -100, missileSuicide: false,
      grenadeProfit: 200, grenadeSuicide: true, bulldozerSuicide: true, expected: "MISSILE", profit: -100 },
    { criterion: "later ordinary survival", missileProfit: 200, missileSuicide: true,
      grenadeProfit: -100, grenadeSuicide: false, bulldozerSuicide: true, expected: "GRENADE", profit: -100 },
    { criterion: "BULLDOZER profit", missileProfit: -2, missileSuicide: false,
      grenadeProfit: -1, grenadeSuicide: false, bulldozerSuicide: false, expected: "BULLDOZER", profit: 0 },
    { criterion: "later ordinary profit", missileProfit: 1, missileSuicide: false,
      grenadeProfit: 2, grenadeSuicide: false, bulldozerSuicide: false, expected: "GRENADE", profit: 2 },
    { criterion: "stable ordinary ties", missileProfit: 1, missileSuicide: false,
      grenadeProfit: 1, grenadeSuicide: false, bulldozerSuicide: false, expected: "MISSILE", profit: 1 },
    { criterion: "stable BULLDOZER tie", missileProfit: 0, missileSuicide: false,
      grenadeProfit: 0, grenadeSuicide: false, bulldozerSuicide: false, expected: "MISSILE", profit: 0 },
    { criterion: "stable later ordinary/BULLDOZER tie", missileProfit: -1, missileSuicide: false,
      grenadeProfit: 0, grenadeSuicide: false, bulldozerSuicide: false, expected: "GRENADE", profit: 0 },
  ])("traces the winning weapon under $criterion without changing the plan or RNG", (scenario) => {
    const f = fixture();
    f.shooter.inventory = { BULLDOZER: 2, GRENADE: 1, NUKE: 3, THERMONUCLEAR: 4 };
    const cache = createExpertForecastCache();
    const bulldozer = evaluateBulldozerThreat(f.state, f.terrain, f.shooter, f.self, cache);
    if (!bulldozer.best) throw new Error("fixture must demonstrate a lethal BULLDOZER threat");
    const baseProfit = bulldozer.best.profit;
    cache.bulldozer.set(f.shooter.id, { ...bulldozer,
      best: { ...bulldozer.best, shooterDestroyed: scenario.bulldozerSuicide } });
    const evaluate: typeof evaluateExpertShot = (_state, _terrain, shooter, weapon) => {
      if (shooter.id === f.self.id) return invalid;
      expect(["NUKE", "THERMONUCLEAR"]).not.toContain(weapon);
      const suicide = weapon === "MISSILE" ? scenario.missileSuicide : scenario.grenadeSuicide;
      return {
        kind: "evaluated", primaryTargetId: "self", attempts: 0, offset: 0,
        requestedPoint: { x: 780, y: 300 }, policy: { variant: "full", penalizeProximity: true },
        rawCommand: { angle: 45, power: 50 }, command: { angle: 45, power: 50 },
        destination: { x: 780, y: 300, kind: "tank" },
        profit: baseProfit + (weapon === "MISSILE" ? scenario.missileProfit : scenario.grenadeProfit),
        destroyedIds: new Set(suicide ? ["self", "shooter"] : ["self"]),
        shooterDestroyed: suicide, pointOrder: 0,
        humanDestroyedCount: 0, humanDamageMilli: 0, aiDestroyedCount: 1, aiDamageMilli: 100000,
      };
    };
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0);
    const trace = vi.fn();
    const withTrace = chooseExpertPlan(f.self, f.state, f.terrain,
      createExpertDecisionAim({ currentTargetAttempts: 0 }, 1), evaluate, trace, cache);
    expect(trace.mock.calls[0][0]).toMatchObject({
      phase: "REPLI", selectedThreatId: "shooter", threats: [{
        playerId: "shooter", weaponId: scenario.expected, lethalProfit: baseProfit + scenario.profit,
      }],
    });
    expect(rng).toHaveBeenCalledTimes(2);
    rng.mockClear();
    expect(chooseExpertPlan(f.self, f.state, f.terrain,
      createExpertDecisionAim({ currentTargetAttempts: 0 }, 1), evaluate, undefined, cache)).toEqual(withTrace);
    expect(rng).toHaveBeenCalledTimes(2);
  });
});
