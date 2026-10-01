import { afterEach, describe, expect, it, vi } from "vitest";
import { flatTerrain, makePlayer, makeTank } from "../../../__tests__/helpers";
import { AISmartStrategy } from "../AISmartStrategy";
import { chooseExpertPlan } from "../expertPlanner";
import { createExpertForecastCache, evaluateExpertShot, expertTacticalPoints, forecastPhysicalShot } from "../expertShotEvaluator";
import type { ExpertShotResult, ValidExpertShotResult } from "../expertShotEvaluator";
import { aggregateExpertConsequences, type ExpertConsequences } from "../expertConsequences";
import { normalizeDamageToMilli } from "../../../economy/fixedPoint";
import type { CombatDamageEvent, CombatDestructionEvent } from "../../../economy/shotRewards";
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

const equalConsequences: ExpertConsequences = {
  humanDestroyedCount: 1, humanDamageMilli: 10, aiDestroyedCount: 1, aiDamageMilli: 10,
};
const consequenceCases = [
  { key: "humanDestroyedCount", winner: { ...equalConsequences, humanDestroyedCount: 0,
    humanDamageMilli: 999, aiDestroyedCount: 0, aiDamageMilli: 0 }, reason: "moins d'humains détruits" },
  { key: "humanDamageMilli", winner: { ...equalConsequences, humanDamageMilli: 9,
    aiDestroyedCount: 0, aiDamageMilli: 0 }, reason: "moins de dégâts aux humains" },
  { key: "aiDestroyedCount", winner: { ...equalConsequences, aiDestroyedCount: 2,
    aiDamageMilli: 0 }, reason: "davantage d'IA détruites" },
  { key: "aiDamageMilli", winner: { ...equalConsequences, aiDamageMilli: 11 },
    reason: "davantage de dégâts aux IA" },
];

function forecastDamage(overrides: Partial<CombatDamageEvent> = {}): CombatDamageEvent {
  return { shotId: 1, munitionId: 0, shooterId: "self", victimId: "enemy", weaponId: "CLUSTER",
    source: "projectile", classification: "direct", shieldAbsorbedMilli: 500,
    shieldLostMilli: 1_000, healthDamageMilli: 2_000, ...overrides };
}

function forecastDestruction(overrides: Partial<CombatDestructionEvent> = {}): CombatDestructionEvent {
  return { shotId: 1, shooterId: "self", victimId: "enemy", weaponId: "CLUSTER",
    cause: "health-zero", ...overrides };
}

describe("EXPERT #267 consequences", () => {
  it("retains the real later ground forecast that avoids collateral human fall damage at equal profit", () => {
    const f = fixture();
    f.enemy.isHuman = false;
    f.enemy.tank.health = 1;
    f.state.players.push(makePlayer({ id: "collateral", isHuman: true,
      tank: makeTank("collateral", 360, 336, { health: 1000 }) }));
    f.state.localShotContext!.playerCountAtMatchStart = 3;
    f.terrain.loadHeights([...f.terrain.getHeightmap()],
      Array.from({ length: f.terrain.width }, () => TERRAIN_MATERIAL.DIRT));
    const points = expertTacticalPoints(f.self, [f.enemy], "MISSILE", f.terrain, f.state.players);
    const forecasts = points.slice(1).map((point) => forecastPhysicalShot(f.state, f.terrain, f.self, "MISSILE",
      finalizeAdvancedAim(solveExpertAim(f.self, point.x, point.y, 0, 260, f.terrain, "MISSILE").command), false));
    expect(forecasts[0]).toMatchObject({ complete: true, profit: 91, humanDamageMilli: 2000 });
    expect(forecasts[1]).toMatchObject({ complete: true, profit: 91, humanDamageMilli: 0 });
    expect(forecasts[0].damage).toContainEqual(expect.objectContaining({
      victimId: "collateral", source: "fall", shieldLostMilli: 0,
    }));
    const cache = createExpertForecastCache();
    // Isolate the two valid ground points; both use the real solver and full physics.
    cache.search.set(JSON.stringify(["self", "MISSILE", points[0].x, points[0].y, 0, 260, { variant: "full", penalizeProximity: true }]),
      { command: { angle: 45, power: 50 }, complete: false });
    const before = structuredClone(f.state.players);
    const rng = vi.spyOn(random, "secureRandom");
    expect(evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [f.enemy], false, false, cache))
      .toMatchObject({ pointOrder: 2, profit: 91, humanDamageMilli: 0 });
    expect(f.state.players).toEqual(before);
    expect(rng).not.toHaveBeenCalled();
  });

  it.each(consequenceCases)("keeps the later tactical point on $key before reducing a group", ({ winner }) => {
    const f = fixture();
    const cache = createExpertForecastCache();
    const points = expertTacticalPoints(f.self, [f.enemy], "MISSILE", f.terrain, f.state.players);
    for (const [index, point] of points.entries()) {
      const command = { angle: 45 + index, power: 50 };
      cache.search.set(JSON.stringify(["self", "MISSILE", point.x, point.y, 0, 260, { variant: "full", penalizeProximity: true }]),
        { command, complete: index < 2 });
      cache.physics.set(JSON.stringify(["self", "MISSILE", command.angle, command.power, 0, 260, 2, false]), {
        complete: true, ...(index === 0 ? equalConsequences : winner),
        hits: [{ shotId: 1, munitionId: 0, x: point.x, y: point.y,
          weaponId: "MISSILE", directTargetId: "enemy" }],
        support: [], steps: 1,
        damage: [forecastDamage()], destruction: [], survivors: ["self", "enemy"], profit: 100,
      });
    }
    const result = evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [f.enemy], false, false, cache);
    expect(result).toMatchObject({ pointOrder: 1, ...winner });
  });

  it.each(["safety", "profit", "stable", "required-kill"] as const)(
    "keeps the tactical point contract for %s ahead of the human preference", (criterion) => {
      const f = fixture();
      const cache = createExpertForecastCache();
      const points = expertTacticalPoints(f.self, [f.enemy], "MISSILE", f.terrain, f.state.players);
      for (const [index, point] of points.entries()) {
        const command = { angle: 45 + index, power: 50 };
        cache.search.set(JSON.stringify(["self", "MISSILE", point.x, point.y, 0, 260, { variant: "full", penalizeProximity: true }]),
          { command, complete: index < 2 });
        const destruction = index === 0 ? [forecastDestruction()] :
          criterion === "required-kill" ? [] : [forecastDestruction(),
            ...(criterion === "safety" ? [forecastDestruction({ victimId: "self" })] : [])];
        cache.physics.set(JSON.stringify(["self", "MISSILE", command.angle, command.power, 0, 260, 2, false]), {
          complete: true, ...equalConsequences,
          humanDamageMilli: criterion === "stable" || index === 0 ? 10 : 9,
          hits: [{ shotId: 1, munitionId: 0, x: point.x, y: point.y,
            weaponId: "MISSILE", directTargetId: "enemy" }],
          support: [], steps: 1,
          damage: [forecastDamage()], destruction, survivors: ["self"],
          profit: criterion === "profit" && index === 0 ? 101 : 100,
        });
      }
      expect(evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [f.enemy],
        criterion === "required-kill", false, cache)).toMatchObject({ pointOrder: 0 });
    });

  for (const phase of ["SURVIE", "OPTIMISER_PROFIT"] as const) {
    it.each(consequenceCases)(`${phase} chooses and diagnoses the later candidate on $key`, ({ winner, reason }) => {
      const f = fixture();
      f.self.inventory.NUKE = 1;
      const invalid: ExpertShotResult = { destination: -1, profit: 0,
        destroyedIds: new Set(), shooterDestroyed: false, pointOrder: -1 };
      const evaluate: typeof evaluateExpertShot = (_state, _terrain, shooter, weapon) => {
        if (shooter.id !== "self") {
          return phase === "SURVIE" ? {
            destination: { x: 100, y: 320, kind: "tank" }, profit: 0,
            destroyedIds: new Set(["self"]), shooterDestroyed: false, pointOrder: 0,
            ...equalConsequences,
          } : invalid;
        }
        return {
          destination: { x: weapon === "MISSILE" ? 400 : 420, y: 320, kind: "tank" },
          profit: 100, destroyedIds: new Set(["enemy"]), shooterDestroyed: false, pointOrder: 0,
          ...(weapon === "MISSILE" ? equalConsequences : winner),
        };
      };
      const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0);
      const trace = vi.fn();
      const withTrace = chooseExpertPlan(f.self, f.state, f.terrain, evaluate, trace);
      expect(rng).toHaveBeenCalledTimes(phase === "SURVIE" ? 1 : 0);
      rng.mockClear();
      const withoutTrace = chooseExpertPlan(f.self, f.state, f.terrain, evaluate);
      expect(withoutTrace).toEqual(withTrace);
      expect(rng).toHaveBeenCalledTimes(phase === "SURVIE" ? 1 : 0);
      expect(withTrace?.weaponId).toBe("NUKE");
      expect(trace.mock.calls[0][0]).toMatchObject({
        phase, selectionReason: reason, selected: { weaponId: "NUKE", ...winner },
        runnerUp: { weaponId: "MISSILE", ...equalConsequences },
        bestByWeapon: [{ weaponId: "NUKE", ...winner }, { weaponId: "MISSILE", ...equalConsequences }],
      });
    });
  }

  it("aggregates collateral victims, Cluster impacts and falls without counting the shooter or foreign events", () => {
    const f = fixture();
    const ai = makePlayer({ id: "ai", isHuman: false });
    f.state.players.push(ai);
    const metrics = aggregateExpertConsequences(f.state.players, 1, "self", [
      forecastDamage(), forecastDamage({ munitionId: 1 }),
      forecastDamage({ source: "fall", shieldLostMilli: 0, shieldAbsorbedMilli: 0 }),
      forecastDamage({ victimId: "ai" }), forecastDamage({ victimId: "self" }),
      forecastDamage({ shotId: 2 }), forecastDamage({ shooterId: "other" }),
    ], [forecastDestruction(), forecastDestruction(), forecastDestruction({ victimId: "ai" }),
      forecastDestruction({ victimId: "self" }), forecastDestruction({ shotId: 2 })]);
    expect(metrics).toEqual({ humanDestroyedCount: 1, humanDamageMilli: 8_000,
      aiDestroyedCount: 1, aiDamageMilli: 3_000 });
  });

  it.each(["lava", "buried", "out-of-bounds"] as const)("counts an attributed %s death without fictitious losses", (cause) => {
    const f = fixture();
    const metrics = aggregateExpertConsequences(f.state.players, 1, "self",
      [forecastDamage({ shieldLostMilli: 0, healthDamageMilli: 1 })], [forecastDestruction({ cause })]);
    expect(metrics).toEqual({ humanDestroyedCount: 1, humanDamageMilli: 1,
      aiDestroyedCount: 0, aiDamageMilli: 0 });
    expect(aggregateExpertConsequences(f.state.players, 1, "self", [], [forecastDestruction({ cause })]))
      .toMatchObject({ humanDestroyedCount: 1, humanDamageMilli: 0 });
  });

  it("adds already normalized components without rounding the raw cumulative loss", () => {
    const f = fixture();
    const small = forecastDamage({ shieldLostMilli: normalizeDamageToMilli(0.0004),
      healthDamageMilli: normalizeDamageToMilli(0.0004) });
    expect(aggregateExpertConsequences(f.state.players, 1, "self", [small, small], []))
      .toMatchObject({ humanDamageMilli: 0 });
    expect(aggregateExpertConsequences(f.state.players, 1, "self", [small,
      forecastDamage({ shieldLostMilli: 0, healthDamageMilli: normalizeDamageToMilli(0.0006) })], []))
      .toMatchObject({ humanDamageMilli: 1 });
  });

  it("rejects missing losses and unsafe totals rather than silently turning them into zero", () => {
    const f = fixture();
    const missing = forecastDamage();
    Reflect.deleteProperty(missing, "shieldLostMilli");
    expect(() => aggregateExpertConsequences(f.state.players, 1, "self", [missing], [])).toThrow(RangeError);
    expect(() => aggregateExpertConsequences(f.state.players, 1, "self",
      [forecastDamage({ shieldLostMilli: Number.MAX_SAFE_INTEGER })], [])).toThrow(RangeError);
  });

  it("keeps safety and one unit of profit before consequences and profile scores", () => {
    const f = fixture();
    const ai = makePlayer({ id: "ai", isHuman: false, aiProfile: "v2-heuristic" });
    f.state.players.push(ai);
    const invalid: ExpertShotResult = { destination: -1, profit: 0,
      destroyedIds: new Set(), shooterDestroyed: false, pointOrder: -1 };
    let humanProfit = 100;
    let aiSuicide = false;
    const evaluate: typeof evaluateExpertShot = (_state, _terrain, shooter, _weapon, targets) => {
      if (shooter.id !== "self" || targets.length !== 1) return invalid;
      const human = targets[0].isHuman;
      return { destination: { x: human ? 400 : 200, y: 320, kind: "tank" },
        profit: human ? humanProfit : 100, pointOrder: 0,
        shooterDestroyed: !human && aiSuicide,
        destroyedIds: new Set(human ? ["enemy"] : aiSuicide ? ["ai", "self"] : ["ai"]),
        humanDestroyedCount: human ? 1 : 0, humanDamageMilli: human ? 100_000 : 0,
        aiDestroyedCount: human ? 0 : 1, aiDamageMilli: human ? 0 : 100_000 };
    };
    expect(chooseExpertPlan(f.self, f.state, f.terrain, evaluate)?.primaryTargetId).toBe("ai");
    humanProfit = 101;
    expect(chooseExpertPlan(f.self, f.state, f.terrain, evaluate)?.primaryTargetId).toBe("enemy");
    humanProfit = 99;
    aiSuicide = true;
    expect(chooseExpertPlan(f.self, f.state, f.terrain, evaluate)?.primaryTargetId).toBe("enemy");
  });

  it("does not privilege a mixed group whose AI primary target hides human collateral", () => {
    const f = fixture();
    const ai = makePlayer({ id: "ai", isHuman: false, aiProfile: "v4-smart",
      tank: makeTank("ai", 200, 336, { health: 1 }) });
    f.state.players.push(ai);
    const invalid: ExpertShotResult = { destination: -1, profit: 0,
      destroyedIds: new Set(), shooterDestroyed: false, pointOrder: -1 };
    const evaluate: typeof evaluateExpertShot = (_state, _terrain, shooter, _weapon, targets) => {
      if (shooter.id !== "self" || targets[0].id === "ai") return invalid;
      const mixed = targets.length === 2;
      return { destination: { x: mixed ? 300 : 400, y: 320, kind: mixed ? "pair" : "tank" },
        profit: 100, pointOrder: 0, shooterDestroyed: false,
        destroyedIds: new Set(mixed ? ["enemy", "ai"] : ["ai"]),
        humanDestroyedCount: mixed ? 1 : 0, humanDamageMilli: mixed ? 100_000 : 0,
        aiDestroyedCount: 1, aiDamageMilli: 1_000 };
    };
    const trace = vi.fn();
    expect(chooseExpertPlan(f.self, f.state, f.terrain, evaluate, trace)?.point.x).toBe(400);
    expect(trace.mock.calls[0][0]).toMatchObject({
      selected: { primaryTargetId: "enemy", destroyedIds: ["ai"] },
      runnerUp: { primaryTargetId: "ai", humanDestroyedCount: 1 },
      bestByWeapon: [{ point: { x: 400 }, humanDestroyedCount: 0 }],
    });
  });

  it("neutralizes the next lethal human and preserves other humans in survival", () => {
    const f = fixture();
    f.self.inventory.NUKE = 1;
    f.state.players.push(makePlayer({ id: "later-ai", isHuman: false, aiProfile: "v4-smart" }),
      makePlayer({ id: "collateral", isHuman: true }));
    const invalid: ExpertShotResult = { destination: -1, profit: 0,
      destroyedIds: new Set(), shooterDestroyed: false, pointOrder: -1 };
    const evaluate: typeof evaluateExpertShot = (_state, _terrain, shooter, weapon, targets, requireKill) => {
      if (shooter.id !== "self") {
        if (shooter.id === "collateral") return invalid;
        return { destination: { x: 100, y: 320, kind: "tank" }, profit: 100,
          destroyedIds: new Set(["self"]), shooterDestroyed: false, pointOrder: 0,
          humanDestroyedCount: 0, humanDamageMilli: 0, aiDestroyedCount: 1, aiDamageMilli: 100_000 };
      }
      expect(requireKill).toBe(true);
      expect(targets[0].id).toBe("enemy");
      if (targets.length !== 1) return invalid;
      const killsCollateral = weapon === "MISSILE";
      return { destination: { x: killsCollateral ? 400 : 420, y: 320, kind: "tank" }, profit: 100,
        destroyedIds: new Set(killsCollateral ? ["enemy", "collateral"] : ["enemy"]),
        shooterDestroyed: false, pointOrder: 0, humanDestroyedCount: killsCollateral ? 2 : 1,
        humanDamageMilli: killsCollateral ? 200_000 : 100_000, aiDestroyedCount: 0, aiDamageMilli: 0 };
    };
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0);
    const trace = vi.fn();
    expect(chooseExpertPlan(f.self, f.state, f.terrain, evaluate, trace)?.weaponId).toBe("NUKE");
    expect(trace.mock.calls[0][0]).toMatchObject({ phase: "SURVIE", selectedThreatId: "enemy",
      selected: { destroyedIds: ["enemy"], humanDestroyedCount: 1 },
      selectionReason: "moins d'humains détruits" });
    expect(rng).toHaveBeenCalledOnce();
  });

  it("returns to all opponents when every threat-destroying survival shot is suicidal", () => {
    const f = fixture();
    f.state.players.push(makePlayer({ id: "ai", isHuman: false, aiProfile: "v2-heuristic" }));
    const invalid: ExpertShotResult = { destination: -1, profit: 0,
      destroyedIds: new Set(), shooterDestroyed: false, pointOrder: -1 };
    const evaluate: typeof evaluateExpertShot = (_state, _terrain, shooter, _weapon, targets, requireKill) => {
      if (shooter.id === "ai") return invalid;
      if (shooter.id === "enemy" || requireKill) return {
        destination: { x: 400, y: 320, kind: "tank" }, profit: 100,
        destroyedIds: new Set(["self", "enemy"]), shooterDestroyed: true, pointOrder: 0,
        ...equalConsequences,
      };
      if (targets.length !== 1 || targets[0].id !== "ai") return invalid;
      return { destination: { x: 200, y: 320, kind: "tank" }, profit: 1,
        destroyedIds: new Set(), shooterDestroyed: false, pointOrder: 0, ...equalConsequences };
    };
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    const trace = vi.fn();
    expect(chooseExpertPlan(f.self, f.state, f.terrain, evaluate, trace)?.primaryTargetId).toBe("ai");
    expect(trace.mock.calls[0][0]).toMatchObject({ phase: "OPTIMISER_PROFIT",
      survivalCandidateCount: 0, transitionReason: expect.stringContaining("aucun tir sûr") });
  });

  it("keeps the stable survival weapon order when every consequence is equal", () => {
    const f = fixture();
    f.self.inventory.NUKE = 1;
    const evaluate: typeof evaluateExpertShot = (_state, _terrain, shooter) => ({
      destination: { x: 400, y: 320, kind: "tank" }, profit: 100, pointOrder: 0,
      destroyedIds: new Set([shooter.id === "self" ? "enemy" : "self"]), shooterDestroyed: false,
      ...equalConsequences,
    });
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    const trace = vi.fn();
    expect(chooseExpertPlan(f.self, f.state, f.terrain, evaluate, trace)?.weaponId).toBe("MISSILE");
    expect(trace.mock.calls[0][0]).toMatchObject({ selectionReason: "ordre stable des armes" });
  });
});

describe("EXPERT full-shot forecast", () => {
  it.each([0, 1])("prévoit une destruction réelle à 450 px pour le tireur %s", (index) => {
    const f = fixture();
    f.enemy.tank.position.x = 550;
    f.self.tank.health = f.enemy.tank.health = 30;
    const shooter = f.state.players[index];
    const target = f.state.players[1 - index];
    const rng = vi.spyOn(random, "secureRandom");
    const result = evaluateExpertShot(f.state, f.terrain, shooter, "MISSILE",
      [target], true, false, createExpertForecastCache());

    expect(result.destination).not.toBe(-1);
    expect(result.forecast?.complete).toBe(true);
    expect(result.destroyedIds.has(target.id)).toBe(true);
    expect(result.shooterDestroyed).toBe(false);
    expect(result.forecast?.survivors).toEqual([shooter.id]);
    expect(rng).not.toHaveBeenCalled();
    expect(f.state.players.map((player) => player.tank.health)).toEqual([30, 30]);
  });

  it("rejette les approximations du vrai solveur quand toutes sont incomplètes", () => {
    const f = fixture();
    f.enemy.tank.position.x = f.self.tank.position.x;
    f.state.gravity = 0;
    // Keep every upward shot in bounds for the entire search budget.
    const terrain = flatTerrain(10000, 480);
    f.self.tank.position.x = f.enemy.tank.position.x = 5000;
    const solution = solveExpertAim(f.self, 5000, 328.5, 0, 0, terrain, "MISSILE");

    expect(solution.complete).toBe(false);
    expect(solution.command.angle).toBeGreaterThanOrEqual(6);
    expect(solution.command.angle).toBeLessThanOrEqual(174);
    expect(solution.command.power).toBeGreaterThanOrEqual(25);
    expect(solution.command.power).toBeLessThanOrEqual(95);
    expect(evaluateExpertShot(f.state, terrain, f.self, "MISSILE", [f.enemy],
      false, false, createExpertForecastCache()).destination).toBe(-1);
  });

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
    expect(result.damage.every((event) => Number.isSafeInteger(event.shieldLostMilli))).toBe(true);
    expect(result).toMatchObject({ humanDestroyedCount: 0, aiDestroyedCount: 0, aiDamageMilli: 0,
      humanDamageMilli: result.damage.filter((event) => event.victimId === "enemy")
        .reduce((sum, event) => sum + event.shieldLostMilli + event.healthDamageMilli, 0) });
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
    expect(result.damage.filter((event) => event.source === "fall")
      .every((event) => event.shieldLostMilli === 0)).toBe(true);
    expect(result).toMatchObject({ humanDamageMilli: result.damage
      .filter((event) => event.victimId === "enemy")
      .reduce((sum, event) => sum + event.shieldLostMilli + event.healthDamageMilli, 0) });
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
    expect(forecast).toMatchObject({
      humanDestroyedCount: new Set(forecast.destruction.filter((event) => event.victimId === "enemy")
        .map((event) => event.victimId)).size,
      humanDamageMilli: forecast.damage.filter((event) => event.victimId === "enemy")
        .reduce((sum, event) => sum + event.shieldLostMilli + event.healthDamageMilli, 0),
    });
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

  it("rejects a resolved ground explosion that affects no opponent", () => {
    const f = fixture();
    const heights = [...f.terrain.getHeightmap()];
    // Keep the target above the explosion on an indestructible plateau, without a fall.
    heights.fill(120, 390);
    f.terrain.loadHeights(heights);
    f.terrain.setMaterialRange(390, f.terrain.width - 1, TERRAIN_MATERIAL.ROCK);
    f.enemy.tank.position.y = 120;
    const groundX = f.enemy.tank.position.x - WEAPON_REGISTRY.MISSILE.blastRadius / 2;
    const groundY = f.terrain.getHeightAt(groundX);
    const solution = solveExpertAim(f.self, groundX, groundY, 0, 260, f.terrain, "MISSILE");
    const forecast = forecastPhysicalShot(f.state, f.terrain, f.self, "MISSILE",
      finalizeAdvancedAim(solution.command), false);

    expect(solution.complete).toBe(true);
    expect(forecast.complete).toBe(true);
    expect(forecast.hits.some((hit) => Math.hypot(hit.x - groundX, hit.y - groundY) <=
      Math.max(24, WEAPON_REGISTRY.MISSILE.blastRadius))).toBe(true);
    expect(forecast.damage).toEqual([]);
    expect(forecast.destruction).toEqual([]);
    expect(forecast.profit).toBe(0);

    // Isolate this ground point: the other searches cannot provide a valid alternative.
    const solver = vi.spyOn(ballistics, "searchBallisticSolution")
      .mockImplementation(({ tx, ty }) => ({ ...solution.command, err: 0,
        complete: tx === groundX && ty === groundY }));
    const result = evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE",
      [f.enemy], false, false, createExpertForecastCache());

    expect(solver).toHaveBeenCalledTimes(3);
    expect(result.destination).toBe(-1);
    expect(result.profit).toBe(0);
    expect(result.destroyedIds.size).toBe(0);
  });

  it("compares missile profit with the cost of a NUKE", () => {
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
  it.each([0, 1])("détecte la menace réelle à 450 px et choisit SURVIE depuis le slot %s", (index) => {
    const f = fixture();
    f.enemy.tank.position.x = 550;
    f.self.tank.health = f.enemy.tank.health = 30;
    f.state.currentPlayerIndex = index;
    f.state.localShotContext!.isFirstShotOfRound = false;
    const shooter = f.state.players[index];
    const target = f.state.players[1 - index];
    shooter.isHuman = false;
    shooter.aiProfile = "v4-smart";
    target.isHuman = true;
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0);
    const trace = vi.fn();
    const plan = chooseExpertPlan(shooter, f.state, f.terrain, undefined, trace);

    expect(plan).toMatchObject({ weaponId: "MISSILE", primaryTargetId: target.id });
    expect(trace).toHaveBeenCalledOnce();
    expect(trace.mock.calls[0][0]).toMatchObject({
      phase: "SURVIE", selectedThreatId: target.id, survivalRoll: 0,
      threats: [{ playerId: target.id, turnsUntilShot: 1 }],
      selected: { shooterDestroyed: false, destroyedIds: [target.id] },
    });
    expect(rng).toHaveBeenCalledOnce();
  });

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
      selected: { weaponId: shot.weaponId, profit: expect.any(Number),
        humanDestroyedCount: expect.any(Number), humanDamageMilli: expect.any(Number),
        aiDestroyedCount: expect.any(Number), aiDamageMilli: expect.any(Number),
        predictedDamage: expect.arrayContaining([expect.objectContaining({
          shield: expect.any(Number), shieldAbsorbed: expect.any(Number), shieldLost: expect.any(Number),
        })]) },
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

  it("validates fallback physics without economics instead of imposing ordinary BULLDOZER", async () => {
    const f = fixture();
    f.state.localShotContext = undefined;
    f.enemy.tank.position.x = 780;
    f.self.inventory.BULLDOZER = 1;
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const shot = await new AISmartStrategy().executeTurn("self", f.state, f.terrain);
    expect(shot.weaponId).toBe("MISSILE");
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
  const valid = (x: number, profit: number, destroyed: string[], shooterId: string): ValidExpertShotResult => ({
    destination: { x, y: 320, kind: "tank" }, profit,
    destroyedIds: new Set(destroyed), shooterDestroyed: destroyed.includes(shooterId),
    humanDestroyedCount: 0, humanDamageMilli: 0, aiDestroyedCount: 0, aiDamageMilli: 0,
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
        return valid(400, 1, ["self"], shooter.id);
      }
      if (shooter.id === "later" && weapon === "MISSILE") return valid(200, 999, ["self"], shooter.id);
      if (shooter.id === "self" && requireKill && targets[0].id === "early") {
        return valid(400, 10, ["early"], shooter.id);
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
      if (shooter.id === "early" && weapon === "MISSILE") return valid(400, 1, ["self"], shooter.id);
      if (shooter.id === "self" && !requireKill && targets.length === 1 &&
          targets[0].id === "later") return valid(200, 20, [], shooter.id);
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
      if (shooter.id === "early" && weapon === "MISSILE") return valid(400, 1, ["self"], shooter.id);
      if (shooter.id === "self" && requireKill && targets.length === 2 &&
          targets[0].id === "early") return valid(300, -5, ["early"], shooter.id);
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
      if (shooter.id === "enemy" && weapon === "MISSILE") return valid(400, 1, ["self"], shooter.id);
      if (shooter.id === "self" && requireKill && targets[0].id === "enemy") {
        return valid(400, -10, ["enemy"], shooter.id);
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
      if (shooter.id === "enemy" && weapon === "MISSILE") return valid(400, 1, ["self"], shooter.id);
      if (shooter.id !== "self" || !requireKill || targets[0].id !== "enemy") return invalid;
      if (weapon === "NUKE") return valid(400, 20, ["enemy"], shooter.id);
      return invalid;
    };
    expect(chooseExpertPlan(f.self, f.state, f.terrain, evaluate)?.weaponId).toBe("NUKE");
    const profitableMissile: typeof evaluateExpertShot = (...args) => {
      if (args[2].id === "self" && args[3] === "MISSILE" && args[5]) {
        return valid(400, 21, ["enemy"], args[2].id);
      }
      return evaluate(...args);
    };
    expect(chooseExpertPlan(f.self, f.state, f.terrain, profitableMissile)?.weaponId)
      .toBe("MISSILE");
  });

  it("ranks safety before profit, then historical pair scores and roster turns when consequences are equal", () => {
    const f = threePlayers();
    const evaluate: typeof evaluateExpertShot = (_state, _terrain, shooter, weapon,
      targets, requireKill) => {
      if (shooter.id !== "self" || requireKill || weapon !== "MISSILE") return invalid;
      if (targets.length === 1 && targets[0].id === "early") return valid(400, 10, [], shooter.id);
      if (targets.length === 1 && targets[0].id === "later") return valid(200, 10, [], shooter.id);
      if (targets.length === 2) return valid(300, 10, [], shooter.id);
      return invalid;
    };
    const plan = chooseExpertPlan(f.self, f.state, f.terrain, evaluate);
    expect(plan).toMatchObject({ primaryTargetId: "later", point: { x: 300 } });
    const suicidal: typeof evaluateExpertShot = (...args) => {
      if (args[2].id === "self" && args[4].length === 2) {
        return valid(300, 1000, ["self"], args[2].id);
      }
      return evaluate(...args);
    };
    expect(chooseExpertPlan(f.self, f.state, f.terrain, suicidal)?.point.x).toBe(200);
  });
});
