import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine, type ResolvedShotPreview } from "../../../game/engine/GameEngine";
import { makePlayer, makeRoundMap, makeTank } from "../../../game/__tests__/helpers";
import { fragmentCombat, type CombatSnapshot } from "../../../game/online/combatCatchUp";
import { isStrictOnlineMessage, type ShotEarningsAppliedMessage, type ShotMessage } from "../../../game/online/protocol";
import { createEmptyShopSession, gameCanvasReducer, INITIAL_STATE, type GameCanvasAction } from "../../gameCanvasReducer";
import { getHudWaitCauseKey, getTerrainCursor } from "../../combatWaitStatus";
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
    return { engine, players, dispatch, receive, reapplyEconomy, opts, send: vi.mocked(ws.send), handle };
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

  it.each(["before settlement", "after settlement", "in a catch-up"] as const)(
    "counts confirmed damage once and discards abandoned damage (confirmation %s)",
    (confirmation) => {
      const { engine, players, receive } = setup();
      engine.setLocalMatch(false);
      engine.getTankManager().setPlayers(structuredClone(players));
      const finalize = Reflect.get(engine, "finalizeActiveShot") as () => ResolvedShotPreview;
      const settleDamagingShot = (shotId: number, damage: number): void => {
        const [shooter, target] = engine.getTankManager().getPlayers();
        const { command, physicsSeed } = shot(shotId);
        expect(engine.fireProjectile(shooter.tank.position, command, shooter.id, {
          shotId, physicsSeed, isFirstShotOfRound: shotId === 1,
        })).toBe(true);
        const projectile = engine.getActiveProjectiles()[0];
        engine.getTankManager().applyExplosionDamage({
          explosionX: target.tank.position.x, explosionY: target.tank.position.y,
          radius: 80, maxDamage: damage, shooterId: shooter.id, weaponId: "MISSILE",
          isDirectHit: false, shotId, munitionId: projectile.munitionId,
        });
        expect(finalize.call(engine).damageDealtMilliByPlayer).toEqual({ a: damage * 1_000 });
        engine.getPhysicsEngine().clear(false);
      };

      const applied = result([{ playerId: "a", money: 1200 }, { playerId: "b", money: 800 }]);
      const committedPlayers = structuredClone(players);
      committedPlayers[1].tank.health = 80;
      if (confirmation === "before settlement") receive(applied);
      settleDamagingShot(1, 20);
      if (confirmation !== "before settlement") {
        expect(engine.buildRoundResult().damageDealt).toEqual({});
      }
      if (confirmation === "in a catch-up") {
        const snapshot = relaySnapshot(players, [shot(1)]);
        snapshot.activeShot = null;
        snapshot.activeShotId = null;
        snapshot.players = committedPlayers;
        const tm = engine.getTurnManager();
        vi.spyOn(tm, "executeRemoteFire").mockImplementationOnce(() => {});
        for (const part of fragmentCombat(snapshot, "confirmed")) receive(part);
        tm.onAuthoritativeShotSettled?.(1, "CATCH_UP");
      } else {
        receive(applied);
      }
      expect(engine.buildRoundResult().damageDealt).toEqual({ a: 20 });
      receive(applied);
      expect(engine.buildRoundResult().damageDealt).toEqual({ a: 20 });

      settleDamagingShot(2, 30);
      receive({ type: "ROUND_END", players: committedPlayers, roundNumber: 1, roundWinnerId: null, isDraw: true, abandonedShotId: 2 });
      expect(engine.buildRoundResult().damageDealt).toEqual({ a: 20 });
      expect(engine.getTankManager().getPlayers()[1].tank.health).toBe(80);
    },
  );

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
    const { engine, players, receive, opts, handle } = setup();
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
    expect(handle.isReceivingCatchUp()).toBe(false);
    expect(engine.getTurnManager().getCurrentTurnInfo()?.isCatchUp).toBe(false);
  });

  it("ignores stale COMBAT_CATCH_UP batches for completed rounds without locking TurnManager and acknowledges pending fires", () => {
    const { engine, players, dispatch, receive, opts, handle } = setup();
    const tm = engine.getTurnManager();
    const lockSpy = vi.spyOn(tm, "lockForCatchUp");
    opts.gamePhaseRef.current = "SHOP";
    opts.currentMancheRef.current = 2;
    opts.lastCompletedRoundNumberRef.current = 1;
    opts.pendingFireRef.current = { actionId: "shot-2", command: shot(2).command };

    const snapshot = relaySnapshot(players, [shot(1), shot(2)]);
    const parts = fragmentCombat(snapshot, "stale-shop-batch");
    // Omit COMBAT_CATCH_UP_END to confirm a truncated stale batch never leaves catch-up locked.
    for (const part of parts.slice(0, -1)) receive(part);

    expect(lockSpy).not.toHaveBeenCalled();
    expect(handle.isReceivingCatchUp()).toBe(false);
    expect(tm.getCurrentTurnInfo()?.isCatchUp).toBe(false);
    expect(opts.pendingFireRef.current).toBeNull();
    expect(dispatch).toHaveBeenCalledWith({ type: "SET_FIRE_PENDING", intent: null });
  });

  it("clears seenBatchIds on SHOP_FINISH so catch-up batch tracking stays bounded per round", () => {
    const { engine, players, receive, opts, handle } = setup();
    const tm = engine.getTurnManager();
    const lockSpy = vi.spyOn(tm, "lockForCatchUp");
    vi.mocked(opts.applyShopFinish).mockImplementation((nextPlayers, epoch, nextRound) => {
      engine.getTankManager().setPlayers(nextPlayers);
      opts.lastAppliedShopEpochRef.current = epoch;
      opts.currentMancheRef.current = nextRound;
      opts.gamePhaseRef.current = "COMBAT";
    });

    const round1Parts = fragmentCombat(relaySnapshot(players, [shot(1)]), "reused-id");
    receive(round1Parts[0]);
    expect(handle.isReceivingCatchUp()).toBe(true);
    expect(lockSpy).toHaveBeenCalledTimes(1);

    // A duplicate COMBAT_CATCH_UP_BEGIN in the same round is deduplicated by seenBatchIds.
    receive(round1Parts[0]);
    expect(lockSpy).toHaveBeenCalledTimes(1);
    for (const part of round1Parts.slice(1)) receive(part);

    receive({ type: "ROUND_END", players, roundNumber: 1, roundWinnerId: null, isDraw: true, abandonedShotId: 1 });
    expect(handle.isReceivingCatchUp()).toBe(false);
    receive({
      type: "SHOP_STATE", shopEpoch: 1, roundNumber: 1, players,
      readySlots: [], purchasesByPlayerId: {}, aiShopApplied: true,
    });
    receive({
      type: "SHOP_FINISH", shopEpoch: 1, completedRoundNumber: 1, nextRoundNumber: 2,
      map: makeRoundMap(2), players,
    });

    lockSpy.mockClear();
    const round2Snapshot = { ...relaySnapshot(players, [shot(2, 2, 1)]), map: makeRoundMap(2), roundNumber: 2 };
    const [beginRound2] = fragmentCombat(round2Snapshot, "reused-id");
    receive(beginRound2);
    expect(handle.isReceivingCatchUp()).toBe(true);
    expect(lockSpy).toHaveBeenCalled();
    for (const part of fragmentCombat(round2Snapshot, "round2-complete")) receive(part);
    expect(handle.isReceivingCatchUp()).toBe(false);
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

  it("does not re-display AI wait status when SHOT_EARNINGS_APPLIED arrives before STATE_UPDATE after reconnect", () => {
    const { engine, receive } = setup();
    const tm = engine.getTurnManager();
    tm.setLocalPlayerId("a");
    const reconnectPlayers = [
      makePlayer({ id: "a", isHuman: true, money: 1000 }),
      makePlayer({ id: "b", isHuman: false, money: 800, tank: makeTank("tank-2", 620, 300) }),
    ];
    const aiActiveShot: ShotMessage = {
      type: "SHOT",
      shotId: 1,
      roundNumber: 1,
      shotNumberInRound: 1,
      eventSequence: 1,
      physicsSeed: 1,
      isFirstShotOfRound: true,
      ownerId: "b",
      slot: 1,
      actionId: "ai-shot-1",
      command: { angle: 135, power: 50, weaponId: "MISSILE" },
    };
    const snapshot: CombatSnapshot = {
      ...relaySnapshot(reconnectPlayers, [aiActiveShot]),
      currentPlayerIndex: 1,
    };

    for (const part of fragmentCombat(snapshot, "reconnect-ai-active")) {
      receive(part);
    }

    // Active AI shot settles locally during catch-up before server earnings/turn messages arrive.
    engine.getPhysicsEngine().clear(false);
    Reflect.set(tm, "awaitingTankStabilization", true);
    tm.update(0.016);

    // 1. Deliver SHOT_EARNINGS_APPLIED first (before STATE_UPDATE).
    receive(result([{ playerId: "a", money: 1000 }, { playerId: "b", money: 800 }]));

    const infoAfterEarnings = tm.getCurrentTurnInfo();
    expect(infoAfterEarnings?.isCatchUp).toBe(false);
    expect(infoAfterEarnings?.isAwaitingServerTurn).toBe(true);
    expect(getHudWaitCauseKey(infoAfterEarnings, "online")).toBeNull();
    expect(
      getTerrainCursor({
        gameMode: "online",
        gamePhase: "COMBAT",
        turnInfo: infoAfterEarnings,
        advisorView: { status: "idle" },
        winner: null,
      }),
    ).toBe("crosshair");

    // 2. Deliver STATE_UPDATE separately to confirm turn advancement.
    receive({ type: "STATE_UPDATE", currentPlayerIndex: 0, roundEnded: false, players: reconnectPlayers });

    const infoAfterStateUpdate = tm.getCurrentTurnInfo();
    expect(infoAfterStateUpdate?.playerId).toBe("a");
    expect(infoAfterStateUpdate?.isAwaitingServerTurn).toBe(false);
    expect(getHudWaitCauseKey(infoAfterStateUpdate, "online")).toBeNull();
    expect(
      getTerrainCursor({
        gameMode: "online",
        gamePhase: "COMBAT",
        turnInfo: infoAfterStateUpdate,
        advisorView: { status: "idle" },
        winner: null,
      }),
    ).toBe("crosshair");
  });

  it("displays AI wait status for the next AI when SHOT_EARNINGS_APPLIED and STATE_UPDATE arrive during active recovery replay", () => {
    const { engine, receive } = setup();
    const tm = engine.getTurnManager();
    tm.setLocalPlayerId("a");
    const reconnectPlayers = [
      makePlayer({ id: "a", isHuman: true, money: 1000 }),
      makePlayer({ id: "b", isHuman: false, money: 800, tank: makeTank("tank-2", 420, 300) }),
      makePlayer({ id: "c", isHuman: false, money: 800, tank: makeTank("tank-3", 620, 300) }),
    ];
    const ai1ActiveShot: ShotMessage = {
      type: "SHOT",
      shotId: 1,
      roundNumber: 1,
      shotNumberInRound: 1,
      eventSequence: 1,
      physicsSeed: 1,
      isFirstShotOfRound: true,
      ownerId: "b",
      slot: 1,
      actionId: "ai-shot-1",
      command: { angle: 135, power: 50, weaponId: "MISSILE" },
    };
    const snapshot: CombatSnapshot = {
      ...relaySnapshot(reconnectPlayers, [ai1ActiveShot]),
      currentPlayerIndex: 1,
      roundEarningsByPlayer: { a: 0, b: 0, c: 0 },
      zeus: {
        type: "ZEUS_STATE",
        activeZeusId: null,
        currentPlayerIndex: 1,
        rotationSlots: [],
        deadSlots: [false, false, false],
        activeStrike: null,
        lastAppliedStrikeId: 0,
      },
    };

    for (const part of fragmentCombat(snapshot, "reconnect-ai-to-ai")) {
      receive(part);
    }

    // Both SHOT_EARNINGS_APPLIED and STATE_UPDATE (advancing to AI-2 at slot 2) arrive while AI-1's recovered shot is still replaying.
    receive({
      ...result([
        { playerId: "a", money: 1000 },
        { playerId: "b", money: 1000 },
        { playerId: "c", money: 800 },
      ]),
      roundEarningsByPlayer: { a: 0, b: 200, c: 0 },
    });
    receive({
      type: "STATE_UPDATE",
      roundNumber: 1,
      eventSequence: 1,
      economicRevision: 2,
      currentPlayerIndex: 2,
      roundEnded: false,
      players: reconnectPlayers,
    });

    // Now finish the local replay of the recovered shot.
    engine.getPhysicsEngine().clear(false);
    Reflect.set(tm, "awaitingTankStabilization", true);
    tm.update(0.016);

    const infoAfterUnlock = tm.getCurrentTurnInfo();
    expect(infoAfterUnlock?.playerId).toBe("c");
    expect(infoAfterUnlock?.isHuman).toBe(false);
    expect(infoAfterUnlock?.isCatchUp).toBe(false);
    expect(infoAfterUnlock?.isAwaitingServerTurn).toBe(false);
    expect(getHudWaitCauseKey(infoAfterUnlock, "online")).toBe("status_ai_waiting");
    expect(
      getTerrainCursor({
        gameMode: "online",
        gamePhase: "COMBAT",
        turnInfo: infoAfterUnlock,
        advisorView: { status: "idle" },
        winner: null,
      }),
    ).toBe("wait");
  });

  it("hides AI wait status until STATE_UPDATE confirms the next AI after active recovery replay", () => {
    const { engine, receive } = setup();
    const tm = engine.getTurnManager();
    tm.setLocalPlayerId("a");
    const reconnectPlayers = [
      makePlayer({ id: "a", isHuman: true, money: 1000 }),
      makePlayer({ id: "b", isHuman: false, money: 800, tank: makeTank("tank-2", 420, 300) }),
      makePlayer({ id: "c", isHuman: false, money: 800, tank: makeTank("tank-3", 620, 300) }),
    ];
    const ai1ActiveShot: ShotMessage = {
      type: "SHOT",
      shotId: 1,
      roundNumber: 1,
      shotNumberInRound: 1,
      eventSequence: 1,
      physicsSeed: 1,
      isFirstShotOfRound: true,
      ownerId: "b",
      slot: 1,
      actionId: "ai-shot-1",
      command: { angle: 135, power: 50, weaponId: "MISSILE" },
    };
    const snapshot: CombatSnapshot = {
      ...relaySnapshot(reconnectPlayers, [ai1ActiveShot]),
      currentPlayerIndex: 1,
      roundEarningsByPlayer: { a: 0, b: 0, c: 0 },
      zeus: {
        type: "ZEUS_STATE",
        activeZeusId: null,
        currentPlayerIndex: 1,
        rotationSlots: [],
        deadSlots: [false, false, false],
        activeStrike: null,
        lastAppliedStrikeId: 0,
      },
    };

    for (const part of fragmentCombat(snapshot, "reconnect-ai-to-ai-after-replay")) {
      receive(part);
    }

    // Finish local replay of AI-1 before SHOT_EARNINGS_APPLIED or STATE_UPDATE arrive.
    engine.getPhysicsEngine().clear(false);
    Reflect.set(tm, "awaitingTankStabilization", true);
    tm.update(0.016);

    // 1. SHOT_EARNINGS_APPLIED arrives alone while the snapshot still points to AI-1 (slot 1).
    receive({
      ...result([
        { playerId: "a", money: 1000 },
        { playerId: "b", money: 1000 },
        { playerId: "c", money: 800 },
      ]),
      roundEarningsByPlayer: { a: 0, b: 200, c: 0 },
    });

    const infoAfterEarnings = tm.getCurrentTurnInfo();
    expect(infoAfterEarnings?.playerId).toBe("b");
    expect(infoAfterEarnings?.isCatchUp).toBe(false);
    expect(infoAfterEarnings?.isAwaitingServerTurn).toBe(true);
    expect(getHudWaitCauseKey(infoAfterEarnings, "online")).toBeNull();
    expect(
      getTerrainCursor({
        gameMode: "online",
        gamePhase: "COMBAT",
        turnInfo: infoAfterEarnings,
        advisorView: { status: "idle" },
        winner: null,
      }),
    ).toBe("crosshair");

    // 2. Server STATE_UPDATE confirms AI-2 (slot 2) after the replay.
    receive({
      type: "STATE_UPDATE",
      roundNumber: 1,
      eventSequence: 1,
      economicRevision: 2,
      currentPlayerIndex: 2,
      roundEnded: false,
      players: reconnectPlayers,
    });

    const infoAfterStateUpdate = tm.getCurrentTurnInfo();
    expect(infoAfterStateUpdate?.playerId).toBe("c");
    expect(infoAfterStateUpdate?.isHuman).toBe(false);
    expect(infoAfterStateUpdate?.isCatchUp).toBe(false);
    expect(infoAfterStateUpdate?.isAwaitingServerTurn).toBe(false);
    expect(getHudWaitCauseKey(infoAfterStateUpdate, "online")).toBe("status_ai_waiting");
    expect(
      getTerrainCursor({
        gameMode: "online",
        gamePhase: "COMBAT",
        turnInfo: infoAfterStateUpdate,
        advisorView: { status: "idle" },
        winner: null,
      }),
    ).toBe("wait");
  });

  it("unlocks local human controls when human -> AI -> same human completes during catch-up and the intermediate STATE_UPDATE is dropped as stale", () => {
    const { engine, receive, send } = setup();
    const tm = engine.getTurnManager();
    tm.setLocalPlayerId("a");
    const syncTurnSpy = vi.spyOn(tm, "syncTurn");
    const reconnectPlayers = [
      makePlayer({ id: "a", isHuman: true, money: 1000 }),
      makePlayer({ id: "b", isHuman: false, money: 800, tank: makeTank("tank-2", 620, 300) }),
    ];
    const humanActiveShot = shot(1, 1, 1);
    const snapshot: CombatSnapshot = {
      ...relaySnapshot(reconnectPlayers, [humanActiveShot]),
      currentPlayerIndex: 0,
    };

    for (const part of fragmentCombat(snapshot, "reconnect-human-ai-human")) {
      receive(part);
    }

    // While the local human's recovered shot #1 is still replaying, the server settles #1,
    // plays AI shot #2, and advances the turn back to slot 0 (human).
    receive({
      ...result([
        { playerId: "a", money: 1200 },
        { playerId: "b", money: 800 },
      ]),
      shotId: 1,
      economicRevision: 2,
    });
    receive({
      type: "STATE_UPDATE",
      roundNumber: 1,
      eventSequence: 1,
      economicRevision: 2,
      currentPlayerIndex: 1,
      roundEnded: false,
      players: reconnectPlayers,
    });
    receive({
      type: "SHOT",
      shotId: 2,
      roundNumber: 1,
      shotNumberInRound: 2,
      eventSequence: 2,
      physicsSeed: 2,
      isFirstShotOfRound: false,
      ownerId: "b",
      slot: 1,
      actionId: "ai-shot-2",
      command: { angle: 135, power: 50, weaponId: "MISSILE" },
    });
    receive({
      ...result([
        { playerId: "a", money: 1200 },
        { playerId: "b", money: 1000 },
      ]),
      shotId: 2,
      economicRevision: 3,
      roundEarningsByPlayer: { a: 200, b: 200 },
    });
    receive({
      type: "STATE_UPDATE",
      roundNumber: 1,
      eventSequence: 2,
      economicRevision: 3,
      currentPlayerIndex: 0,
      roundEnded: false,
      players: reconnectPlayers,
    });

    // Settle recovered human shot #1, triggering queued AI shot #2.
    engine.getPhysicsEngine().clear(false);
    Reflect.set(tm, "awaitingTankStabilization", true);
    tm.update(0.016);

    // Settle AI shot #2, advancing processedEventSequence to 2 and flushing deferredControl.
    // The intermediate STATE_UPDATE (eventSequence: 1, slot: 1) is ignored as stale.
    engine.getPhysicsEngine().clear(false);
    Reflect.set(tm, "awaitingTankStabilization", true);
    tm.update(0.016);

    expect(syncTurnSpy).toHaveBeenCalledTimes(1);
    expect(syncTurnSpy).toHaveBeenCalledWith(0, { eventSequence: 2 });

    const infoAfterCatchUp = tm.getCurrentTurnInfo();
    expect(infoAfterCatchUp?.playerId).toBe("a");
    expect(infoAfterCatchUp?.isCatchUp).toBe(false);
    expect(infoAfterCatchUp?.isAwaitingServerTurn).toBe(false);
    expect(infoAfterCatchUp?.isInputLocked).toBe(false);
    expect(tm.isAwaitingServerTurnAfterLocalShot()).toBe(false);
    expect(getHudWaitCauseKey(infoAfterCatchUp, "online")).toBeNull();
    expect(
      getTerrainCursor({
        gameMode: "online",
        gamePhase: "COMBAT",
        turnInfo: infoAfterCatchUp,
        advisorView: { status: "idle" },
        winner: null,
      }),
    ).toBe("crosshair");

    send.mockClear();
    expect(tm.tryFire()).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0][0] as string)).toMatchObject({
      type: "FIRE",
    });
  });

  it("keeps local human controls locked while the snapshot repeats the initial shot without server advancement", () => {
    const { engine, receive, send } = setup();
    const tm = engine.getTurnManager();
    tm.setLocalPlayerId("a");
    const reconnectPlayers = [
      makePlayer({ id: "a", isHuman: true, money: 1000 }),
      makePlayer({ id: "b", isHuman: false, money: 800, tank: makeTank("tank-2", 620, 300) }),
    ];
    const humanActiveShot = shot(1, 1, 1);
    const snapshot: CombatSnapshot = {
      ...relaySnapshot(reconnectPlayers, [humanActiveShot]),
      currentPlayerIndex: 0,
    };

    for (const part of fragmentCombat(snapshot, "reconnect-human-repeats-shot")) {
      receive(part);
    }

    // Settle recovered shot #1 locally before server advancement arrives;
    // onIdle applies snapshotPending (slot 0, eventSequence 1).
    engine.getPhysicsEngine().clear(false);
    Reflect.set(tm, "awaitingTankStabilization", true);
    tm.update(0.016);

    // SHOT_EARNINGS_APPLIED unlocks catchUpLocked, but server has not advanced the turn yet.
    receive({
      ...result([
        { playerId: "a", money: 1200 },
        { playerId: "b", money: 800 },
      ]),
      shotId: 1,
      economicRevision: 2,
    });

    send.mockClear();
    expect(tm.getCurrentTurnInfo()?.isCatchUp).toBe(false);
    expect(tm.getCurrentTurnInfo()?.isAwaitingServerTurn).toBe(true);
    expect(tm.isAwaitingServerTurnAfterLocalShot()).toBe(true);
    expect(tm.getCurrentTurnInfo()?.isInputLocked).toBe(true);
    expect(tm.tryFire()).toBe(false);
    expect(send).not.toHaveBeenCalled();

    // A STATE_UPDATE repeating the initial turn at the same sequence must still keep controls locked.
    receive({
      type: "STATE_UPDATE",
      roundNumber: 1,
      eventSequence: 1,
      economicRevision: 2,
      currentPlayerIndex: 0,
      roundEnded: false,
      players: reconnectPlayers,
    });

    expect(tm.isAwaitingServerTurnAfterLocalShot()).toBe(true);
    expect(tm.getCurrentTurnInfo()?.isInputLocked).toBe(true);
    expect(tm.tryFire()).toBe(false);
    expect(send).not.toHaveBeenCalled();

    // Once the server advances to AI slot 1, the local shot wait clears.
    receive({
      type: "STATE_UPDATE",
      roundNumber: 1,
      eventSequence: 1,
      economicRevision: 2,
      currentPlayerIndex: 1,
      roundEnded: false,
      players: reconnectPlayers,
    });

    const infoOnAiTurn = tm.getCurrentTurnInfo();
    expect(tm.isAwaitingServerTurnAfterLocalShot()).toBe(false);
    expect(infoOnAiTurn?.playerId).toBe("b");
    expect(infoOnAiTurn?.isAwaitingServerTurn).toBe(false);
    expect(getHudWaitCauseKey(infoOnAiTurn, "online")).toBe("status_ai_waiting");
  });
});
