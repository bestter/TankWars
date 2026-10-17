import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine, type ResolvedShotPreview } from "../../../game/engine/GameEngine";
import { makePlayer } from "../../../game/__tests__/helpers";
import { isStrictOnlineMessage, type ShotEarningsAppliedMessage } from "../../../game/online/protocol";
import { createEmptyShopSession } from "../../gameCanvasReducer";
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
    const players = [makePlayer({ id: "a", money: 1000 }), makePlayer({ id: "b", money: 800 })];
    engine.getTankManager().setPlayers(players);
    const ws = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      onmessage: null,
    } as unknown as WebSocket;
    const dispatch = vi.fn();
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
      const preview: ResolvedShotPreview = {
        shotId: 2, awards: [], balances: [], damageDealtMilliByPlayer: {},
        hasEarnings: false, directHitVictimIds: [],
        roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
      };
      opts.submitShotEarningsRef.current(preview);
    };
    return { engine, players, dispatch, receive, reapplyEconomy };
  }

  function result(balances: ShotEarningsAppliedMessage["balances"]): ShotEarningsAppliedMessage {
    return {
      type: "SHOT_EARNINGS_APPLIED", shotId: 1, economicRevision: 1,
      roundEarningsByPlayer: { a: 200, b: 0 }, balances, awards: [],
      hasEarnings: true, blockDurationMs: 0,
      roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
    };
  }

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
