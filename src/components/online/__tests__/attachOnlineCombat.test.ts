import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine, type ResolvedShotPreview } from "../../../game/engine/GameEngine";
import { makePlayer, makeRoundMap, makeTank } from "../../../game/__tests__/helpers";
import { fragmentCombat, type CombatSnapshot } from "../../../game/online/combatCatchUp";
import { isStrictOnlineMessage, type ShotEarningsAppliedMessage, type ShotMessage } from "../../../game/online/protocol";
import { createEmptyShopSession, gameCanvasReducer, INITIAL_STATE, type GameCanvasAction } from "../../gameCanvasReducer";
import { attachOnlineCombat, type AttachOnlineCombatOptions } from "../attachOnlineCombat";

describe("online authoritative economy updates", () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("WebSocket", { OPEN: 1, CONNECTING: 0 });
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function setup() {
    const engine = new GameEngine(800, 480);
    const players = [
      makePlayer({ id: "a", money: 1000 }),
      makePlayer({ id: "b", money: 800, tank: makeTank("tank-2", 620, 300) }),
    ];
    engine.getTankManager().setPlayers(players);
    const ws = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      onmessage: null,
    } as unknown as WebSocket;
    const dispatch = vi.fn<(action: GameCanvasAction) => void>();
    const opts: AttachOnlineCombatOptions = {
      engine, dispatch, roomId: "room", slot: 0, token: "token", incomingWs: ws,
      gameWsRef: { current: null },
      protocolMismatchRef: { current: false },
      authoritySlotRef: { current: 0 },
      authorityEpochRef: { current: 1 },
      lastAppliedShotIdRef: { current: 0 },
      lastSeenShotIdRef: { current: 0 },
      lastAppliedShopEpochRef: { current: 0 },
      lastCompletedRoundNumberRef: { current: 0 },
      currentMancheRef: { current: 1 },
      gamePhaseRef: { current: "COMBAT" },
      shopSessionRef: { current: createEmptyShopSession() },
      shopPlayersRef: { current: [] },
      localShopDoneRef: { current: false },
      pendingFireRef: { current: null },
      fireRejectionTimerRef: { current: null },
      pendingShotPreviewsRef: { current: new Map() },
      submitShotEarningsRef: { current: vi.fn() },
      roundEndFromNetworkRef: { current: false },
      applyShopFinish: vi.fn(), clearCelebrationTimer: vi.fn(), setLocalShopDone: vi.fn(),
      buildOverlayAwards: () => [],
    };
    const handle = attachOnlineCombat(opts);
    cleanups.push(() => {
      handle.detach();
      engine.getTurnManager().removeInputListeners();
    });

    const receive = (message: object): void => {
      expect(isStrictOnlineMessage(message)).toBe(true);
      ws.onmessage?.call(ws, { data: JSON.stringify(message) } as MessageEvent<string>);
      expect(dispatch).not.toHaveBeenCalledWith({ type: "SET_NETWORK_ERROR", key: "combat_catch_up_invalid" });
    };
    receive({ type: "STATE_UPDATE", currentPlayerIndex: 0, roundEnded: false, players });
    dispatch.mockClear();

    // Submission reapplies the private authoritative economy before reading live players.
    const reapplyEconomy = (): void => {
      vi.spyOn(engine.getTurnManager(), "executeRemoteFire").mockImplementation(() => {});
      receive(shot(2, 1, 1));
      opts.submitShotEarningsRef.current(preview(2));
    };
    return { engine, players, dispatch, receive, reapplyEconomy, opts, send: vi.mocked(ws.send) };
  }

  function shot(shotId: number, roundNumber = 1, eventSequence = shotId): ShotMessage {
    return {
      type: "SHOT", shotId, roundNumber, shotNumberInRound: eventSequence, eventSequence, physicsSeed: shotId,
      isFirstShotOfRound: eventSequence === 1, ownerId: "a", slot: 0, actionId: `shot-${shotId}`,
      command: { angle: 45, power: 50, weaponId: "MISSILE" },
    };
  }

  function relaySnapshot(players: CombatSnapshot["players"], events: ShotMessage[]): CombatSnapshot {
    const active = events.at(-1)!;
    return {
      roundNumber: 1, map: makeRoundMap(), initialPlayers: structuredClone(players), players,
      currentPlayerIndex: 0, economicRevision: 1, roundEarningsByPlayer: { a: 0, b: 0 },
      authoritySlot: 0, authorityEpoch: 2, activeShotId: active.shotId, events,
      activeShot: { ...active, shooterSettled: false, earningsApplied: false, releaseAt: null, zeusEvaluated: false, appointment: null },
      zeus: { type: "ZEUS_STATE", activeZeusId: null, currentPlayerIndex: 0, rotationSlots: [], deadSlots: [false, false], activeStrike: null, lastAppliedStrikeId: 0 },
    };
  }

  function preview(shotId: number): ResolvedShotPreview {
    return {
      shotId, awards: [], balances: [], damageDealtMilliByPlayer: {},
      hasEarnings: false, directHitVictimIds: [],
      roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
    };
  }

  function result(balances: ShotEarningsAppliedMessage["balances"]): ShotEarningsAppliedMessage {
    return {
      type: "SHOT_EARNINGS_APPLIED", shotId: 1, economicRevision: 1,
      roundEarningsByPlayer: { a: 200, b: 0 }, balances, awards: [],
      hasEarnings: true, blockDurationMs: 0,
      roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
    };
  }

  it.each(["report", "draw"] as const)("clears a report error after the Worker confirms the %s", (resolution) => {
    const { engine, players, dispatch, receive, opts } = setup();
    const reject = (reason: string) => receive({ type: "EARNINGS_REJECTED", reason, shotId: 1, authorityEpoch: 1 });
    const reduceMessages = () => dispatch.mock.calls.reduce(
      (state, [action]) => gameCanvasReducer(state, action),
      INITIAL_STATE,
    );
    reject("MALFORMED");
    expect(reduceMessages().networkError).toBe("earnings_rejected_malformed");
    if (resolution === "report") {
      receive(result([{ playerId: "a", money: 1200 }]));
    } else {
      const syncEnd = vi.spyOn(engine, "syncRoundEndFromRemote");
      receive({ type: "ROUND_END", players, roundNumber: 1, roundWinnerId: null, isDraw: true });
      expect(syncEnd).toHaveBeenCalledWith(players, null, true);
      opts.gamePhaseRef.current = "SUMMARY";
      receive({ type: "EARNINGS_REJECTED", reason: "MALFORMED", shotId: null, authorityEpoch: null });
      opts.gamePhaseRef.current = "SHOP";
    }
    reject("MALFORMED");
    reject("STALE_AUTHORITY");
    reject("WRONG_SHOT");
    expect(reduceMessages().networkError).toBeNull();
    const unrelated = { ...INITIAL_STATE, networkError: "combat_catch_up_invalid" };
    expect(gameCanvasReducer(unrelated, { type: "CLEAR_EARNINGS_ERROR" })).toBe(unrelated);
  });

  it.each(["SHOP_STATE", "SHOP_FINISH"] as const)("clears a report error on a direct %s transition", (type) => {
    const { players, dispatch, receive, opts } = setup();
    const reduceMessages = () => dispatch.mock.calls.reduce(
      (state, [action]) => gameCanvasReducer(state, action),
      INITIAL_STATE,
    );
    receive({ type: "EARNINGS_REJECTED", reason: "CAP_MISMATCH", shotId: 1, authorityEpoch: 1 });
    expect(reduceMessages().networkError).toBe("earnings_rejected_cap_mismatch");
    if (type === "SHOP_STATE") {
      receive({ type, players, shopEpoch: 1, roundNumber: 1,
        readySlots: [], purchasesByPlayerId: {}, aiShopApplied: true });
      expect(opts.gamePhaseRef.current).toBe("SHOP");
    } else {
      const map = makeRoundMap(2);
      receive({ type, players, shopEpoch: 1, completedRoundNumber: 1, nextRoundNumber: 2, map });
      expect(opts.applyShopFinish).toHaveBeenCalledWith(players, 1, 2, map);
    }
    expect(reduceMessages().networkError).toBeNull();
  });

  it("ignores a stale EARNINGS_REJECTED for an earlier shot once a newer shot is active", () => {
    const { engine, dispatch, receive } = setup();
    const tm = engine.getTurnManager();
    vi.spyOn(tm, "executeRemoteFire").mockImplementation(() => {});

    receive({
      type: "SHOT", shotId: 1, roundNumber: 1, shotNumberInRound: 1, eventSequence: 1, physicsSeed: 1,
      isFirstShotOfRound: true, ownerId: "a", slot: 0, actionId: "shot-1",
      command: { angle: 45, power: 50, weaponId: "MISSILE" },
    });
    tm.onAuthoritativeShotSettled?.(1, "LIVE_LOCAL");
    receive({
      type: "SHOT", shotId: 2, roundNumber: 1, shotNumberInRound: 2, eventSequence: 2, physicsSeed: 2,
      isFirstShotOfRound: false, ownerId: "b", slot: 1, actionId: "shot-2",
      command: { angle: 135, power: 55, weaponId: "MISSILE" },
    });
    dispatch.mockClear();

    receive({ type: "EARNINGS_REJECTED", reason: "CAP_MISMATCH", shotId: 1, authorityEpoch: 1 });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "SET_NETWORK_ERROR" }),
    );

    receive({ type: "EARNINGS_REJECTED", reason: "CAP_MISMATCH", shotId: 2, authorityEpoch: 1 });
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_NETWORK_ERROR",
      key: "earnings_rejected_cap_mismatch",
    });
  });

  it.each(["settled", "in flight", "settles during reception", "missing history", "different journal"])("handles relay with a %s local shot after 24 seconds of history", (state) => {
    const { engine, players, receive, opts, send } = setup();
    const tm = engine.getTurnManager();
    const fire = vi.spyOn(tm, "executeRemoteFire").mockImplementation(() => {});
    const reconstruct = vi.spyOn(engine, "reconstructCombat");
    opts.authoritySlotRef.current = 1;
    const events = Array.from({ length: 7 }, (_, index) => shot(index + 1));
    const activeId = events.length;
    if (state !== "missing history") {
      for (const event of events.slice(0, -1)) {
        receive(state === "different journal" && event.shotId === 1 ? { ...event, physicsSeed: 10 } : event);
        vi.advanceTimersByTime(4_000);
        tm.onAuthoritativeShotSettled?.(event.shotId, "LIVE_LOCAL");
      }
      receive(events.at(-1)!);
      if (state === "settled") {
        opts.pendingShotPreviewsRef.current.set(activeId, preview(activeId));
        tm.onAuthoritativeShotSettled?.(activeId, "LIVE_LOCAL");
      } else {
        vi.spyOn(tm, "isResolvingAuthoritativeShot").mockImplementation((id) => id === activeId);
      }
    }
    send.mockClear();
    const [begin, ...parts] = fragmentCombat(relaySnapshot(players, events), "relay");
    receive(begin);
    if (state === "settles during reception") {
      opts.pendingShotPreviewsRef.current.set(activeId, preview(activeId));
      opts.submitShotEarningsRef.current(preview(activeId));
      tm.onAuthoritativeShotSettled?.(activeId, "LIVE_LOCAL");
      expect(send).not.toHaveBeenCalled();
    }
    for (const part of parts) receive(part);
    receive({ type: "AUTHORITY_CHANGED", authoritySlot: 0, authorityEpoch: 2 });
    if (state === "missing history" || state === "different journal") {
      expect(reconstruct).toHaveBeenCalledOnce();
      expect(fire).toHaveBeenCalledWith(events[0].command, expect.objectContaining({ mode: "CATCH_UP" }));
      expect(send).not.toHaveBeenCalled();
      const roundEnd = vi.spyOn(engine, "syncRoundEndFromRemote");
      receive({ type: "ROUND_END", players, roundNumber: 1, roundWinnerId: null, isDraw: true, abandonedShotId: activeId });
      expect(roundEnd).toHaveBeenCalledOnce();
      return;
    }
    expect(reconstruct).not.toHaveBeenCalled();
    expect(fire).toHaveBeenCalledTimes(events.length);
    if (state === "in flight") {
      expect(send).not.toHaveBeenCalled();
      opts.submitShotEarningsRef.current(preview(activeId));
    }
    receive({ type: "AUTHORITY_CHANGED", authoritySlot: 1, authorityEpoch: 1 });
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.parse(send.mock.calls[0][0] as string)).toMatchObject({ type: "SHOT_EARNINGS", shotId: activeId, authorityEpoch: 2 });
    expect(opts.authoritySlotRef.current).toBe(0);
  });

  it("still waits for local settlement at a normal round end", () => {
    const { engine, players, receive } = setup();
    const tm = engine.getTurnManager();
    vi.spyOn(tm, "executeRemoteFire").mockImplementation(() => {});
    const roundEnd = vi.spyOn(engine, "syncRoundEndFromRemote");
    receive(shot(1));
    receive({ type: "ROUND_END", players, roundNumber: 1, roundWinnerId: "a", isDraw: false });
    expect(roundEnd).not.toHaveBeenCalled();
    tm.onAuthoritativeShotSettled?.(1, "LIVE_LOCAL");
    expect(roundEnd).toHaveBeenCalledOnce();
  });

  it.each(["COMBAT", "SHOP"] as const)("restores an abandoned round from %s without starting historical shots", (phase) => {
    const { engine, players, receive, opts } = setup();
    const fire = vi.spyOn(engine.getTurnManager(), "executeRemoteFire");
    const roundEnd = vi.spyOn(engine, "syncRoundEndFromRemote");
    engine.onRoundEnded = () => { opts.gamePhaseRef.current = "SUMMARY"; };
    if (phase === "SHOP") {
      opts.gamePhaseRef.current = "SHOP";
      opts.currentMancheRef.current = 2;
      opts.lastCompletedRoundNumberRef.current = 1;
    }
    const snapshot = relaySnapshot(players, [shot(1), shot(2)]);
    snapshot.activeShot = null;
    snapshot.activeShotId = null;
    snapshot.abandonedShotId = 2;
    snapshot.roundEarningsByPlayer.a = 200;
    for (const part of fragmentCombat(snapshot, "abandoned")) receive(part);
    receive({ type: "ROUND_END", players, roundNumber: 1, roundWinnerId: null, isDraw: true, abandonedShotId: 2 });
    expect(fire).not.toHaveBeenCalled();
    expect(roundEnd).toHaveBeenCalledTimes(phase === "COMBAT" ? 1 : 0);
    expect(opts.gamePhaseRef.current).toBe(phase === "COMBAT" ? "SUMMARY" : "SHOP");
    if (phase === "COMBAT") expect(engine.getRoundEarningsByPlayer()).toEqual({ a: 200, b: 0 });
  });

  it("abandons a never-settled shot immediately and retains committed earnings and shop economy", () => {
    const { engine, players, receive, opts, send } = setup();
    const tm = engine.getTurnManager();
    const fire = vi.spyOn(tm, "executeRemoteFire");
    const roundEnd = vi.spyOn(engine, "syncRoundEndFromRemote");
    engine.onRoundEnded = () => {
      opts.gamePhaseRef.current = "SUMMARY";
    };
    vi.mocked(opts.applyShopFinish).mockImplementation((nextPlayers, epoch, nextRound) => {
      engine.getTankManager().setPlayers(nextPlayers);
      opts.lastAppliedShopEpochRef.current = epoch;
      opts.currentMancheRef.current = nextRound;
      opts.gamePhaseRef.current = "COMBAT";
      vi.spyOn(tm, "isInterRoundPaused").mockReturnValue(false);
    });
    receive(result([{ playerId: "a", money: 1200 }]));
    fire.mockImplementationOnce(() => {});
    receive(shot(1));
    tm.onAuthoritativeShotSettled?.(1, "LIVE_LOCAL");
    const abandoned = shot(2);
    receive(abandoned);
    expect(engine.getPhysicsEngine().hasActiveProjectiles()).toBe(true);
    const draw = { type: "ROUND_END", players: structuredClone(players), roundNumber: 1, roundWinnerId: null, isDraw: true, abandonedShotId: 2 };
    opts.pendingShotPreviewsRef.current.set(2, preview(2));
    receive(draw);
    expect(roundEnd).toHaveBeenCalledOnce();
    expect(opts.gamePhaseRef.current).toBe("SUMMARY");
    expect(engine.getPhysicsEngine().hasActiveProjectiles()).toBe(false);
    expect(engine.getRoundEarningsByPlayer()).toEqual({ a: 200, b: 0 });
    expect(engine.getTankManager().getPlayers()[0].money).toBe(1200);
    expect(opts.pendingShotPreviewsRef.current.size).toBe(0);
    tm.onAuthoritativeShotSettled?.(2, "LIVE_LOCAL");
    receive(draw);
    receive(abandoned);
    expect(roundEnd).toHaveBeenCalledOnce();
    expect(fire).toHaveBeenCalledTimes(2);

    const shopPlayers = structuredClone(players);
    shopPlayers[0].money = 700;
    shopPlayers[0].inventory.GRENADE = 4;
    receive({
      type: "SHOP_STATE", shopEpoch: 1, roundNumber: 1, players: shopPlayers,
      readySlots: [], purchasesByPlayerId: {}, aiShopApplied: true,
    });
    send.mockClear();
    receive({ type: "AUTHORITY_CHANGED", authoritySlot: 0, authorityEpoch: 2 });
    expect(send).not.toHaveBeenCalled();
    expect(engine.getTankManager().getPlayers()[0]).toMatchObject({ money: 700, inventory: { GRENADE: 4 } });

    const finalPlayers = structuredClone(shopPlayers);
    finalPlayers[0].money = 600;
    finalPlayers[0].inventory.GRENADE = 5;
    receive({
      type: "SHOP_FINISH", shopEpoch: 1, completedRoundNumber: 1, nextRoundNumber: 2,
      map: makeRoundMap(2), players: finalPlayers,
    });
    receive({ type: "AUTHORITY_CHANGED", authoritySlot: 0, authorityEpoch: 3 });
    receive(abandoned);
    receive(draw);
    expect(send).not.toHaveBeenCalled();
    opts.submitShotEarningsRef.current(preview(2));
    expect(send).not.toHaveBeenCalled();
    receive(shot(3, 2, 1));
    opts.submitShotEarningsRef.current(preview(3));
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.parse(send.mock.calls[0][0] as string)).toMatchObject({
      type: "SHOT_EARNINGS", shotId: 3,
      players: [expect.objectContaining({ money: 600, inventory: { MISSILE: 99, GRENADE: 5 } }), expect.anything()],
    });
  });

  it("updates live balances and retains them in the authoritative economy", () => {
    const { engine, players, dispatch, receive, reapplyEconomy } = setup();
    // Deliberately reverse the balance order and include zero to cover ID lookup and ?? fallback.
    receive(result([{ playerId: "b", money: 0 }, { playerId: "a", money: 1200 }]));
    expect(players.map((player) => player.money)).toEqual([1200, 0]);
    expect(engine.getRoundEarningsByPlayer()).toEqual({ a: 200, b: 0 });
    expect(dispatch).toHaveBeenCalledWith({ type: "SET_UI_PLAYERS", players });

    players[0].money = 7;
    players[1].money = 9;
    reapplyEconomy();
    expect(players.map((player) => player.money)).toEqual([1200, 0]);
  });

  it("preserves the previous authoritative balance for a player absent from balances", () => {
    const { players, receive, reapplyEconomy } = setup();
    receive(result([{ playerId: "a", money: 1200 }]));
    expect(players.map((player) => player.money)).toEqual([1200, 800]);

    players[0].money = 7;
    players[1].money = 9;
    reapplyEconomy();
    expect(players.map((player) => player.money)).toEqual([1200, 800]);
  });

  it("retains the last duplicate balance for both live and authoritative players", () => {
    const { players, receive, reapplyEconomy } = setup();
    receive(result([{ playerId: "a", money: 1100 }, { playerId: "a", money: 1200 }]));
    expect(players[0].money).toBe(1200);

    players[0].money = 7;
    reapplyEconomy();
    expect(players.map((player) => player.money)).toEqual([1200, 800]);
  });
});
