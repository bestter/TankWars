import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnManager } from "../../engine/TurnManager";
import { TankManager } from "../../entities/TankManager";
import { AIByProfileStrategy } from "../../entities/ai/AIByProfileStrategy";
import { AISimpleStrategy } from "../../entities/ai/AISimpleStrategy";
import { flatTerrain, makeGameState } from "../../__tests__/helpers";
import { fixture } from "./helpers";
import { createSeededRNG, getRNG, setRNG } from "../../../utils/random";
import type { AiProfile } from "../../../types/player";
import type { EnduranceEvent } from "../types";
import type { AIObservation } from "../../observation";

const previous = getRNG();
afterEach(() => { setRNG(previous); vi.unstubAllEnvs(); });
describe("additive AI observation and cancellation", () => {
  it.each<AiProfile>(["v1-random", "v2-heuristic", "v3-sniper", "v4-smart"])("preserves %s decisions and RNG draws", async profile => {
    vi.stubEnv("DEV", false);
    async function execute(observe: boolean) {
      const rng = createSeededRNG(12453); const draws: number[] = [];
      setRNG({ next: () => { const value = rng.next(); draws.push(value); return value; } });
      const { players } = fixture();
      const state = makeGameState(players[0], players[1], profile);
      const strategy = new AIByProfileStrategy();
      const targets: string[] = [];
      const details: AIObservation[] = [];
      if (observe) strategy.onDecisionObserved = value => details.push(value);
      if (observe) strategy.onTargetSelected = (_id, targetId) => targets.push(targetId);
      const decision = await strategy.executeTurn(state.players[0].tank.id, state, flatTerrain(800, 480));
      return { decision, draws, targets, details, players: state.players };
    }
    const observed = await execute(true), ordinary = await execute(false);
    expect(observed.decision).toEqual(ordinary.decision);
    expect(observed.draws).toEqual(ordinary.draws);
    expect(observed.players).toEqual(ordinary.players);
    expect(observed.details).toHaveLength(1);
    expect(observed.details[0].final).toEqual(observed.decision);
    expect(observed.details[0].target?.playerId).toBe("player-2");
    expect(observed.details[0].nominal).toBeNull();
    expect(observed.targets).toEqual(["player-2"]);
  });
  it("records SIMPLE's early gaffe without inventing a nominal command or solving an aim", async () => {
    const { players } = fixture(); const state = makeGameState(players[0], players[1]);
    const details: AIObservation[] = []; let draws = 0;
    setRNG({ next: () => { draws++; return 0; } });
    const strategy = new AISimpleStrategy(); strategy.onDecisionObserved = v => details.push(v);
    const result = await strategy.executeTurn(state.players[0].tank.id, state, flatTerrain(800, 480));
    expect(details[0]).toMatchObject({ reason: "early-gaffe", evaluated: null, nominal: null, point: null, final: result });
    expect(details[0].steps.map(s => s.kind)).toEqual(["gaffe", "finalize"]);
    expect(draws).toBe(4);
  });
  it("records SIMPLE's offset, direction/power errors and reaction in their applied order", async () => {
    const sequence = [0.9, 0.5, 0.5, 0, 0.25, 0, 0.8, 0.2, 0.2, 0.5];
    async function execute(observe: boolean) {
      let index = 0; setRNG({ next: () => { if (index >= sequence.length) throw new Error("EXTRA_RNG_DRAW"); return sequence[index++]; } });
      const { players } = fixture(), details: AIObservation[] = [];
      const state = makeGameState(players[0], players[1]);
      state.players[0].tank.hitReaction = { wasDirectHit: true, fallDistance: 0 };
      const strategy = new AISimpleStrategy(); if (observe) strategy.onDecisionObserved = v => details.push(v);
      const result = await strategy.executeTurn(state.players[0].tank.id, state, flatTerrain(800, 480));
      return { details, result, index, players: state.players };
    }
    const observed = await execute(true), ordinary = await execute(false);
    expect(observed.result).toEqual(ordinary.result); expect(observed.players).toEqual(ordinary.players);
    expect(observed.index).toBe(ordinary.index); expect(observed.index).toBe(sequence.length);
    const detail = observed.details[0]; expect(detail.evaluated).not.toBeNull();
    expect(detail.steps.map(s => s.kind)).toEqual(["gaffe", "offset", "direction-error", "power-error", "reaction", "finalize"]);
    expect(detail.steps[2].after?.angle).toBe(45);
    expect(detail.steps[3].after?.power).toBe(80);
    expect(detail.steps[3].before).toEqual(detail.steps[2].after);
    expect(detail.steps[4].before).toEqual(detail.steps[3].after);
    expect(detail.final).toEqual(observed.result);
  });
  it.each<AiProfile>(["v1-random", "v2-heuristic", "v3-sniper", "v4-smart"])("keeps %s reaction and gaffe draws passive", async profile => {
    vi.stubEnv("DEV", false);
    async function execute(observe: boolean) {
      const draws: number[] = [], details: AIObservation[] = [];
      setRNG({ next: () => { draws.push(0.01); return 0.01; } });
      const { players } = fixture(); const state = makeGameState(players[0], players[1], profile);
      state.players[0].tank.hitReaction = { wasDirectHit: true, fallDistance: 120 };
      const strategy = new AIByProfileStrategy();
      if (observe) strategy.onDecisionObserved = v => details.push(v);
      const decision = await strategy.executeTurn(state.players[0].tank.id, state, flatTerrain(800, 480));
      return { draws, details, decision, players: state.players };
    }
    const observed = await execute(true), ordinary = await execute(false);
    expect(observed.draws).toEqual(ordinary.draws);
    expect(observed.decision).toEqual(ordinary.decision);
    expect(observed.players).toEqual(ordinary.players);
    expect(observed.details[0].steps.some(s => s.kind === "gaffe" && s.parameters.occurred === true)).toBe(true);
    if (profile !== "v1-random") expect(observed.details[0].steps.find(s => s.kind === "reaction")?.parameters.intensity).toBeGreaterThan(0);
  });
  it.each<AiProfile>(["v1-random", "v2-heuristic", "v3-sniper", "v4-smart"])("keeps an absent target unavailable for %s", async profile => {
    const { players } = fixture(); const state = makeGameState(players[0], players[1], profile);
    state.players[1].tank.isDead = true;
    const strategy = new AIByProfileStrategy(); const details: AIObservation[] = [];
    strategy.onDecisionObserved = v => details.push(v);
    await strategy.executeTurn(state.players[0].tank.id, state, flatTerrain(800, 480));
    expect(details[0]).toMatchObject({ target: null, point: null, evaluated: null, nominal: null, reason: "no-target" });
  });
  it("rejects a lazy advanced strategy after cancellation before it can draw from the next block RNG", async () => {
    const { players } = fixture(); const state = makeGameState(players[0], players[1], "v4-smart");
    let active = true, draws = 0;
    const router = new AIByProfileStrategy(() => active);
    const pending = router.executeTurn(state.players[0].tank.id, state, flatTerrain(800, 480));
    active = false; setRNG({ next: () => { draws++; return 0.75; } });
    await expect(pending).rejects.toThrow("AI_CANCELLED"); expect(draws).toBe(0);
  });
  it("cancels SIMPLE after its lazy solver import, before further random draws", async () => {
    const { players } = fixture(); const state = makeGameState(players[0], players[1]);
    let active = true, draws = 0;
    setRNG({ next: () => 0.75 });
    const pending = new AISimpleStrategy(() => active).executeTurn(state.players[0].tank.id, state, flatTerrain(800, 480));
    active = false; setRNG({ next: () => { draws++; return 0.75; } });
    await expect(pending).rejects.toThrow("AI_CANCELLED"); expect(draws).toBe(0);
  });
  it("rejects a stale turn even when its block remains active", async () => {
    const { players } = fixture(); const state = makeGameState(players[0], players[1], "v3-sniper");
    let current = true, draws = 0;
    const pending = new AIByProfileStrategy().executeTurn(state.players[0].tank.id, state, flatTerrain(800, 480), () => current);
    current = false; setRNG({ next: () => { draws++; return 0.75; } });
    await expect(pending).rejects.toThrow("AI_CANCELLED"); expect(draws).toBe(0);
  });
  it("does not report a stale rejected decision or release the newer turn's processing flag", async () => {
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    try {
      const { players } = fixture(); const tanks = new TankManager(); tanks.setPlayers(players);
      let rejectOld: (error: Error) => void = () => {};
      const executeTurn = vi.fn()
        .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }))
        .mockImplementation(() => new Promise(() => {}));
      const fire = vi.fn(), emit = vi.fn<(event: EnduranceEvent) => boolean>(() => true);
      const tm = new TurnManager(tanks, flatTerrain(800, 480), fire, { executeTurn });
      tm.combatObserver = { emit }; tm.startFirstTurn(); tm.nextTurn();
      rejectOld(new Error("AI_CANCELLED")); await Promise.resolve(); await Promise.resolve();
      expect(emit.mock.calls.some(([e]) => e.kind === "failure")).toBe(false);
      expect(Reflect.get(tm, "isProcessingAI")).toBe(true);
      expect(fire).not.toHaveBeenCalled(); tm.pauseForInterRound();
    } finally { vi.unstubAllGlobals(); }
  });
});
