import type { Dispatch, MutableRefObject } from "react";
import type { GameEngine } from "../../game/engine/GameEngine";
import { seedFromRoomRound, setRNG, createSeededRNG } from "../../utils/random";
import { trackEvent } from "../../utils/analytics";
import type { GamePhase } from "../../types/game";
import type { Player } from "../../types/player";
import type { ShopEnterMessage } from "../../game/online/protocol";
import { normalizeRosterAtShopOpen } from "../../game/shop/shopTransaction";
import {
  INITIAL_STATE,
  type GameCanvasAction,
  type ShopClientSessionState,
} from "../gameCanvasReducer";
import {
  processNextShopperIfAI,
  type LocalHotseatShopHost,
} from "./localHotseatShop";

export interface CompleteShopRoundHost {
  readonly gameMode: "local" | "online";
  readonly roomId?: string;
  readonly localPlayerId?: string;
  readonly engineRef: MutableRefObject<GameEngine | null>;
  readonly shopFinishingRef: MutableRefObject<boolean>;
  readonly lastAppliedShopEpochRef: MutableRefObject<number>;
  readonly lastCompletedRoundNumberRef: MutableRefObject<number>;
  readonly gamePhaseRef: MutableRefObject<GamePhase>;
  readonly shopPlayersRef: MutableRefObject<Player[]>;
  readonly pendingShopFinishRef: MutableRefObject<{
    players: Player[];
    shopEpoch: number;
    nextRoundNumber: number;
  } | null>;
  readonly localShopDoneRef: MutableRefObject<boolean>;
  readonly currentMancheRef: MutableRefObject<number>;
  readonly currentShopIndexRef: MutableRefObject<number>;
  readonly shopSessionRef: MutableRefObject<ShopClientSessionState>;
  readonly shopAiTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  readonly dispatch: Dispatch<GameCanvasAction>;
  readonly clearShopAiTimeout: () => void;
  readonly clearCelebrationTimer: () => void;
  readonly setLocalShopDone: (done: boolean) => void;
  readonly sendCombatMessage: (message: object) => void;
}

export function hotseatHostFrom(
  host: CompleteShopRoundHost,
): LocalHotseatShopHost {
  return {
    gameMode: host.gameMode,
    engineRef: host.engineRef,
    shopPlayersRef: host.shopPlayersRef,
    currentShopIndexRef: host.currentShopIndexRef,
    shopSessionRef: host.shopSessionRef,
    shopFinishingRef: host.shopFinishingRef,
    gamePhaseRef: host.gamePhaseRef,
    shopAiTimeoutRef: host.shopAiTimeoutRef,
    dispatch: host.dispatch,
    clearShopAiTimeout: host.clearShopAiTimeout,
    finishShopPhase: () => {
      finishShopPhase(host);
    },
  };
}

export function endMatchFromShop(
  host: CompleteShopRoundHost,
  engine: GameEngine,
  survivors: Player[],
): void {
  host.clearShopAiTimeout();
  host.shopFinishingRef.current = true;
  engine.getTurnManager().pauseForInterRound();

  let matchWinner: Player | null = null;
  if (survivors.length === 1) {
    const winner = engine.getTankManager().getWinner();
    if (winner) {
      engine.declareMatchWinner(winner);
      matchWinner = winner;
    }
  } else if (!engine.isGameOver()) {
    engine.declareMatchDraw();
  }

  host.dispatch({ type: "END_MATCH_FROM_SHOP", winner: matchWinner });

  const winnerType = matchWinner
    ? matchWinner.isHuman
      ? "human"
      : "ai"
    : "draw";
  const winnerProfile =
    matchWinner && !matchWinner.isHuman
      ? (matchWinner.aiProfile ?? "v1-random")
      : undefined;

  trackEvent("game_over", {
    winnerId: matchWinner ? matchWinner.id : null,
    winnerType,
    winnerProfile,
    totalRounds: host.currentMancheRef.current,
  });

  setTimeout(
    () => host.dispatch({ type: "SHOW_NEW_GAME_BUTTON", show: true }),
    7000,
  );
  host.shopFinishingRef.current = false;
}

export function finishShopPhase(
  host: CompleteShopRoundHost,
  finalPlayers?: Player[],
  shopEpoch?: number,
  nextRoundNumber?: number,
): void {
  if (host.shopFinishingRef.current) return;
  if (
    shopEpoch !== undefined &&
    shopEpoch <= host.lastAppliedShopEpochRef.current
  ) {
    return;
  }
  if (
    host.gamePhaseRef.current === "COMBAT" &&
    host.shopPlayersRef.current.length === 0
  ) {
    return;
  }

  const engine = host.engineRef.current;
  if (!engine) return;

  host.shopFinishingRef.current = true;
  host.clearShopAiTimeout();
  host.pendingShopFinishRef.current = null;
  host.localShopDoneRef.current = false;
  host.setLocalShopDone(false);

  if (finalPlayers && finalPlayers.length >= 2) {
    engine.getTankManager().setPlayers(finalPlayers);
    host.shopPlayersRef.current = finalPlayers;
  }

  if (nextRoundNumber !== undefined) {
    host.currentMancheRef.current = Math.max(
      host.currentMancheRef.current,
      nextRoundNumber,
    );
  }

  if (host.gameMode === "online" && host.roomId) {
    setRNG(
      createSeededRNG(seedFromRoomRound(host.roomId, host.currentMancheRef.current)),
    );
  }

  const tm = engine.getTurnManager();
  const roster = engine.getTankManager().getPlayers();

  if (roster.length < 2) {
    host.shopFinishingRef.current = false;
    endMatchFromShop(host, engine, [...roster]);
    return;
  }

  const started = engine.startNextRound();
  engine.setRoundNumber(host.currentMancheRef.current);
  if (!started) {
    host.shopFinishingRef.current = false;
    endMatchFromShop(host, engine, [...roster]);
    return;
  }

  tm.resumeForCombat();
  if (host.gameMode === "online") tm.syncTurn(0);

  const nextPlayers = [...engine.getTankManager().getPlayers()];
  const completedShopEpoch =
    shopEpoch ??
    (host.gameMode !== "online"
      ? (host.shopSessionRef.current.epoch ?? undefined)
      : undefined);
  if (completedShopEpoch !== undefined) {
    host.lastAppliedShopEpochRef.current = Math.max(
      host.lastAppliedShopEpochRef.current,
      completedShopEpoch,
    );
  }
  host.dispatch({
    type: "FINISH_SHOP",
    uiPlayers: nextPlayers,
    shopEpoch: completedShopEpoch,
    nextRoundNumber,
  });
  host.gamePhaseRef.current = "COMBAT";
  host.shopPlayersRef.current = [];
  host.currentShopIndexRef.current = 0;

  host.clearCelebrationTimer();
  host.shopFinishingRef.current = false;
}

export function startShopPhase(host: CompleteShopRoundHost): void {
  const engine = host.engineRef.current;
  if (!engine) return;

  host.clearShopAiTimeout();
  host.shopFinishingRef.current = false;
  host.localShopDoneRef.current = false;
  host.setLocalShopDone(false);
  engine.getTurnManager().pauseForInterRound();

  let roster = [...engine.getTankManager().getPlayers()];
  if (roster.length < 2) {
    endMatchFromShop(host, engine, roster);
    return;
  }

  const completedRoundNumber =
    host.gameMode === "online"
      ? host.lastCompletedRoundNumberRef.current
      : Math.max(1, host.currentMancheRef.current - 1);

  if (host.gameMode !== "online") {
    roster = normalizeRosterAtShopOpen(roster);
    engine.getTankManager().setPlayers(roster);
  }

  host.dispatch({
    type: "START_SHOP",
    roster,
    mode: host.gameMode,
    completedRoundNumber,
  });
  const nextShopEpoch =
    host.gameMode === "online" ? null : host.lastAppliedShopEpochRef.current + 1;
  host.shopSessionRef.current = {
    ...INITIAL_STATE.shopSession,
    epoch: nextShopEpoch,
    roundNumber: completedRoundNumber,
    authoritativeReceived: host.gameMode !== "online",
  };
  host.shopPlayersRef.current = roster;
  host.currentShopIndexRef.current = 0;
  host.gamePhaseRef.current = "SHOP";

  const pendingFinish = host.pendingShopFinishRef.current;
  if (pendingFinish !== null) {
    host.pendingShopFinishRef.current = null;
    finishShopPhase(
      host,
      pendingFinish.players,
      pendingFinish.shopEpoch,
      pendingFinish.nextRoundNumber,
    );
    return;
  }

  if (host.gameMode === "online") {
    const message: ShopEnterMessage = {
      type: "SHOP_ENTER",
      roundNumber: completedRoundNumber,
    };
    host.sendCombatMessage(message);
    return;
  }

  if (!roster[0]?.isHuman) {
    host.shopAiTimeoutRef.current = setTimeout(() => {
      host.shopAiTimeoutRef.current = null;
      processNextShopperIfAI(hotseatHostFrom(host));
    }, 50);
  }
}

export function applyAuthoritativeShopFinish(
  host: CompleteShopRoundHost,
  finalPlayers: Player[],
  shopEpoch: number,
  nextRoundNumber: number,
): void {
  if (host.shopFinishingRef.current) return;
  if (shopEpoch <= host.lastAppliedShopEpochRef.current) return;

  const phase = host.gamePhaseRef.current;
  if (phase !== "SHOP") {
    host.lastCompletedRoundNumberRef.current = Math.max(
      host.lastCompletedRoundNumberRef.current,
      nextRoundNumber - 1,
    );
    host.currentMancheRef.current = Math.max(
      host.currentMancheRef.current,
      nextRoundNumber,
    );
    host.pendingShopFinishRef.current = {
      players: finalPlayers,
      shopEpoch,
      nextRoundNumber,
    };
    if (phase === "CELEBRATION") {
      host.clearCelebrationTimer();
      host.engineRef.current?.clearRoundCelebration();
    }
    if (phase === "COMBAT" || phase === "CELEBRATION") {
      host.dispatch({ type: "GO_TO_SUMMARY" });
      host.gamePhaseRef.current = "SUMMARY";
    }
    if (phase === "COMBAT" || phase === "CELEBRATION" || phase === "SUMMARY") {
      startShopPhase(host);
    }
    return;
  }
  finishShopPhase(host, finalPlayers, shopEpoch, nextRoundNumber);
}
