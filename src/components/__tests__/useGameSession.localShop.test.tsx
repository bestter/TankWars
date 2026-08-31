// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect } from "react";
import { render, act, cleanup } from "@testing-library/react";
import { useGameSession } from "../useGameSession";
import { makePlayer, makeTank } from "../../game/__tests__/helpers";
import type { Player } from "../../types/player";
import { TurnManager } from "../../game/engine/TurnManager";
import { TankManager } from "../../game/entities/TankManager";

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

  it("finishes the shop after human ready and retains AI purchases in TankManager and uiPlayers", () => {
    const setPlayersSpy = vi.spyOn(TankManager.prototype, "setPlayers");
    const players: Player[] = [
      makePlayer({
        id: "player-1",
        name: "Joueur-1",
        isHuman: true,
        money: 1000,
        inventory: {},
        tank: makeTank("tank-1", 120, 300),
      }),
      makePlayer({
        id: "player-2",
        name: "CPU-1",
        isHuman: false,
        aiProfile: "v4-smart",
        money: 1000,
        inventory: {},
        tank: makeTank("tank-2", 620, 300),
      }),
    ];

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

    // Check uiPlayers at COMBAT phase
    const uiPlayers = sessionRef.current?.state.uiPlayers;
    expect(uiPlayers).toBeDefined();
    expect(uiPlayers?.[0].money).toBe(1000);
    expect(uiPlayers?.[1].money).toBe(40);
    expect(uiPlayers?.[1].inventory).toEqual({
      NUKE: 1,
      GRENADE: 6,
      DRILLER: 1,
    });

    // Verify TankManager.setPlayers was called during AI shopping with the updated AI player
    const lastSetPlayersCall = setPlayersSpy.mock.calls.at(-1)?.[0];
    expect(lastSetPlayersCall).toBeDefined();
    expect(lastSetPlayersCall?.[1].money).toBe(uiPlayers?.[1].money);
    expect(lastSetPlayersCall?.[1].inventory).toEqual(uiPlayers?.[1].inventory);
  });

  it("retains purchases for all AI players in a pure 4-AI match across round transition", () => {
    const setPlayersSpy = vi.spyOn(TankManager.prototype, "setPlayers");
    const aiPlayers = [
      makePlayer({
        id: "ai-1",
        name: "CPU-1",
        isHuman: false,
        aiProfile: "v4-smart",
        money: 1000,
        inventory: {},
        tank: makeTank("tank-ai-1", 100, 300),
      }),
      makePlayer({
        id: "ai-2",
        name: "CPU-2",
        isHuman: false,
        aiProfile: "v3-sniper",
        money: 1000,
        inventory: {},
        tank: makeTank("tank-ai-2", 260, 300),
      }),
      makePlayer({
        id: "ai-3",
        name: "CPU-3",
        isHuman: false,
        aiProfile: "v2-heuristic",
        money: 1000,
        inventory: {},
        tank: makeTank("tank-ai-3", 420, 300),
      }),
      makePlayer({
        id: "ai-4",
        name: "CPU-4",
        isHuman: false,
        aiProfile: "v1-random",
        money: 1000,
        inventory: {},
        tank: makeTank("tank-ai-4", 580, 300),
      }),
    ];

    const sessionRef: { current: SessionApi | null } = { current: null };
    render(<ShopHarness players={aiPlayers} sessionRef={sessionRef} />);

    act(() => {
      sessionRef.current?.handleNextRound();
      // Advance timers across all AI shopping steps (50ms + 80ms * 3 + 80ms)
      vi.advanceTimersByTime(600);
    });

    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    expect(sessionRef.current?.state.shopPlayers).toEqual([]);

    const uiPlayers = sessionRef.current?.state.uiPlayers;
    expect(uiPlayers).toBeDefined();
    expect(uiPlayers?.length).toBe(4);

    for (let i = 0; i < 4; i++) {
      const p = uiPlayers?.[i];
      expect(p?.money).toBeLessThan(1000);
      expect(Object.keys(p?.inventory ?? {}).length).toBeGreaterThan(0);
    }

    const lastSetPlayersCall = setPlayersSpy.mock.calls.at(-1)?.[0];
    expect(lastSetPlayersCall).toBeDefined();
    for (let i = 0; i < 4; i++) {
      expect(lastSetPlayersCall?.[i].money).toBe(uiPlayers?.[i].money);
      expect(lastSetPlayersCall?.[i].inventory).toEqual(uiPlayers?.[i].inventory);
    }
  });

  it("retains AI purchases even if React re-renders during the shop phase", () => {
    const players: Player[] = [
      makePlayer({
        id: "player-1",
        name: "Joueur-1",
        isHuman: true,
        money: 1000,
        inventory: {},
        tank: makeTank("tank-1", 120, 300),
      }),
      makePlayer({
        id: "player-2",
        name: "CPU-1",
        isHuman: false,
        aiProfile: "v4-smart",
        money: 1000,
        inventory: {},
        tank: makeTank("tank-2", 620, 300),
      }),
    ];

    const sessionRef: { current: SessionApi | null } = { current: null };
    const { rerender } = render(<ShopHarness players={players} sessionRef={sessionRef} />);

    act(() => {
      sessionRef.current?.handleNextRound();
    });

    act(() => {
      sessionRef.current?.handleShopReady();
    });

    // Advance enough for AI to auto-buy, but before finishShopPhase completes
    act(() => {
      vi.advanceTimersByTime(80);
    });

    // Trigger an extra React re-render
    rerender(<ShopHarness players={players} sessionRef={sessionRef} />);

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    const uiPlayers = sessionRef.current?.state.uiPlayers;
    expect(uiPlayers?.[1].money).toBe(40);
    expect(uiPlayers?.[1].inventory).toEqual({
      NUKE: 1,
      GRENADE: 6,
      DRILLER: 1,
    });
  });

  it("safely handles AI player inventories containing forbidden prototype keys", () => {
    const maliciousInventory = Object.create(null) as Record<string, unknown>;
    maliciousInventory["__proto__"] = { hacked: true };
    maliciousInventory["prototype"] = { hacked: true };
    maliciousInventory["constructor"] = { hacked: true };

    const players: Player[] = [
      makePlayer({
        id: "player-1",
        name: "Joueur-1",
        isHuman: true,
        money: 1000,
        inventory: {},
        tank: makeTank("tank-1", 120, 300),
      }),
      makePlayer({
        id: "player-2",
        name: "CPU-1",
        isHuman: false,
        aiProfile: "v4-smart",
        money: 1000,
        inventory: maliciousInventory as unknown as Player["inventory"],
        tank: makeTank("tank-2", 620, 300),
      }),
    ];

    const sessionRef: { current: SessionApi | null } = { current: null };
    render(<ShopHarness players={players} sessionRef={sessionRef} />);

    act(() => {
      sessionRef.current?.handleNextRound();
    });

    act(() => {
      sessionRef.current?.handleShopReady();
      vi.advanceTimersByTime(200);
    });

    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    const uiPlayers = sessionRef.current?.state.uiPlayers;
    expect(uiPlayers?.[1].money).toBeLessThan(1000);
    expect((Object.prototype as unknown as Record<string, unknown>).hacked).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(uiPlayers?.[1].inventory ?? {}, "__proto__")).toBe(false);
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
