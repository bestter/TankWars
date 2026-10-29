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
  return { status, reason: status === "risk" ? "lethal-reply" : status === "safe" ? "no-new-threat" : "uncertified",
    initial: null, after: null, reply: null };
}
function choice(reason: selection.SniperChoiceReason = "bullet", angle = 40): selection.SniperPhysicalChoice {
  return { weaponId: reason === "bullet" ? "BULLET" : reason === "driller" ? "DRILLER" : "MISSILE",
    reason, certified: reason !== "missile-ordinary", point: { x: 400, y: 330, kind: "tank" }, variant: "full",
    rawCommand: { angle: angle + 0.04, power: 50 }, command: { angle, power: 50 },
    trace: { selectionReason: "seul candidat", admissible: [], refusals: [], searches: 2, forecasts: 1, cacheHits: 1 } };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("SNIPER lethal transitions with real first-shot and hypothesis physics", () => {
  it.each([false, true])("retains stabilized original forecast, with economic context=%s", (context) => {
    const f = transitionFixture(2);
    if (!context) delete f.state.localShotContext;
    const before = structuredClone(f.state), heights = [...f.terrain.getHeightmap()];
    const rng = vi.spyOn(random, "secureRandom").mockImplementation(() => { throw new Error("unexpected RNG"); });
    const resolve = vi.spyOn(physical, "resolvePhysicalShot");
    const search = vi.fn(searchLethalThreat);
    const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 3, true, new LethalTransitionDetector(search));
    expect(result.trace.analysis).toMatchObject({ status: "risk", initial: { status: "absent" },
      after: { status: "found" }, reply: { status: "found" } });
    expect(result.trace.alternatives).toHaveLength(0);
    expect(result.trace.extraAmplitude).toBeUndefined();
    const forecast = selection.getSniperChoiceForecast(result.choice)!;
    const after = physical.getForecastAfterState(forecast)!;
    expect(search.mock.calls[1][0]).toBe(after.state);
    expect(search.mock.calls[2][0]).toBe(after.state);
    expect(search.mock.calls[1][1]).toBe(search.mock.calls[2][1]);
    expect(after.state.localShotContext?.isFirstShotOfRound).toBe(context ? false : undefined);
    const selectionCalls = resolve.mock.calls.filter(call => call[5]?.captureAfterState);
    expect(selectionCalls).toHaveLength(result.choice.trace.forecasts);
    expect(selectionCalls.some((_, i) => resolve.mock.results[resolve.mock.calls.indexOf(selectionCalls[i])].value === forecast)).toBe(true);
    expect(after.terrain.getHeightmap()).not.toEqual(heights);
    expect(f.state).toEqual(before);
    expect(f.terrain.getHeightmap()).toEqual(heights);
    expect(rng).not.toHaveBeenCalled();
    expect(JSON.stringify(result.trace)).not.toMatch(/copiedTerrain|"players"|"heights"/);
  });

  it("a real transition without a lethal reply keeps the original", () => {
    const f = transitionFixture(2, 100);
    const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 3);
    expect(result.trace.analysis).toMatchObject({ status: "safe", reason: "no-lethal-reply",
      initial: { status: "absent" }, after: { status: "found" }, reply: { status: "absent" } });
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

  it.each(["safe", "unknown"] as const)("keeps the initial %s analysis without examining alternatives", status => {
    const f = transitionFixture(4);
    const pick = vi.spyOn(selection, "chooseSniperPhysicalShot").mockReturnValue(choice());
    const detector = new LethalTransitionDetector();
    vi.spyOn(detector, "analyze").mockReturnValue(analysis(status));
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0.3);
    const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain, 3, false, detector);
    expect(result.target).toBe(f.target); expect(pick).toHaveBeenCalledTimes(1); expect(rng).not.toHaveBeenCalled();
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
    expect(result.trace.selectionCounters).toEqual({ searches: 6, forecasts: 3, cacheHits: 3 });
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
    const f = transitionFixture(count), detector = new LethalTransitionDetector(), initial = choice("missile-surviving");
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
});
