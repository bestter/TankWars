import type { Dispatch, MutableRefObject } from "react";
import type { GameEngine, ResolvedShotPreview } from "../game/engine/GameEngine";
import type { CurrentTurnInfo } from "../game/engine/TurnManager";
import { trackEvent } from "../utils/analytics";
import type { GamePhase } from "../types/game";
import type { ZeusAppointment, ZeusStrikeResult } from "../game/zeus/zeusDomain";
import { ZEUS_ANNOUNCEMENT_DURATION_MS, type GameCanvasAction } from "./gameCanvasReducer";
import { buildOverlayAwards } from "./sessionPresentation";

export function wireEngineSessionCallbacks(opts: {
  readonly engine: GameEngine;
  readonly dispatch: Dispatch<GameCanvasAction>;
  readonly gameMode: "local" | "online";
  readonly localPlayerId?: string;
  readonly slot?: number;
  readonly sendCombatMessage: (message: object) => void;
  readonly combatActiveShotId: () => number | null;
  readonly gamePhaseRef: MutableRefObject<GamePhase>;
  readonly currentMancheRef: MutableRefObject<number>;
  readonly lastCompletedRoundNumberRef: MutableRefObject<number>;
  readonly lastZeusAppointmentIdRef: MutableRefObject<number>;
  readonly lastAppliedZeusStrikeIdRef: MutableRefObject<number>;
  readonly zeusAnnouncementTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  readonly celebrationTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  readonly pendingShotPreviewsRef: MutableRefObject<Map<number, ResolvedShotPreview>>;
  readonly submitShotEarningsRef: MutableRefObject<(preview: ResolvedShotPreview) => void>;
  readonly roundEndFromNetworkRef: MutableRefObject<boolean>;
  readonly clearZeusAnnouncement: () => void;
  readonly clearCelebrationTimer: () => void;
  readonly goToSummary: () => void;
}): void {
  const { engine, dispatch } = opts;
  const tm = engine.getTurnManager();

  engine.onWindChange = (wind) => dispatch({ type: "SET_WIND", wind });

  tm.onShotSettled = () => {
    console.log(
      `[Game] onShotSettled callback triggered. gameMode=${opts.gameMode}, localPlayerId=${opts.localPlayerId}`,
    );
    if (opts.gameMode !== "online" || !opts.localPlayerId) return;
    const currentPlayer = tm.getCurrentPlayer();
    console.log(
      `[Game] onShotSettled: currentPlayer.id=${currentPlayer?.id}, localPlayerId=${opts.localPlayerId}`,
    );
    const shouldNotify =
      (currentPlayer && currentPlayer.id === opts.localPlayerId) ||
      tm.isAwaitingServerTurnAfterLocalShot();
    if (!shouldNotify) return;
    console.log("[Game] Sending SHOT_SETTLED to server");
    const deadSlots = engine
      .getTankManager()
      .getPlayers()
      .map((player) => Boolean(player.tank.isDead));
    const shotId = opts.combatActiveShotId();
    if (shotId !== null) {
      opts.sendCombatMessage({
        type: "SHOT_SETTLED",
        shotId,
        slot: opts.slot,
        deadSlots,
      });
    }
  };

  engine.onProjectileHit = (hit) => {
    console.log("[GameEngine] Hit:", hit.weaponId, "at", "(coordinates redacted)");
  };

  engine.onTurnHudUpdate = (info: CurrentTurnInfo) => {
    dispatch({ type: "SET_TURN_INFO", info });
  };

  engine.onZeusAppointed = (appointment: ZeusAppointment) => {
    if (
      opts.gameMode === "online" &&
      appointment.appointmentId <= opts.lastZeusAppointmentIdRef.current
    ) {
      return;
    }
    opts.lastZeusAppointmentIdRef.current = appointment.appointmentId;
    const player = engine.getTankManager().getPlayerById(appointment.zeusId);
    if (!player) return;
    if (opts.zeusAnnouncementTimerRef.current !== null) {
      clearTimeout(opts.zeusAnnouncementTimerRef.current);
    }
    dispatch({
      type: "SHOW_ZEUS_ANNOUNCEMENT",
      announcement: {
        appointmentId: appointment.appointmentId,
        playerName: player.name,
        displayedAt: Date.now(),
      },
    });
    opts.zeusAnnouncementTimerRef.current = setTimeout(() => {
      opts.zeusAnnouncementTimerRef.current = null;
      dispatch({ type: "HIDE_ZEUS_ANNOUNCEMENT" });
    }, ZEUS_ANNOUNCEMENT_DURATION_MS);
  };

  engine.onZeusStrikeApplied = (result: ZeusStrikeResult) => {
    if (
      opts.gameMode === "online" &&
      result.strikeId <= opts.lastAppliedZeusStrikeIdRef.current
    ) {
      return;
    }
    opts.lastAppliedZeusStrikeIdRef.current = result.strikeId;
    const roster = [...engine.getTankManager().getPlayers()];
    dispatch({ type: "SET_UI_PLAYERS", players: roster });
    const awards = buildOverlayAwards([result.award], roster);
    if (awards.length > 0) {
      dispatch({
        type: "SHOW_EARNINGS",
        overlay: {
          shotId: -result.strikeId,
          awards,
          displayedAt: Date.now(),
        },
      });
    }
  };

  engine.onShotResolved = (preview) => {
    if (opts.gameMode === "online") {
      opts.pendingShotPreviewsRef.current.set(preview.shotId, preview);
      opts.submitShotEarningsRef.current(preview);
      return;
    }
    const roster = [...engine.getTankManager().getPlayers()];
    dispatch({ type: "SET_UI_PLAYERS", players: roster });
    const awards = buildOverlayAwards(preview.awards, roster);
    if (awards.length > 0) {
      dispatch({
        type: "SHOW_EARNINGS",
        overlay: {
          shotId: preview.shotId,
          awards,
          displayedAt: Date.now(),
        },
      });
    }
  };

  engine.onRoundEnded = (payload) => {
    if (opts.gamePhaseRef.current !== "COMBAT") return;
    opts.clearZeusAnnouncement();
    opts.roundEndFromNetworkRef.current = false;
    tm.pauseForInterRound();

    const res = engine.buildRoundResult();
    const nextPlayers = [...engine.getTankManager().getPlayers()];
    opts.lastCompletedRoundNumberRef.current = Math.max(
      opts.lastCompletedRoundNumberRef.current,
      opts.currentMancheRef.current,
    );
    dispatch({
      type: "SET_LAST_COMPLETED_ROUND",
      roundNumber: opts.currentMancheRef.current,
    });

    const winner = payload.roundWinner;
    const winnerType = winner ? (winner.isHuman ? "human" : "ai") : "none";
    const winnerProfile =
      winner && !winner.isHuman ? (winner.aiProfile ?? "v1-random") : undefined;
    const nextHumanCount = nextPlayers.reduce(
      (count, player) => count + (player.isHuman ? 1 : 0),
      0,
    );
    trackEvent("round_end", {
      roundNumber: opts.currentMancheRef.current,
      winnerId: winner ? winner.id : null,
      winnerType,
      winnerProfile,
      humanCount: nextHumanCount,
      aiCount: nextPlayers.length - nextHumanCount,
    });

    engine.triggerRoundCelebration(payload.roundWinner || undefined);
    opts.currentMancheRef.current += 1;
    dispatch({
      type: "START_CELEBRATION",
      payload: {
        roundWinner: payload.roundWinner,
        roundResult: res,
        uiPlayers: nextPlayers,
      },
    });
    opts.gamePhaseRef.current = "CELEBRATION";
    opts.clearCelebrationTimer();
    opts.celebrationTimerRef.current = setTimeout(() => {
      if (opts.gamePhaseRef.current === "CELEBRATION") {
        opts.goToSummary();
      }
    }, 10000);
  };
}
