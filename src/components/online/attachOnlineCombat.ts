import type { Dispatch, MutableRefObject } from "react";
import type { GameEngine, ResolvedShotPreview } from "../../game/engine/GameEngine";
import type { FireCommand } from "../../types/game";
import type { GamePhase } from "../../types/game";
import type { Player } from "../../types/player";
import { ALL_WEAPON_IDS, type WeaponId } from "../../types/weapon";
import { AuthoritativeShotQueue } from "../../game/online/authoritativeShotQueue";
import {
  DeferredTransitionBuffer,
  type DeferredAuthoritativeTransition,
} from "../../game/online/deferredTransitions";
import {
  flushDeferredTransitions,
  scheduleDeferredTransition,
} from "../../game/online/flushDeferredTransitions";
import {
  ONLINE_PROTOCOL_VERSION,
  PROTOCOL_MISMATCH_CLOSE_CODE,
  type ClientFireMessage,
  type FireRejectedMessage,
  type RequestGameStartMessage,
  type RoundEndMessage,
  type ShopBuySellMessage,
  type ShopEnterMessage,
  type ShopReadyMessage,
  type ShopStateMessage,
  type ShotEarningsMessage,
  type ShotMessage,
} from "../../game/online/protocol";
import { getOnlineWsBase } from "../../utils/onlineApi";
import type {
  EarningsOverlayState,
  GameCanvasAction,
  PendingFireIntent,
  ShopClientSessionState,
} from "../gameCanvasReducer";
import { dispatchCombatMessage } from "./combatMessageDispatch";

let combatWsEffectGen = 0;
export const SHOP_ACTION_ACK_RETRY_MS = 5_000;

interface AuthoritativeEconomyPlayer {
  readonly id: string;
  readonly money: number;
  readonly inventory: Partial<Record<WeaponId, number>>;
  readonly currentWeapon: WeaponId;
}

export interface AttachOnlineCombatOptions {
  readonly engine: GameEngine;
  readonly dispatch: Dispatch<GameCanvasAction>;
  readonly roomId: string;
  readonly slot: number;
  readonly token: string;
  readonly incomingWs: WebSocket | null | undefined;
  readonly gameWsRef: MutableRefObject<WebSocket | null>;
  readonly protocolMismatchRef: MutableRefObject<boolean>;
  readonly authoritySlotRef: MutableRefObject<number | null>;
  readonly authorityEpochRef: MutableRefObject<number>;
  readonly lastAppliedShotIdRef: MutableRefObject<number>;
  readonly lastSeenShotIdRef: MutableRefObject<number>;
  readonly lastAppliedShopEpochRef: MutableRefObject<number>;
  readonly lastCompletedRoundNumberRef: MutableRefObject<number>;
  readonly currentMancheRef: MutableRefObject<number>;
  readonly gamePhaseRef: MutableRefObject<GamePhase>;
  readonly shopSessionRef: MutableRefObject<ShopClientSessionState>;
  readonly shopPlayersRef: MutableRefObject<Player[]>;
  readonly localShopDoneRef: MutableRefObject<boolean>;
  readonly pendingFireRef: MutableRefObject<PendingFireIntent | null>;
  readonly fireRejectionTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  readonly pendingShotPreviewsRef: MutableRefObject<Map<number, ResolvedShotPreview>>;
  readonly submitShotEarningsRef: MutableRefObject<(preview: ResolvedShotPreview) => void>;
  readonly roundEndFromNetworkRef: MutableRefObject<boolean>;
  readonly applyShopFinish: (
    players: Player[],
    shopEpoch: number,
    nextRoundNumber: number,
  ) => void;
  readonly clearCelebrationTimer: () => void;
  readonly setLocalShopDone: (done: boolean) => void;
  readonly buildOverlayAwards: (
    awards: ReadonlyArray<{ playerId: string; amount: number }>,
    roster: ReadonlyArray<Player>,
  ) => EarningsOverlayState["awards"];
}

export interface OnlineCombatHandle {
  readonly send: (message: object) => void;
  readonly detach: () => void;
  readonly activeServerShotId: () => number | null;
}

export function attachOnlineCombat(
  opts: AttachOnlineCombatOptions,
): OnlineCombatHandle {
  const {
    engine,
    dispatch,
    roomId,
    slot,
    token,
    incomingWs,
    gameWsRef,
    protocolMismatchRef,
  } = opts;
  const tm = engine.getTurnManager();
  const localSlotNum = Number(slot);
  const wsBase = getOnlineWsBase();
  const pendingMessages: string[] = [];
  const authoritativeEconomyRef: { current: AuthoritativeEconomyPlayer[] } = {
    current: [],
  };
  const effectGeneration = ++combatWsEffectGen;
  let isMounted = true;
  let combatReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let combatStartTimer: ReturnType<typeof setTimeout> | null = null;
  let shopActionRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let gameWs: WebSocket | null = null;
  const shotQueueRef: { current: AuthoritativeShotQueue | null } = {
    current: null,
  };
  const transitionBufferRef: { current: DeferredTransitionBuffer | null } = {
    current: null,
  };

  const flush = (): void => {
    if (protocolMismatchRef.current) return;
    const ws = gameWsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (pendingMessages.length > 0) {
      const payload = pendingMessages.shift();
      if (!payload) continue;
      try {
        ws.send(payload);
      } catch (e) {
        console.warn("[Game] Failed to flush combat message", e);
        pendingMessages.unshift(payload);
        break;
      }
    }
  };

  const send = (obj: object): void => {
    if (protocolMismatchRef.current) return;
    if (
      "type" in obj &&
      (obj.type === "SHOP_BUY_SELL" || obj.type === "SHOP_READY")
    ) {
      schedulePendingShopRetry();
    }
    const payload = JSON.stringify(obj);
    const ws = gameWsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(payload);
        return;
      } catch (e) {
        console.warn("[Game] WS send failed, queueuing", e);
      }
    }
    pendingMessages.push(payload);
    console.warn(
      `[Game] Queued combat message type=${"type" in obj ? String(obj.type) : "unknown"} (ws readyState=${ws?.readyState ?? "null"})`,
    );
  };

  const buildCatchUpRequest = (): RequestGameStartMessage => ({
    type: "REQUEST_GAME_START",
    protocolVersion: ONLINE_PROTOCOL_VERSION,
    roundNumber: opts.currentMancheRef.current,
    lastSeenShotId: opts.lastSeenShotIdRef.current,
    lastAppliedShopEpoch: opts.lastAppliedShopEpochRef.current,
  });

  const transitionBuffer = new DeferredTransitionBuffer();
  transitionBufferRef.current = transitionBuffer;

  const acknowledgePendingFire = (message: ShotMessage): void => {
    if (opts.pendingFireRef.current?.actionId !== message.actionId) return;
    opts.pendingFireRef.current = null;
    dispatch({ type: "SET_FIRE_PENDING", intent: null });
    dispatch({ type: "SET_FIRE_REJECTION", reason: null });
  };

  tm.setFireIntentHandler((command: FireCommand) => {
    if (opts.pendingFireRef.current) return;
    if (opts.fireRejectionTimerRef.current !== null) {
      clearTimeout(opts.fireRejectionTimerRef.current);
      opts.fireRejectionTimerRef.current = null;
    }
    const actionId = crypto.randomUUID();
    const pending: PendingFireIntent = {
      actionId,
      command: { ...command },
    };
    opts.pendingFireRef.current = pending;
    dispatch({ type: "SET_FIRE_PENDING", intent: pending });
    dispatch({ type: "SET_FIRE_REJECTION", reason: null });
    const message: ClientFireMessage = {
      type: "FIRE",
      actionId,
      command: pending.command,
    };
    send(message);
  });

  const clearCombatReconnect = (): void => {
    if (combatReconnectTimer !== null) {
      clearTimeout(combatReconnectTimer);
      combatReconnectTimer = null;
    }
  };

  const clearShopActionRetry = (): void => {
    if (shopActionRetryTimer !== null) {
      clearTimeout(shopActionRetryTimer);
      shopActionRetryTimer = null;
    }
  };

  const submitShotEarnings = (preview: ResolvedShotPreview): void => {
    if (opts.authoritySlotRef.current !== localSlotNum) return;
    const message: ShotEarningsMessage = {
      type: "SHOT_EARNINGS",
      shotId: preview.shotId,
      authorityEpoch: opts.authorityEpochRef.current,
      awards: preview.awards.map(({ playerId, amount }) => ({
        playerId,
        amount,
      })),
      deadSlots: engine
        .getTankManager()
        .getPlayers()
        .map((player) => player.tank.isDead),
      roundOutcome: preview.roundOutcome,
      directHitVictimIds: preview.directHitVictimIds,
    };
    send(message);
  };
  opts.submitShotEarningsRef.current = submitShotEarnings;

  const reapplyAuthoritativeEconomy = (): void => {
    const livePlayers = engine.getTankManager().getPlayers();
    const livePlayersById = new Map(
      livePlayers.map((player) => [player.id, player]),
    );
    for (const update of authoritativeEconomyRef.current) {
      const livePlayer = livePlayersById.get(update.id);
      if (!livePlayer) continue;
      livePlayer.money = update.money;
      livePlayer.inventory = { ...update.inventory };
      livePlayer.tank.currentWeapon = update.currentWeapon;
    }
    dispatch({ type: "SET_UI_PLAYERS", players: [...livePlayers] });
  };

  const syncWireEconomy = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    const updates: AuthoritativeEconomyPlayer[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
      const wirePlayer = entry as Record<string, unknown>;
      if (
        typeof wirePlayer.id !== "string" ||
        typeof wirePlayer.money !== "number" ||
        !Number.isSafeInteger(wirePlayer.money) ||
        wirePlayer.money < 0
      )
        return;
      if (
        !wirePlayer.inventory ||
        typeof wirePlayer.inventory !== "object" ||
        Array.isArray(wirePlayer.inventory) ||
        !wirePlayer.tank ||
        typeof wirePlayer.tank !== "object" ||
        Array.isArray(wirePlayer.tank)
      )
        return;
      const inventory: Partial<Record<WeaponId, number>> = {};
      for (const [weaponId, stock] of Object.entries(
        wirePlayer.inventory as Record<string, unknown>,
      )) {
        if (
          !ALL_WEAPON_IDS.includes(weaponId as WeaponId) ||
          typeof stock !== "number" ||
          !Number.isSafeInteger(stock) ||
          stock < 0
        )
          return;
        inventory[weaponId as WeaponId] = stock;
      }
      const currentWeapon = (wirePlayer.tank as Record<string, unknown>)[
        "currentWeapon"
      ];
      if (
        typeof currentWeapon !== "string" ||
        !ALL_WEAPON_IDS.includes(currentWeapon as WeaponId)
      )
        return;
      updates.push({
        id: wirePlayer.id,
        money: wirePlayer.money,
        inventory,
        currentWeapon: currentWeapon as WeaponId,
      });
    }
    authoritativeEconomyRef.current = updates;
    reapplyAuthoritativeEconomy();
  };

  const applyFireRejection = (message: FireRejectedMessage): void => {
    const pending = opts.pendingFireRef.current;
    if (
      !pending ||
      message.actionId === undefined ||
      pending.actionId !== message.actionId
    )
      return;
    const roster = engine.getTankManager().getPlayers();
    const localPlayer = roster[localSlotNum];
    if (localPlayer) {
      localPlayer.inventory = { ...message.inventory };
      localPlayer.tank.currentWeapon = message.currentWeapon;
      authoritativeEconomyRef.current = authoritativeEconomyRef.current.map(
        (entry) =>
          entry.id === localPlayer.id
            ? {
                ...entry,
                inventory: { ...message.inventory },
                currentWeapon: message.currentWeapon,
              }
            : entry,
      );
      dispatch({ type: "SET_UI_PLAYERS", players: [...roster] });
    }
    opts.pendingFireRef.current = null;
    dispatch({ type: "SET_FIRE_PENDING", intent: null });
    tm.rejectPendingFireIntent();
    dispatch({ type: "SET_FIRE_REJECTION", reason: message.reason });
  };

  const applyRoundEndMessage = (message: RoundEndMessage): void => {
    if (message.roundNumber <= opts.lastCompletedRoundNumberRef.current) return;
    if (opts.gamePhaseRef.current !== "COMBAT") return;
    opts.lastCompletedRoundNumberRef.current = Math.max(
      opts.lastCompletedRoundNumberRef.current,
      message.roundNumber,
    );
    dispatch({
      type: "SET_LAST_COMPLETED_ROUND",
      roundNumber: message.roundNumber,
    });
    opts.roundEndFromNetworkRef.current = true;
    engine.syncRoundEndFromRemote(
      message.players,
      message.roundWinnerId,
      message.isDraw,
    );
  };

  const applyShopStateMessage = (message: ShopStateMessage): void => {
    if (message.shopEpoch <= opts.lastAppliedShopEpochRef.current) return;
    const pending = opts.shopSessionRef.current.pendingIntent;
    const acknowledged =
      pending?.shopEpoch === message.shopEpoch &&
      message.acknowledgedAction?.slot === localSlotNum &&
      message.acknowledgedAction.actionId === pending.actionId;
    const relevantPending =
      pending?.shopEpoch === message.shopEpoch ? pending : null;
    const nextShopSession: ShopClientSessionState = {
      epoch: message.shopEpoch,
      roundNumber: message.roundNumber,
      counters: message.purchasesByPlayerId,
      readySlots: message.readySlots,
      aiShopApplied: message.aiShopApplied,
      authoritativeReceived: true,
      pendingIntent: acknowledged ? null : relevantPending,
      denial: null,
    };
    const liveById = new Map(
      engine.getTankManager().getPlayers().map((player) => [player.id, player]),
    );
    const mergedPlayers = message.players.map((authoritativePlayer) => {
      const livePlayer = liveById.get(authoritativePlayer.id);
      if (!livePlayer) return authoritativePlayer;
      return {
        ...livePlayer,
        name: authoritativePlayer.name,
        isHuman: authoritativePlayer.isHuman,
        aiProfile: authoritativePlayer.aiProfile,
        money: authoritativePlayer.money,
        inventory: { ...authoritativePlayer.inventory },
        tank: {
          ...livePlayer.tank,
          currentWeapon: authoritativePlayer.tank.currentWeapon,
        },
      };
    });

    opts.clearCelebrationTimer();
    engine.clearRoundCelebration();
    opts.shopSessionRef.current = nextShopSession;
    engine.getTankManager().setPlayers(mergedPlayers);
    opts.shopPlayersRef.current = mergedPlayers;
    opts.localShopDoneRef.current = message.readySlots.includes(localSlotNum);
    opts.setLocalShopDone(opts.localShopDoneRef.current);
    dispatch({
      type: "APPLY_SHOP_STATE",
      shopEpoch: message.shopEpoch,
      roundNumber: message.roundNumber,
      readySlots: message.readySlots,
      players: mergedPlayers,
      counters: message.purchasesByPlayerId,
      aiShopApplied: message.aiShopApplied,
    });
    dispatch({
      type: "SET_SHOP_PENDING",
      intent: nextShopSession.pendingIntent,
    });
    opts.currentMancheRef.current = Math.max(
      opts.currentMancheRef.current,
      message.roundNumber + 1,
    );
    opts.lastCompletedRoundNumberRef.current = Math.max(
      opts.lastCompletedRoundNumberRef.current,
      message.roundNumber,
    );
    opts.gamePhaseRef.current = "SHOP";
    tm.pauseForInterRound();
    schedulePendingShopRetry();
  };

  function applyDeferredItem(item: DeferredAuthoritativeTransition): void {
    if (item.kind === "ROUND_END") {
      applyRoundEndMessage(item.message);
      return;
    }
    if (item.kind === "SHOP_STATE") {
      applyShopStateMessage(item.message);
      return;
    }
    opts.applyShopFinish(
      item.message.players,
      item.message.shopEpoch,
      item.message.nextRoundNumber,
    );
    schedulePendingShopRetry();
    const queue = shotQueueRef.current;
    if (
      opts.gamePhaseRef.current === "COMBAT" &&
      queue &&
      queue.pendingCount > 0
    ) {
      queue.drain();
    }
  }

  const shotQueue = new AuthoritativeShotQueue({
    getGamePhase: () => opts.gamePhaseRef.current,
    isInterRoundPaused: () => tm.isInterRoundPaused(),
    lastSeenShotId: () => opts.lastSeenShotIdRef.current,
    markSeen: (shotId) => {
      opts.lastSeenShotIdRef.current = Math.max(
        opts.lastSeenShotIdRef.current,
        shotId,
      );
      dispatch({ type: "SET_LAST_SEEN_SHOT", shotId });
    },
    acknowledgePendingFire,
    executeRemoteFire: (message, mode) => {
      tm.executeRemoteFire(message.command, {
        fromSlot: message.slot,
        ownerId: message.ownerId,
        identity: {
          shotId: message.shotId,
          isFirstShotOfRound: message.isFirstShotOfRound,
        },
        mode,
      });
    },
    onIdle: () => {
      reapplyAuthoritativeEconomy();
      flushDeferredTransitions(shotQueue, transitionBuffer, applyDeferredItem);
    },
    lockForCatchUp: () => tm.lockForCatchUp(),
    unlockAfterCatchUp: () => tm.unlockAfterCatchUp(),
  });
  shotQueueRef.current = shotQueue;

  tm.onAuthoritativeShotSettled = (shotId) => {
    shotQueue.onShotSettled(shotId);
  };

  const scheduleTransition = (
    item: DeferredAuthoritativeTransition,
  ): void => {
    scheduleDeferredTransition(
      shotQueue,
      transitionBuffer,
      applyDeferredItem,
      item,
    );
  };

  const retryPendingShopAction = (): void => {
    const pendingShop = opts.shopSessionRef.current.pendingIntent;
    if (pendingShop?.kind === "BUY_SELL") {
      const retry: ShopBuySellMessage = {
        type: "SHOP_BUY_SELL",
        shopEpoch: pendingShop.shopEpoch,
        actionId: pendingShop.actionId,
        weaponId: pendingShop.weaponId,
        delta: pendingShop.delta,
      };
      send(retry);
    } else if (pendingShop?.kind === "READY") {
      const retry: ShopReadyMessage = {
        type: "SHOP_READY",
        shopEpoch: pendingShop.shopEpoch,
        actionId: pendingShop.actionId,
      };
      send(retry);
    }
  };

  function schedulePendingShopRetry(): void {
    clearShopActionRetry();
    if (
      !isMounted ||
      protocolMismatchRef.current ||
      opts.gamePhaseRef.current !== "SHOP" ||
      !opts.shopSessionRef.current.pendingIntent
    ) {
      return;
    }
    shopActionRetryTimer = setTimeout(() => {
      shopActionRetryTimer = null;
      const ws = gameWsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        retryPendingShopAction();
      } else {
        schedulePendingShopRetry();
      }
    }, SHOP_ACTION_ACK_RETRY_MS);
  }

  const retryPendingActions = (): void => {
    const pendingFire = opts.pendingFireRef.current;
    if (pendingFire) {
      const retry: ClientFireMessage = {
        type: "FIRE",
        actionId: pendingFire.actionId,
        command: pendingFire.command,
      };
      send(retry);
    }
    const shopSession = opts.shopSessionRef.current;
    if (
      opts.gamePhaseRef.current === "SHOP" &&
      !shopSession.authoritativeReceived &&
      shopSession.roundNumber !== null
    ) {
      const retry: ShopEnterMessage = {
        type: "SHOP_ENTER",
        roundNumber: shopSession.roundNumber,
      };
      send(retry);
    }
    retryPendingShopAction();
  };

  function bindCombatWsHandlers(ws: WebSocket): void {
    ws.onopen = () => {
      console.log("[Game] Combat WS connected to server");
      flush();
      retryPendingActions();
      try {
        ws.send(JSON.stringify(buildCatchUpRequest()));
      } catch {
        // ignore
      }
    };

    ws.onmessage = (ev) => {
      try {
        dispatchCombatMessage(
          {
            engine,
            shotQueue,
            localSlotNum,
            dispatch,
            protocolMismatchRef,
            authoritySlotRef: opts.authoritySlotRef,
            authorityEpochRef: opts.authorityEpochRef,
            lastAppliedShotIdRef: opts.lastAppliedShotIdRef,
            pendingShotPreviewsRef: opts.pendingShotPreviewsRef,
            shopSessionRef: opts.shopSessionRef,
            gamePhaseRef: opts.gamePhaseRef,
            applyFireRejection,
            scheduleTransition,
            submitShotEarnings,
            syncWireEconomy,
            buildOverlayAwards: opts.buildOverlayAwards,
          },
          JSON.parse(ev.data) as unknown,
        );
      } catch (e) {
        console.warn("[Game] invalid WS message", e);
      }
      schedulePendingShopRetry();
    };

    ws.onclose = (ev: CloseEvent) => {
      console.log("[Game] Combat WS closed", ev.code, ev.reason);
      if (gameWsRef.current === ws) {
        gameWsRef.current = null;
        if (
          ev.code === 4001 ||
          ev.code === PROTOCOL_MISMATCH_CLOSE_CODE ||
          (typeof ev.reason === "string" && ev.reason.includes("replaced"))
        ) {
          console.log(
            "[Game] Socket superseded by another connection, skipping reconnect",
          );
          return;
        }
        if (opts.gamePhaseRef.current !== "GAME_OVER" && isMounted) {
          clearCombatReconnect();
          combatReconnectTimer = setTimeout(() => {
            combatReconnectTimer = null;
            connectCombatWs();
          }, 2000);
        }
      }
    };
    ws.onerror = (e) => {
      console.warn("[Game] Combat WS error", e);
    };
  }

  function connectCombatWs(): void {
    if (!isMounted) return;
    if (
      gameWsRef.current?.readyState === WebSocket.OPEN ||
      gameWsRef.current?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }
    const wsUrl = `${wsBase}/api/rooms/${roomId}/ws?slot=${slot}&token=${encodeURIComponent(token)}`;
    gameWs = new WebSocket(wsUrl);
    gameWsRef.current = gameWs;
    bindCombatWsHandlers(gameWs);
  }

  if (incomingWs && incomingWs.readyState === WebSocket.OPEN) {
    console.log("[Game] Re-using existing WebSocket connection from lobby");
    gameWs = incomingWs;
    gameWsRef.current = incomingWs;
    bindCombatWsHandlers(incomingWs);
    flush();
    retryPendingActions();
    try {
      incomingWs.send(JSON.stringify(buildCatchUpRequest()));
    } catch {
      // ignore
    }
  } else {
    console.log(
      "[Game] No existing active WS or not open. Connecting new WebSocket...",
    );
    combatStartTimer = setTimeout(connectCombatWs, 50);
  }

  return {
    send,
    activeServerShotId: () => shotQueue.activeServerShotId,
    detach: () => {
      isMounted = false;
      if (combatStartTimer !== null) {
        clearTimeout(combatStartTimer);
        combatStartTimer = null;
      }
      clearCombatReconnect();
      clearShopActionRetry();
      tm.setFireIntentHandler(null);
      tm.onAuthoritativeShotSettled = undefined;
      transitionBufferRef.current?.drain();
      transitionBufferRef.current = null;
      shotQueueRef.current = null;
      const wsToClose = gameWs;
      const genAtCleanup = effectGeneration;
      setTimeout(() => {
        if (combatWsEffectGen !== genAtCleanup) return;
        if (wsToClose) {
          wsToClose.onopen = null;
          wsToClose.onmessage = null;
          wsToClose.onclose = null;
          wsToClose.onerror = null;
          if (
            wsToClose.readyState === WebSocket.OPEN ||
            wsToClose.readyState === WebSocket.CONNECTING
          ) {
            try {
              wsToClose.close();
            } catch {
              void 0;
            }
          }
        }
        if (gameWsRef.current === wsToClose) {
          gameWsRef.current = null;
        }
      }, 0);
    },
  };
}
