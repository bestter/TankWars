// @vitest-environment jsdom
import { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePlayer, makeTank } from "../../game/__tests__/helpers";
import type { Player } from "../../types/player";
import type { OnlineCanvasSnapshot } from "../../utils/onlineSession";
import { createEmptyShopSession } from "../gameCanvasReducer";
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
    roomId: "room-fire-reconnect",
    localPlayerId: "player-1",
    initialCurrentPlayerIndex: 0,
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

describe("useGameSession FIRE reconnect", () => {
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
    vi.unstubAllGlobals();
  });

  it("retries the persisted FIRE and applies only its correlated catch-up rejection", () => {
    const players = [
      makePlayer({
        id: "player-1",
        name: "Local",
        isHuman: true,
        inventory: { GRENADE: 1 },
        tank: makeTank("tank-1", 120, 300, { currentWeapon: "GRENADE" }),
      }),
      makePlayer({
        id: "player-2",
        name: "Remote",
        isHuman: true,
        tank: makeTank("tank-2", 680, 300),
      }),
    ];
    const pendingFireIntent = {
      actionId: "fire-survives-refresh",
      command: { angle: 47, power: 63, weaponId: "GRENADE" as const },
    };
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
      shopSession: createEmptyShopSession(),
      lastAppliedShopEpoch: 0,
      lastCompletedRoundNumber: 0,
      lastSeenShotId: 0,
      pendingFireIntent,
      fireRejection: null,
      roundEarningsByPlayer: {},
      earningsOverlay: null,
    };
    const ws = new MockCombatWebSocket();
    const sessionRef: { current: SessionApi | null } = { current: null };

    render(
      <Harness
        players={players}
        resumeCanvas={resumeCanvas}
        ws={ws as unknown as WebSocket}
        sessionRef={sessionRef}
      />,
    );

    const sentMessages = ws.send.mock.calls.map(([payload]) =>
      JSON.parse(String(payload)) as Record<string, unknown>,
    );
    expect(sentMessages).toContainEqual({
      type: "FIRE",
      actionId: pendingFireIntent.actionId,
      command: pendingFireIntent.command,
    });

    act(() => {
      ws.receive({
        type: "FIRE_REJECTED",
        actionId: "stale-fire",
        reason: "NO_AMMO",
        inventory: { GRENADE: 0 },
        currentWeapon: "MISSILE",
      });
    });
    expect(sessionRef.current?.state.pendingFireIntent).toEqual(
      pendingFireIntent,
    );
    expect(sessionRef.current?.state.fireRejection).toBeNull();

    act(() => {
      ws.receive({
        type: "SHOT_CATCH_UP",
        roundNumber: 1,
        activeShotId: null,
        shots: [],
        lastFireResult: {
          type: "FIRE_REJECTED",
          actionId: pendingFireIntent.actionId,
          reason: "NO_AMMO",
          inventory: { GRENADE: 0 },
          currentWeapon: "MISSILE",
        },
      });
    });

    expect(sessionRef.current?.state.pendingFireIntent).toBeNull();
    expect(sessionRef.current?.state.fireRejection).toBe("NO_AMMO");
    expect(
      sessionRef.current?.state.uiPlayers[0].inventory.GRENADE,
    ).toBe(0);
  });
});
