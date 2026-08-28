import type { WeaponId } from "../../types/weapon";
import { applyShopTransaction } from "../../game/shop/shopTransaction";
import type {
  ShopBuySellMessage,
  ShopReadyMessage,
} from "../../game/online/protocol";
import type { PendingShopIntent } from "../gameCanvasReducer";
import { advanceToNextShopper } from "./localHotseatShop";
import {
  hotseatHostFrom,
  type CompleteShopRoundHost,
} from "./completeShopRound";

export function shopBuySell(
  host: CompleteShopRoundHost,
  weaponId: WeaponId,
  delta: 1 | -1,
): void {
  if (host.shopPlayersRef.current.length === 0) return;
  if (host.gameMode === "online" && host.localShopDoneRef.current) return;

  const engine = host.engineRef.current;
  if (!engine) return;

  const enginePlayers = engine.getTankManager().getPlayers();
  const currentPlayer =
    host.gameMode === "online" && host.localPlayerId
      ? (enginePlayers.find((player) => player.id === host.localPlayerId) ??
        null)
      : enginePlayers.find(
          (player) =>
            player.id ===
            host.shopPlayersRef.current[host.currentShopIndexRef.current]?.id,
        ) || host.shopPlayersRef.current[host.currentShopIndexRef.current];

  if (!currentPlayer || !currentPlayer.isHuman) return;

  if (
    host.gameMode === "online" &&
    host.localPlayerId &&
    currentPlayer.id !== host.localPlayerId
  ) {
    return;
  }

  if (
    host.gameMode === "online" &&
    (host.shopSessionRef.current.epoch === null ||
      !host.shopSessionRef.current.authoritativeReceived ||
      host.shopSessionRef.current.pendingIntent)
  ) {
    return;
  }

  const transaction = applyShopTransaction({
    player: currentPlayer,
    counters: host.shopSessionRef.current.counters,
    weaponId,
    delta,
  });
  if (!transaction.ok) {
    host.dispatch({ type: "SET_SHOP_DENIAL", denial: transaction.reason });
    return;
  }

  if (host.gameMode === "online") {
    const shopEpoch = host.shopSessionRef.current.epoch;
    if (
      shopEpoch === null ||
      !host.shopSessionRef.current.authoritativeReceived ||
      host.shopSessionRef.current.pendingIntent
    ) {
      return;
    }
    const actionId = crypto.randomUUID();
    const expectedPurchaseCount =
      transaction.counters[currentPlayer.id]?.[weaponId] ?? 0;
    const intent: PendingShopIntent = {
      kind: "BUY_SELL",
      actionId,
      shopEpoch,
      weaponId,
      delta,
      expectedMoney: transaction.player.money,
      expectedStock: transaction.player.inventory[weaponId] ?? 0,
      expectedPurchaseCount,
    };
    host.shopSessionRef.current = {
      ...host.shopSessionRef.current,
      pendingIntent: intent,
      denial: null,
    };
    host.dispatch({ type: "SET_SHOP_PENDING", intent });
    const message: ShopBuySellMessage = {
      type: "SHOP_BUY_SELL",
      shopEpoch,
      actionId,
      weaponId,
      delta,
    };
    host.sendCombatMessage(message);
    return;
  }

  const updatedPlayers = enginePlayers.map((player) =>
    player.id === currentPlayer.id ? transaction.player : player,
  );
  engine.getTankManager().setPlayers(updatedPlayers);
  host.shopPlayersRef.current = updatedPlayers;
  host.shopSessionRef.current = {
    ...host.shopSessionRef.current,
    counters: transaction.counters,
    denial: null,
  };
  host.dispatch({
    type: "APPLY_LOCAL_SHOP_TRANSACTION",
    players: updatedPlayers,
    counters: transaction.counters,
    denial: null,
  });
}

export function shopReady(host: CompleteShopRoundHost): void {
  if (host.gameMode === "online" && host.localPlayerId) {
    const shopEpoch = host.shopSessionRef.current.epoch;
    if (
      host.localShopDoneRef.current ||
      shopEpoch === null ||
      !host.shopSessionRef.current.authoritativeReceived ||
      host.shopSessionRef.current.pendingIntent
    ) {
      return;
    }
    const me = host.engineRef.current
      ?.getTankManager()
      .getPlayers()
      .find((player) => player.id === host.localPlayerId);
    if (!me?.isHuman) return;

    const actionId = crypto.randomUUID();
    const intent: PendingShopIntent = {
      kind: "READY",
      actionId,
      shopEpoch,
    };
    host.shopSessionRef.current = {
      ...host.shopSessionRef.current,
      pendingIntent: intent,
      denial: null,
    };
    host.dispatch({ type: "SET_SHOP_PENDING", intent });
    const message: ShopReadyMessage = {
      type: "SHOP_READY",
      shopEpoch,
      actionId,
    };
    host.sendCombatMessage(message);
    return;
  }

  const idx = host.currentShopIndexRef.current;
  const shopper = host.shopPlayersRef.current[idx];
  if (host.localPlayerId && shopper && shopper.id !== host.localPlayerId) {
    return;
  }
  advanceToNextShopper(hotseatHostFrom(host));
}
