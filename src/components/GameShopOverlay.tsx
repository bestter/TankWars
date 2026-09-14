import { Trans, useTranslation } from "react-i18next";
import type { ShopClientSessionState } from "./gameCanvasReducer";
import type { Player } from "../types/player";
import type { WeaponId } from "../types/weapon";
import { WeaponShop } from "./WeaponShop";

interface GameShopOverlayProps {
  readonly gameMode: "local" | "online" | undefined;
  readonly shopPlayers: Player[];
  readonly currentShopIndex: number;
  readonly shopDisplayPlayer: Player | null;
  readonly isLocalShopTurn: boolean;
  readonly localShopDone: boolean;
  readonly shopSession: ShopClientSessionState;
  readonly onBuySell: (weaponId: WeaponId, delta: 1 | -1) => void;
  readonly onReady: () => void;
}

type ShopViewProps = Omit<GameShopOverlayProps, "gameMode">;

function WaitingForOpponent({
  shopPlayers,
  currentShopIndex,
  localShopDone,
}: Pick<
  ShopViewProps,
  "shopPlayers" | "currentShopIndex" | "localShopDone"
>) {
  const { t } = useTranslation();
  return (
    <div className="retro-ai-overlay">
      {localShopDone
        ? t("shop_waiting_others")
        : t("shop_waiting_opponent", {
            name: shopPlayers[currentShopIndex]?.name ?? "",
          })}
    </div>
  );
}

function OnlineShopView(props: ShopViewProps) {
  const { t } = useTranslation();
  const {
    shopPlayers,
    shopDisplayPlayer,
    isLocalShopTurn,
    shopSession,
    onBuySell,
    onReady,
  } = props;

  if (!shopSession.authoritativeReceived) {
    return <div className="retro-ai-overlay">{t("shop_waiting_state")}</div>;
  }

  if (!isLocalShopTurn || !shopDisplayPlayer) {
    return <WaitingForOpponent {...props} />;
  }

  return (
    <WeaponShop
      player={shopDisplayPlayer}
      shopIndex={Math.max(
        0,
        shopPlayers.findIndex((player) => player.id === shopDisplayPlayer.id),
      )}
      totalShoppers={shopPlayers.filter((player) => player.isHuman).length}
      onBuySell={onBuySell}
      onReady={onReady}
      purchaseCounters={shopSession.counters[shopDisplayPlayer.id]}
      controlsDisabled={shopSession.pendingIntent !== null}
      denial={shopSession.denial}
    />
  );
}

function LocalShopView(props: ShopViewProps) {
  const {
    shopPlayers,
    currentShopIndex,
    isLocalShopTurn,
    shopSession,
    onBuySell,
    onReady,
  } = props;
  const currentPlayer = shopPlayers[currentShopIndex];

  if (currentPlayer?.isHuman) {
    if (!isLocalShopTurn) {
      return <WaitingForOpponent {...props} />;
    }
    return (
      <WeaponShop
        player={currentPlayer}
        shopIndex={currentShopIndex}
        totalShoppers={shopPlayers.length}
        onBuySell={onBuySell}
        onReady={onReady}
        purchaseCounters={shopSession.counters[currentPlayer.id]}
        controlsDisabled={shopSession.pendingIntent !== null}
        denial={shopSession.denial}
      />
    );
  }

  return (
    <div className="retro-ai-overlay">
      <Trans
        i18nKey="ai_shopping_status"
        values={{ name: currentPlayer?.name ?? "" }}
        components={{
          strong: (
            <strong style={{ color: currentPlayer?.tank.color ?? "#fff" }} />
          ),
        }}
      />
    </div>
  );
}

export function GameShopOverlay(props: GameShopOverlayProps) {
  if (props.gameMode === "online") {
    return <OnlineShopView {...props} />;
  }
  return <LocalShopView {...props} />;
}
