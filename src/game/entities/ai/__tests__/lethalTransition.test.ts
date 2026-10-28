import { afterEach, describe, expect, it, vi } from "vitest";
import { flatTerrain, makePlayer, makeTank } from "../../../__tests__/helpers";
import type { GameState } from "../../../../types/game";
import { createIdealExpertAim } from "../shotAdvisor";
import { createExpertForecastCache, evaluateExpertShot, isValidExpertShot } from "../expertShotEvaluator";
import { getForecastAfterState, resolvePhysicalShot } from "../physicalShotForecast";
import { chooseTransitionSafePlan, LethalTransitionDetector, searchLethalThreat,
  type ThreatSearchResult, type TransitionCandidate } from "../lethalTransition";
import * as aim from "../expertAim";
import * as physical from "../physicalShotForecast";
import * as random from "../../../../utils/random";
import * as ballistics from "../BallisticsSimulator";

function fixture(shooterHealth = 30) {
  const self = makePlayer({ id: "self", isHuman: false, aiProfile: "v4-smart", inventory: {},
    tank: makeTank("self", 100, 336, { health: shooterHealth }) });
  const target = makePlayer({ id: "target", inventory: {}, tank: makeTank("target", 400, 336, { health: 60 }) });
  const other = makePlayer({ id: "other", isHuman: false, aiProfile: "v1-random", inventory: {},
    tank: makeTank("other", 650, 336) });
  const state: GameState = { phase: "COMBAT", players: [self, target, other], currentPlayerIndex: 0,
    turn: 5, roundNumber: 2, windForce: 0, gravity: 260,
    localShotContext: { playerCountAtMatchStart: 3, isFirstShotOfRound: true } };
  return { self, target, other, state, terrain: flatTerrain(800, 480) };
}
function candidate(f: ReturnType<typeof fixture>, target = f.target): TransitionCandidate {
  const result = evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [target], false, true,
    createExpertForecastCache(), { mode: "own", aim: createIdealExpertAim().forTarget(target.id), selectionPolicy: "OPTIMISER_PROFIT" });
  if (!isValidExpertShot(result)) throw new Error("Expected a real certified candidate");
  return { primaryTargetId: target.id, weaponId: "MISSILE", command: result.command, result };
}
function searched(status: ThreatSearchResult["status"]): ThreatSearchResult {
  return { status, weapons: ["MISSILE"], stock: {}, searches: 1, forecasts: 1, elapsedMs: 0 };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("new lethal transition #352", () => {
  it("retains the stabilized state when profit reuses a failed survival forecast without another simulation", () => {
    const f = fixture(100), cache = createExpertForecastCache();
    const targetAim = createIdealExpertAim().forTarget(f.target.id);
    const resolve = vi.spyOn(physical, "resolvePhysicalShot");
    evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [f.target], true, true, cache,
      { mode: "own", aim: targetAim, selectionPolicy: "SURVIE" });
    const count = resolve.mock.calls.length;
    const result = evaluateExpertShot(f.state, f.terrain, f.self, "MISSILE", [f.target], false, true, cache,
      { mode: "own", aim: targetAim, selectionPolicy: "OPTIMISER_PROFIT" });
    expect(isValidExpertShot(result)).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(count);
    expect(getForecastAfterState(result.forecast!)).toBeDefined();
  });
  it.each([30, 100])("uses real stabilized physics and independent after-shot hypotheses (shooter HP %s)", (health) => {
    const f = fixture(health);
    const before = structuredClone(f.state);
    const heights = [...f.terrain.getHeightmap()];
    const proposal = candidate(f);
    const rng = vi.spyOn(random, "secureRandom").mockImplementation(() => { throw new Error("GAME_RNG_USED"); });
    const analysis = new LethalTransitionDetector().analyze(proposal, f.self, f.state, f.terrain);
    expect(analysis).toMatchObject({ status: health === 30 ? "risk" : "safe",
      reason: health === 30 ? "lethal-reply" : "no-lethal-reply",
      initial: { status: "absent" }, after: { status: "found" }, reply: { status: health === 30 ? "found" : "absent" } });
    expect(f.state).toEqual(before);
    expect([...f.terrain.getHeightmap()]).toEqual(heights);
    expect(rng).not.toHaveBeenCalled();
    const after = getForecastAfterState(proposal.result!.forecast!);
    expect(after?.state.localShotContext?.isFirstShotOfRound).toBe(false);
    expect(after?.state.players[1].tank.health).toBeLessThan(f.target.tank.health);
    expect(after?.terrain.getHeightmap()).not.toEqual(heights);
    expect(JSON.stringify(proposal)).not.toContain("copiedTerrain");
  });

  it("changes target using only existing real candidates and retains the original in a duel", () => {
    const f = fixture();
    const initial = candidate(f), alternative = candidate(f, f.other);
    const selection = chooseTransitionSafePlan([initial, alternative], f.self, f.state, f.terrain, true);
    expect(selection.choice).toBe(alternative);
    expect(selection.trace.reason).toBe("alternative-accepted");
    expect(chooseTransitionSafePlan([initial], f.self, f.state, f.terrain, true).choice).toBe(initial);
  });

  it("retains unknown winners, skips unknown alternatives and never explores a lesser variant of the same target", () => {
    const f = fixture(); const a = candidate(f), b = candidate(f, f.other);
    const detector = new LethalTransitionDetector();
    const analyze = vi.spyOn(detector, "analyze").mockReturnValueOnce({ status: "risk", reason: "lethal-reply", initial: null, after: null, reply: null })
      .mockReturnValue({ status: "unknown", reason: "uncertified", initial: null, after: null, reply: null });
    const result = chooseTransitionSafePlan([a, b, { ...b }], f.self, f.state, f.terrain, true, detector);
    expect(result.choice).toBe(a); expect(analyze).toHaveBeenCalledTimes(2);
    analyze.mockClear();
    expect(chooseTransitionSafePlan([a, b], f.self, f.state, f.terrain, false, detector).choice).toBe(a);
    expect(analyze).not.toHaveBeenCalled();
    expect(chooseTransitionSafePlan([a, b], f.self, f.state, f.terrain, true, detector).choice).toBe(a);
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it("keeps missing after states unknown only after complete initial absence, with directed state caches", () => {
    const f = fixture(), a = candidate(f);
    const search = vi.fn().mockReturnValue(searched("absent"));
    const detector = new LethalTransitionDetector(search);
    const missing = { ...a, result: { ...a.result!, forecast: { ...a.result!.forecast! } } };
    expect(detector.analyze(missing, f.self, f.state, f.terrain)).toMatchObject({ status: "unknown", reason: "after-state-missing", after: null, reply: null });
    detector.analyze(a, f.self, f.state, f.terrain);
    expect(search).toHaveBeenCalledTimes(2); // initial shared, after distinct
    const states: GameState[] = [];
    const directed = vi.fn<typeof searchLethalThreat>((state) => { states.push(state); return searched(states.length === 1 ? "absent" : "found"); });
    expect(new LethalTransitionDetector(directed).analyze(a, f.self, f.state, f.terrain).status).toBe("risk");
    expect(states[1]).toBe(states[2]);
    expect(directed.mock.calls[1].slice(2)).toEqual([expect.objectContaining({ id: "self" }), expect.objectContaining({ id: "target" })]);
    expect(directed.mock.calls[2].slice(2)).toEqual([expect.objectContaining({ id: "target" }), expect.objectContaining({ id: "self" })]);
  });

  it.each(["existing", "unknown", "target-type", "target-dead", "self-dead", "uncertified"])("short circuits %s", (branch) => {
    const f = fixture(), a = candidate(f);
    const search = vi.fn().mockReturnValue(searched(branch === "existing" ? "found" : "unknown"));
    if (branch === "target-type") { f.target.isHuman = false; f.target.aiProfile = "v3-sniper"; }
    const forecast = a.result!.forecast;
    const proposal = branch === "target-dead" || branch === "self-dead" ? { ...a, result: { ...a.result!, forecast: {
      ...candidate(f).result!.forecast!, survivors: branch === "target-dead" ? [] : [f.target.id],
    } } } : branch === "uncertified" ? { ...a, result: undefined } : a;
    const analysis = new LethalTransitionDetector(search).analyze(proposal, f.self, f.state, f.terrain);
    expect(analysis.after).toBeNull(); expect(analysis.reply).toBeNull();
    expect(search).toHaveBeenCalledTimes(branch === "existing" || branch === "unknown" ? 1 : 0);
    expect(forecast).toBeDefined();
  });

  it("consumes the last paid round exactly once on isolated copies, retaining materials and never serializing full state", () => {
    const f = fixture(); f.self.inventory.BULLET = 1; f.terrain.setMaterialRange(0, 800, "ROCK");
    const result = resolvePhysicalShot(f.state, f.terrain, f.self, "BULLET", { angle: 30, power: 50 }, { captureAfterState: true });
    expect(result.complete).toBe(true);
    const after = getForecastAfterState(result)!;
    expect(after.state.players[0].inventory.BULLET).toBe(0);
    expect(f.self.inventory.BULLET).toBe(1);
    expect(after.terrain.getMaterials()).toEqual(f.terrain.getMaterials());
    expect(after.state.players).not.toBe(f.state.players);
    expect(getForecastAfterState(result)).toBe(after);
    expect(Object.keys(result)).not.toContain("state");
  });

  it("excludes nuclear stock and lets positive lethal proof override another incomplete trial, without economics", () => {
    const f = fixture(); delete f.state.localShotContext;
    f.self.inventory = { NUKE: 3, THERMONUCLEAR: 3, BULLET: 1 };
    const forecast = candidate(fixture()).result!.forecast!;
    vi.spyOn(aim, "solveExpertAim").mockReturnValueOnce({ command: { angle: 45, power: 50 }, complete: false })
      .mockReturnValue({ command: { angle: 45, power: 50 }, complete: true });
    const physics = vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue({ ...forecast, destruction: [
      { shotId: 1, shooterId: f.self.id, victimId: f.target.id, weaponId: "MISSILE", cause: "health-zero" },
    ] });
    expect(searchLethalThreat(f.state, f.terrain, f.self, f.target)).toMatchObject({ status: "found" });
    expect(physics.mock.calls.every((call) => !["NUKE", "THERMONUCLEAR"].includes(call[3]))).toBe(true);
  });

  it.each(["absent", "unknown"] as const)("stops after an %s post-shot threat", (status) => {
    const f = fixture(), proposal = candidate(f);
    const search = vi.fn<typeof searchLethalThreat>().mockReturnValueOnce(searched("absent")).mockReturnValue(searched(status));
    const analysis = new LethalTransitionDetector(search).analyze(proposal, f.self, f.state, f.terrain);
    expect(analysis.status).toBe(status === "absent" ? "safe" : "unknown");
    expect(analysis.reply).toBeNull(); expect(search).toHaveBeenCalledTimes(2);
  });

  it("cannot conclude absence after incomplete ordinary search or forecast", () => {
    const f = fixture();
    const search = vi.spyOn(aim, "solveExpertAim").mockReturnValue({ command: { angle: 45, power: 50 }, complete: false });
    expect(searchLethalThreat(f.state, f.terrain, f.self, f.target)).toMatchObject({ status: "unknown", cause: "search-incomplete", forecasts: 0 });
    search.mockReturnValue({ command: { angle: 45, power: 50 }, complete: true });
    vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue({ complete: false, steps: 2400, hits: [], damage: [], destruction: [], survivors: [], support: [] });
    expect(searchLethalThreat(f.state, f.terrain, f.self, f.target)).toMatchObject({ status: "unknown", cause: "forecast-incomplete", forecasts: 1 });
  });

  it("BULLDOZER distinguishes bounded misses from incomplete positive-push impacts and accepts a suicidal proof", () => {
    const f = fixture(); f.self.inventory.BULLDOZER = 1;
    // Edge target: the flat safe-corridor shortcut cannot apply.
    f.target.tank.position.x = 780;
    const complete = candidate(f).result!.forecast!;
    if (!complete.complete) throw new Error("Expected complete forecast");
    vi.spyOn(aim, "solveExpertAim").mockReturnValue({ command: { angle: 45, power: 50 }, complete: true });
    vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue({ ...complete, destruction: [] });
    const trajectory: ballistics.DirectBulldozerTrajectory = { terminal: "incomplete", x: 780, y: 336, vx: 20, steps: 420, nearDistance: 0 };
    const direct = vi.spyOn(ballistics, "searchDirectBulldozerSolutions").mockImplementation(function* () {
      yield { command: { angle: 45, power: 50 }, trajectory };
    });
    expect(searchLethalThreat(f.state, f.terrain, f.self, f.target).status).toBe("absent");
    direct.mockImplementation(function* () { yield { command: { angle: 45, power: 50 }, trajectory: { ...trajectory, terminal: "tank", targetId: f.target.id } }; });
    const push = vi.spyOn(physical, "resolveBulldozerImpact").mockReturnValue({ complete: false, steps: 2400, hits: [], damage: [], destruction: [], survivors: [], support: [] });
    expect(searchLethalThreat(f.state, f.terrain, f.self, f.target)).toMatchObject({ status: "unknown", cause: "bulldozer-fall-incomplete" });
    push.mockReturnValue({ ...complete, complete: true, survivors: [] });
    expect(searchLethalThreat(f.state, f.terrain, f.self, f.target)).toMatchObject({ status: "found", weaponId: "BULLDOZER" });
  });
});
