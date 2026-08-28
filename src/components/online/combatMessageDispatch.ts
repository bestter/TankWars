import type { Dispatch, MutableRefObject } from "react";
import type { GameEngine, ResolvedShotPreview } from "../../game/engine/GameEngine";
import type { AuthoritativeShotQueue } from "../../game/online/authoritativeShotQueue";
import type { DeferredTransitionBuffer } from "../../game/online/deferredTransitions";
import {
  isStrictOnlineMessage,
  ONLINE_PROTOCOL_VERSION,
  readProtocolVersion,
  type FireRejectedMessage,
  type RoundEndMessage,
  type ShopStateMessage,
  type ShotMessage,
} from "../../game/online/protocol";
import type { ZeusStrikeResult } from "../../game/zeus/zeusDomain";
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
  readonly transitionBuffer: DeferredTransitionBuffer;
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
  readonly applyShopStateMessage: (message: ShopStateMessage) => void;
  readonly applyRoundEndMessage: (message: RoundEndMessage) => void;
  readonly applyShopFinish: (
    players: Player[],
    shopEpoch: number,
    nextRoundNumber: number,
  ) => void;
  readonly submitShotEarnings: (preview: ResolvedShotPreview) => void;
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
  const { shotQueue, transitionBuffer, engine } = ctx;

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

  if (strictMessage?.type === "PROTOCOL_MISMATCH") {
    applyProtocolMismatch(strictMessage.receivedVersion);
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
    tm.syncTurn(strictMessage.currentPlayerIndex);
    if (typeof msg.wind === "number" && Number.isFinite(msg.wind)) {
      engine.setWindForce(msg.wind);
    }
    ctx.syncWireEconomy(msg.players);
  }

  if (strictMessage?.type === "SHOT") {
    shotQueue.enqueue(
      [strictMessage],
      strictMessage.slot === ctx.localSlotNum ? "LIVE_LOCAL" : "LIVE_REMOTE",
    );
  }

  if (strictMessage?.type === "SHOT_CATCH_UP") {
    shotQueue.setCatchUpActiveShotId(strictMessage.activeShotId);
    const catchUpMode = (message: ShotMessage) =>
      message.shotId === strictMessage.activeShotId
        ? ("ACTIVE_RECOVERY" as const)
        : ("CATCH_UP" as const);
    shotQueue.enqueue(strictMessage.shots, catchUpMode);
    if (strictMessage.lastFireResult?.type === "FIRE_REJECTED") {
      ctx.applyFireRejection(strictMessage.lastFireResult);
    } else if (strictMessage.lastFireResult?.type === "SHOT") {
      shotQueue.enqueue([strictMessage.lastFireResult], catchUpMode);
    }
    if (
      strictMessage.shots.length === 0 &&
      strictMessage.activeShotId === null
    ) {
      tm.unlockAfterCatchUp();
    }
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

  if (
    strictMessage?.type === "SHOT_EARNINGS_APPLIED" &&
    strictMessage.shotId > ctx.lastAppliedShotIdRef.current
  ) {
    engine.applyResolvedEarnings(strictMessage.shotId, strictMessage.balances);
    ctx.lastAppliedShotIdRef.current = strictMessage.shotId;
    if (shotQueue.activeServerShotId === strictMessage.shotId) {
      shotQueue.clearActiveServerShotId();
    }
    shotQueue.noteCatchUpShotApplied(strictMessage.shotId);
    ctx.pendingShotPreviewsRef.current.delete(strictMessage.shotId);
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

  if (strictMessage?.type === "ZEUS_APPOINTED") {
    const roster = engine.getTankManager().getPlayers();
    const rotationPlayerIds = strictMessage.rotationSlots
      .map((rotationSlot) => roster[rotationSlot]?.id)
      .filter((playerId): playerId is string => typeof playerId === "string");
    engine.applyRemoteZeusAppointment({
      appointmentId: strictMessage.appointmentId,
      zeusId: strictMessage.zeusId,
      rotationPlayerIds,
    });
    tm.syncTurn(strictMessage.zeusSlot);
  }

  if (strictMessage?.type === "ZEUS_STRIKE") {
    engine.startRemoteZeusStrike(strictMessage, strictMessage.resolveAt);
  }

  if (strictMessage?.type === "ZEUS_STRIKE_APPLIED") {
    const result: ZeusStrikeResult = {
      strikeId: strictMessage.strikeId,
      zeusId: strictMessage.zeusId,
      targetId: strictMessage.targetId,
      award: strictMessage.award,
      balances: strictMessage.balances,
      roundOutcome: strictMessage.roundOutcome,
    };
    engine.applyRemoteZeusStrikeResult(result);
    if (
      strictMessage.nextPlayerIndex !== null &&
      ctx.gamePhaseRef.current === "COMBAT"
    ) {
      tm.syncTurn(strictMessage.nextPlayerIndex);
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
    if (strictMessage.activeStrike) {
      engine.startRemoteZeusStrike(
        strictMessage.activeStrike,
        strictMessage.activeStrike.resolveAt,
      );
    }
    if (ctx.gamePhaseRef.current === "COMBAT" && !isReplayingShots) {
      tm.syncTurn(strictMessage.currentPlayerIndex);
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
      if (strictMessage.players) ctx.syncWireEconomy(strictMessage.players);
      if (typeof msg.wind === "number" && Number.isFinite(msg.wind)) {
        engine.setWindForce(msg.wind);
      }
    }
  }

  if (strictMessage?.type === "SHOP_STATE") {
    shotQueue.purgeCompletedRound(strictMessage.roundNumber);
    if (shotQueue.replayActiveNow) {
      transitionBuffer.enqueue({
        kind: "SHOP_STATE",
        message: strictMessage,
      });
    } else {
      ctx.applyShopStateMessage(strictMessage);
    }
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
    shotQueue.purgeCompletedRound(strictMessage.completedRoundNumber);
    const applyFinish = (): void => {
      ctx.applyShopFinish(
        strictMessage.players,
        strictMessage.shopEpoch,
        strictMessage.nextRoundNumber,
      );
      if (
        ctx.gamePhaseRef.current === "COMBAT" &&
        shotQueue.pendingCount > 0
      ) {
        shotQueue.drain();
      }
    };
    if (shotQueue.replayActiveNow) {
      transitionBuffer.enqueue({
        kind: "SHOP_FINISH",
        message: strictMessage,
      });
    } else {
      applyFinish();
    }
  }

  if (strictMessage?.type === "ROUND_END") {
    if (shotQueue.replayActiveNow || shotQueue.pendingCount > 0) {
      transitionBuffer.enqueue({
        kind: "ROUND_END",
        message: strictMessage,
      });
    } else {
      ctx.applyRoundEndMessage(strictMessage);
    }
  }
}
