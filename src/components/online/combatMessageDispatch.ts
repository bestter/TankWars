import { isCombatEvent } from "../../game/online/combatCatchUp";
import type { Dispatch, MutableRefObject } from "react";
import type { GameEngine, ResolvedShotPreview } from "../../game/engine/GameEngine";
import type { AuthoritativeShotQueue } from "../../game/online/authoritativeShotQueue";
import type { DeferredAuthoritativeTransition } from "../../game/online/deferredTransitions";
import {
  isStrictOnlineMessage,
  ONLINE_PROTOCOL_VERSION,
  readProtocolVersion,
  type FireRejectedMessage,
} from "../../game/online/protocol";
import type { GamePhase } from "../../types/game";
import type { Player } from "../../types/player";
import type {
  EarningsOverlayState,
  GameCanvasAction,
  ShopClientSessionState,
} from "../gameCanvasReducer";

export interface CombatMessageContext {
  readonly engine: GameEngine;
  readonly shotQueue: AuthoritativeShotQueue;
  readonly localSlotNum: number;
  readonly dispatch: Dispatch<GameCanvasAction>;
  readonly protocolMismatchRef: MutableRefObject<boolean>;
  readonly authoritySlotRef: MutableRefObject<number | null>;
  readonly authorityEpochRef: MutableRefObject<number>;
  readonly lastAppliedShotIdRef: MutableRefObject<number>;
  readonly pendingShotPreviewsRef: MutableRefObject<
    Map<number, ResolvedShotPreview>
  >;
  readonly shopSessionRef: MutableRefObject<ShopClientSessionState>;
  readonly gamePhaseRef: MutableRefObject<GamePhase>;
  readonly applyFireRejection: (message: FireRejectedMessage) => void;
  readonly scheduleTransition: (item: DeferredAuthoritativeTransition) => void;
  readonly submitShotEarnings: (preview: ResolvedShotPreview) => void;
  readonly applyEconomicResult?: (message: { economicRevision: number; roundEarningsByPlayer: Record<string, number>; balances: Array<{ playerId: string; money: number }> }) => void;
  readonly deferControl?: (message: unknown) => void;
  readonly syncWireEconomy: (value: unknown) => void;
  readonly buildOverlayAwards: (
    awards: ReadonlyArray<{ playerId: string; amount: number }>,
    roster: ReadonlyArray<Player>,
  ) => EarningsOverlayState["awards"];
}

export function dispatchCombatMessage(
  ctx: CombatMessageContext,
  parsed: unknown,
): void {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const msg = parsed as Record<string, unknown>;
  const strictMessage = isStrictOnlineMessage(parsed) ? parsed : null;
  const tm = ctx.engine.getTurnManager();
  const { shotQueue, engine } = ctx;

  const applyProtocolMismatch = (receivedVersion: number | null): void => {
    ctx.protocolMismatchRef.current = true;
    ctx.dispatch({
      type: "SET_PROTOCOL_MISMATCH",
      mismatch: {
        requiredVersion: ONLINE_PROTOCOL_VERSION,
        receivedVersion,
      },
    });
  };

  if (strictMessage && (strictMessage.type === "STATE_UPDATE" || strictMessage.type === "ZEUS_STATE") && typeof msg.roundNumber === "number" && msg.roundNumber !== engine.getInitialRoundMap()?.roundNumber) return;

  if (strictMessage && (strictMessage.type === "STATE_UPDATE" || strictMessage.type === "ZEUS_STATE" || strictMessage.type === "GAME_START") && typeof msg.eventSequence === "number" && msg.eventSequence < shotQueue.processedEventSequence) return;

  if (strictMessage?.type === "PROTOCOL_MISMATCH") {
    applyProtocolMismatch(strictMessage.receivedVersion);
    return;
  }

  if (strictMessage?.type === "ROUND_PREPARATION_FAILED") {
    engine.enterInterRoundPhase();
    ctx.dispatch({ type: "SET_ROUND_PREPARATION_ERROR", reason: strictMessage.reason });
    return;
  }

  if (msg.type === "SHOP_FINISH" && strictMessage?.type !== "SHOP_FINISH") {
    engine.enterInterRoundPhase();
    ctx.dispatch({ type: "SET_ROUND_PREPARATION_ERROR", reason: "NEW_GAME_REQUIRED" });
    return;
  }
  if (msg.type === "GAME_START") {
    if (strictMessage?.type !== "GAME_START") {
      applyProtocolMismatch(readProtocolVersion(msg));
      return;
    }
    console.log(
      `[Game] Received GAME_START: currentPlayerIndex=${strictMessage.currentPlayerIndex}`,
    );

  }

  if (isCombatEvent(strictMessage)) {
    shotQueue.enqueueCombat([strictMessage], strictMessage.type === "SHOT" && strictMessage.slot === ctx.localSlotNum ? "LIVE_LOCAL" : "LIVE_REMOTE");
    return;
  }
  if (strictMessage?.type === "EARNINGS_REJECTED") {
    ctx.dispatch({ type: "SET_NETWORK_ERROR", key: `earnings_rejected_${strictMessage.reason.toLowerCase()}` });
    return;
  }
  if (strictMessage && (strictMessage.type === "STATE_UPDATE" || strictMessage.type === "ZEUS_STATE" || strictMessage.type === "GAME_START") && (shotQueue.replayActiveNow || shotQueue.pendingCount > 0)) {
    ctx.deferControl?.(strictMessage);
    return;
  }
  if (strictMessage?.type === "FIRE_REJECTED") {
    ctx.applyFireRejection(strictMessage);
  }

  if (strictMessage?.type === "AUTHORITY_CHANGED") {
    ctx.authoritySlotRef.current = strictMessage.authoritySlot;
    ctx.authorityEpochRef.current = strictMessage.authorityEpoch;
    if (
      strictMessage.authoritySlot === ctx.localSlotNum &&
      shotQueue.activeServerShotId !== null
    ) {
      const preview = ctx.pendingShotPreviewsRef.current.get(
        shotQueue.activeServerShotId,
      );
      if (preview) ctx.submitShotEarnings(preview);
    }
  }

  if (strictMessage?.type === "SHOT_EARNINGS_APPLIED") {
    if (ctx.applyEconomicResult) ctx.applyEconomicResult(strictMessage);
    else engine.applyResolvedEarnings(strictMessage.shotId, strictMessage.balances);
    if (shotQueue.activeServerShotId === strictMessage.shotId && !shotQueue.replayActiveNow) {
      shotQueue.clearActiveServerShotId();
    }
    shotQueue.noteCatchUpShotApplied(strictMessage.shotId);
    ctx.pendingShotPreviewsRef.current.delete(strictMessage.shotId);
    if (strictMessage.shotId <= ctx.lastAppliedShotIdRef.current) return;
    ctx.lastAppliedShotIdRef.current = strictMessage.shotId;
    const roster = [...engine.getTankManager().getPlayers()];
    ctx.dispatch({ type: "SET_UI_PLAYERS", players: roster });
    const awards = ctx.buildOverlayAwards(strictMessage.awards, roster);
    if (awards.length > 0) {
      ctx.dispatch({
        type: "SHOW_EARNINGS",
        overlay: {
          shotId: strictMessage.shotId,
          awards,
          displayedAt: Date.now(),
        },
      });
    }
  }

  if (strictMessage?.type === "ZEUS_STATE") {
    engine.syncRemoteZeusState(strictMessage.activeZeusId);
    const roster = engine.getTankManager().getPlayers();
    const isReplayingShots =
      shotQueue.replayActiveNow || shotQueue.pendingCount > 0;
    if (!isReplayingShots) {
      for (let index = 0; index < strictMessage.deadSlots.length; index++) {
        if (!strictMessage.deadSlots[index]) continue;
        const player = roster[index];
        if (!player) continue;
        player.tank.health = 0;
        player.tank.shield = 0;
        player.tank.isDead = true;
      }
    }
    if (ctx.gamePhaseRef.current === "COMBAT" && !isReplayingShots) {
      tm.releaseSpecialTurn();
      tm.syncTurn(strictMessage.currentPlayerIndex);
      if (strictMessage.activeStrike || roster[strictMessage.currentPlayerIndex]?.id === strictMessage.activeZeusId) tm.lockSpecialTurn();
    }
    ctx.dispatch({ type: "SET_UI_PLAYERS", players: [...roster] });
  }

  if (strictMessage?.type === "STATE_UPDATE") {
    console.log(
      `[Game] Received STATE_UPDATE: currentPlayerIndex=${strictMessage.currentPlayerIndex}`,
    );
    if (
      ctx.gamePhaseRef.current === "COMBAT" &&
      !tm.isInterRoundPaused()
    ) {
      tm.syncTurn(strictMessage.currentPlayerIndex);
      if (engine.getTankManager().getPlayers()[strictMessage.currentPlayerIndex]?.id === engine.getActiveZeusId()) tm.lockSpecialTurn();
      if (strictMessage.players) ctx.syncWireEconomy(strictMessage.players);
      if (typeof msg.wind === "number" && Number.isFinite(msg.wind)) {
        engine.setWindForce(msg.wind);
      }
    }
  }

  if (strictMessage?.type === "SHOP_STATE") {
    ctx.scheduleTransition({
      kind: "SHOP_STATE",
      message: strictMessage,
    });
  }

  if (strictMessage?.type === "SHOP_REJECTED") {
    const pending = ctx.shopSessionRef.current.pendingIntent;
    const matchesPending =
      strictMessage.actionId !== undefined &&
      pending?.actionId === strictMessage.actionId;
    const isUncorrelatedWithoutPending =
      strictMessage.actionId === undefined && pending === null;
    if (matchesPending || isUncorrelatedWithoutPending) {
      ctx.shopSessionRef.current = {
        ...ctx.shopSessionRef.current,
        pendingIntent: null,
        denial: strictMessage.reason,
      };
      ctx.dispatch({
        type: "SET_SHOP_DENIAL",
        denial: strictMessage.reason,
      });
    }
  }

  if (strictMessage?.type === "SHOP_FINISH") {
    ctx.scheduleTransition({
      kind: "SHOP_FINISH",
      message: strictMessage,
    });
  }

  if (strictMessage?.type === "ROUND_END") {
    ctx.scheduleTransition({
      kind: "ROUND_END",
      message: strictMessage,
    });
  }
}
