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

const previous = getRNG();
afterEach(() => setRNG(previous));
describe("additive AI observation and cancellation", () => {
  it.each<AiProfile>(["v1-random", "v2-heuristic", "v3-sniper", "v4-smart"])("preserves %s decisions and RNG draws", async profile => {
    async function execute(observe: boolean) {
      const rng = createSeededRNG(12453); let draws = 0;
      setRNG({ next: () => { draws++; return rng.next(); } });
      const { players } = fixture();
      const state = makeGameState(players[0], players[1], profile);
      const strategy = new AIByProfileStrategy();
      const targets: string[] = [];
      if (observe) strategy.onTargetSelected = (_id, targetId) => targets.push(targetId);
      const decision = await strategy.executeTurn(state.players[0].tank.id, state, flatTerrain(800, 480));
      return { decision, draws, targets };
    }
    const observed = await execute(true), ordinary = await execute(false);
    expect(observed.decision).toEqual(ordinary.decision);
    expect(observed.draws).toBe(ordinary.draws);
    expect(observed.targets).toEqual(["player-2"]);
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
