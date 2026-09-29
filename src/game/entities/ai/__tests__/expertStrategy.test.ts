import { afterEach, describe, expect, it, vi } from "vitest";
import { flatTerrain, makePlayer, makeTank } from "../../../__tests__/helpers";
import { AISmartStrategy } from "../AISmartStrategy";
import { chooseExpertPlan } from "../expertPlanner";
import { createExpertForecastCache, evaluateExpertShot, forecastPhysicalShot } from "../expertShotEvaluator";
import type { ExpertShotResult } from "../expertShotEvaluator";
import { solveExpertAim } from "../expertAim";
import * as ballistics from "../BallisticsSimulator";
import * as random from "../../../../utils/random";
import { finalizeAdvancedAim } from "../aimCorruption";
import type { GameState } from "../../../../types/game";
import { calculateShotRewards } from "../../../economy/shotRewards";
import { WEAPON_REGISTRY } from "../../../../types/weapon";
import { TERRAIN_MATERIAL } from "../../../../types/terrain";
import { TerrainManager } from "../../../engine/Terrain";

function fixture() {
  const terrain = flatTerrain(800, 480);
  const self = makePlayer({ id: "self", isHuman: false, aiProfile: "v4-smart",
    tank: makeTank("self", 100, 336), inventory: { MISSILE: 99 } });
  const enemy = makePlayer({ id: "enemy", isHuman: true,
    tank: makeTank("enemy", 400, 336), inventory: {} });
  const state: GameState = { phase: "COMBAT", players: [self, enemy],
    currentPlayerIndex: 0, turn: 2, roundNumber: 1, windForce: 0, gravity: 260,
    localShotContext: { playerCountAtMatchStart: 2, isFirstShotOfRound: true } };
  return { terrain, self, enemy, state };
}

afterEach(() => vi.restoreAllMocks());

describe("EXPERT full-shot forecast", () => {
  it("uses resolved damage and shooter reward without changing live state or RNG", () => {
    const f = fixture();
    const before = structuredClone(f.state.players);
    const heights = [...f.terrain.getHeightmap()];
    const materials = [...f.terrain.getMaterials()];
    const rng = vi.spyOn(random, "secureRandom");
    const command = solveExpertAim(f.self, 400, 328.5, 0, 260, f.terrain, "MISSILE");
    const result = forecastPhysicalShot(f.state, f.terrain, f.self, "MISSILE",
      finalizeAdvancedAim(command.command), true);
    expect(result.complete).toBe(true);
    expect(result.damage.some((event) => event.victimId === "enemy")).toBe(true);
    expect(result.profit).toBeGreaterThan(0);
    expect(f.state.players).toEqual(before);
    expect(f.terrain.getHeightmap()).toEqual(heights);
    expect(f.terrain.getMaterials()).toEqual(materials);
    expect(rng).not.toHaveBeenCalled();
  });

  it("credits a fall caused by the forecasted crater to the shooter", () => {
    const f = fixture();
    f.enemy.tank.health = 1000;
    const command = finalizeAdvancedAim(solveExpertAim(f.self, 400, 336, 0, 260,
      f.terrain, "MISSILE").command);
    const result = forecastPhysicalShot(f.state, f.terrain, f.self, "MISSILE",
      command, false);
    expect(result.complete).toBe(true);
    expect(result.damage.some((event) => event.victimId === "enemy" &&
      event.shooterId === "self" && event.source === "fall")).toBe(true);
  });

  it("uses the first-shot context and subtracts the ammunition price once", () => {
    const f = fixture();
    f.enemy.tank.health = 1;
    const missile = finalizeAdvancedAim(solveExpertAim(f.self, 400, 328.5, 0, 260,
      f.terrain, "MISSILE").command);
    const first = forecastPhysicalShot(f.state, f.terrain, f.self, "MISSILE", missile, true);
    const later = forecastPhysicalShot(f.state, f.terrain, f.self, "MISSILE", missile, false);
    expect(first.complete).toBe(true);
    expect(first.destruction.some((event) => event.victimId === "enemy")).toBe(true);
    expect(first.profit).toBeGreaterThan(later.profit);
    const nuke = forecastPhysicalShot(f.state, f.terrain, f.self, "NUKE", missile, true);
    const reward = calculateShotRewards({ shotId: 1, shooterId: "self", weaponId: "NUKE",
      playerCountAtMatchStart: 2, isFirstShotOfRound: true,
      aliveBeforeShot: ["self", "enemy"], survivorsAfterShot: [...nuke.survivors],
      damageEvents: [...nuke.damage], destructionEvents: [...nuke.destruction] });
    expect(nuke.profit).toBe(
      (reward.awards.find((award) => award.playerId === "self")?.amount ?? 0) -
      WEAPON_REGISTRY.NUKE.price);
  });

  it("resolves CLUSTER submunitions with a private RNG and one ammunition cost", () => {
    const f = fixture();
    const rng = vi.spyOn(random, "secureRandom");
    const command = finalizeAdvancedAim(solveExpertAim(f.self, 400, 328.5, 0, 260,
      f.terrain, "CLUSTER").command);
    const forecast = forecastPhysicalShot(f.state, f.terrain, f.self, "CLUSTER",
      command, true);
    expect(forecast.complete).toBe(true);
    expect(forecast.hits.length).toBeGreaterThan(0);
    expect(forecast.hits.length).toBeLessThanOrEqual(5);
    expect(rng).not.toHaveBeenCalled();
    const reward = calculateShotRewards({ shotId: 1, shooterId: "self", weaponId: "CLUSTER",
      playerCountAtMatchStart: 2, isFirstShotOfRound: true,
      aliveBeforeShot: ["self", "enemy"], survivorsAfterShot: [...forecast.survivors],
      damageEvents: [...forecast.damage], destructionEvents: [...forecast.destruction] });
    expect(forecast.profit).toBe(
      (reward.awards.find((award) => award.playerId === "self")?.amount ?? 0) -
      WEAPON_REGISTRY.CLUSTER.price);
  });

  it("copies the actual terrain materials once for a DRILLER forecast", () => {
    const f = fixture();
    f.terrain.setMaterialRange(380, 420, TERRAIN_MATERIAL.ROCK);
    const materials = [...f.terrain.getMaterials()];
    const load = vi.spyOn(TerrainManager.prototype, "loadHeights");
    const command = finalizeAdvancedAim(solveExpertAim(f.self, 381, 336, 0, 260,
      f.terrain, "DRILLER").command);
    forecastPhysicalShot(f.state, f.terrain, f.self, "DRILLER", command, true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][1]).toEqual(materials);
    expect(f.terrain.getMaterials()).toEqual(materials);
  });

  it("normalizes ideal commands and rejects incomplete searches and BULLDOZER", () => {
    const f = fixture();
    f.self.inventory.BULLDOZER = 1;
    const solver = vi.spyOn(ballistics, "searchBallisticSolution")
      .mockReturnValue({ angle: 45.44, power: 52.7, err: 0, complete: false });
    const result = evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE",
      [f.enemy], false, true, createExpertForecastCache());
    expect(result.destination).toBe(-1);
    expect(evaluateExpertShot(f.state, f.terrain, f.self, "BULLDOZER",
      [f.enemy], false, true, createExpertForecastCache()).destination).toBe(-1);
    expect(finalizeAdvancedAim(solveExpertAim(f.self, 400, 328.5, 0, 260, f.terrain, "MISSILE").command))
      .toEqual({ angle: 45.4, power: 53 });
    expect(solver).toHaveBeenCalled();
  });

  it("invalidates an unresolved physical forecast at its own step limit", () => {
    const f = fixture();
    f.state.gravity = 0;
    const forecast = forecastPhysicalShot(f.state, f.terrain, f.self, "MISSILE",
      { angle: 90, power: 99 }, false);
    expect(forecast.complete).toBe(false);
    expect(forecast.damage).toEqual([]);
    expect(forecast.destruction).toEqual([]);
    expect(ballistics.simulateShot(100, 336, 90, 99, 0, 0, f.terrain).complete).toBe(false);
  });

  it("treats an effect-free ground hit as invalid and permits a negative-profit hit", () => {
    const f = fixture();
    const miss = evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE",
      [f.enemy], false, true, createExpertForecastCache());
    expect(miss.destination).not.toBe(-1);
    f.self.inventory.NUKE = 1;
    const costly = evaluateExpertShot(f.state, f.terrain, f.self, "NUKE",
      [f.enemy], false, true, createExpertForecastCache());
    if (costly.destination !== -1) expect(costly.profit).toBeLessThan(miss.profit);
  });
});

describe("EXPERT decision and fallback", () => {
  it("selects a simulated candidate and updates aim memory only for the final shot", async () => {
    const f = fixture();
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const plan = chooseExpertPlan(f.self, f.state, f.terrain);
    expect(plan).not.toBeNull();
    const strategy = new AISmartStrategy();
    const shot = await strategy.executeTurn("self", f.state, f.terrain);
    expect(shot.weaponId).toBe(plan?.weaponId);
    expect(f.self.tank.currentWeapon).toBe(shot.weaponId);
    expect(f.self.tank.health).toBe(100);
  });

  it("logs the tactical reason and the final fallible command in development", async () => {
    const f = fixture();
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const shot = await new AISmartStrategy().executeTurn("self", f.state, f.terrain);
    const entry = log.mock.calls.find(([label]) => label === "[AI EXPERT] Décision")?.[1];
    expect(typeof entry).toBe("string");
    const decision = JSON.parse(String(entry)) as {
      phase: string;
      realAim: { horizontalOffset: number };
    };
    expect(decision).toMatchObject({
      shooterId: "self",
      round: 1,
      availableWeapons: ["MISSILE"],
      selected: { weaponId: shot.weaponId, profit: expect.any(Number) },
      realAim: {
        weaponId: shot.weaponId,
        targetId: "enemy",
        attemptsOnTarget: 1,
        gaffeOccurred: false,
        finalCommand: { angle: shot.angle, power: shot.power },
      },
    });
    expect(["SURVIE", "OPTIMISER_PROFIT"]).toContain(decision.phase);
    expect(decision.realAim.horizontalOffset).toBeGreaterThanOrEqual(45);
  });

  it("keeps the ordinary BULLDOZER fallback when forecasts are unavailable", async () => {
    const f = fixture();
    f.state.localShotContext = undefined;
    f.enemy.tank.position.x = 780;
    f.self.inventory.BULLDOZER = 1;
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const shot = await new AISmartStrategy().executeTurn("self", f.state, f.terrain);
    expect(shot.weaponId).toBe("BULLDOZER");
  });

  it("examines a four-player full-stock decision within per-shot bounds", () => {
    const f = fixture();
    const fullStock = { GRENADE: 2, CLUSTER: 2, NUKE: 2,
      THERMONUCLEAR: 2, DRILLER: 2, BULLET: 2, BULLDOZER: 2 };
    f.self.inventory = { ...fullStock };
    f.enemy.isHuman = false;
    f.enemy.aiProfile = "v2-heuristic";
    f.enemy.inventory = { ...fullStock };
    f.state.players.push(
      makePlayer({ id: "third", isHuman: false, aiProfile: "v3-sniper",
        tank: makeTank("third", 550, 336), inventory: { ...fullStock } }),
      makePlayer({ id: "fourth", isHuman: true,
        tank: makeTank("fourth", 700, 336), inventory: { ...fullStock } }),
    );
    f.state.localShotContext = { playerCountAtMatchStart: 4, isFirstShotOfRound: false };
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const start = performance.now();
    const plan = chooseExpertPlan(f.self, f.state, f.terrain);
    const elapsedMs = performance.now() - start;
    expect(plan).not.toBeNull();
    expect(elapsedMs).toBeLessThan(10_000);
  });
});

describe("EXPERT survival and profit ordering", () => {
  const invalid: ExpertShotResult = { destination: -1, profit: 0,
    destroyedIds: new Set(), shooterDestroyed: false, pointOrder: -1 };
  const valid = (x: number, profit: number, destroyed: string[]): ExpertShotResult => ({
    destination: { x, y: 320, kind: "tank" }, profit,
    destroyedIds: new Set(destroyed), shooterDestroyed: destroyed.includes("self"),
    pointOrder: 0,
  });

  function threePlayers() {
    const f = fixture();
    f.enemy.id = "early";
    f.enemy.tank.id = "early";
    f.enemy.isHuman = false;
    f.enemy.aiProfile = "v1-random";
    const later = makePlayer({ id: "later", isHuman: false, aiProfile: "v4-smart",
      tank: makeTank("later", 200, 336, { health: 10 }), inventory: {} });
    f.state.players.push(later);
    f.state.localShotContext = { playerCountAtMatchStart: 3, isFirstShotOfRound: true };
    return { ...f, later };
  }

  it("chooses the next living threat before a stronger profile and rolls once", () => {
    const f = threePlayers();
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0);
    const evaluate: typeof evaluateExpertShot = (_state, _terrain, shooter, weapon,
      targets, requireKill, firstShot) => {
      if (shooter.id === "early" && weapon === "MISSILE") {
        expect(firstShot).toBe(false);
        return valid(400, 1, ["self"]);
      }
      if (shooter.id === "later" && weapon === "MISSILE") return valid(200, 999, ["self"]);
      if (shooter.id === "self" && requireKill && targets[0].id === "early") {
        return valid(400, 10, ["early"]);
      }
      return invalid;
    };
    const traces: { phase: string; selectedThreatId?: string;
      survivalRoll?: number; transitionReason: string; candidateCount: number }[] = [];
    const plan = chooseExpertPlan(f.self, f.state, f.terrain, evaluate,
      (trace) => traces.push(trace));
    expect(plan?.point.x).toBe(400);
    expect(rng).toHaveBeenCalledTimes(1);
    expect(traces).toMatchObject([{
      phase: "SURVIE", selectedThreatId: "early", survivalRoll: 0,
      transitionReason: expect.stringContaining("early"), candidateCount: 2,
    }]);
  });

  it("falls through a failed survival roll to profit over all opponents", () => {
    const f = threePlayers();
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const evaluate: typeof evaluateExpertShot = (_state, _terrain, shooter, weapon,
      targets, requireKill) => {
      if (shooter.id === "early" && weapon === "MISSILE") return valid(400, 1, ["self"]);
      if (shooter.id === "self" && !requireKill && targets.length === 1 &&
          targets[0].id === "later") return valid(200, 20, []);
      return invalid;
    };
    const traces: { phase: string; selectedThreatId?: string;
      survivalRoll?: number; transitionReason: string;
      selected?: { primaryTargetId: string } }[] = [];
    expect(chooseExpertPlan(f.self, f.state, f.terrain, evaluate,
      (trace) => traces.push(trace))?.primaryTargetId).toBe("later");
    expect(rng).toHaveBeenCalledTimes(1);
    expect(traces).toMatchObject([{
      phase: "OPTIMISER_PROFIT", selectedThreatId: "early",
      survivalRoll: 0.99, transitionReason: expect.stringContaining("jet de SURVIE refusé"),
      selected: { primaryTargetId: "later" },
    }]);
  });

  it("allows a survival pair only when its first member dies and remembers the weaker other member", () => {
    const f = threePlayers();
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0);
    const evaluate: typeof evaluateExpertShot = (_state, _terrain, shooter, weapon,
      targets, requireKill) => {
      if (shooter.id === "early" && weapon === "MISSILE") return valid(400, 1, ["self"]);
      if (shooter.id === "self" && requireKill && targets.length === 2 &&
          targets[0].id === "early") return valid(300, -5, ["early"]);
      return invalid;
    };
    const plan = chooseExpertPlan(f.self, f.state, f.terrain, evaluate);
    expect(plan).toMatchObject({ primaryTargetId: "later", point: { x: 300 } });
    expect(rng).toHaveBeenCalledTimes(1);
  });

  it("enters survival without RNG for a score-one threat", () => {
    const f = fixture();
    f.enemy.isHuman = false;
    f.enemy.aiProfile = "v4-smart";
    const rng = vi.spyOn(random, "secureRandom");
    const evaluate: typeof evaluateExpertShot = (_state, _terrain, shooter, weapon,
      targets, requireKill) => {
      if (shooter.id === "enemy" && weapon === "MISSILE") return valid(400, 1, ["self"]);
      if (shooter.id === "self" && requireKill && targets[0].id === "enemy") {
        return valid(400, -10, ["enemy"]);
      }
      return invalid;
    };
    expect(chooseExpertPlan(f.self, f.state, f.terrain, evaluate)?.point.x).toBe(400);
    expect(rng).not.toHaveBeenCalled();
  });

  it("can choose a heavy against one threat, or reject it on net profit", () => {
    const f = fixture();
    f.enemy.isHuman = false;
    f.enemy.aiProfile = "v4-smart";
    f.self.inventory.NUKE = 1;
    const evaluate: typeof evaluateExpertShot = (_state, _terrain, shooter, weapon,
      targets, requireKill) => {
      if (shooter.id === "enemy" && weapon === "MISSILE") return valid(400, 1, ["self"]);
      if (shooter.id !== "self" || !requireKill || targets[0].id !== "enemy") return invalid;
      if (weapon === "NUKE") return valid(400, 20, ["enemy"]);
      return invalid;
    };
    expect(chooseExpertPlan(f.self, f.state, f.terrain, evaluate)?.weaponId).toBe("NUKE");
    const profitableMissile: typeof evaluateExpertShot = (...args) => {
      if (args[2].id === "self" && args[3] === "MISSILE" && args[5]) {
        return valid(400, 21, ["enemy"]);
      }
      return evaluate(...args);
    };
    expect(chooseExpertPlan(f.self, f.state, f.terrain, profitableMissile)?.weaponId)
      .toBe("MISSILE");
  });

  it("ranks survival before profit, then pair scores and roster turns", () => {
    const f = threePlayers();
    const evaluate: typeof evaluateExpertShot = (_state, _terrain, shooter, weapon,
      targets, requireKill) => {
      if (shooter.id !== "self" || requireKill || weapon !== "MISSILE") return invalid;
      if (targets.length === 1 && targets[0].id === "early") return valid(400, 10, []);
      if (targets.length === 1 && targets[0].id === "later") return valid(200, 10, []);
      if (targets.length === 2) return valid(300, 10, []);
      return invalid;
    };
    const plan = chooseExpertPlan(f.self, f.state, f.terrain, evaluate);
    expect(plan).toMatchObject({ primaryTargetId: "later", point: { x: 300 } });
    const suicidal: typeof evaluateExpertShot = (...args) => {
      if (args[2].id === "self" && args[4].length === 2) {
        return valid(300, 1000, ["self"]);
      }
      return evaluate(...args);
    };
    expect(chooseExpertPlan(f.self, f.state, f.terrain, suicidal)?.point.x).toBe(200);
  });
});
