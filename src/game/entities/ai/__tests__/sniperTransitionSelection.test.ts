import { afterEach, describe, expect, it, vi } from "vitest";
import { flatTerrain, makePlayer, makeTank } from "../../../__tests__/helpers";
import type { GameState } from "../../../../types/game";
import type { AIObservation } from "../../../observation";
import * as random from "../../../../utils/random";
import * as selection from "../sniperPhysicalSelection";
import * as physical from "../physicalShotForecast";
import { LethalTransitionDetector, searchLethalThreat, type TransitionAnalysis } from "../lethalTransition";
import { chooseSniperTransitionShot } from "../sniperTransitionSelection";
import { AISniperStrategy } from "../AISniperStrategy";
import * as memory from "../aimMemory";
import { solveSniperAim } from "../sniperAim";
import * as aim from "../sniperAim";
import type { WeaponId } from "../../../../types/weapon";
import { ADVANCED_GAFFES } from "../aimCorruption";

function transitionFixture(count = 3, health = 30) {
  const self = makePlayer({ id: "s", isHuman: false, aiProfile: "v3-sniper", inventory: {},
    tank: makeTank("s", 100, 336, { health }) });
  const target = makePlayer({ id: "c", inventory: {}, tank: makeTank("c", 400, 336, { health: 60 }) });
  const others = Array.from({ length: count - 2 }, (_, index) => makePlayer({ id: `a${index}`, isHuman: false,
    aiProfile: "v1-random", inventory: {}, tank: makeTank(`a${index}`, 650 + index * 150, 336) }));
  const state: GameState = { phase: "COMBAT", players: [self, target, ...others], currentPlayerIndex: 0,
    turn: 5, roundNumber: 12, windForce: 0, gravity: 260,
    localShotContext: { playerCountAtMatchStart: count, isFirstShotOfRound: true } };
  return { self, target, others, state, terrain: flatTerrain(1000, 480) };
}

function analysis(status: TransitionAnalysis["status"]): TransitionAnalysis {
  return { status, reason: status === "risk" ? "provoked-survival" : status === "safe" ? "no-new-threat" : "uncertified",
    initial: null, after: null, reply: null };
}
function choice(reason: selection.SniperChoiceReason = "bullet", angle = 40): selection.SniperPhysicalChoice {
  return { weaponId: reason === "bullet" ? "BULLET" : reason === "driller" ? "DRILLER" : "MISSILE",
    reason, certified: reason !== "missile-ordinary", point: { x: 400, y: 330, kind: "tank" }, variant: "full",
    rawCommand: { angle: angle + 0.04, power: 50 }, command: { angle, power: 50 },
    trace: { selectionReason: "seul candidat", admissible: [], refusals: [], searches: 2, solverCalls: 1, ballisticCacheHits: 1, forecasts: 1, cacheHits: 1 } };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function fallbackForecast(targetId: string, weaponId: WeaponId = "MISSILE", loss = 1000,
  overrides: Partial<Extract<physical.PhysicalResolution, { complete: true }>> = {},
): physical.PhysicalResolution {
  return { complete: true, survivors: ["s", "c", "a0", "a1"], support: [], steps: 1,
    humanDamageMilli: 0, aiDamageMilli: 0, humanDestroyedCount: 0, aiDestroyedCount: 0,
    hits: [{ shotId: 1, munitionId: 0, x: 650, y: 330, weaponId, directTargetId: targetId }],
    damage: [{ shotId: 1, munitionId: 0, shooterId: "s", victimId: targetId, weaponId,
      source: "projectile", classification: "direct", healthDamageMilli: loss, shieldLostMilli: 0, shieldAbsorbedMilli: 0 }],
    destruction: [], ...overrides };
}

function fallbackSetup(count = 4) {
  const f = transitionFixture(count);
  const initial = choice("missile-surviving");
  const pick = vi.spyOn(selection, "chooseSniperPhysicalShot").mockReturnValue(initial);
  const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0.25);
  const solve = vi.spyOn(aim, "solveSniperAim").mockImplementation((_self, x, _y, _wind, _gravity, _terrain, _weapon, variant) => ({
    command: { angle: x < 700 ? variant === "full" ? 40.04 : 60.04 : variant === "full" ? 80.04 : 100.04, power: 50.2 }, complete: true,
  }));
  const resolve = vi.spyOn(physical, "resolvePhysicalShot").mockImplementation((_state, _terrain, _self, weapon, command) =>
    fallbackForecast(command.angle < 70 ? "a0" : "a1", weapon));
  const detector = new LethalTransitionDetector();
  const analyze = vi.spyOn(detector, "analyze").mockReturnValue(analysis("safe"));
  return { ...f, initial, pick, rng, solve, resolve, detector, analyze };
}

describe("SNIPER multi-target fallback #371", () => {
  it.each([1, 2, 3, 4])("examines exactly two ordinary arcs per other target with one amplitude, attempt=%s", attempts => {
    vi.stubEnv("DEV", false);
    const f = fallbackSetup();
    const dead = makePlayer({ id: "dead", tank: makeTank("dead", 500, 336, { isDead: true }) });
    f.state.players.push(dead);
    const before = structuredClone(f.state);
    const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, attempts, true, f.detector);
    expect(result.target.id).toBe("a0");
    expect(result.trace.reason).toBe("fallback-target-accepted");
    expect(result.attempts).toBe(1); expect(result.offset).toBe(-41);
    expect(f.rng).toHaveBeenCalledTimes(1);
    expect(result.trace.extraAmplitude).toBe(attempts >= 3 ? 0.25 : undefined);
    expect(f.pick).toHaveBeenCalledTimes(1); // Never recursively evaluates the principal selector.
    expect(f.solve.mock.calls.map(call => [call[1], call[2], call[6], call[7]])).toEqual([
      [609, 330, "MISSILE", "full"], [609, 330, "MISSILE", "high"],
      [759, 330, "MISSILE", "full"], [759, 330, "MISSILE", "high"],
    ]);
    expect(result.trace.selectionCounters).toEqual({ searches: 6, solverCalls: 5, ballisticCacheHits: 1, forecasts: 5, cacheHits: 1 });
    expect(f.resolve.mock.calls.every(call => call[5]?.captureAfterState)).toBe(true);
    expect(selection.getSniperChoiceForecast(result.choice)).toBe(f.resolve.mock.results[0].value);
    expect(f.state).toEqual(before);
    expect(JSON.stringify(result.trace)).not.toMatch(/"players"|"heights"|"forecast"/);
  });

  it("orders AI by health then roster before humans and preserves full before high ties", () => {
    const f = fallbackSetup(); f.others[1].tank.health = 50;
    f.state.players.push(makePlayer({ id: "human", tank: makeTank("human", 900, 336, { health: 1 }) }));
    // Match forecasts to the target actually searched, including equal-health stable ordering.
    f.resolve.mockImplementation((_state, _terrain, _self, weapon, command) => fallbackForecast(command.angle < 70 ? "a0" : "a1", weapon));
    const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 1, true, f.detector);
    expect(result.target.id).toBe("a1"); expect(result.choice.variant).toBe("full");
    expect(f.solve.mock.calls.map(call => call[1])).toEqual([759, 759, 609, 609, 859, 859]);
  });

  it("ranks target destruction above target loss and ignores collateral damage", () => {
    const f = fallbackSetup();
    f.resolve.mockImplementation((_state, _terrain, _self, weapon, command) => command.angle === 100
      ? fallbackForecast("a1", weapon, 1, { destruction: [{ shotId: 1, shooterId: "s", victimId: "a1", weaponId: weapon, cause: "lava" }] })
      : fallbackForecast(command.angle < 70 ? "a0" : "a1", weapon, command.angle < 70 ? 10000 : 2000));
    const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 1, true, f.detector);
    expect(result.target.id).toBe("a1"); expect(result.choice.variant).toBe("high");
    f.resolve.mockImplementation((_state, _terrain, _self, weapon, command) => fallbackForecast(command.angle < 70 ? "a0" : "a1", weapon,
      command.angle < 70 ? 1000 : 2000, { destruction: command.angle < 70
        ? [{ shotId: 1, shooterId: "s", victimId: "c", weaponId: weapon, cause: "lava" }] : [] }));
    const again = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 1, true, f.detector);
    expect(again.target.id).toBe("a1"); expect(again.choice.variant).toBe("full");
  });

  it.each(["safe", "unknown"] as const)("skips risky ranked arcs and accepts a %s analysis", status => {
    const f = fallbackSetup();
    f.analyze.mockReturnValueOnce(analysis("safe")).mockReturnValueOnce(analysis("risk")).mockReturnValue(analysis(status));
    const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 3, true, f.detector);
    expect(result.choice.variant).toBe("high"); expect(result.target.id).toBe("a0");
    expect(result.trace.alternatives.map(value => value.accepted)).toEqual([false, true]);
  });

  it.each(["missile-surviving", "missile-ordinary"] as const)("retains exactly %s if all useful arcs are risky", reason => {
    const f = fallbackSetup(); const initial = choice(reason); f.pick.mockReturnValue(initial);
    f.analyze.mockReturnValue(analysis("risk"));
    const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 3, true, f.detector);
    expect(result.choice).toBe(initial); expect(result.target).toBe(f.target);
    expect(result.trace.alternatives).toHaveLength(4); expect(f.pick).toHaveBeenCalledTimes(1);
  });

  it.each([0, 500, 1000, 2000])("compares BULLET on the same command without solving again, loss=%s", loss => {
    const f = fallbackSetup(3); f.self.inventory.BULLET = 1;
    f.resolve.mockImplementation((_state, _terrain, _self, weapon) => fallbackForecast("a0", weapon, weapon === "BULLET" ? loss : 1000));
    const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 1, true, f.detector);
    expect(result.choice.weaponId).toBe(loss >= 1000 ? "BULLET" : "MISSILE");
    expect(f.solve).toHaveBeenCalledTimes(2); expect(f.resolve).toHaveBeenCalledTimes(3);
    expect(f.resolve.mock.calls[2][4]).toEqual(f.resolve.mock.calls[0][4]);
    expect(result.trace.selectionCounters).toEqual({ searches: 5, solverCalls: 3, ballisticCacheHits: 2, forecasts: 4, cacheHits: 1 });
    expect(f.self.inventory.BULLET).toBe(1);
    expect(selection.getSniperChoiceForecast(result.choice)).toBe(f.resolve.mock.results[loss >= 1000 ? 2 : 0].value);
  });

  it.each(["MISSILE", "BULLET"] as const)("allows %s self damage only for a surviving target kill", weapon => {
    const f = fallbackSetup(3); f.self.inventory.BULLET = weapon === "BULLET" ? 1 : 0;
    let lethal = false;
    f.resolve.mockImplementation((_state, _terrain, _self, current) => {
      const value = fallbackForecast("a0", current, current === "BULLET" ? 5000 : 1000);
      return current !== weapon ? value : { ...value, damage: [...value.damage, {
        ...value.damage[0], victimId: "s", source: "fall", healthDamageMilli: 100,
      }], destruction: lethal ? [{ shotId: 1, shooterId: "s", victimId: "a0", weaponId: current, cause: "health-zero" }] : [] };
    });
    const rejected = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 3, true, f.detector);
    expect(rejected.choice.weaponId).toBe("MISSILE");
    expect(rejected.choice === f.initial).toBe(weapon === "MISSILE");
    lethal = true;
    const accepted = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 3, true, f.detector);
    expect(accepted.choice.weaponId).toBe(weapon); expect(accepted.target.id).toBe("a0");
    f.resolve.mockReturnValue(fallbackForecast("a0", weapon, 1000, { survivors: ["a0"] }));
    expect(chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 3, true, f.detector).choice).toBe(f.initial);
  });

  it("rejects incomplete searches and forecasts and reuses identical normalized forecasts per target", () => {
    const f = fallbackSetup(3);
    f.solve.mockReturnValue({ command: { angle: 40, power: 50 }, complete: false });
    expect(chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 3, true, f.detector).choice).toBe(f.initial);
    expect(f.resolve).not.toHaveBeenCalled();
    f.solve.mockReturnValue({ command: { angle: 40, power: 50 }, complete: true });
    f.resolve.mockReturnValue({ complete: false, damage: [], hits: [], destruction: [], survivors: [], support: [], steps: 2400 });
    const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 3, true, f.detector);
    expect(result.choice).toBe(f.initial); expect(f.resolve).toHaveBeenCalledTimes(1);
    expect(result.trace.fallbackTargets[0].selection.refusals).toHaveLength(2);
    expect(result.trace.selectionCounters).toEqual({ searches: 4, solverCalls: 3, ballisticCacheHits: 1, forecasts: 2, cacheHits: 2 });
  });

  it("reuses physical BULLET forecasts across equal commands when every candidate is risky", () => {
    const f = fallbackSetup(3); f.self.inventory.BULLET = 1;
    f.solve.mockReturnValue({ command: { angle: 40, power: 50 }, complete: true });
    f.analyze.mockReturnValue(analysis("risk"));
    const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 3, true, f.detector);
    expect(result.choice).toBe(f.initial); expect(f.resolve).toHaveBeenCalledTimes(2);
    expect(f.solve).toHaveBeenCalledTimes(2);
    expect(result.trace.selectionCounters).toEqual({ searches: 6, solverCalls: 3, ballisticCacheHits: 3, forecasts: 3, cacheHits: 3 });
  });

  it("retains the exact harmless initial fallback when other arcs have only collateral effects", () => {
    const f = fallbackSetup(); f.resolve.mockReturnValue(fallbackForecast("c"));
    const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 3, true, f.detector);
    expect(result.choice).toBe(f.initial); expect(result.trace.alternatives).toEqual([]);
    expect(result.trace.fallbackTargets.every(target => target.selection.refusals.every(refusal => refusal.refusal === "sans effet"))).toBe(true);
  });

  it("keeps real stabilized forecast identity, isolated state and strict RNG with the real fallback solver", () => {
    const f = transitionFixture(3); f.others[0].tank.position.x = 400; f.target.tank.position.x = 1000;
    f.terrain = flatTerrain(1600, 480); f.self.inventory.BULLET = 1;
    f.terrain.setMaterialRange(0, 1599, "SOFT");
    const before = structuredClone(f.state), heights = [...f.terrain.getHeightmap()];
    vi.spyOn(selection, "chooseSniperPhysicalShot").mockReturnValue(choice("missile-surviving"));
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0);
    const solve = vi.spyOn(aim, "solveSniperAim");
    const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 3, true);
    expect(result.target).toBe(f.others[0]); expect(result.choice.certified).toBe(true);
    expect(solve).toHaveBeenCalledTimes(2); expect(rng).toHaveBeenCalledTimes(1);
    const forecast = selection.getSniperChoiceForecast(result.choice)!;
    const after = physical.getForecastAfterState(forecast)!;
    expect(forecast.complete).toBe(true); expect(after).toBeDefined();
    expect(after.state.players[0].inventory.BULLET).toBe(result.choice.weaponId === "BULLET" ? 0 : 1);
    expect(f.state).toEqual(before); expect(f.terrain.getHeightmap()).toEqual(heights);
  });

  it("commits only the final fallback target with production diagnostics and one reaction/gaffe", async () => {
    vi.stubEnv("DEV", false);
    const f = fallbackSetup(3); f.others[0].isHuman = true; f.self.inventory.BULLET = 1;
    f.rng.mockReturnValue(0.99);
    const record = vi.spyOn(memory, "recordAimAttempt");
    vi.spyOn(LethalTransitionDetector.prototype, "analyze").mockReturnValue(analysis("safe"));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const strategy = new AISniperStrategy(), observations: AIObservation[] = [];
    const callback = vi.fn(); strategy.onTargetSelected = callback;
    strategy.onDecisionObserved = value => observations.push(value);
    await strategy.executeTurn("s", f.state, f.terrain);
    expect(record).toHaveBeenCalledExactlyOnceWith(expect.anything(), "a0");
    expect(callback).toHaveBeenCalledExactlyOnceWith("s", "a0");
    expect(observations).toHaveLength(1); expect(observations[0].target?.playerId).toBe("a0");
    expect(observations[0].steps.map(step => step.kind)).toEqual(["offset", "reaction", "gaffe", "finalize"]);
    expect(observations[0].steps[2].parameters).toMatchObject({ chance: 0, occurred: false });
    expect(JSON.stringify(observations[0].diagnostics)).toContain("fallback-target-accepted");
    expect(f.rng).toHaveBeenCalledTimes(2); expect(info).not.toHaveBeenCalled();
  });
});

describe("SNIPER lethal transitions with real first-shot and hypothesis physics", () => {
  it.each([false, true])("retains stabilized original forecast, with economic context=%s", (context) => {
    const f = transitionFixture(2);
    if (!context) delete f.state.localShotContext;
    const before = structuredClone(f.state), heights = [...f.terrain.getHeightmap()];
    const rng = vi.spyOn(random, "secureRandom").mockImplementation(() => { throw new Error("unexpected RNG"); });
    const resolve = vi.spyOn(physical, "resolvePhysicalShot");
    const search = vi.fn(searchLethalThreat);
    const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 3, true, new LethalTransitionDetector(search));
    expect(result.trace.analysis).toMatchObject({ status: "risk", reason: "provoked-survival", initial: { status: "absent" },
      after: { status: "found" }, reply: null });
    expect(result.trace.alternatives).toHaveLength(0);
    expect(result.trace.extraAmplitude).toBeUndefined();
    const forecast = selection.getSniperChoiceForecast(result.choice)!;
    const after = physical.getForecastAfterState(forecast)!;
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1][0]).toBe(after.state);
    expect(after.state.localShotContext?.isFirstShotOfRound).toBe(context ? false : undefined);
    const selectionCalls = resolve.mock.calls.filter(call => call[5]?.captureAfterState);
    expect(selectionCalls).toHaveLength(result.trace.selectionCounters.forecasts);
    expect(selectionCalls.some((_, i) => resolve.mock.results[resolve.mock.calls.indexOf(selectionCalls[i])].value === forecast)).toBe(true);
    expect(after.terrain.getHeightmap()).not.toEqual(heights);
    expect(f.state).toEqual(before);
    expect(f.terrain.getHeightmap()).toEqual(heights);
    expect(rng).not.toHaveBeenCalled();
    expect(JSON.stringify(result.trace)).not.toMatch(/copiedTerrain|"players"|"heights"/);
  });

  it("a real transition with provoked-survival in a duel without lethal alternative keeps the original", () => {
    const f = transitionFixture(2, 100);
    const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 3);
    expect(result.trace.analysis).toMatchObject({ status: "risk", reason: "provoked-survival",
      initial: { status: "absent" }, after: { status: "found" }, reply: null });
    expect(result.trace.reason).toBe("initial-retained-no-alternative");
  });

  it("accepts a useful alternative with real physics while retaining the original forecast identity", () => {
    const f = transitionFixture(3);
    f.terrain = flatTerrain(1600, 480);
    vi.spyOn(random, "secureRandom").mockReturnValue(0.25);
    const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 3, true);
    expect(result.trace.analysis.status).toBe("risk");
    expect(result.target.id).toBe("a0");
    expect(result.choice.reason).toBe("missile-useful");
    expect(result.trace.alternatives[0]).toMatchObject({ accepted: true, analysis: { status: "safe", reason: "target-type" } });
    expect(physical.getForecastAfterState(selection.getSniperChoiceForecast(result.choice)!)).toBeDefined();
    expect(f.self.tank.currentWeapon).toBe("MISSILE");
  });

  it("captures the last BULLET once on material-preserving isolated copies without serializing it", () => {
    const f = transitionFixture(2); f.self.inventory.BULLET = 1;
    f.terrain.setMaterialRange(0, 999, "ROCK");
    const resolve = vi.spyOn(physical, "resolvePhysicalShot");
    const selected = selection.chooseSniperPhysicalShot(f.self, f.target, f.state, f.terrain, 0,
      (point, weapon, variant) => {
        // The selector uses the real solver and real physics, without a fabricated final state.
        return solveSniper(f, point, weapon, variant);
      });
    expect(selected.weaponId).toBe("BULLET");
    const forecast = selection.getSniperChoiceForecast(selected)!;
    const stabilized = physical.getForecastAfterState(forecast)!;
    expect(stabilized.state.players[0].inventory.BULLET).toBe(0);
    expect(f.self.inventory.BULLET).toBe(1);
    expect(stabilized.terrain.getMaterials()).toEqual(f.terrain.getMaterials());
    expect(resolve).toHaveBeenCalledTimes(selected.trace.forecasts);
    expect(JSON.stringify(selected)).not.toContain('"forecast":');
  });
});

function solveSniper(f: ReturnType<typeof transitionFixture>, point: { x: number; y: number },
  weapon: Parameters<typeof solveSniperAim>[6], variant: Parameters<typeof solveSniperAim>[7]) {
  return solveSniperAim(f.self, point.x, point.y, f.state.windForce, f.state.gravity, f.terrain, weapon, variant);
}

describe("SNIPER virtual alternatives and random sequence", () => {
  it("certification precedes target type even when a complete forecast exists", () => {
    const f = transitionFixture(3);
    const complete = physical.resolvePhysicalShot(f.state, f.terrain, f.self, "MISSILE", { angle: 40, power: 50 });
    const search = vi.fn(searchLethalThreat), detector = new LethalTransitionDetector(search);
    for (const target of [f.target, f.others[0]]) {
      expect(detector.analyze({ primaryTargetId: target.id, weaponId: "MISSILE", command: { angle: 40, power: 50 },
        certified: false, result: { forecast: complete } }, f.self, f.state, f.terrain)).toMatchObject({
        status: "unknown", reason: "uncertified", initial: null, after: null, reply: null,
      });
    }
    expect(search).not.toHaveBeenCalled();
  });

  it.each([false, true])("plateau alternative draw stays consumed on return to C0, reaction=%s", async reaction => {
    vi.stubEnv("DEV", false);
    const f = transitionFixture(3), observations: AIObservation[] = [];
    const strategy = new AISniperStrategy();
    strategy.onDecisionObserved = value => observations.push(value);
    const initial = choice("driller");
    const pick = vi.spyOn(selection, "chooseSniperPhysicalShot").mockReturnValue(initial);
    const analyze = vi.spyOn(LethalTransitionDetector.prototype, "analyze").mockReturnValue(analysis("safe"));
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    await strategy.executeTurn("s", f.state, f.terrain);
    await strategy.executeTurn("s", f.state, f.terrain);
    // At plateau, a rejected ordinary alternative consumes one amplitude and nothing else.
    pick.mockClear().mockReturnValueOnce(initial).mockReturnValue(choice("missile-ordinary"));
    analyze.mockReturnValueOnce(analysis("risk"));
    f.self.tank.hitReaction = { wasDirectHit: reaction, fallDistance: 0 };
    const draws = [0.25, ...(reaction ? [0.1, 0.9] : []), 0.99];
    let index = 0;
    vi.spyOn(random, "secureRandom").mockImplementation(() => {
      const value = draws[index++]; if (value === undefined) throw new Error("Unexpected RNG"); return value;
    });
    const result = await strategy.executeTurn("s", f.state, f.terrain);
    expect(index).toBe(draws.length);
    expect(result.weaponId).toBe("DRILLER");
    const last = observations.at(-1)!;
    expect(last.evaluated).toEqual({ ...initial.command, weaponId: "DRILLER" });
    expect(last.steps[0].parameters.offset).toBe(-4);
    expect(last.steps[2].parameters.occurred).toBe(false);
    expect(last.target?.playerId).toBe("a0");
    expect(pick).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["safe", "bullet"], ["safe", "driller"], ["safe", "missile-useful"],
    ["unknown", "bullet"], ["unknown", "driller"], ["unknown", "missile-useful"],
  ] as const)("keeps the initial %s %s without examining alternatives", (status, reason) => {
    const f = transitionFixture(4);
    const initial = choice(reason);
    const pick = vi.spyOn(selection, "chooseSniperPhysicalShot").mockReturnValue(initial);
    const detector = new LethalTransitionDetector();
    vi.spyOn(detector, "analyze").mockReturnValue(analysis(status));
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0.3);
    const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 3, false, detector);
    expect(result.target).toBe(f.target); expect(pick).toHaveBeenCalledTimes(1); expect(rng).not.toHaveBeenCalled();
    expect(result.choice).toBe(initial);
    expect(result.trace.alternatives).toEqual([]);
    expect(result.trace.fallbackTargets).toEqual([]);
    expect(result.trace.selectionCounters).toEqual({ searches: initial.trace.searches, solverCalls: initial.trace.solverCalls,
      ballisticCacheHits: initial.trace.ballisticCacheHits, forecasts: initial.trace.forecasts, cacheHits: initial.trace.cacheHits });
  });

  it.each([1, 2, 3, 4])("shares exactly one amplitude on alternative examination, initial attempt %s", attempts => {
    const f = transitionFixture(4);
    const initial = choice("driller", 41);
    const pick = vi.spyOn(selection, "chooseSniperPhysicalShot").mockReturnValueOnce(initial).mockReturnValue(choice());
    const detector = new LethalTransitionDetector();
    const analyze = vi.spyOn(detector, "analyze").mockReturnValueOnce(analysis("risk"))
      .mockReturnValueOnce(analysis("unknown")).mockReturnValue(analysis("safe"));
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0.25);
    const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, attempts, false, detector);
    expect(result.target).toBe(f.others[1]);
    expect(rng).toHaveBeenCalledTimes(1);
    expect(result.trace.extraAmplitude).toBe(attempts < 3 ? undefined : 0.25);
    expect(pick.mock.calls.map(call => call[1].id)).toEqual(["c", "a0", "a1"]);
    expect(pick.mock.calls[0][4]).toBe((attempts === 2 ? -1 : 1) *
      (attempts >= 3 ? 4 : attempts === 1 ? 41 : 22.5));
    expect(pick.mock.calls[1][4]).toBe(-41); expect(pick.mock.calls[2][4]).toBe(-41);
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(result.trace.selectionCounters).toEqual({ searches: 6, solverCalls: 3, ballisticCacheHits: 3, forecasts: 3, cacheHits: 3 });
    expect(f.self.tank.currentWeapon).toBe("MISSILE");
  });

  it("orders AI before humans, health then roster; stops at the first safe useful choice", () => {
    const f = transitionFixture(4);
    const human = makePlayer({ id: "human", tank: makeTank("human", 800, 336, { health: 1 }) });
    f.others[0].tank.health = 80; f.others[1].tank.health = 70;
    f.state.players.push(human);
    const pick = vi.spyOn(selection, "chooseSniperPhysicalShot").mockReturnValue(choice());
    const detector = new LethalTransitionDetector();
    vi.spyOn(detector, "analyze").mockReturnValueOnce(analysis("risk")).mockReturnValue(analysis("safe"));
    vi.spyOn(random, "secureRandom").mockReturnValue(0.5);
    const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 1, true, detector);
    expect(result.target.id).toBe("a1"); expect(pick.mock.calls.map(call => call[1].id)).toEqual(["c", "a1"]);
  });

  it.each(["missile-surviving", "missile-ordinary"] as const)("rejects alternative %s without trying another variant", reason => {
    const f = transitionFixture(4), detector = new LethalTransitionDetector();
    const initial = choice();
    const pick = vi.spyOn(selection, "chooseSniperPhysicalShot").mockReturnValueOnce(initial)
      .mockReturnValueOnce(choice(reason)).mockReturnValue(choice("missile-useful"));
    const analyze = vi.spyOn(detector, "analyze").mockReturnValueOnce(analysis("risk")).mockReturnValue(analysis("safe"));
    const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 3, true, detector);
    expect(result.target.id).toBe("a1"); expect(pick).toHaveBeenCalledTimes(3); expect(analyze).toHaveBeenCalledTimes(2);
    expect(result.trace.alternatives[0]).toMatchObject({ accepted: false, analysis: null });
  });

  it.each([2, 4])("keeps the exact initial choice after exhausted alternatives with %s players", count => {
    const f = transitionFixture(count), detector = new LethalTransitionDetector(), initial = choice("bullet");
    const pick = vi.spyOn(selection, "chooseSniperPhysicalShot").mockReturnValueOnce(initial).mockReturnValue(choice());
    vi.spyOn(detector, "analyze").mockReturnValue(analysis("risk"));
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0.5);
    const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 3, true, detector);
    expect(result.choice).toBe(initial); expect(result.offset).toBe(4);
    expect(result.target).toBe(f.target); expect(pick).toHaveBeenCalledTimes(count - 1);
    expect(rng).toHaveBeenCalledTimes(count === 2 ? 0 : 1);
  });

  it("commits the final target once, preserves A → B → A resets, and exposes production observations", async () => {
    const f = transitionFixture(3);
    vi.stubEnv("DEV", false);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const pick = vi.spyOn(selection, "chooseSniperPhysicalShot").mockReturnValue(choice());
    const analyze = vi.spyOn(LethalTransitionDetector.prototype, "analyze").mockReturnValue(analysis("safe"));
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const record = vi.spyOn(memory, "recordAimAttempt");
    const strategy = new AISniperStrategy(), observations: AIObservation[] = [];
    strategy.onDecisionObserved = value => observations.push(value);
    const callback = vi.fn(); strategy.onTargetSelected = callback;
    // C0 initially follows the ordinary AI-first rule.
    await strategy.executeTurn("s", f.state, f.terrain);
    analyze.mockReturnValueOnce(analysis("risk")).mockReturnValue(analysis("safe"));
    await strategy.executeTurn("s", f.state, f.terrain);
    analyze.mockReturnValueOnce(analysis("risk")).mockReturnValue(analysis("safe"));
    await strategy.executeTurn("s", f.state, f.terrain);
    expect(callback.mock.calls.map(call => call[1])).toEqual(["a0", "c", "a0"]);
    expect(record.mock.calls.map(call => call[1])).toEqual(["a0", "c", "a0"]);
    expect(observations.map(value => value.target?.playerId)).toEqual(["a0", "c", "a0"]);
    expect(observations.map(value => value.steps[0].parameters.offset)).toEqual([-46.92, 46.92, -46.92]);
    expect(observations).toHaveLength(3); expect(info).not.toHaveBeenCalled();
    expect(pick.mock.calls.every(call => call[6] === true)).toBe(true);
    const serialized = JSON.stringify(observations.at(-1)?.diagnostics);
    expect(serialized).toContain('"lethalTransition"'); expect(serialized).not.toContain('"players"');
    expect(rng).toHaveBeenCalledTimes(6); // Shared offset and BULLET's zero-chance gaffe decision.
    f.state.roundNumber = 13;
    analyze.mockReturnValue(analysis("safe"));
    await strategy.executeTurn("s", f.state, f.terrain);
    expect(pick.mock.calls.at(-1)?.[4]).toBeCloseTo(-46.92);
  });

  describe("SNIPER same-target lethal continuation #374", () => {
    it("replaces a risky non-lethal BULLET with a lethal MISSILE on the same target", () => {
      const f = transitionFixture(2);
      f.self.inventory = { BULLET: 1 };
      f.target.isHuman = true;

      // Mock resolvePhysicalShot: BULLET does non-lethal damage, MISSILE kills target
      vi.spyOn(physical, "resolvePhysicalShot").mockImplementation((_state, _terrain, _self, weapon) => {
        if (weapon === "BULLET") {
          return fallbackForecast("c", "BULLET", 1000, {
            survivors: ["s", "c"],
            destruction: [],
          });
        }
        // MISSILE
        return fallbackForecast("c", "MISSILE", 60000, {
          survivors: ["s"], // target c eliminated
          destruction: [{ shotId: 1, shooterId: "s", victimId: "c", weaponId: "MISSILE", cause: "health-zero" }],
        });
      });

      const detector = new LethalTransitionDetector();
      // First analysis of BULLET is risk (provoked-survival)
      vi.spyOn(detector, "analyze")
        .mockReturnValueOnce({ status: "risk", reason: "provoked-survival", initial: null, after: null, reply: null })
        .mockReturnValueOnce({ status: "safe", reason: "target-destroyed", initial: null, after: null, reply: null });

      const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 1, true, detector);
      expect(result.target.id).toBe("c");
      expect(result.choice.weaponId).toBe("MISSILE");
      expect(result.choice.certified).toBe(true);
      expect(result.trace.reason).toBe("same-target-lethal-accepted");
      expect(result.trace.explanation).toBe("élimination de la cible initiale");
      expect(result.trace.continuation).toMatchObject({
        attempted: true,
        accepted: true,
        analysis: { status: "safe", reason: "target-destroyed" },
      });
      expect(result.trace.continuation?.counters?.searches).toBeGreaterThan(0);
      expect(result.trace.alternatives).toHaveLength(0);
      expect(result.trace.extraAmplitude).toBeUndefined();
    });

    it("follows a non-lethal missile-useful with an alternative lethal missile arc on the same target", () => {
      const f = transitionFixture(2);
      f.self.inventory = {}; // Only MISSILE
      f.target.isHuman = true;

      let missileCall = 0;
      vi.spyOn(physical, "resolvePhysicalShot").mockImplementation(() => {
        missileCall++;
        if (missileCall === 1) {
          // First arc is non-lethal missile-useful
          return fallbackForecast("c", "MISSILE", 1000, {
            survivors: ["s", "c"],
            destruction: [],
          });
        }
        // Second arc is lethal
        return fallbackForecast("c", "MISSILE", 60000, {
          survivors: ["s"],
          destruction: [{ shotId: 1, shooterId: "s", victimId: "c", weaponId: "MISSILE", cause: "health-zero" }],
        });
      });

      const detector = new LethalTransitionDetector();
      vi.spyOn(detector, "analyze")
        .mockReturnValueOnce({ status: "risk", reason: "provoked-survival", initial: null, after: null, reply: null });

      const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 1, true, detector);
      expect(result.target.id).toBe("c");
      expect(result.choice.weaponId).toBe("MISSILE");
      expect(result.choice.certified).toBe(true);
      expect(result.trace.reason).toBe("same-target-lethal-accepted");
      expect(result.trace.continuation?.accepted).toBe(true);
    });

    it("selects higher targetLoss among multiple lethal MISSILE arcs and preserves stable order on tie", () => {
      const f = transitionFixture(2);
      f.self.inventory = { BULLET: 1 };
      f.target.isHuman = true;

      let callIndex = 0;
      vi.spyOn(physical, "resolvePhysicalShot").mockImplementation((_state, _terrain, _self, weapon) => {
        callIndex++;
        if (weapon === "BULLET") {
          return fallbackForecast("c", "BULLET", 1000, { survivors: ["s", "c"] });
        }
        // Consecutive missile arcs with different losses
        const loss = callIndex === 2 ? 20000 : 35000;
        return fallbackForecast("c", "MISSILE", loss, {
          survivors: ["s"],
          destruction: [{ shotId: 1, shooterId: "s", victimId: "c", weaponId: "MISSILE", cause: "health-zero" }],
        });
      });

      const detector = new LethalTransitionDetector();
      vi.spyOn(detector, "analyze")
        .mockReturnValueOnce({ status: "risk", reason: "provoked-survival", initial: null, after: null, reply: null });

      const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 1, true, detector);
      expect(result.trace.reason).toBe("same-target-lethal-accepted");
      // Picked the higher loss candidate
      expect(result.choice.trace.admissible[0]?.loss).toBe(35000);
    });

    it("does not replace if continuation finds only injury, suicide, incomplete forecast or foreign kill", () => {
      const f = transitionFixture(3);
      f.self.inventory = { BULLET: 1 };
      f.target.isHuman = true;

      vi.spyOn(physical, "resolvePhysicalShot").mockImplementation((_state, _terrain, _self, weapon, command) => {
        // Any shot not aimed at target c is for alternative target a0
        if (command.angle > 60 || command.power > 70) {
          return fallbackForecast("a0", "BULLET", 1000, {
            survivors: ["s", "a0"],
            hits: [{ shotId: 1, munitionId: 0, x: 650, y: 330, weaponId: "BULLET", directTargetId: "a0" }],
            damage: [{ shotId: 1, munitionId: 0, shooterId: "s", victimId: "a0", weaponId: "BULLET", source: "projectile", classification: "direct", healthDamageMilli: 1000, shieldLostMilli: 0, shieldAbsorbedMilli: 0 }],
          });
        }
        if (weapon === "BULLET") {
          return fallbackForecast("c", "BULLET", 1000, { survivors: ["s", "c"] });
        }
        // MISSILE: suicide kill (shooter dies too)
        return fallbackForecast("c", "MISSILE", 60000, {
          survivors: [], // shooter s is dead
          destruction: [
            { shotId: 1, shooterId: "s", victimId: "c", weaponId: "MISSILE", cause: "health-zero" },
            { shotId: 1, shooterId: "s", victimId: "s", weaponId: "MISSILE", cause: "health-zero" },
          ],
        });
      });

      const detector = new LethalTransitionDetector();
      vi.spyOn(detector, "analyze")
        .mockReturnValueOnce({ status: "risk", reason: "provoked-survival", initial: null, after: null, reply: null })
        .mockReturnValue({ status: "safe", reason: "target-type", initial: null, after: null, reply: null });

      const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 1, true, detector);
      // Continuation failed because shooter died, so it fell back to other target a0
      expect(result.trace.continuation).toMatchObject({ attempted: true, accepted: false });
      expect(result.target.id).toBe("a0");
      expect(result.trace.reason).toBe("alternative-accepted");
    });

    it("respects aggregated budgets 2/4/4 and 10 with solverCalls + ballisticCacheHits === searches", () => {
      const f = transitionFixture(2);
      f.self.inventory = { BULLET: 2, DRILLER: 1 };
      f.target.isHuman = true;

      const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 1, true);
      const counters = result.trace.selectionCounters;
      expect(counters.searches).toBeLessThanOrEqual(10);
      expect(counters.solverCalls + counters.ballisticCacheHits).toBe(counters.searches);
    });

    it("in AISniperStrategy, switching from BULLET to MISSILE applies MISSILE gaffe rules and commits only once", async () => {
      vi.stubEnv("DEV", false);
      const f = transitionFixture(2);
      f.self.inventory = { BULLET: 1 };
      f.target.isHuman = true;

      // Mock resolvePhysicalShot so BULLET is non-lethal and MISSILE is lethal
      vi.spyOn(physical, "resolvePhysicalShot").mockImplementation((_state, _terrain, _self, weapon) => {
        if (weapon === "BULLET") {
          return fallbackForecast("c", "BULLET", 1000, { survivors: ["s", "c"] });
        }
        return fallbackForecast("c", "MISSILE", 60000, {
          survivors: ["s"],
          destruction: [{ shotId: 1, shooterId: "s", victimId: "c", weaponId: "MISSILE", cause: "health-zero" }],
        });
      });

      vi.spyOn(LethalTransitionDetector.prototype, "analyze")
        .mockReturnValueOnce({ status: "risk", reason: "provoked-survival", initial: null, after: null, reply: null })
        .mockReturnValueOnce({ status: "safe", reason: "target-destroyed", initial: null, after: null, reply: null });

      const record = vi.spyOn(memory, "recordAimAttempt");
      const strategy = new AISniperStrategy(), observations: AIObservation[] = [];
      const callback = vi.fn();
      strategy.onTargetSelected = callback;
      strategy.onDecisionObserved = (value) => observations.push(value);

      const shot = await strategy.executeTurn("s", f.state, f.terrain);

      // Final weapon is MISSILE
      expect(shot.weaponId).toBe("MISSILE");
      expect(f.self.tank.currentWeapon).toBe("MISSILE");
      // Committed exactly once on target "c"
      expect(record).toHaveBeenCalledExactlyOnceWith(expect.anything(), "c");
      expect(callback).toHaveBeenCalledExactlyOnceWith("s", "c");
      expect(observations).toHaveLength(1);
      expect(observations[0].target?.playerId).toBe("c");
      // Gaffe step for MISSILE has non-zero chance (whereas BULLET would have 0)
      const gaffeStep = observations[0].steps.find((s) => s.kind === "gaffe");
      expect(gaffeStep?.parameters.chance).toBe(ADVANCED_GAFFES["v3-sniper"].chance);
      expect(JSON.stringify(observations[0].diagnostics)).toContain("same-target-lethal-accepted");
    });
  });
});
