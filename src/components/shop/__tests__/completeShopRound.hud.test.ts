import { afterEach, describe, expect, it, vi } from "vitest";
import { GameEngine } from "../../../game/engine/GameEngine";
import { makePlayer, makeTank } from "../../../game/__tests__/helpers";
import type { RoundMap } from "../../../game/round/prepareRound";
import type { GamePhase } from "../../../types/game";
import type { Player } from "../../../types/player";
import { INITIAL_STATE } from "../../gameCanvasReducer";
import { isAimingInspectionVisible } from "../../playerStatus";
import {
  advanceToNextRoundDirect,
  finishShopPhase,
  type CompleteShopRoundHost,
} from "../completeShopRound";

function players(): Player[] {
  return [
    makePlayer({
      id: "human",
      name: "Alice",
      isHuman: true,
      tank: makeTank("tank-human", 120, 300),
    }),
    makePlayer({
      id: "cpu",
      name: "Bob",
      isHuman: false,
      aiProfile: "v1-random",
      tank: makeTank("tank-cpu", 620, 300),
    }),
  ];
}

function hostFor(
  engine: GameEngine,
  phase: GamePhase,
  roster: Player[],
  gameMode: "local" | "online" = "local",
): CompleteShopRoundHost {
  return {
    gameMode,
    initialPlayerCount: 2,
    engineRef: { current: engine },
    shopFinishingRef: { current: false },
    lastAppliedShopEpochRef: { current: 0 },
    lastCompletedRoundNumberRef: { current: 1 },
    gamePhaseRef: { current: phase },
    shopPlayersRef: { current: roster },
    pendingShopFinishRef: { current: null },
    localShopDoneRef: { current: false },
    currentMancheRef: { current: 2 },
    currentShopIndexRef: { current: 0 },
    shopSessionRef: { current: INITIAL_STATE.shopSession },
    shopAiTimeoutRef: { current: null },
    dispatch: vi.fn(),
    clearShopAiTimeout: vi.fn(),
    clearCelebrationTimer: vi.fn(),
    setLocalShopDone: vi.fn(),
    sendCombatMessage: vi.fn(),
  };
}

describe("combat HUD at the first turn of a new round", () => {
  const engines: GameEngine[] = [];

  afterEach(() => {
    for (const engine of engines.splice(0)) {
      engine.getTurnManager().removeInputListeners();
      engine.stop();
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function startedEngine(roster: Player[]): GameEngine {
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const engine = new GameEngine(800, 480, { gravity: 260, baseShotSpeed: 420 });
    engines.push(engine);
    engine.setPlayers(roster);
    return engine;
  }

  it("publishes the aiming list when the shop phase is still current", () => {
    const roster = players();
    const engine = startedEngine(roster);
    const host = hostFor(engine, "SHOP", roster);
    const seen: GamePhase[] = [];
    engine.onTurnHudUpdate = (info) => {
      seen.push(host.gamePhaseRef.current);
      expect(isAimingInspectionVisible({
        gamePhase: host.gamePhaseRef.current,
        turnInfo: info,
      })).toBe(true);
    };

    finishShopPhase(host);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((phase) => phase === "COMBAT")).toBe(true);
    expect(host.gamePhaseRef.current).toBe("COMBAT");
    expect(host.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "FINISH_SHOP" }));
  });

  it("restores the shop phase when the next round cannot be prepared", () => {
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const engine = new GameEngine(800, 480);
    engines.push(engine);
    const roster = players();
    const host = hostFor(engine, "SHOP", roster, "online");

    finishShopPhase(host, roster, 1, 2, { width: 1 } as RoundMap);

    expect(host.gamePhaseRef.current).toBe("SHOP");
    expect(host.shopFinishingRef.current).toBe(false);
    expect(host.dispatch).toHaveBeenCalledWith({
      type: "SET_ROUND_PREPARATION_ERROR",
      reason: "EXHAUSTED",
    });
  });

  it("publishes the aiming list when free weapons leave the summary", () => {
    const roster = players();
    const engine = startedEngine(roster);
    const host = hostFor(engine, "SUMMARY", roster);
    const seen: GamePhase[] = [];
    engine.onTurnHudUpdate = (info) => {
      seen.push(host.gamePhaseRef.current);
      expect(info.isHuman).toBe(true);
      expect(info.isInputLocked).toBe(false);
    };

    advanceToNextRoundDirect(host);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((phase) => phase === "COMBAT")).toBe(true);
    expect(host.gamePhaseRef.current).toBe("COMBAT");
    expect(host.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "ADVANCE_ROUND_FREE_WEAPONS",
    }));
  });

  it("restores the summary when free-weapons preparation throws", () => {
    const roster = players();
    const engine = startedEngine(roster);
    const host = hostFor(engine, "SUMMARY", roster);
    vi.spyOn(engine, "startNextRound").mockImplementation(() => {
      throw new Error("boom");
    });

    advanceToNextRoundDirect(host);

    expect(host.gamePhaseRef.current).toBe("SUMMARY");
    expect(host.shopFinishingRef.current).toBe(false);
  });
});
