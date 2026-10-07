import { fragmentCombat } from "../../game/online/combatCatchUp";
import type { ShotMessage } from "../../game/online/protocol";
import { makeRoundMap } from "../../game/__tests__/helpers";
// @vitest-environment jsdom
import { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePlayer, makeTank } from "../../game/__tests__/helpers";
import { TurnManager } from "../../game/engine/TurnManager";
import { GameEngine } from "../../game/engine/GameEngine";
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

  public receiveCatchUp(players: Player[], payload: { type: string; roundNumber: number; activeShotId: number | null; shots: ReadonlyArray<ShotMessage>; lastFireResult: import("../../game/online/protocol").FireRejectedMessage | null }): void {
    const round = payload.roundNumber;
    const initialPlayers = structuredClone(players).map((p) => ({ ...p, tank: { ...p.tank, isDead: false, health: p.tank.maxHealth } }));
    const messages = fragmentCombat({ roundNumber: round, map: makeRoundMap(round), initialPlayers, players,
      currentPlayerIndex: payload.shots.at(-1)?.slot ?? 0,
      economicRevision: 1, roundEarningsByPlayer: Object.fromEntries(players.map((p) => [p.id, 0])), activeShotId: payload.activeShotId,
      activeShot: payload.activeShotId === null ? null : { ...payload.shots.find((shot) => shot.shotId === payload.activeShotId)!, physicsSeed: 1,
        eventSequence: payload.shots.findIndex((shot) => shot.shotId === payload.activeShotId) + 1,
        shooterSettled: false, earningsApplied: false, zeusEvaluated: false, releaseAt: null, appointment: null },
      authoritySlot: 0, authorityEpoch: 1, lastFireResult: payload.lastFireResult,
      completedShop: round > 1 ? { type: "SHOP_FINISH", shopEpoch: round - 1, completedRoundNumber: round - 1, nextRoundNumber: round, players: initialPlayers, map: makeRoundMap(round) } : null,
      zeus: { type: "ZEUS_STATE", activeZeusId: null, currentPlayerIndex: 0, rotationSlots: [], deadSlots: players.map((p) => p.tank.isDead), activeStrike: null, lastAppliedStrikeId: 0 },
      events: payload.shots.map((shot, index) => ({ ...shot, physicsSeed: 1, eventSequence: index + 1 })),
    }, crypto.randomUUID());
    for (const message of messages) this.receive(message);
  }

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
    initialMap: resumeCanvas.map,
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
    map: makeRoundMap(),
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
      ws.receiveCatchUp(players, {
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
      physicsSeed: 1, eventSequence: 1,
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
      protocolVersion: 3,
      roundNumber: 2,
      lastSeenShotId: 0,
      lastAppliedShopEpoch: 0,
    });
    expect(sessionRef.current?.state.shopSession.authoritativeReceived).toBe(
      false,
    );

    act(() => {
      ws.receiveCatchUp(players, {
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

    expect(executeRemoteFire).toHaveBeenCalledTimes(1);
    const historicalManager = executeRemoteFire.mock.instances.at(-1)!;
    act(() => {
      (Reflect.get(historicalManager, "finishShotResolution") as () => void).call(historicalManager);
    });
    expect(sessionRef.current?.state.pendingFireIntent).toBeNull();
    expect(sessionRef.current?.state.lastSeenShotId).toBe(5);
    expect(sessionRef.current?.state.gamePhase).toBe("SHOP");
    expect(sessionRef.current?.state.shopSession.authoritativeReceived).toBe(
      true,
    );

    act(() => {
      ws.receive({
        type: "SHOP_FINISH",
        map: makeRoundMap(2),
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
      physicsSeed: 1, eventSequence: 1,
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

    expect(executeRemoteFire).toHaveBeenCalledTimes(2);
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
      physicsSeed: 1, eventSequence: 1,
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
      ws.receiveCatchUp(players, {
        type: "SHOT_CATCH_UP",
        roundNumber: 2,
        activeShotId: nextRoundShot.shotId,
        shots: [nextRoundShot],
        lastFireResult: null,
      });
    });

    expect(executeRemoteFire).toHaveBeenCalledTimes(1);

    act(() => {
      ws.receive({
        type: "SHOP_FINISH",
        map: makeRoundMap(2),
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

  it.each([false, true])("preserves the replay sequence after duplicate SHOP_FINISH (during replay: %s)", (duringReplay) => {
    const players = createPlayers();
    const ws = new MockCombatWebSocket();
    const sessionRef: { current: SessionApi | null } = { current: null };
    const executeRemoteFire = vi.spyOn(TurnManager.prototype, "executeRemoteFire")
      .mockImplementation(() => undefined);
    render(<Harness players={players} ws={ws as unknown as WebSocket} sessionRef={sessionRef}
      resumeCanvas={createResumeCanvas(players, { gamePhase: "SHOP", currentManche: 2,
        shopPlayers: players, lastCompletedRoundNumber: 1 })} />);
    const shot: ShotMessage = {
      type: "SHOT", physicsSeed: 1, eventSequence: 1, actionId: "replayed-round-two",
      shotId: 6, roundNumber: 2, shotNumberInRound: 1, isFirstShotOfRound: true,
      slot: 0, ownerId: "player-1", command: { angle: 47, power: 63, weaponId: "MISSILE" },
    };
    act(() => ws.receiveCatchUp(players, { type: "SHOT_CATCH_UP", roundNumber: 2,
      activeShotId: null, shots: [shot], lastFireResult: null }));
    const tm = executeRemoteFire.mock.instances.at(-1) as TurnManager;
    expect(executeRemoteFire).toHaveBeenCalledTimes(1);
    expect(sessionRef.current?.state.lastAppliedShopEpoch).toBe(1);
    const duplicate = { type: "SHOP_FINISH", map: makeRoundMap(2), shopEpoch: 1,
      completedRoundNumber: 1, nextRoundNumber: 2, players };
    act(() => {
      if (duringReplay) ws.receive(duplicate);
      tm.onAuthoritativeShotSettled?.(6, "CATCH_UP");
      if (!duringReplay) ws.receive(duplicate);
      ws.receive({ ...shot, actionId: "next-live-shot", shotId: 7, eventSequence: 2,
        shotNumberInRound: 2, isFirstShotOfRound: false });
    });
    expect(sessionRef.current?.state.networkError).toBeNull();
    expect(executeRemoteFire).toHaveBeenCalledTimes(2);
    expect(executeRemoteFire).toHaveBeenLastCalledWith(shot.command,
      expect.objectContaining({ identity: expect.objectContaining({ shotId: 7 }) }));
  });

  it("rebuilds the current combat and ignores stale shop states from the previous round", () => {
    const players = createPlayers();
    const resumeCanvas = createResumeCanvas(players, {
      gamePhase: "SHOP",
      currentManche: 2,
      shopPlayers: players,
      lastCompletedRoundNumber: 1,
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
    const nextRoundShot = {
      type: "SHOT",
      physicsSeed: 1, eventSequence: 1,
      actionId: "queued-round-two-shot",
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
      ws.receiveCatchUp(players, {
        type: "SHOT_CATCH_UP",
        roundNumber: 2,
        activeShotId: nextRoundShot.shotId,
        shots: [nextRoundShot],
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

    expect(executeRemoteFire).toHaveBeenCalledTimes(1);
    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    expect(sessionRef.current?.state.lastAppliedShopEpoch).toBe(1);
  });

  it("keeps a pending shop intent until its correlated rejection arrives", () => {
    const players = createPlayers();
    const pendingIntent = {
      kind: "BUY_SELL" as const,
      actionId: "valid-buy-in-flight",
      shopEpoch: 1,
      weaponId: "GRENADE" as const,
      delta: 1 as const,
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

  it("applies concurrent shop state, retries the same actionId, and unlocks only on its ack", () => {
    const players = createPlayers();
    const pendingIntent = {
      kind: "BUY_SELL" as const,
      actionId: "shop-action-awaiting-ack",
      shopEpoch: 1,
      weaponId: "GRENADE" as const,
      delta: 1 as const,
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

    const shopRetries = (): Record<string, unknown>[] =>
      getSentMessages(ws).filter(
        (message) => message.type === "SHOP_BUY_SELL",
      );
    expect(shopRetries()).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(shopRetries()).toHaveLength(2);
    expect(shopRetries()[1]).toEqual(shopRetries()[0]);

    const concurrentPlayers = players.map((player, index) =>
      index === 1 ? { ...player, money: player.money + 25 } : player,
    );
    act(() => {
      ws.receive({
        type: "SHOP_STATE",
        shopEpoch: 1,
        roundNumber: 1,
        readySlots: [],
        players: concurrentPlayers,
        purchasesByPlayerId: {},
        aiShopApplied: true,
        acknowledgedAction: { slot: 1, actionId: "remote-action" },
      });
    });

    expect(sessionRef.current?.state.shopPlayers[1].money).toBe(
      players[1].money + 25,
    );
    expect(sessionRef.current?.state.shopSession.pendingIntent).toEqual(
      pendingIntent,
    );

    const acknowledgedPlayers = concurrentPlayers.map((player, index) =>
      index === 0 ? { ...player, money: player.money - 25 } : player,
    );
    act(() => {
      ws.receive({
        type: "SHOP_STATE",
        shopEpoch: 1,
        roundNumber: 1,
        readySlots: [],
        players: acknowledgedPlayers,
        purchasesByPlayerId: {},
        aiShopApplied: true,
        acknowledgedAction: {
          slot: 0,
          actionId: pendingIntent.actionId,
        },
      });
      vi.advanceTimersByTime(10_000);
    });

    expect(sessionRef.current?.state.shopSession.pendingIntent).toBeNull();
    expect(sessionRef.current?.state.shopPlayers[0].money).toBe(
      players[0].money - 25,
    );
    expect(shopRetries()).toHaveLength(2);
  });

  it.each([true, false])("recovers after preparation failure and lost SHOP_FINISH exactly once (pending READY: %s)", (pendingReady) => {
    const players = createPlayers();
    const ready = { type: 'SHOP_READY', shopEpoch: 1, actionId: 'original-ready' };
    const resumeCanvas = createResumeCanvas(players, {
      gamePhase: 'SHOP', currentManche: 2, shopPlayers: players, lastCompletedRoundNumber: 1,
      shopSession: {
        ...createEmptyShopSession(), epoch: 1, roundNumber: 1, readySlots: [0, 1],
        aiShopApplied: true, authoritativeReceived: true,
        pendingIntent: pendingReady ? { kind: 'READY', shopEpoch: 1, actionId: ready.actionId } : null,
      },
    });
    const ws = new MockCombatWebSocket();
    const sessionRef: { current: SessionApi | null } = { current: null };
    const nextRound = vi.spyOn(GameEngine.prototype, 'startNextRound');
    const mounted = render(<Harness players={players} resumeCanvas={resumeCanvas}
      ws={ws as unknown as WebSocket} sessionRef={sessionRef} />);
    act(() => ws.receive({ type: 'ROUND_PREPARATION_FAILED', reason: 'EXHAUSTED', roundNumber: 2 }));
    expect(sessionRef.current?.state.roundPreparationError).toBe('EXHAUSTED');
    expect(sessionRef.current?.state.gamePhase).toBe('SHOP');
    expect(nextRound).not.toHaveBeenCalled();
    ws.send.mockClear();
    act(() => sessionRef.current?.retryRoundPreparation());
    expect(getSentMessages(ws)).toContainEqual(pendingReady ? ready : {
      type: 'REQUEST_GAME_START', protocolVersion: 3, roundNumber: 2,
      lastSeenShotId: 0, lastAppliedShopEpoch: 0,
    });
    // The server succeeds, but its SHOP_FINISH is lost. Reconnect with the saved SHOP state.
    const saved = createResumeCanvas(players, {
      ...resumeCanvas, shopSession: sessionRef.current!.state.shopSession,
    });
    mounted.unmount();
    const reconnected = new MockCombatWebSocket();
    render(<Harness players={players} resumeCanvas={saved}
      ws={reconnected as unknown as WebSocket} sessionRef={sessionRef} />);
    expect(getSentMessages(reconnected)).toContainEqual({
      type: 'REQUEST_GAME_START', protocolVersion: 3, roundNumber: 2,
      lastSeenShotId: 0, lastAppliedShopEpoch: 0,
    });
    if (pendingReady) expect(getSentMessages(reconnected)).toContainEqual(ready);
    const finish = {
      type: 'SHOP_FINISH', map: makeRoundMap(2), shopEpoch: 1, completedRoundNumber: 1,
      nextRoundNumber: 2, players, acknowledgedAction: { slot: 1, actionId: 'closing-ready' },
    };
    act(() => {
      reconnected.receive({ type: 'SHOT_CATCH_UP', roundNumber: 2, activeShotId: null, shots: [], lastFireResult: null });
      reconnected.receive(finish);
    });
    expect(sessionRef.current?.state.gamePhase).toBe('COMBAT');
    expect(sessionRef.current?.state.currentManche).toBe(2);
    expect(sessionRef.current?.state.lastAppliedShopEpoch).toBe(1);
    expect(sessionRef.current?.state.shopSession.pendingIntent).toBeNull();
    expect(sessionRef.current?.state.roundPreparationError).toBeNull();
    act(() => {
      reconnected.receive({ ...finish, acknowledgedAction: { slot: 0, actionId: ready.actionId } });
      reconnected.receive(finish);
      reconnected.receive({ type: 'SHOP_STATE', shopEpoch: 1, roundNumber: 1, readySlots: [0, 1],
        players, purchasesByPlayerId: {}, aiShopApplied: true });
      vi.advanceTimersByTime(10_000);
    });
    expect(nextRound).toHaveBeenCalledTimes(1);
    expect(sessionRef.current?.state.gamePhase).toBe('COMBAT');
    expect(getSentMessages(reconnected).filter((message) => message.type === 'SHOP_READY'))
      .toHaveLength(pendingReady ? 1 : 0);
  });

  it("recovers the local active shot and emits settlement plus earnings", () => {
    const players = createPlayers();
    players[0].inventory.GRENADE = 0;
    players[0].tank.currentWeapon = "MISSILE";
    const resumeCanvas = createResumeCanvas(players, { lastSeenShotId: 999, lastAppliedShotId: 7 });
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
      ws.receiveCatchUp(players, {
        type: "SHOT_CATCH_UP",
        roundNumber: 1,
        activeShotId: 7,
        shots: [
          {
            type: "SHOT",
      physicsSeed: 1, eventSequence: 1,
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
    expect(sessionRef.current?.state.uiPlayers[0].inventory.GRENADE).toBe(0);
    act(() => ws.receive({ type: "SHOT_EARNINGS_APPLIED", shotId: 7, economicRevision: 1,
      roundEarningsByPlayer: { "player-1": 0, "player-2": 0 }, balances: players.map((p) => ({ playerId: p.id, money: p.money })),
      awards: [], hasEarnings: false, blockDurationMs: 0, roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null } }));
    const manager = executeRemoteFire.mock.instances.at(-1);
    if (!manager) throw new Error("TurnManager de reprise introuvable.");
    const finishShotResolution = Reflect.get(
      manager,
      "finishShotResolution",
    ) as () => void;
    act(() => finishShotResolution.call(manager));

    expect(sessionRef.current?.state.lastSeenShotId).toBe(7);
    const sentMessages = getSentMessages(ws);
    const report = sentMessages.find((message) => message.type === "SHOT_EARNINGS") as { players: Player[] } | undefined;
    expect(report?.players[0].inventory.GRENADE).toBe(0);
    expect(report?.players[0].tank.currentWeapon).toBe("MISSILE");
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
      ws.receiveCatchUp(players, {
        type: "SHOT_CATCH_UP",
        roundNumber: 1,
        activeShotId: 8,
        shots: [
          {
            type: "SHOT",
      physicsSeed: 1, eventSequence: 1,
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
        requiredVersion: 3,
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
      requiredVersion: 3,
      receivedVersion: null,
    });
    expect(wsCtor).not.toHaveBeenCalled();
  });

  it("applies SHOP_STATE then SHOP_FINISH after an in-flight shot replay", () => {
    const players = createPlayers();
    const resumeCanvas = createResumeCanvas(players, { lastSeenShotId: 4 });
    const ws = new MockCombatWebSocket();
    const sessionRef: { current: SessionApi | null } = { current: null };
    const executeRemoteFire = vi
      .spyOn(TurnManager.prototype, "executeRemoteFire")
      .mockImplementation(() => undefined);

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
        type: "SHOT",
      physicsSeed: 1, eventSequence: 1,
        actionId: "live-round-one",
        shotId: 5,
        roundNumber: 1,
        shotNumberInRound: 5,
        isFirstShotOfRound: false,
        slot: 0,
        ownerId: "player-1",
        command: { angle: 47, power: 63, weaponId: "GRENADE" },
      });
    });

    const capturedTm = executeRemoteFire.mock.instances.at(-1) as
      | TurnManager
      | undefined;
    expect(capturedTm).toBeDefined();

    act(() => {
      ws.receive({
        type: "ROUND_END",
        players,
        roundWinnerId: "player-1",
        isDraw: false,
        roundNumber: 1,
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
      ws.receive({
        type: "SHOP_FINISH",
        map: makeRoundMap(2),
        shopEpoch: 1,
        completedRoundNumber: 1,
        nextRoundNumber: 2,
        players,
      });
    });

    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    expect(sessionRef.current?.state.lastAppliedShopEpoch).toBe(0);

    act(() => {
      capturedTm?.onAuthoritativeShotSettled?.(5, "LIVE_REMOTE");
    });

    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    expect(sessionRef.current?.state.currentManche).toBe(2);
    expect(sessionRef.current?.state.lastAppliedShopEpoch).toBe(1);
  });

  it("accepts sequence one again after a new shop epoch", () => {
    const players = createPlayers();
    const ws = new MockCombatWebSocket();
    const sessionRef: { current: SessionApi | null } = { current: null };
    const executeRemoteFire = vi.spyOn(TurnManager.prototype, "executeRemoteFire")
      .mockImplementation(() => undefined);
    render(<Harness players={players} ws={ws as unknown as WebSocket}
      sessionRef={sessionRef} resumeCanvas={createResumeCanvas(players)} />);
    const shot: ShotMessage = {
      type: "SHOT", physicsSeed: 1, eventSequence: 1, actionId: "round-one",
      shotId: 1, roundNumber: 1, shotNumberInRound: 1, isFirstShotOfRound: true,
      slot: 0, ownerId: "player-1", command: { angle: 47, power: 63, weaponId: "MISSILE" },
    };
    act(() => ws.receive(shot));
    const tm = executeRemoteFire.mock.instances.at(-1) as TurnManager;
    act(() => {
      ws.receive({ type: "ROUND_END", players, roundWinnerId: "player-1", isDraw: false, roundNumber: 1 });
      ws.receive({ type: "SHOP_STATE", shopEpoch: 1, roundNumber: 1, readySlots: [0],
        players, purchasesByPlayerId: {}, aiShopApplied: true });
      ws.receive({ type: "SHOP_FINISH", map: makeRoundMap(2), shopEpoch: 1,
        completedRoundNumber: 1, nextRoundNumber: 2, players });
      tm.onAuthoritativeShotSettled?.(1, "LIVE_LOCAL");
    });
    expect(sessionRef.current?.state.lastAppliedShopEpoch).toBe(1);
    act(() => ws.receive({ ...shot, actionId: "round-two", shotId: 2, roundNumber: 2 }));
    expect(sessionRef.current?.state.networkError ?? null).toBeNull();
    expect(executeRemoteFire).toHaveBeenCalledTimes(2);
    expect(executeRemoteFire).toHaveBeenLastCalledWith(shot.command,
      expect.objectContaining({ identity: expect.objectContaining({ shotId: 2 }) }));
  });

  it("does not reopen SHOP when a late SHOP_STATE follows SHOP_FINISH during replay", () => {
    const players = createPlayers();
    const resumeCanvas = createResumeCanvas(players, { lastSeenShotId: 4 });
    const ws = new MockCombatWebSocket();
    const sessionRef: { current: SessionApi | null } = { current: null };
    const executeRemoteFire = vi
      .spyOn(TurnManager.prototype, "executeRemoteFire")
      .mockImplementation(() => undefined);

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
        type: "SHOT",
      physicsSeed: 1, eventSequence: 1,
        actionId: "live-round-one",
        shotId: 5,
        roundNumber: 1,
        shotNumberInRound: 5,
        isFirstShotOfRound: false,
        slot: 0,
        ownerId: "player-1",
        command: { angle: 47, power: 63, weaponId: "GRENADE" },
      });
      ws.receive({
        type: "SHOP_FINISH",
        map: makeRoundMap(2),
        shopEpoch: 1,
        completedRoundNumber: 1,
        nextRoundNumber: 2,
        players,
      });
      ws.receive({
        type: "SHOP_STATE",
        shopEpoch: 1,
        roundNumber: 1,
        readySlots: [],
        players,
        purchasesByPlayerId: {},
        aiShopApplied: true,
      });
    });

    const capturedTm = executeRemoteFire.mock.instances.at(-1) as
      | TurnManager
      | undefined;
    expect(capturedTm).toBeDefined();

    act(() => {
      capturedTm?.onAuthoritativeShotSettled?.(5, "LIVE_REMOTE");
    });

    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    expect(sessionRef.current?.state.currentManche).toBe(2);
    expect(sessionRef.current?.state.lastAppliedShopEpoch).toBe(1);
  });
});
