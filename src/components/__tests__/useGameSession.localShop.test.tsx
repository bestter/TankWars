// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect } from "react";
import { render, act, cleanup } from "@testing-library/react";
import { useGameSession } from "../useGameSession";
import { makePlayer, makeTank } from "../../game/__tests__/helpers";
import type { Player } from "../../types/player";
import { TurnManager } from "../../game/engine/TurnManager";

type SessionApi = ReturnType<typeof useGameSession>;

function stubCanvas2d(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get: () => () => undefined,
    },
  ) as CanvasRenderingContext2D;
}

function ShopHarness({
  players,
  sessionRef,
}: {
  players: Player[];
  sessionRef: { current: SessionApi | null };
}) {
  const session = useGameSession({ initialPlayers: players, gameMode: "local" });
  const { canvasRef } = session;
  useEffect(() => {
    sessionRef.current = session;
  });
  return <canvas ref={canvasRef} width={800} height={480} />;
}

describe("useGameSession local shop AI advance", () => {
  const players: Player[] = [
    makePlayer({
      id: "player-1",
      name: "Joueur-1",
      isHuman: true,
      tank: makeTank("tank-1", 120, 300),
    }),
    makePlayer({
      id: "player-2",
      name: "CPU-1",
      isHuman: false,
      aiProfile: "v4-smart",
      tank: makeTank("tank-2", 620, 300),
    }),
  ];

  beforeEach(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => stubCanvas2d(),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("finishes the shop after the human ready click even when React re-renders", () => {
    const sessionRef: { current: SessionApi | null } = { current: null };
    render(<ShopHarness players={players} sessionRef={sessionRef} />);

    expect(sessionRef.current).not.toBeNull();

    act(() => {
      sessionRef.current?.handleNextRound();
    });
    expect(sessionRef.current?.state.gamePhase).toBe("SHOP");
    expect(sessionRef.current?.state.currentShopIndex).toBe(0);
    expect(sessionRef.current?.state.shopPlayers[0]?.isHuman).toBe(true);

    act(() => {
      sessionRef.current?.handleShopReady();
    });
    expect(sessionRef.current?.state.gamePhase).toBe("SHOP");
    expect(sessionRef.current?.state.currentShopIndex).toBe(1);
    expect(sessionRef.current?.state.shopPlayers[1]?.isHuman).toBe(false);

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    expect(sessionRef.current?.state.shopPlayers).toEqual([]);
  });

  it("does not invalidate the first AI turn when a four-AI second round starts", () => {
    const aiPlayers = Array.from({ length: 4 }, (_, index) => makePlayer({
      id: `ai-${index + 1}`,
      name: `CPU-${index + 1}`,
      isHuman: false,
      aiProfile: "v1-random",
      tank: makeTank(`tank-ai-${index + 1}`, 120 + index * 160, 300),
    }));
    const syncTurn = vi.spyOn(TurnManager.prototype, "syncTurn");
    const sessionRef: { current: SessionApi | null } = { current: null };
    render(<ShopHarness players={aiPlayers} sessionRef={sessionRef} />);

    act(() => {
      sessionRef.current?.handleNextRound();
      vi.advanceTimersByTime(400);
    });

    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    expect(sessionRef.current?.state.shopPlayers).toEqual([]);
    expect(syncTurn).not.toHaveBeenCalled();
  });
});
