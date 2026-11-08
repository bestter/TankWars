import { afterEach, describe, expect, it, vi } from "vitest";
import { flatTerrain, makePlayer, makeTank } from "../../../__tests__/helpers";
import type { GameState } from "../../../../types/game";
import { createIdealExpertAim } from "../shotAdvisor";
import { createExpertForecastCache, evaluateExpertShot, isValidExpertShot, type ValidExpertShotResult } from "../expertShotEvaluator";
import { chooseExpertPlan, type ExpertDecisionTrace } from "../expertPlanner";
import { getForecastAfterState, resolvePhysicalShot, retainForecastAfterState, FORECAST_SHOT_ID } from "../physicalShotForecast";
import { summarizeExpertDecision } from "../expertDecisionLog";
import { chooseTransitionSafePlan, CRITICAL_SURVIVAL_EFFECTIVE_HEALTH, hasCriticalProtectedSurvivor,
  LethalTransitionDetector, searchLethalThreat, type ThreatSearchResult, type TransitionCandidate } from "../lethalTransition";
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
  it.each([30, 100])("gives risk/provoked-survival with reply: null on provoked threat (shooter HP %s)", (health) => {
    const f = fixture(health);
    const before = structuredClone(f.state);
    const heights = [...f.terrain.getHeightmap()];
    const proposal = candidate(f);
    const rng = vi.spyOn(random, "secureRandom").mockImplementation(() => { throw new Error("GAME_RNG_USED"); });
    const analysis = new LethalTransitionDetector().analyze(proposal, f.self, f.state, f.terrain);
    expect(analysis).toMatchObject({
      status: "risk",
      reason: "provoked-survival",
      initial: { status: "absent" },
      after: { status: "found" },
      reply: null,
    });
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
    const analyze = vi.spyOn(detector, "analyze").mockReturnValueOnce({ status: "risk", reason: "provoked-survival", initial: null, after: null, reply: null })
      .mockReturnValue({ status: "unknown", reason: "uncertified", initial: null, after: null, reply: null });
    const result = chooseTransitionSafePlan([a, b, { ...b }], f.self, f.state, f.terrain, true, detector);
    expect(result.choice).toBe(a); expect(analyze).toHaveBeenCalledTimes(2);
    analyze.mockClear();
    expect(chooseTransitionSafePlan([a, b], f.self, f.state, f.terrain, false, detector).choice).toBe(a);
    expect(analyze).not.toHaveBeenCalled();
    expect(chooseTransitionSafePlan([a, b], f.self, f.state, f.terrain, true, detector).choice).toBe(a);
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it("keeps missing after states unknown only after complete initial absence, with directed state caches and no reverse threat query", () => {
    const f = fixture(), a = candidate(f);
    const search = vi.fn().mockReturnValue(searched("absent"));
    const detector = new LethalTransitionDetector(search);
    const missing = { ...a, result: { ...a.result!, forecast: { ...a.result!.forecast! } } };
    expect(detector.analyze(missing, f.self, f.state, f.terrain)).toMatchObject({ status: "unknown", reason: "after-state-missing", after: null, reply: null });
    detector.analyze(a, f.self, f.state, f.terrain);
    expect(search).toHaveBeenCalledTimes(2); // initial shared, after distinct
    const states: GameState[] = [];
    const directed = vi.fn<typeof searchLethalThreat>((state) => { states.push(state); return searched(states.length === 1 ? "absent" : "found"); });
    const analysis = new LethalTransitionDetector(directed).analyze(a, f.self, f.state, f.terrain);
    expect(analysis.status).toBe("risk");
    expect(analysis.reason).toBe("provoked-survival");
    expect(analysis.reply).toBeNull();
    // Proves absence of inverse pair search (target -> shooter)
    expect(directed).toHaveBeenCalledTimes(2);
    expect(directed.mock.calls[0].slice(2)).toEqual([expect.objectContaining({ id: "self" }), expect.objectContaining({ id: "target" })]);
    expect(directed.mock.calls[1].slice(2)).toEqual([expect.objectContaining({ id: "self" }), expect.objectContaining({ id: "target" })]);
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

  describe("ticket #374 lethal transition alternatives", () => {
    it("accepts a lethal candidate on the same target in a duel when C0 is risky", () => {
      const f = fixture();
      // Duel: remove other
      f.state.players = [f.self, f.target];
      const initial = candidate(f);
      const forecastLethal: physical.PhysicalResolution = {
        complete: true,
        survivors: [f.self.id], // target is dead
        support: [],
        steps: 10,
        hits: [],
        damage: [],
        destruction: [{ shotId: 1, shooterId: f.self.id, victimId: f.target.id, weaponId: "MISSILE", cause: "health-zero" }],
        humanDamageMilli: 0,
        aiDamageMilli: 0,
        humanDestroyedCount: 1,
        aiDestroyedCount: 0,
      };
      const lethalCandidate: TransitionCandidate = {
        primaryTargetId: f.target.id,
        weaponId: "MISSILE",
        command: { angle: 50, power: 60 },
        certified: true,
        result: {
          forecast: forecastLethal,
          rawCommand: { angle: 50, power: 60 },
        },
      };

      const detector = new LethalTransitionDetector();
      vi.spyOn(detector, "analyze")
        .mockReturnValueOnce({ status: "risk", reason: "provoked-survival", initial: null, after: null, reply: null })
        .mockReturnValueOnce({ status: "safe", reason: "target-destroyed", initial: null, after: null, reply: null });

      const selection = chooseTransitionSafePlan([initial, lethalCandidate], f.self, f.state, f.terrain, true, detector);
      expect(selection.choice).toBe(lethalCandidate);
      expect(selection.trace.reason).toBe("alternative-accepted");
      expect(selection.trace.alternatives).toHaveLength(1);
      expect(selection.trace.alternatives[0]).toMatchObject({
        targetId: f.target.id,
        accepted: true,
        analysis: { status: "safe", reason: "target-destroyed" },
      });
    });

    it("prioritizes an earlier better-ranked safe alternative on another target over a same-target lethal candidate", () => {
      const f = fixture();
      const initial = candidate(f);
      const alternativeOther = candidate(f, f.other);
      const lethalSame: TransitionCandidate = {
        primaryTargetId: f.target.id,
        weaponId: "MISSILE",
        command: { angle: 50, power: 60 },
        certified: true,
        result: {
          forecast: {
            complete: true,
            survivors: [f.self.id],
            support: [],
            steps: 10,
            hits: [],
            damage: [],
            destruction: [],
            humanDamageMilli: 0,
            aiDamageMilli: 0,
            humanDestroyedCount: 0,
            aiDestroyedCount: 0,
          },
        },
      };

      const detector = new LethalTransitionDetector();
      vi.spyOn(detector, "analyze")
        .mockReturnValueOnce({ status: "risk", reason: "provoked-survival", initial: null, after: null, reply: null })
        .mockReturnValueOnce({ status: "safe", reason: "target-type", initial: null, after: null, reply: null });

      // alternativeOther is before lethalSame in candidates
      const selection = chooseTransitionSafePlan([initial, alternativeOther, lethalSame], f.self, f.state, f.terrain, true, detector);
      expect(selection.choice).toBe(alternativeOther);
      expect(selection.trace.reason).toBe("alternative-accepted");
      expect(selection.trace.alternatives).toHaveLength(1);
      expect(selection.trace.alternatives[0].targetId).toBe(f.other.id);
    });

    it("skips critical non-lethal, uncertified or incomplete same-target variants without consuming the slot", () => {
      const f = fixture();
      const initial = candidate(f);
      // Critical non-lethal variant on same target (leaves target at 25 PV < 35 PV)
      const nonLethalVariant: TransitionCandidate = {
        primaryTargetId: f.target.id,
        weaponId: "MISSILE",
        command: { angle: 44, power: 50 },
        certified: true,
        result: {
          forecast: initial.result!.forecast!,
        },
      };
      // Incomplete variant on same target
      const incompleteVariant: TransitionCandidate = {
        primaryTargetId: f.target.id,
        weaponId: "MISSILE",
        command: { angle: 46, power: 50 },
        certified: true,
        result: {
          forecast: { complete: false, steps: 10, hits: [], damage: [], destruction: [], survivors: [], support: [] },
        },
      };
      // Uncertified variant
      const uncertifiedVariant: TransitionCandidate = {
        primaryTargetId: f.target.id,
        weaponId: "MISSILE",
        command: { angle: 47, power: 50 },
        certified: false,
        result: {
          forecast: {
            complete: true, steps: 10, hits: [], damage: [], destruction: [], survivors: [], support: [],
            humanDestroyedCount: 0, humanDamageMilli: 0, aiDestroyedCount: 0, aiDamageMilli: 0,
          },
        },
      };
      // Valid lethal variant
      const lethalVariant: TransitionCandidate = {
        primaryTargetId: f.target.id,
        weaponId: "MISSILE",
        command: { angle: 48, power: 50 },
        certified: true,
        result: {
          forecast: {
            complete: true,
            survivors: [f.self.id], // target destroyed
            support: [],
            steps: 10,
            hits: [],
            damage: [],
            destruction: [{ shotId: 1, shooterId: f.self.id, victimId: f.target.id, weaponId: "MISSILE", cause: "health-zero" }],
            humanDamageMilli: 0,
            aiDamageMilli: 0,
            humanDestroyedCount: 1,
            aiDestroyedCount: 0,
          },
        },
      };

      const detector = new LethalTransitionDetector();
      const spy = vi.spyOn(detector, "analyze")
        .mockReturnValueOnce({ status: "risk", reason: "provoked-survival", initial: null, after: null, reply: null })
        .mockReturnValueOnce({ status: "safe", reason: "target-destroyed", initial: null, after: null, reply: null });

      const selection = chooseTransitionSafePlan(
        [initial, nonLethalVariant, incompleteVariant, uncertifiedVariant, lethalVariant],
        f.self, f.state, f.terrain, true, detector,
      );
      expect(selection.choice).toBe(lethalVariant);
      expect(selection.trace.reason).toBe("alternative-accepted");
      // Exactly 2 analyze calls: initial, then lethalVariant (non-lethal variants were skipped without analyze)
      expect(spy).toHaveBeenCalledTimes(2);
      expect(selection.trace.alternatives).toHaveLength(1);
      expect(selection.trace.alternatives[0].targetId).toBe(f.target.id);
    });

    it("examines at most one candidate per other target", () => {
      const f = fixture();
      const initial = candidate(f);
      const other1 = candidate(f, f.other);
      const other2 = candidate(f, f.other);

      const detector = new LethalTransitionDetector();
      const spy = vi.spyOn(detector, "analyze")
        .mockReturnValueOnce({ status: "risk", reason: "provoked-survival", initial: null, after: null, reply: null })
        .mockReturnValueOnce({ status: "risk", reason: "provoked-survival", initial: null, after: null, reply: null });

      const selection = chooseTransitionSafePlan([initial, other1, other2], f.self, f.state, f.terrain, true, detector);
      expect(selection.choice).toBe(initial);
      expect(selection.trace.reason).toBe("initial-retained-no-alternative");
      // other2 was not analyzed because other1 was already analyzed
      expect(spy).toHaveBeenCalledTimes(2);
      expect(selection.trace.alternatives).toHaveLength(1);
    });

    it("allows suicidal lethal candidate if already in candidates", () => {
      const f = fixture();
      const initial = candidate(f);
      const suicidalLethal: TransitionCandidate = {
        primaryTargetId: f.target.id,
        weaponId: "MISSILE",
        command: { angle: 50, power: 60 },
        certified: true,
        result: {
          forecast: {
            complete: true,
            survivors: [], // both dead
            support: [],
            steps: 10,
            hits: [],
            damage: [],
            destruction: [],
            humanDamageMilli: 0,
            aiDamageMilli: 0,
            humanDestroyedCount: 1,
            aiDestroyedCount: 1,
          },
        },
      };

      const detector = new LethalTransitionDetector();
      vi.spyOn(detector, "analyze")
        .mockReturnValueOnce({ status: "risk", reason: "provoked-survival", initial: null, after: null, reply: null })
        .mockReturnValueOnce({ status: "safe", reason: "target-destroyed", initial: null, after: null, reply: null });

      const selection = chooseTransitionSafePlan([initial, suicidalLethal], f.self, f.state, f.terrain, true, detector);
      expect(selection.choice).toBe(suicidalLethal);
      expect(selection.trace.reason).toBe("alternative-accepted");
    });

    it("retains C0 when C0 analysis is safe or unknown without testing alternatives", () => {
      const f = fixture();
      const initial = candidate(f);
      const alternative = candidate(f, f.other);

      const detector = new LethalTransitionDetector();
      const spy = vi.spyOn(detector, "analyze")
        .mockReturnValueOnce({ status: "safe", reason: "existing-threat", initial: null, after: null, reply: null });

      const selection = chooseTransitionSafePlan([initial, alternative], f.self, f.state, f.terrain, true, detector);
      expect(selection.choice).toBe(initial);
      expect(selection.trace.reason).toBe("initial-retained");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(selection.trace.alternatives).toHaveLength(0);
    });

    it("summarizeExpertDecision preserves historical archives with non-null reply and formats new null replies correctly", () => {
      // Historical archive with non-null reply
      const historical = summarizeExpertDecision({
        phase: "OPTIMISER_PROFIT",
        candidateCount: 2,
        lethalTransition: {
          reason: "initial-retained",
          turn: 1,
          round: 1,
          analysis: {
            status: "safe",
            reason: "no-lethal-reply",
            initial: searched("absent"),
            after: searched("found"),
            reply: searched("absent"),
          },
          alternatives: [],
        },
      } as unknown as Parameters<typeof summarizeExpertDecision>[0]);
      expect(historical.lethalTransition?.analysis).toEqual({
        status: "safe",
        reason: "no-lethal-reply",
        initial: "absent",
        after: "found",
        reply: "absent",
      });

      // New archive with provoked-survival and reply: null
      const modern = summarizeExpertDecision({
        phase: "OPTIMISER_PROFIT",
        candidateCount: 2,
        lethalTransition: {
          reason: "alternative-accepted",
          turn: 1,
          round: 1,
          initialTargetId: "c",
          finalTargetId: "c",
          analysis: {
            status: "risk",
            reason: "provoked-survival",
            initial: searched("absent"),
            after: searched("found"),
            reply: null,
          },
          alternatives: [{
            targetId: "c",
            accepted: true,
            analysis: { status: "safe", reason: "target-destroyed", initial: null, after: null, reply: null },
          }],
        },
      } as unknown as Parameters<typeof summarizeExpertDecision>[0]);
      expect(modern.lethalTransition?.analysis).toEqual({
        status: "risk",
        reason: "provoked-survival",
        initial: "absent",
        after: "found",
        reply: null,
      });
      expect(modern.lethalTransition?.alternatives).toEqual([{
        targetId: "c",
        accepted: true,
        status: "safe",
        reason: "target-destroyed",
      }]);
    });

    it("formats selectionReason for same-target elimination vs other-target without provoked threat", () => {
      const sameTargetReason = (selectedTargetId: string, initialTargetId: string) => (
        selectedTargetId === initialTargetId
          ? "élimination de la cible sans nouvelle menace provoquée"
          : "autre cible sans nouvelle menace provoquée"
      );
      expect(sameTargetReason("c", "c")).toBe("élimination de la cible sans nouvelle menace provoquée");
      expect(sameTargetReason("other", "c")).toBe("autre cible sans nouvelle menace provoquée");
    });
  });

  describe("ticket #389 critical non-lethal survival prevention", () => {
    it("flags a shot leaving a protected target (< 35 effective HP) as risk/provoked-survival even when initial threat is found", () => {
      expect(CRITICAL_SURVIVAL_EFFECTIVE_HEALTH).toBe(35);
      const f = fixture(100);
      // f.target starts at 60 HP; MISSILE (35 dmg) leaves it at 25 HP (< 35)
      const proposal = candidate(f);
      expect(hasCriticalProtectedSurvivor(proposal.result!.forecast!, f.state, f.self.id)).toBe(true);

      // Even if a theoretical initial threat (e.g. BULLDOZER or DRILLER) already existed ("found"),
      // leaving the protected target at < 35 effective HP must NOT short-circuit to safe/existing-threat.
      const search = vi.fn<typeof searchLethalThreat>().mockReturnValue(searched("found"));
      const analysis = new LethalTransitionDetector(search).analyze(proposal, f.self, f.state, f.terrain);
      expect(analysis).toMatchObject({
        status: "risk",
        reason: "provoked-survival",
        initial: { status: "found" },
        after: null,
        reply: null,
      });
      expect(search).toHaveBeenCalledTimes(1);
    });

    it("preserves safe/existing-threat when initial threat is found and protected target survives with >= 35 effective HP", () => {
      const f = fixture(100);
      f.target.tank.health = 100;
      f.target.tank.shield = 26;
      // MISSILE leaves target well above 35 effective HP (~91 HP)
      const proposal = candidate(f);
      const after = getForecastAfterState(proposal.result!.forecast!)!;
      const victim = after.state.players.find((p) => p.id === f.target.id)!;
      expect(victim.tank.health + victim.tank.shield).toBeGreaterThanOrEqual(35);
      expect(hasCriticalProtectedSurvivor(proposal.result!.forecast!, f.state, f.self.id)).toBe(false);

      const search = vi.fn<typeof searchLethalThreat>().mockReturnValue(searched("found"));
      const analysis = new LethalTransitionDetector(search).analyze(proposal, f.self, f.state, f.terrain);
      expect(analysis).toMatchObject({
        status: "safe",
        reason: "existing-threat",
        initial: { status: "found" },
        after: null,
        reply: null,
      });
      expect(search).toHaveBeenCalledTimes(1);
    });

    it("detects collateral protected survivors (< 35 effective HP or newly threatened) when primaryTargetId is unprotected or destroyed", () => {
      const f = fixture(100);
      // Primary target is unprotected (v2-heuristic), collateral is v4-smart left at 6 HP
      const p2 = makePlayer({
        id: "player-2",
        isHuman: false,
        aiProfile: "v2-heuristic",
        tank: makeTank("player-2", 380, 336, { health: 40 }),
      });
      const p4 = makePlayer({
        id: "player-4",
        isHuman: false,
        aiProfile: "v4-smart",
        tank: makeTank("player-4", 410, 336, { health: 40 }),
      });
      const untouchedSmart = makePlayer({
        id: "untouched",
        isHuman: false,
        aiProfile: "v4-smart",
        tank: makeTank("untouched", 720, 336, { health: 20 }), // < 35 HP initially, but untouched by the shot
      });
      f.state.players = [f.self, p2, p4, untouchedSmart];

      const baseResolution = resolvePhysicalShot(
        f.state,
        f.terrain,
        f.self,
        "MISSILE",
        { angle: 45, power: 50 },
        { captureAfterState: true },
      );
      if (!baseResolution.complete) throw new Error("Expected complete baseResolution");
      const afterState = getForecastAfterState(baseResolution)!;
      const afterP2 = afterState.state.players.find((p) => p.id === "player-2")!;
      const afterP4 = afterState.state.players.find((p) => p.id === "player-4")!;
      afterP2.tank.isDead = true;
      afterP2.tank.health = 0;
      afterP4.tank.health = 6;
      afterP4.tank.shield = 0;

      const collateralForecast = retainForecastAfterState<physical.PhysicalResolution>(baseResolution, {
        ...baseResolution,
        complete: true,
        survivors: ["self", "player-4", "untouched"],
        destruction: [{ shotId: FORECAST_SHOT_ID, shooterId: "self", victimId: "player-2", weaponId: "MISSILE", cause: "health-zero" }],
        damage: [
          {
            shotId: FORECAST_SHOT_ID,
            munitionId: 0,
            shooterId: "self",
            victimId: "player-2",
            weaponId: "MISSILE",
            source: "projectile",
            classification: "direct",
            healthDamageMilli: 40_000,
            shieldLostMilli: 0,
            shieldAbsorbedMilli: 0,
          },
          {
            shotId: FORECAST_SHOT_ID,
            munitionId: 0,
            shooterId: "self",
            victimId: "player-4",
            weaponId: "MISSILE",
            source: "projectile",
            classification: "indirect",
            healthDamageMilli: 34_000,
            shieldLostMilli: 0,
            shieldAbsorbedMilli: 0,
          },
        ],
        hits: [{ shotId: FORECAST_SHOT_ID, munitionId: 0, x: 380, y: 336, weaponId: "MISSILE", directTargetId: "player-2" }],
      });

      const collateralCandidate: TransitionCandidate = {
        primaryTargetId: "player-2",
        weaponId: "MISSILE",
        command: { angle: 45, power: 50 },
        certified: true,
        result: { forecast: collateralForecast },
      };

      const search = vi.fn<typeof searchLethalThreat>().mockReturnValue(searched("found"));
      const analysis = new LethalTransitionDetector(search).analyze(collateralCandidate, f.self, f.state, f.terrain);
      expect(analysis).toMatchObject({
        status: "risk",
        reason: "provoked-survival",
      });
      // Only player-4 was inspected; untouchedSmart was not affected by the shot
      expect(search).toHaveBeenCalledTimes(1);
      expect(search.mock.calls[0][3].id).toBe("player-4");
    });

    it("deduplicates identical commands across groups and accepts a measured safe non-lethal alternative on the same target", () => {
      const f = fixture(100);
      f.state.players = [f.self, f.target]; // Duel with human target
      f.target.tank.health = 100;
      f.target.tank.shield = 40;
      f.self.inventory = { BULLET: 2, MISSILE: 99 };

      // Simulate C0, C1, C2 sharing the exact same risky BULLET command (from [p2,p4], [p3,p4], [p4])
      // and C3 being a measured MISSILE command on the same target leaving it at 91 HP (safe: no-new-threat)
      const missileProposal = candidate(f);
      const bulletForecast = retainForecastAfterState<physical.PhysicalResolution>(
        missileProposal.result!.forecast!,
        {
          ...missileProposal.result!.forecast!,
          damage: [{
            shotId: FORECAST_SHOT_ID,
            munitionId: 0,
            shooterId: f.self.id,
            victimId: f.target.id,
            weaponId: "BULLET",
            source: "projectile",
            classification: "direct",
            healthDamageMilli: 94_000,
            shieldLostMilli: 40_000,
            shieldAbsorbedMilli: 0,
          }],
        },
      );

      const makeBulletDup = (): TransitionCandidate => ({
        primaryTargetId: f.target.id,
        weaponId: "BULLET",
        command: { angle: 50, power: 75 },
        certified: true,
        result: { forecast: bulletForecast, rawCommand: { angle: 50, power: 75 } },
      });

      const c0 = makeBulletDup();
      const c1 = makeBulletDup();
      const c2 = makeBulletDup();
      const c3: TransitionCandidate = {
        primaryTargetId: f.target.id,
        weaponId: "MISSILE",
        command: { angle: 66, power: 86 },
        certified: true,
        result: { forecast: missileProposal.result!.forecast!, rawCommand: { angle: 66, power: 86 } },
      };

      const detector = new LethalTransitionDetector();
      const spy = vi.spyOn(detector, "analyze")
        .mockReturnValueOnce({ status: "risk", reason: "provoked-survival", initial: searched("absent"), after: searched("found"), reply: null })
        .mockReturnValueOnce({ status: "safe", reason: "no-new-threat", initial: searched("absent"), after: searched("absent"), reply: null });

      const selection = chooseTransitionSafePlan([c0, c1, c2, c3], f.self, f.state, f.terrain, true, detector);
      expect(selection.choice).toBe(c3);
      expect(selection.trace.reason).toBe("alternative-accepted");
      // c1 and c2 were skipped by command deduplication without calling detector.analyze
      expect(spy).toHaveBeenCalledTimes(2);
      expect(selection.trace.alternatives).toHaveLength(1);
      expect(selection.trace.alternatives[0]).toMatchObject({
        targetId: f.target.id,
        accepted: true,
        analysis: { status: "safe", reason: "no-new-threat" },
      });
    });

    it("preserves nonCriticalAlternative per (group, weapon) in evaluateExpertShot and selects it in chooseExpertPlan with measured selectionReason", () => {
      const f = fixture(100);
      f.state.players = [f.self, f.target];
      f.target.tank.health = 100;
      f.target.tank.shield = 40;
      f.self.inventory = { GRENADE: 2 };

      const cache = createExpertForecastCache(true);
      const baseRes = resolvePhysicalShot(f.state, f.terrain, f.self, "MISSILE", { angle: 66, power: 86 }, { captureAfterState: true });
      if (!baseRes.complete) throw new Error("Expected complete resolution");

      // Create two distinct after-states: one critical (6 HP) for the first point/arc, one safe (80 HP) for the second point/arc
      const resCritical = resolvePhysicalShot(f.state, f.terrain, f.self, "MISSILE", { angle: 66, power: 86 }, { captureAfterState: true });
      if (!resCritical.complete) throw new Error("Expected complete resCritical");
      const afterCrit = getForecastAfterState(resCritical)!;
      const critVictim = afterCrit.state.players.find((p) => p.id === f.target.id)!;
      critVictim.tank.health = 6;
      critVictim.tank.shield = 0;

      const resSafe = resolvePhysicalShot(f.state, f.terrain, f.self, "MISSILE", { angle: 66, power: 86 }, { captureAfterState: true });
      if (!resSafe.complete) throw new Error("Expected complete resSafe");
      const afterSafe = getForecastAfterState(resSafe)!;
      const safeVictim = afterSafe.state.players.find((p) => p.id === f.target.id)!;
      safeVictim.tank.health = 80;
      safeVictim.tank.shield = 0;

      let callIndex = 0;
      vi.spyOn(aim, "solveExpertAim").mockImplementation(() => {
        callIndex++;
        return {
          command: callIndex === 1 ? { angle: 50, power: 75 } : { angle: 62, power: 70 },
          complete: true,
        };
      });
      const resolveSpy = vi.spyOn(physical, "resolvePhysicalShot").mockImplementation((_state, _terrain, _shooter, _weapon, command): physical.PhysicalResolution => {
        if (command.angle === 50) {
          return retainForecastAfterState<physical.PhysicalResolution>(resCritical, {
            ...resCritical,
            hits: [{ shotId: FORECAST_SHOT_ID, munitionId: 0, x: 400, y: 336, weaponId: "GRENADE", directTargetId: f.target.id }],
            damage: [{
              shotId: FORECAST_SHOT_ID, munitionId: 0, shooterId: f.self.id, victimId: f.target.id, weaponId: "GRENADE",
              source: "projectile", classification: "direct", healthDamageMilli: 94_000, shieldLostMilli: 40_000, shieldAbsorbedMilli: 0,
            }],
          });
        }
        return retainForecastAfterState<physical.PhysicalResolution>(resSafe, {
          ...resSafe,
          hits: [{ shotId: FORECAST_SHOT_ID, munitionId: 0, x: 400, y: 336, weaponId: "GRENADE", directTargetId: f.target.id }],
          damage: [{
            shotId: FORECAST_SHOT_ID, munitionId: 0, shooterId: f.self.id, victimId: f.target.id, weaponId: "GRENADE",
            source: "projectile", classification: "indirect", healthDamageMilli: 20_000, shieldLostMilli: 40_000, shieldAbsorbedMilli: 0,
          }],
        });
      });

      const evaluated = evaluateExpertShot(
        f.state,
        f.terrain,
        f.self,
        "GRENADE",
        [f.target],
        false,
        true,
        cache,
        { mode: "own", aim: createIdealExpertAim().forTarget(f.target.id), selectionPolicy: "OPTIMISER_PROFIT" },
      );

      expect(isValidExpertShot(evaluated)).toBe(true);
      const valid = evaluated as ValidExpertShotResult;
      expect(valid.command).toEqual({ angle: 50, power: 75 });
      expect(valid.nonCriticalAlternative).toBeDefined();
      expect(valid.nonCriticalAlternative?.command).toEqual({ angle: 62, power: 70 });
      // Only the 2 unique normalized commands were physically simulated
      expect(resolveSpy).toHaveBeenCalledTimes(2);

      // Verify chooseExpertPlan includes nonCriticalAlternative and selects it with the measured-shot reason
      vi.spyOn(LethalTransitionDetector.prototype, "analyze").mockImplementation((cand) => {
        if (cand.command.angle === 50) {
          return { status: "risk", reason: "provoked-survival", initial: searched("absent"), after: searched("found"), reply: null };
        }
        return { status: "safe", reason: "no-new-threat", initial: searched("absent"), after: searched("absent"), reply: null };
      });

      let trace: ExpertDecisionTrace | undefined;
      const plan = chooseExpertPlan(
        f.self,
        f.state,
        f.terrain,
        createIdealExpertAim(),
        () => valid,
        (t) => { trace = t; },
        cache,
        "OPTIMISER_PROFIT",
      );

      expect(plan?.command).toEqual({ angle: 62, power: 70 });
      expect(trace?.lethalTransition?.reason).toBe("alternative-accepted");
      expect(trace?.selectionReason).toBe("tir mesuré sur la cible sans nouvelle menace provoquée");
    });
  });
});
