// @vitest-environment jsdom
import { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePlayer, makeTank } from "../../game/__tests__/helpers";
import { TankManager } from "../../game/entities/TankManager";
import type { OnlineCanvasSnapshot } from "../../utils/onlineSession";
import type { Player } from "../../types/player";
import { useGameSession } from "../useGameSession";

type SessionApi = ReturnType<typeof useGameSession>;

function stubCanvas2d(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get: () => () => undefined,
    },
  ) as CanvasRenderingContext2D;
}

class MockCombatWebSocket {
  public readonly readyState = WebSocket.OPEN;
  public readonly send = vi.fn();
  public readonly close = vi.fn();
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onclose: ((event: CloseEvent) => void) | null = null;

  public receive(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
}

class MockBroadcastChannel {
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public postMessage(): void {}
  public close(): void {}
}

function Harness({
  players,
  resumeCanvas,
  ws,
  sessionRef,
}: {
  players: Player[];
  resumeCanvas: OnlineCanvasSnapshot;
  ws: WebSocket;
  sessionRef: { current: SessionApi | null };
}) {
  const session = useGameSession({
    initialPlayers: players,
    gameMode: "online",
    roomId: "room-zeus-race",
    localPlayerId: "player-1",
    initialCurrentPlayerIndex: 1,
    resumeCanvas,
    slot: 0,
    token: "TOKEN1",
    ws,
  });
  const { canvasRef } = session;
  useEffect(() => {
    sessionRef.current = session;
  });
  return <canvas ref={canvasRef} width={800} height={480} />;
}

describe("useGameSession Zeus reconnect", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => stubCanvas2d(),
    });
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("applies an in-progress reconnect strike once across duplicate and stale messages", () => {
    const players = [
      makePlayer({
        id: "player-1",
        name: "Local",
        isHuman: true,
        money: 250,
        tank: makeTank("tank-1", 120, 300),
      }),
      makePlayer({
        id: "player-2",
        name: "Zeus",
        isHuman: false,
        money: 250,
        tank: makeTank("tank-2", 400, 300),
      }),
      makePlayer({
        id: "player-3",
        name: "Target",
        isHuman: false,
        money: 250,
        tank: makeTank("tank-3", 680, 300),
      }),
    ];
    const resumeCanvas: OnlineCanvasSnapshot = {
      gamePhase: "COMBAT",
      currentManche: 1,
      uiPlayers: players,
      shopPlayers: [],
      currentShopIndex: 0,
      roundResult: null,
      lastRoundOutcome: null,
      wind: 0,
      authoritySlot: 0,
      authorityEpoch: 1,
      lastAppliedShotId: 0,
      lastAppliedZeusStrikeId: 0,
      roundEarningsByPlayer: {},
      earningsOverlay: null,
    };
    const ws = new MockCombatWebSocket();
    const sessionRef: { current: SessionApi | null } = { current: null };
    const applyStrike = vi.spyOn(TankManager.prototype, "applyZeusStrike");

    render(
      <Harness
        players={players}
        resumeCanvas={resumeCanvas}
        ws={ws as unknown as WebSocket}
        sessionRef={sessionRef}
      />,
    );

    const activeStrike = {
      type: "ZEUS_STRIKE",
      strikeId: 7,
      zeusId: "player-2",
      targetId: "player-3",
      resolveAt: Date.now() + 350,
    };
    const appliedStrike = {
      type: "ZEUS_STRIKE_APPLIED",
      strikeId: 7,
      zeusId: "player-2",
      targetId: "player-3",
      award: { playerId: "player-2", amount: 88 },
      balances: [
        { playerId: "player-1", money: 250 },
        { playerId: "player-2", money: 338 },
        { playerId: "player-3", money: 250 },
      ],
      deadSlots: [false, false, true],
      roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
      nextPlayerIndex: 0,
    };
    const zeusState = {
      type: "ZEUS_STATE",
      activeZeusId: "player-2",
      currentPlayerIndex: 1,
      rotationSlots: [1, 2, 0],
      deadSlots: [false, false, false],
      activeStrike,
      lastAppliedStrikeId: 0,
    };

    act(() => {
      ws.receive(zeusState);
      ws.receive(activeStrike);
      ws.receive(appliedStrike);
      ws.receive(appliedStrike);
      ws.receive(zeusState);
      vi.advanceTimersByTime(1_000);
    });

    const state = sessionRef.current?.state;
    expect(applyStrike).toHaveBeenCalledOnce();
    expect(state?.uiPlayers.find((player) => player.id === "player-3")?.tank).toMatchObject({
      health: 0,
      shield: 0,
      isDead: true,
    });
    expect(state?.uiPlayers.find((player) => player.id === "player-2")?.money).toBe(338);
    expect(state?.earningsOverlay?.awards).toEqual([
      expect.objectContaining({ playerId: "player-2", amount: 88 }),
    ]);
  });
});
