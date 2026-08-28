// @vitest-environment jsdom
import { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePlayer, makeTank } from "../../game/__tests__/helpers";
import { TurnManager } from "../../game/engine/TurnManager";
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

function createPlayers(): Player[] {
  return [
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
      inventory: { GRENADE: 1 },
      tank: makeTank("tank-2", 680, 300, { currentWeapon: "GRENADE" }),
    }),
  ];
}

function createResumeCanvas(
  players: Player[],
  overrides: Partial<OnlineCanvasSnapshot> = {},
): OnlineCanvasSnapshot {
  return {
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
    pendingFireIntent: null,
    fireRejection: null,
    roundEarningsByPlayer: {},
    earningsOverlay: null,
    ...overrides,
  };
}

function getSentMessages(ws: MockCombatWebSocket): Record<string, unknown>[] {
  return ws.send.mock.calls.map(([payload]) =>
    JSON.parse(String(payload)) as Record<string, unknown>,
  );
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
    const players = createPlayers();
    const pendingFireIntent = {
      actionId: "fire-survives-refresh",
      command: { angle: 47, power: 63, weaponId: "GRENADE" as const },
    };
    const resumeCanvas = createResumeCanvas(players, {
      pendingFireIntent,
    });
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

    const sentMessages = getSentMessages(ws);
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

  it("expires a persisted fire rejection after reconnecting", () => {
    const players = createPlayers();
    const resumeCanvas = createResumeCanvas(players, {
      fireRejection: "NO_AMMO",
    });
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

    expect(sessionRef.current?.state.fireRejection).toBe("NO_AMMO");
    act(() => vi.advanceTimersByTime(3499));
    expect(sessionRef.current?.state.fireRejection).toBe("NO_AMMO");
    act(() => vi.advanceTimersByTime(1));
    expect(sessionRef.current?.state.fireRejection).toBeNull();
  });

  it("keeps a restored SUMMARY phase outside combat", () => {
    const players = createPlayers();
    const resumeCanvas = createResumeCanvas(players, {
      gamePhase: "SUMMARY",
      currentManche: 2,
      lastCompletedRoundNumber: 1,
    });
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

    act(() => {
      ws.receive({
        type: "ROUND_END",
        players,
        roundWinnerId: "player-1",
        isDraw: false,
        roundNumber: 2,
      });
    });

    expect(sessionRef.current?.state.gamePhase).toBe("SUMMARY");
    expect(sessionRef.current?.state.lastCompletedRoundNumber).toBe(1);
  });

  it("recovers an unopened SHOP without replaying completed shots", () => {
    const players = createPlayers();
    const completedShot = {
      type: "SHOT",
      actionId: "completed-round-one-shot",
      shotId: 5,
      roundNumber: 1,
      shotNumberInRound: 3,
      isFirstShotOfRound: false,
      slot: 1,
      ownerId: "player-2",
      command: { angle: 133, power: 58, weaponId: "GRENADE" },
    } as const;
    const resumeCanvas = createResumeCanvas(players, {
      gamePhase: "SHOP",
      currentManche: 2,
      shopPlayers: players,
      lastCompletedRoundNumber: 1,
      pendingFireIntent: {
        actionId: completedShot.actionId,
        command: completedShot.command,
      },
      shopSession: {
        ...createEmptyShopSession(),
        epoch: null,
        roundNumber: 1,
        authoritativeReceived: false,
      },
    });
    const ws = new MockCombatWebSocket();
    const sessionRef: { current: SessionApi | null } = { current: null };
    const executeRemoteFire = vi.spyOn(
      TurnManager.prototype,
      "executeRemoteFire",
    );

    render(
      <Harness
        players={players}
        resumeCanvas={resumeCanvas}
        ws={ws as unknown as WebSocket}
        sessionRef={sessionRef}
      />,
    );

    const recoveryMessages = getSentMessages(ws);
    expect(
      recoveryMessages.filter((message) => message.type === "SHOP_ENTER"),
    ).toEqual([{ type: "SHOP_ENTER", roundNumber: 1 }]);
    expect(recoveryMessages).toContainEqual({
      type: "REQUEST_GAME_START",
      protocolVersion: 1,
      roundNumber: 2,
      lastSeenShotId: 0,
      lastAppliedShopEpoch: 0,
    });
    expect(sessionRef.current?.state.shopSession.authoritativeReceived).toBe(
      false,
    );

    act(() => {
      ws.receive({
        type: "SHOT_CATCH_UP",
        roundNumber: 1,
        activeShotId: null,
        shots: [completedShot],
        lastFireResult: null,
      });
      ws.receive({
        type: "SHOP_STATE",
        shopEpoch: 1,
        roundNumber: 1,
        readySlots: [0],
        players,
        purchasesByPlayerId: {},
        aiShopApplied: true,
      });
    });

    expect(executeRemoteFire).not.toHaveBeenCalled();
    expect(sessionRef.current?.state.pendingFireIntent).toBeNull();
    expect(sessionRef.current?.state.lastSeenShotId).toBe(5);
    expect(sessionRef.current?.state.gamePhase).toBe("SHOP");
    expect(sessionRef.current?.state.shopSession.authoritativeReceived).toBe(
      true,
    );

    act(() => {
      ws.receive({
        type: "SHOP_FINISH",
        shopEpoch: 1,
        completedRoundNumber: 1,
        nextRoundNumber: 2,
        players,
      });
    });

    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");

    act(() => {
      ws.receive({
        type: "SHOT",
        actionId: "round-two-shot",
        shotId: 6,
        roundNumber: 2,
        shotNumberInRound: 1,
        isFirstShotOfRound: true,
        slot: 0,
        ownerId: "player-1",
        command: { angle: 47, power: 63, weaponId: "GRENADE" },
      });
    });

    expect(executeRemoteFire).toHaveBeenCalledTimes(1);
    expect(executeRemoteFire).toHaveBeenCalledWith(
      expect.objectContaining({ weaponId: "GRENADE" }),
      expect.objectContaining({
        mode: "LIVE_LOCAL",
        identity: expect.objectContaining({ shotId: 6 }),
      }),
    );
  });

  it("drains an active next-round catch-up shot after SHOP_FINISH", () => {
    const players = createPlayers();
    const resumeCanvas = createResumeCanvas(players, {
      gamePhase: "SHOP",
      currentManche: 2,
      shopPlayers: players,
      lastCompletedRoundNumber: 1,
      shopSession: {
        ...createEmptyShopSession(),
        epoch: 1,
        roundNumber: 1,
        aiShopApplied: true,
        authoritativeReceived: true,
      },
    });
    const ws = new MockCombatWebSocket();
    const sessionRef: { current: SessionApi | null } = { current: null };
    const executeRemoteFire = vi.spyOn(
      TurnManager.prototype,
      "executeRemoteFire",
    );
    const nextRoundShot = {
      type: "SHOT",
      actionId: "active-round-two-shot",
      shotId: 6,
      roundNumber: 2,
      shotNumberInRound: 1,
      isFirstShotOfRound: true,
      slot: 0,
      ownerId: "player-1",
      command: { angle: 47, power: 63, weaponId: "GRENADE" },
    } as const;

    render(
      <Harness
        players={players}
        resumeCanvas={resumeCanvas}
        ws={ws as unknown as WebSocket}
        sessionRef={sessionRef}
      />,
    );

    act(() => {
      ws.receive({
        type: "SHOT_CATCH_UP",
        roundNumber: 2,
        activeShotId: nextRoundShot.shotId,
        shots: [nextRoundShot],
        lastFireResult: null,
      });
    });

    expect(executeRemoteFire).not.toHaveBeenCalled();

    act(() => {
      ws.receive({
        type: "SHOP_FINISH",
        shopEpoch: 1,
        completedRoundNumber: 1,
        nextRoundNumber: 2,
        players,
      });
    });

    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    expect(executeRemoteFire).toHaveBeenCalledTimes(1);
    expect(executeRemoteFire).toHaveBeenCalledWith(
      nextRoundShot.command,
      expect.objectContaining({
        mode: "ACTIVE_RECOVERY",
        identity: expect.objectContaining({ shotId: nextRoundShot.shotId }),
      }),
    );
  });

  it("keeps a pending shop intent until its correlated rejection arrives", () => {
    const players = createPlayers();
    const pendingIntent = {
      kind: "BUY_SELL" as const,
      actionId: "valid-buy-in-flight",
      shopEpoch: 1,
      weaponId: "GRENADE" as const,
      delta: 1 as const,
      expectedMoney: players[0].money - 75,
      expectedStock: 2,
      expectedPurchaseCount: 1,
    };
    const resumeCanvas = createResumeCanvas(players, {
      gamePhase: "SHOP",
      currentManche: 2,
      shopPlayers: players,
      lastCompletedRoundNumber: 1,
      shopSession: {
        ...createEmptyShopSession(),
        epoch: 1,
        roundNumber: 1,
        authoritativeReceived: true,
        pendingIntent,
      },
    });
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

    expect(
      getSentMessages(ws).filter((message) => message.type === "SHOP_ENTER"),
    ).toHaveLength(0);

    act(() => {
      ws.receive({
        type: "SHOP_REJECTED",
        shopEpoch: 1,
        reason: "MALFORMED",
      });
      ws.receive({
        type: "SHOP_REJECTED",
        shopEpoch: 1,
        actionId: "orphaned-buy",
        reason: "MALFORMED",
      });
    });

    expect(sessionRef.current?.state.shopSession.pendingIntent).toEqual(
      pendingIntent,
    );
    expect(sessionRef.current?.state.shopSession.denial).toBeNull();

    act(() => {
      ws.receive({
        type: "SHOP_REJECTED",
        shopEpoch: 1,
        actionId: pendingIntent.actionId,
        weaponId: pendingIntent.weaponId,
        delta: pendingIntent.delta,
        reason: "MALFORMED",
      });
    });

    expect(sessionRef.current?.state.shopSession.pendingIntent).toBeNull();
    expect(sessionRef.current?.state.shopSession.denial).toBe("MALFORMED");
  });

  it("recovers the local active shot and emits settlement plus earnings", () => {
    const players = createPlayers();
    const resumeCanvas = createResumeCanvas(players, { lastSeenShotId: 7 });
    const ws = new MockCombatWebSocket();
    const sessionRef: { current: SessionApi | null } = { current: null };
    const executeRemoteFire = vi.spyOn(
      TurnManager.prototype,
      "executeRemoteFire",
    );

    render(
      <Harness
        players={players}
        resumeCanvas={resumeCanvas}
        ws={ws as unknown as WebSocket}
        sessionRef={sessionRef}
      />,
    );
    ws.send.mockClear();

    act(() => {
      ws.receive({
        type: "SHOT_CATCH_UP",
        roundNumber: 1,
        activeShotId: 7,
        shots: [
          {
            type: "SHOT",
            actionId: "active-local-recovery",
            shotId: 7,
            roundNumber: 1,
            shotNumberInRound: 1,
            isFirstShotOfRound: true,
            slot: 0,
            ownerId: "player-1",
            command: { angle: 47, power: 63, weaponId: "GRENADE" },
          },
        ],
        lastFireResult: null,
      });
    });

    expect(executeRemoteFire).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: "ACTIVE_RECOVERY", fromSlot: 0 }),
    );
    expect(sessionRef.current?.state.uiPlayers[0].inventory.GRENADE).toBe(1);
    const manager = executeRemoteFire.mock.instances.at(-1);
    if (!manager) throw new Error("TurnManager de reprise introuvable.");
    const finishShotResolution = Reflect.get(
      manager,
      "finishShotResolution",
    ) as () => void;
    act(() => finishShotResolution.call(manager));

    const sentMessages = getSentMessages(ws);
    expect(sentMessages).toContainEqual(
      expect.objectContaining({ type: "SHOT_SETTLED", shotId: 7 }),
    );
    expect(sentMessages).toContainEqual(
      expect.objectContaining({ type: "SHOT_EARNINGS", shotId: 7 }),
    );
  });

  it("lets a distinct authority recover earnings without settling for the shooter", () => {
    const players = createPlayers();
    const resumeCanvas = createResumeCanvas(players, { lastSeenShotId: 8 });
    const ws = new MockCombatWebSocket();
    const sessionRef: { current: SessionApi | null } = { current: null };
    const executeRemoteFire = vi.spyOn(
      TurnManager.prototype,
      "executeRemoteFire",
    );

    render(
      <Harness
        players={players}
        resumeCanvas={resumeCanvas}
        ws={ws as unknown as WebSocket}
        sessionRef={sessionRef}
      />,
    );
    ws.send.mockClear();

    act(() => {
      ws.receive({
        type: "SHOT_CATCH_UP",
        roundNumber: 1,
        activeShotId: 8,
        shots: [
          {
            type: "SHOT",
            actionId: "active-authority-recovery",
            shotId: 8,
            roundNumber: 1,
            shotNumberInRound: 2,
            isFirstShotOfRound: false,
            slot: 1,
            ownerId: "player-2",
            command: { angle: 133, power: 58, weaponId: "GRENADE" },
          },
        ],
        lastFireResult: null,
      });
    });

    expect(executeRemoteFire).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: "ACTIVE_RECOVERY", fromSlot: 1 }),
    );
    const manager = executeRemoteFire.mock.instances.at(-1);
    if (!manager) throw new Error("TurnManager de reprise introuvable.");
    const finishShotResolution = Reflect.get(
      manager,
      "finishShotResolution",
    ) as () => void;
    act(() => finishShotResolution.call(manager));

    const sentMessages = getSentMessages(ws);
    expect(
      sentMessages.some((message) => message.type === "SHOT_SETTLED"),
    ).toBe(false);
    expect(sentMessages).toContainEqual(
      expect.objectContaining({ type: "SHOT_EARNINGS", shotId: 8 }),
    );
  });

  it("surfaces PROTOCOL_MISMATCH and does not reconnect on close 4402", () => {
    const players = createPlayers();
    const resumeCanvas = createResumeCanvas(players);
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

    const wsCtor = vi.spyOn(globalThis, "WebSocket");

    act(() => {
      ws.receive({
        type: "PROTOCOL_MISMATCH",
        requiredVersion: 1,
        receivedVersion: null,
      });
      ws.onclose?.({
        code: 4402,
        reason: "protocol-mismatch",
      } as CloseEvent);
    });

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(sessionRef.current?.state.protocolMismatch).toEqual({
      requiredVersion: 1,
      receivedVersion: null,
    });
    expect(wsCtor).not.toHaveBeenCalled();
  });
});
