import { describe, expect, it, vi } from "vitest";
import type { GameEngine, ResolvedShotPreview } from "../../game/engine/GameEngine";
import type { CurrentTurnInfo } from "../../game/engine/TurnManager";
import type { ZeusStrikeResult } from "../../game/zeus/zeusDomain";
import { makePlayer, makeTank } from "../../game/__tests__/helpers";
import { VGA_PALETTE } from "../../types/game";
import type { GamePhase } from "../../types/game";
import { copyLivingPlayerStatus } from "../playerStatus";
import { wireEngineSessionCallbacks } from "../wireEngineSession";

function turn(overrides: Partial<CurrentTurnInfo> = {}): CurrentTurnInfo {
  return {
    playerName: "Alice",
    playerId: "alive",
    isHuman: true,
    playerColor: VGA_PALETTE.RED,
    angle: 12,
    power: 40,
    currentWeapon: "MISSILE",
    inventory: { MISSILE: 99 },
    turn: 2,
    isInputLocked: false,
    tanksAreFalling: false,
    ...overrides,
  };
}

function wire(gamePhase: GamePhase) {
  const roster = [
    makePlayer({
      id: "alive",
      name: "Alice",
      tank: makeTank("t1", 1, 2, { health: 90, shield: 10, maxShield: 40 }),
      inventory: { GRENADE: 2, NUKE: 1 },
    }),
    makePlayer({
      id: "dead",
      tank: makeTank("t2", 3, 4, { isDead: true, health: 20 }),
    }),
  ];
  const dispatch = vi.fn();
  const engine: {
    getTurnManager: () => { pauseForInterRound: ReturnType<typeof vi.fn> };
    getTankManager: () => { getPlayers: () => typeof roster };
    onTurnHudUpdate?: (info: CurrentTurnInfo) => void;
  } = {
    getTurnManager: () => ({ pauseForInterRound: vi.fn() }),
    getTankManager: () => ({ getPlayers: () => roster }),
  };
  wireEngineSessionCallbacks({
    engine: engine as unknown as GameEngine,
    dispatch,
    gameMode: "local",
    sendCombatMessage: () => {},
    combatActiveShotId: () => null,
    gamePhaseRef: { current: gamePhase },
    currentMancheRef: { current: 1 },
    lastCompletedRoundNumberRef: { current: 0 },
    lastZeusAppointmentIdRef: { current: 0 },
    lastAppliedZeusStrikeIdRef: { current: 0 },
    zeusAnnouncementTimerRef: { current: null },
    celebrationTimerRef: { current: null },
    pendingShotPreviewsRef: { current: new Map() },
    submitShotEarningsRef: { current: () => {} },
    roundEndFromNetworkRef: { current: false },
    clearZeusAnnouncement: () => {},
    clearCelebrationTimer: () => {},
    goToSummary: () => {},
  });
  if (!engine.onTurnHudUpdate) throw new Error("HUD callback was not wired");
  return { dispatch, roster, notify: engine.onTurnHudUpdate };
}

describe("HUD player status publication", () => {
  it("publishes a living copy from the tank manager during an open aim", () => {
    const { dispatch, roster, notify } = wire("COMBAT");
    const info = turn({ angle: 80, power: 15 });
    notify(info);
    expect(dispatch).toHaveBeenNthCalledWith(1, { type: "SET_TURN_INFO", info });
    expect(dispatch).toHaveBeenNthCalledWith(2, {
      type: "SET_PLAYER_STATUS",
      players: copyLivingPlayerStatus(roster),
    });
    expect(dispatch.mock.calls.some((call) => call[0].type === "SET_UI_PLAYERS")).toBe(false);
  });

  it("clears the copy when the aim gate is closed", () => {
    const locked = wire("COMBAT");
    locked.notify(turn({ isInputLocked: true }));
    expect(locked.dispatch).toHaveBeenLastCalledWith({ type: "SET_PLAYER_STATUS", players: null });

    const shop = wire("SHOP");
    shop.notify(turn());
    expect(shop.dispatch).toHaveBeenLastCalledWith({ type: "SET_PLAYER_STATUS", players: null });
  });
});

function zeusStrike(targetId: string): ZeusStrikeResult {
  return {
    strikeId: 1,
    zeusId: "alive",
    targetId,
    award: { playerId: "alive", amount: 0 },
    balances: [],
    roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
  };
}

function wireZeus(gameMode: "local" | "online") {
  const roster = [
    makePlayer({ id: "alive", tank: makeTank("t1", 1, 2) }),
    makePlayer({
      id: "vaporized",
      tank: makeTank("t2", 3, 4, { isDead: true, health: 0 }),
    }),
  ];
  const releaseDeadTargets = vi.fn();
  const dispatch = vi.fn();
  const engine: {
    getTurnManager: () => { pauseForInterRound: ReturnType<typeof vi.fn> };
    getTankManager: () => { getPlayers: () => typeof roster };
    onZeusStrikeApplied?: (result: ZeusStrikeResult) => void;
  } = {
    getTurnManager: () => ({ pauseForInterRound: vi.fn() }),
    getTankManager: () => ({ getPlayers: () => roster }),
  };
  wireEngineSessionCallbacks({
    engine: engine as unknown as GameEngine,
    dispatch,
    gameMode,
    sendCombatMessage: () => {},
    combatActiveShotId: () => null,
    gamePhaseRef: { current: "COMBAT" },
    currentMancheRef: { current: 1 },
    lastCompletedRoundNumberRef: { current: 0 },
    lastZeusAppointmentIdRef: { current: 0 },
    lastAppliedZeusStrikeIdRef: { current: 0 },
    zeusAnnouncementTimerRef: { current: null },
    celebrationTimerRef: { current: null },
    pendingShotPreviewsRef: { current: new Map() },
    submitShotEarningsRef: { current: () => {} },
    roundEndFromNetworkRef: { current: false },
    clearZeusAnnouncement: () => {},
    clearCelebrationTimer: () => {},
    goToSummary: () => {},
    releaseDeadTargets,
  });
  if (!engine.onZeusStrikeApplied) throw new Error("Zeus callback was not wired");
  return { dispatch, roster, releaseDeadTargets, strike: engine.onZeusStrikeApplied };
}

describe("Zeus lock release", () => {
  it("releases local locks when Zeus eliminates a tank without ending the round", () => {
    const wired = wireZeus("local");
    wired.strike(zeusStrike("vaporized"));
    expect(wired.releaseDeadTargets).toHaveBeenCalledExactlyOnceWith(["vaporized"]);
    expect(wired.dispatch).toHaveBeenCalledWith({ type: "SET_UI_PLAYERS", players: wired.roster });
  });

  it("does not release locks on an online Zeus strike", () => {
    const wired = wireZeus("online");
    wired.strike(zeusStrike("vaporized"));
    expect(wired.releaseDeadTargets).not.toHaveBeenCalled();
    expect(wired.dispatch).toHaveBeenCalledWith({ type: "SET_UI_PLAYERS", players: wired.roster });
  });
});

function shotPreview(): ResolvedShotPreview {
  return {
    shotId: 1,
    awards: [],
    damageDealtMilliByPlayer: {},
    hasEarnings: false,
    roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
    balances: [],
    directHitVictimIds: [],
  };
}

function wireShot(gameMode: "local" | "online") {
  const roster = [
    makePlayer({ id: "alive", tank: makeTank("t1", 1, 2) }),
    makePlayer({
      id: "vaporized",
      tank: makeTank("t2", 3, 4, { isDead: true, health: 0 }),
    }),
  ];
  const releaseDeadTargets = vi.fn();
  const dispatch = vi.fn();
  const engine: {
    getTurnManager: () => { pauseForInterRound: ReturnType<typeof vi.fn> };
    getTankManager: () => { getPlayers: () => typeof roster };
    onShotResolved?: (preview: ResolvedShotPreview) => void;
  } = {
    getTurnManager: () => ({ pauseForInterRound: vi.fn() }),
    getTankManager: () => ({ getPlayers: () => roster }),
  };
  wireEngineSessionCallbacks({
    engine: engine as unknown as GameEngine,
    dispatch,
    gameMode,
    sendCombatMessage: () => {},
    combatActiveShotId: () => null,
    gamePhaseRef: { current: "COMBAT" },
    currentMancheRef: { current: 1 },
    lastCompletedRoundNumberRef: { current: 0 },
    lastZeusAppointmentIdRef: { current: 0 },
    lastAppliedZeusStrikeIdRef: { current: 0 },
    zeusAnnouncementTimerRef: { current: null },
    celebrationTimerRef: { current: null },
    pendingShotPreviewsRef: { current: new Map() },
    submitShotEarningsRef: { current: () => {} },
    roundEndFromNetworkRef: { current: false },
    clearZeusAnnouncement: () => {},
    clearCelebrationTimer: () => {},
    goToSummary: () => {},
    releaseDeadTargets,
  });
  if (!engine.onShotResolved) throw new Error("Shot callback was not wired");
  return { dispatch, roster, releaseDeadTargets, resolve: engine.onShotResolved };
}

describe("onShotResolved lock release", () => {
  it("releases local locks when a resolved shot eliminates a tank", () => {
    const wired = wireShot("local");
    wired.resolve(shotPreview());
    expect(wired.releaseDeadTargets).toHaveBeenCalledExactlyOnceWith(["vaporized"]);
    expect(wired.dispatch).toHaveBeenCalledWith({ type: "SET_UI_PLAYERS", players: wired.roster });
  });

  it("does not release locks on an online resolved shot", () => {
    const wired = wireShot("online");
    wired.resolve(shotPreview());
    expect(wired.releaseDeadTargets).not.toHaveBeenCalled();
  });
});
