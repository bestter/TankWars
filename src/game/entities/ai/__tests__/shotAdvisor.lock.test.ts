import { afterEach, describe, expect, it, vi } from "vitest";
import { flatTerrain, makePlayer, makeTank } from "../../../__tests__/helpers";
import type { GameState } from "../../../../types/game";
import type { Player } from "../../../../types/player";
import { calculateShotAdvice, createIdealExpertAim, livingAdvisorLock, type AdvisorSnapshot } from "../shotAdvisor";
import { chooseExpertPlan, type ExpertDecisionTrace } from "../expertPlanner";
import { summarizeExpertDecision } from "../expertDecisionLog";
import * as evaluator from "../expertShotEvaluator";
import * as bulldozerThreat from "../bulldozerThreat";
import * as physical from "../physicalShotForecast";
import * as random from "../../../../utils/random";
import { LethalTransitionDetector, type TransitionCandidate } from "../lethalTransition";
import { ORDINARY_AIM_POLICY } from "../aimSearch";
import type { ExpertFallbackChoice } from "../expertShotEvaluator";

const consequences = { humanDestroyedCount: 0, humanDamageMilli: 0, aiDestroyedCount: 0, aiDamageMilli: 0 };
const invalid: evaluator.ExpertShotResult = {
  destination: -1, profit: 0, destroyedIds: new Set(), shooterDestroyed: false, pointOrder: -1,
};

function resolution(
  victims: readonly { id: string; healthDamageMilli: number }[],
  survivors: readonly string[],
): Extract<physical.PhysicalResolution, { complete: true }> {
  const humanDamageMilli = victims.filter((victim) => victim.id === "c")
    .reduce((sum, victim) => sum + victim.healthDamageMilli, 0);
  const aiDamageMilli = victims.filter((victim) => victim.id === "b")
    .reduce((sum, victim) => sum + victim.healthDamageMilli, 0);
  return {
    complete: true,
    survivors,
    hits: [],
    damage: victims.map((victim) => ({
      shotId: 1, munitionId: 0, shooterId: "a", victimId: victim.id, weaponId: "MISSILE",
      source: "projectile", classification: "indirect", shieldAbsorbedMilli: 0, shieldLostMilli: 0,
      healthDamageMilli: victim.healthDamageMilli,
    })),
    destruction: [],
    support: [],
    steps: 1,
    humanDestroyedCount: 0,
    humanDamageMilli,
    aiDestroyedCount: 0,
    aiDamageMilli,
  };
}

function aimed(
  primaryTargetId: string,
  profit: number,
  extras: Partial<evaluator.ValidExpertShotResult> = {},
): evaluator.ValidExpertShotResult {
  return {
    ...consequences,
    kind: "evaluated",
    primaryTargetId,
    offset: 0,
    attempts: 0,
    command: { angle: 45, power: 50 },
    rawCommand: { angle: 45, power: 50 },
    requestedPoint: { x: 400, y: 328.5 },
    destination: { x: 400, y: 328.5, kind: "tank" },
    policy: { variant: "full", penalizeProximity: false },
    pointOrder: 0,
    profit,
    shooterDestroyed: false,
    destroyedIds: new Set([primaryTargetId]),
    ...extras,
  };
}

function trio(inventory: Player["inventory"] = {}) {
  const self = makePlayer({ id: "a", name: "A", isHuman: true, inventory, tank: makeTank("a", 100, 336) });
  const locked = makePlayer({
    id: "b", name: "B", isHuman: false, aiProfile: "v2-heuristic", inventory: {},
    tank: makeTank("b", 400, 336),
  });
  const other = makePlayer({ id: "c", name: "C", isHuman: true, inventory: {}, tank: makeTank("c", 600, 336) });
  const state: GameState = {
    phase: "COMBAT", players: [self, locked, other], currentPlayerIndex: 0,
    turn: 1, roundNumber: 1, windForce: 0, gravity: 260,
    localShotContext: { playerCountAtMatchStart: 3, isFirstShotOfRound: true },
  };
  const terrain = flatTerrain(800, 480);
  const snapshot: AdvisorSnapshot = {
    state, width: 800, height: 480,
    heights: [...terrain.getHeightmap()], materials: [...terrain.getMaterials()],
  };
  return { self, locked, other, state, terrain, snapshot };
}

function ordinaryFallback(targetId: string): ExpertFallbackChoice {
  return {
    kind: "ordinary", weaponId: "MISSILE", useful: false,
    selectionReason: "dernier MISSILE ordinaire non certifié",
    primaryTargetId: targetId, offset: 0, attempts: 0, policy: ORDINARY_AIM_POLICY,
    requestedPoint: { x: 400, y: 330 }, rawCommand: { angle: 45, power: 50 },
    command: { angle: 45, power: 50 }, searchComplete: true,
    point: { x: 400, y: 330, kind: "tank" },
  };
}

function certifiedMissile(targetId: string): ExpertFallbackChoice {
  return {
    kind: "evaluated", weaponId: "MISSILE", useful: false,
    primaryTargetId: targetId, offset: 0, attempts: 0, policy: ORDINARY_AIM_POLICY,
    requestedPoint: { x: 400, y: 330 }, rawCommand: { angle: 45, power: 50 },
    command: { angle: 45, power: 50 }, point: { x: 400, y: 330, kind: "tank" },
    forecast: { ...resolution([], ["a", "b", "c"]), profit: 0 },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("local advisor target lock #375", () => {
  it.each(["SURVIE", "OPTIMISER_PROFIT"] as const)("searches only the locked target under %s and keeps the rest of the roster", (objective) => {
    const f = trio();
    const dead = makePlayer({
      id: "d", name: "D", isHuman: false, aiProfile: "v1-random", inventory: {},
      tank: makeTank("d", 700, 336, { isDead: true, health: 0 }),
    });
    f.state.players.push(dead);
    f.state.localShotContext!.playerCountAtMatchStart = 4;
    const own: string[][] = [];
    let trace: ExpertDecisionTrace | undefined;
    const evaluate: typeof evaluator.evaluateExpertShot = (state, _terrain, shooter, weapon, targets, _kill, _first, _cache, context) => {
      expect(state.players.map((player) => player.id)).toEqual(["a", "b", "c", "d"]);
      if (context?.mode === "adverse") return invalid;
      if (shooter.id !== "a") return invalid;
      own.push(targets.map((player) => player.id));
      if (weapon !== "MISSILE") return invalid;
      const ids = targets.map((player) => player.id);
      if (ids.includes("c") && !ids.includes("b")) return aimed("c", 900, { destroyedIds: new Set(["c"]) });
      if (ids.includes("c")) return aimed("c", 800, { destroyedIds: new Set(["c"]) });
      return aimed("b", 10);
    };
    const plan = chooseExpertPlan(f.self, f.state, f.terrain, createIdealExpertAim(), evaluate,
      (value) => { trace = value; }, evaluator.createExpertForecastCache(), objective, "b");
    expect(own.every((group) => group.length === 1 && group[0] === "b")).toBe(true);
    expect(own.length).toBeGreaterThan(0);
    expect(plan?.targetIds).toEqual(["b"]);
    expect(plan?.primaryTargetId).toBe("b");
    expect(trace?.lockedTargetId).toBe("b");
    expect(trace?.targets?.find((target) => target.playerId === "c")?.reason).toBe("excluded-by-lock");
    expect(trace?.targets?.find((target) => target.playerId === "d")?.reason).toBe("dead");
    expect(trace?.targets?.find((target) => target.playerId === "b")?.reason).toBe("admissible");
    expect(summarizeExpertDecision(trace).lockedTargetId).toBe("b");
  });

  it("keeps a terrain point searched toward the lock when only a collateral tank is hit", () => {
    const f = trio();
    const bystander = makePlayer({
      id: "e", name: "E", isHuman: false, aiProfile: "v1-random", inventory: {},
      tank: makeTank("e", 200, 336),
    });
    f.state.players.push(bystander);
    const own: string[][] = [];
    let trace: ExpertDecisionTrace | undefined;
    const evaluate: typeof evaluator.evaluateExpertShot = (_state, _terrain, shooter, weapon, targets) => {
      if (shooter.id !== "a" || weapon !== "MISSILE") return invalid;
      own.push(targets.map((player) => player.id));
      return aimed("b", 40, {
        destination: { x: 410, y: 300, kind: "terrain" },
        destroyedIds: new Set(),
        humanDamageMilli: 1500,
        forecast: { ...resolution([{ id: "c", healthDamageMilli: 1500 }], ["a", "b", "c", "e"]), profit: 40 },
      });
    };
    const plan = chooseExpertPlan(f.self, f.state, f.terrain, createIdealExpertAim(), evaluate,
      (value) => { trace = value; }, evaluator.createExpertForecastCache(), "OPTIMISER_PROFIT", "b");
    expect(own).toEqual([["b"]]);
    expect(plan?.targetIds).toEqual(["b"]);
    expect(plan?.primaryTargetId).toBe("c");
    expect(trace?.targets?.find((target) => target.playerId === "b")).toMatchObject({
      reason: "admissible", best: { targetIds: ["b"] },
    });
    expect(trace?.targets?.find((target) => target.playerId === "c")).toMatchObject({
      reason: "admissible", best: { targetIds: ["b"] },
    });
    expect(trace?.targets?.find((target) => target.playerId === "e")?.reason).toBe("excluded-by-lock");
    expect(f.state.players.map((player) => player.id)).toEqual(["a", "b", "c", "e"]);
  });

  it("replaces a risky locked command with an already simulated safe command toward the same target", () => {
    const f = trio();
    const own: string[][] = [];
    const analyze = vi.spyOn(LethalTransitionDetector.prototype, "analyze").mockImplementation((candidate: TransitionCandidate) => {
      const damagesProtected = candidate.result?.forecast?.damage.some((event) =>
        event.victimId === "c" && event.healthDamageMilli > 0) ?? false;
      return {
        status: damagesProtected ? "risk" : "safe",
        reason: damagesProtected ? "provoked-survival" : "no-new-threat",
        initial: null, after: null, reply: null,
      };
    });
    const evaluate: typeof evaluator.evaluateExpertShot = (_state, _terrain, shooter, weapon, targets) => {
      if (shooter.id !== "a" || weapon !== "MISSILE") return invalid;
      own.push(targets.map((player) => player.id));
      const risky = aimed("b", 100, {
        destroyedIds: new Set(),
        humanDamageMilli: 20000,
        forecast: { ...resolution([{ id: "c", healthDamageMilli: 20000 }], ["a", "b", "c"]), profit: 100 },
      });
      const safe = aimed("b", 20, {
        command: { angle: 70, power: 40 },
        rawCommand: { angle: 70, power: 40 },
        destroyedIds: new Set(["b"]),
        aiDamageMilli: 500,
        forecast: { ...resolution([{ id: "b", healthDamageMilli: 500 }], ["a", "b", "c"]), profit: 20 },
      });
      return { ...risky, nonCriticalAlternative: safe };
    };
    let trace: ExpertDecisionTrace | undefined;
    const plan = chooseExpertPlan(f.self, f.state, f.terrain, createIdealExpertAim(), evaluate,
      (value) => { trace = value; }, evaluator.createExpertForecastCache(), "OPTIMISER_PROFIT", "b");
    expect(own).toEqual([["b"]]);
    expect(plan?.targetIds).toEqual(["b"]);
    expect(plan?.command).toEqual({ angle: 70, power: 40 });
    expect(trace?.lethalTransition?.reason).toBe("alternative-accepted");
    expect(analyze.mock.calls[0]?.[0].result?.forecast?.damage.some((event) => event.victimId === "c")).toBe(true);
  });

  it("keeps the risky locked command when no safe alternative was already simulated", () => {
    const f = trio();
    vi.spyOn(LethalTransitionDetector.prototype, "analyze").mockReturnValue({
      status: "risk", reason: "provoked-survival", initial: null, after: null, reply: null,
    });
    const evaluate: typeof evaluator.evaluateExpertShot = (_state, _terrain, shooter, weapon) => {
      if (shooter.id !== "a" || weapon !== "MISSILE") return invalid;
      return aimed("b", 80, {
        destroyedIds: new Set(),
        forecast: { ...resolution([{ id: "c", healthDamageMilli: 20000 }], ["a", "b", "c"]), profit: 80 },
      });
    };
    let trace: ExpertDecisionTrace | undefined;
    const plan = chooseExpertPlan(f.self, f.state, f.terrain, createIdealExpertAim(), evaluate,
      (value) => { trace = value; }, evaluator.createExpertForecastCache(), "OPTIMISER_PROFIT", "b");
    expect(plan?.targetIds).toEqual(["b"]);
    expect(plan?.command.angle).toBe(45);
    expect(trace?.lethalTransition?.reason).toBe("initial-retained-no-alternative");
  });

  it("does not neutralize an unlocked threat while another target is locked", () => {
    const f = trio();
    const adverse: string[] = [];
    const own: string[][] = [];
    const evaluate: typeof evaluator.evaluateExpertShot = (_state, _terrain, shooter, weapon, targets, _kill, _first, _cache, context) => {
      if (context?.mode === "adverse") {
        adverse.push(shooter.id);
        return shooter.id === "c" ? aimed("a", 40, { destroyedIds: new Set(["a"]) }) : invalid;
      }
      own.push(targets.map((player) => player.id));
      expect(context?.advisor).toEqual({ objective: "SURVIE" });
      return weapon === "MISSILE" ? aimed("b", 10, { destroyedIds: new Set() }) : invalid;
    };
    const plan = chooseExpertPlan(f.self, f.state, f.terrain, createIdealExpertAim(), evaluate,
      undefined, evaluator.createExpertForecastCache(), "SURVIE", "b");
    expect(adverse).not.toContain("c");
    expect(own.every((group) => group.length === 1 && group[0] === "b")).toBe(true);
    expect(plan?.targetIds).toEqual(["b"]);
  });

  it("neutralizes a locked bulldozer threat and keeps collateral damage in the ranking", () => {
    const f = trio({ NUKE: 1 });
    f.locked.inventory = { BULLDOZER: 1 };
    const own: string[][] = [];
    vi.spyOn(bulldozerThreat, "evaluateBulldozerThreat").mockReturnValue({
      best: {
        command: { angle: 30, power: 80 },
        expertDestroyed: true,
        shooterDestroyed: false,
        profit: 5,
        forecast: resolution([], ["b", "c"]),
      },
      simulations: 0,
    });
    const evaluate: typeof evaluator.evaluateExpertShot = (_state, _terrain, _shooter, weapon, targets, _kill, _first, _cache, context) => {
      if (context?.mode === "adverse") return invalid;
      own.push(targets.map((player) => player.id));
      expect(context?.advisor).toEqual({ objective: "SURVIE", neutralize: true });
      if (weapon === "NUKE") return aimed("b", -10, { aiDestroyedCount: 1, humanDamageMilli: 400, destroyedIds: new Set(["b"]) });
      if (weapon === "MISSILE") return aimed("b", 500, { destroyedIds: new Set(), aiDestroyedCount: 0 });
      return invalid;
    };
    const plan = chooseExpertPlan(f.self, f.state, f.terrain, createIdealExpertAim(), evaluate,
      undefined, evaluator.createExpertForecastCache(), "SURVIE", "b");
    expect(own.every((group) => group.length === 1 && group[0] === "b")).toBe(true);
    expect(plan?.weaponId).toBe("NUKE");
    expect(plan?.targetIds).toEqual(["b"]);
    expect(plan?.result?.humanDamageMilli).toBe(400);
  });

  it("returns no advice when the locked target has no admissible shot, even if another target would", () => {
    const f = trio();
    const seen: string[][] = [];
    vi.spyOn(evaluator, "evaluateExpertShot").mockImplementation((_state, _terrain, shooter, _weapon, targets) => {
      if (shooter.id === "a") seen.push(targets.map((player) => player.id));
      if (shooter.id === "a" && targets.some((player) => player.id === "c") && !targets.some((player) => player.id === "b")) {
        return aimed("c", 900);
      }
      return invalid;
    });
    const fallback = vi.spyOn(evaluator, "chooseExpertFallback").mockReturnValue(ordinaryFallback("b"));
    let trace: ExpertDecisionTrace | undefined;
    expect(calculateShotAdvice(f.snapshot, "OPTIMISER_PROFIT", (value) => { trace = value; }, "b")).toBeNull();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((group) => group.length === 1 && group[0] === "b")).toBe(true);
    expect(fallback).toHaveBeenCalled();
    expect(fallback.mock.calls[0]?.[3].id).toBe("b");
    expect(trace?.lockedTargetId).toBe("b");
    expect(trace?.advisorFallback).toMatchObject({ targetId: "b", targetSelectionReason: "locked-target", refusal: "uncertified" });
  });

  it("can advise a certified effect-free missile on the locked target", () => {
    const f = trio();
    vi.spyOn(evaluator, "evaluateExpertShot").mockReturnValue(invalid);
    vi.spyOn(evaluator, "chooseExpertFallback").mockReturnValue(certifiedMissile("b"));
    const advice = calculateShotAdvice(f.snapshot, "OPTIMISER_PROFIT", undefined, "b");
    expect(advice).toMatchObject({
      targetIds: ["b"], profit: 0, command: { weaponId: "MISSILE" }, shooterDestroyed: false,
    });
  });

  it("ignores an absent, unknown, dead or self lock and does not consume the match RNG", () => {
    const f = trio();
    expect(livingAdvisorLock(f.self, f.state.players, undefined)).toBeUndefined();
    expect(livingAdvisorLock(f.self, f.state.players, "a")).toBeUndefined();
    expect(livingAdvisorLock(f.self, f.state.players, "missing")).toBeUndefined();
    expect(livingAdvisorLock(f.self, f.state.players, "b")?.id).toBe("b");
    vi.spyOn(evaluator, "evaluateExpertShot").mockImplementation((_state, _terrain, shooter, weapon, targets) =>
      shooter.id === "a" && weapon === "MISSILE" ? aimed(targets[0]?.id ?? "b", 15, {
        destroyedIds: new Set(),
        forecast: { ...resolution([], ["a", "b", "c"]), profit: 15 },
      }) : invalid);
    const rng = vi.spyOn(random, "secureRandom").mockImplementation(() => { throw new Error("LIVE_RNG_USED"); });
    const plain = calculateShotAdvice(f.snapshot, "OPTIMISER_PROFIT");
    expect(plain).not.toBeNull();
    expect(calculateShotAdvice(f.snapshot, "OPTIMISER_PROFIT", undefined, "missing")).toEqual(plain);
    expect(calculateShotAdvice(f.snapshot, "OPTIMISER_PROFIT", undefined, "a")).toEqual(plain);
    expect(calculateShotAdvice(f.snapshot, "SURVIE", undefined, "b")).not.toBeNull();
    expect(rng).not.toHaveBeenCalled();
    f.locked.tank.isDead = true;
    expect(livingAdvisorLock(f.self, f.state.players, "b")).toBeUndefined();
    const deadPlain = calculateShotAdvice(f.snapshot, "OPTIMISER_PROFIT");
    expect(calculateShotAdvice(f.snapshot, "OPTIMISER_PROFIT", undefined, "b")).toEqual(deadPlain);
    f.locked.tank.isDead = false;
    f.locked.tank.health = 0;
    expect(livingAdvisorLock(f.self, f.state.players, "b")).toBeUndefined();
    const zeroPlain = calculateShotAdvice(f.snapshot, "OPTIMISER_PROFIT");
    expect(calculateShotAdvice(f.snapshot, "OPTIMISER_PROFIT", undefined, "b")).toEqual(zeroPlain);
  });
});
