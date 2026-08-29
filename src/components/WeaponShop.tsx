import { useTranslation } from "react-i18next";
import type { Player } from "../types/player";
import {
  WEAPON_REGISTRY,
  type WeaponId,
  SHOP_WEAPON_IDS,
} from "../types/weapon";
import { VGA_PALETTE } from "../types/game";
import { getShopPolicy } from "../game/shop/shopPolicy";
import {
  applyShopTransaction,
  type ShopDenial,
} from "../game/shop/shopTransaction";

const SHOP_DENIAL_KEYS = {
  STOCK_CAP: "shop_reason_stock_cap",
  PURCHASE_LIMIT: "shop_reason_purchase_limit",
  INSUFFICIENT_FUNDS: "shop_reason_insufficient_funds",
  NO_STOCK: "shop_reason_no_stock",
  NOT_SOLD: "shop_reason_not_sold",
  ILLEGAL_INVENTORY: "shop_reason_illegal_inventory",
  MALFORMED: "shop_reason_malformed",
  NOT_YOUR_SLOT: "shop_reason_not_your_slot",
  ALREADY_READY: "shop_reason_already_ready",
  SHOP_CLOSED: "shop_reason_closed",
  SHOP_NOT_AVAILABLE: "shop_reason_not_available",
  STALE_SHOP_EPOCH: "shop_reason_stale_epoch",
} as const satisfies Record<ShopDenial, string>;

const WEAPON_KEYS: Record<WeaponId, "weapons.MISSILE" | "weapons.GRENADE" | "weapons.CLUSTER" | "weapons.NUKE" | "weapons.THERMONUCLEAR" | "weapons.DRILLER" | "weapons.BULLET" | "weapons.BULLDOZER"> = {
  MISSILE: "weapons.MISSILE",
  GRENADE: "weapons.GRENADE",
  CLUSTER: "weapons.CLUSTER",
  NUKE: "weapons.NUKE",
  THERMONUCLEAR: "weapons.THERMONUCLEAR",
  DRILLER: "weapons.DRILLER",
  BULLET: "weapons.BULLET",
  BULLDOZER: "weapons.BULLDOZER",
};

const WEAPON_DESC_KEYS: Record<WeaponId, "weapons.desc.MISSILE" | "weapons.desc.GRENADE" | "weapons.desc.CLUSTER" | "weapons.desc.NUKE" | "weapons.desc.THERMONUCLEAR" | "weapons.desc.DRILLER" | "weapons.desc.BULLET" | "weapons.desc.BULLDOZER"> = {
  MISSILE: "weapons.desc.MISSILE",
  GRENADE: "weapons.desc.GRENADE",
  CLUSTER: "weapons.desc.CLUSTER",
  NUKE: "weapons.desc.NUKE",
  THERMONUCLEAR: "weapons.desc.THERMONUCLEAR",
  DRILLER: "weapons.desc.DRILLER",
  BULLET: "weapons.desc.BULLET",
  BULLDOZER: "weapons.desc.BULLDOZER",
};

export interface WeaponShopProps {
  /** Le joueur dont c'est le tour d'acheter (humain) */
  player: Player;
  /** Index dans la séquence boutique (pour affichage "Joueur X / Y") */
  shopIndex: number;
  /** Nombre total de joueurs vivants qui font leurs achats */
  totalShoppers: number;
  /** Callback pour acheter (+1) ou vendre (-1) */
  onBuySell: (weaponId: WeaponId, delta: 1 | -1) => void;
  /** Le joueur a fini ses achats → passer au suivant (humain ou IA) */
  onReady: () => void;
  /** Compteurs autoritaires de cette visite pour le joueur affiché. */
  purchaseCounters?: Readonly<Partial<Record<WeaponId, number>>>;
  /** Désactive toute intention pendant une requête en vol. */
  controlsDisabled?: boolean;
  /** Dernier refus métier ou de session à afficher. */
  denial?: ShopDenial | null;
}

export function WeaponShop({
  player,
  shopIndex,
  totalShoppers,
  onBuySell,
  onReady,
  purchaseCounters = {},
  controlsDisabled = false,
  denial = null,
}: WeaponShopProps) {
  const { t } = useTranslation();
  const money = player.money ?? 0;
  const inventory = player.inventory ?? {};

  return (
    <div
      className="retro-modal"
      style={{
        border: `4px solid ${VGA_PALETTE.MAGENTA}`,
        width: "min(520px, 92%)",
        maxHeight: "min(460px, 95%)",
        display: "flex",
        flexDirection: "column",
        padding: "12px 16px",
        backgroundColor: "rgba(0, 0, 0, 0.94)",
        boxSizing: "border-box",
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: 6, flexShrink: 0 }}>
        <span style={{ color: VGA_PALETTE.CYAN, fontSize: "13px" }}>
          {t("shop_header", { current: shopIndex + 1, total: totalShoppers })}
        </span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          marginBottom: 8,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: 14,
            height: 14,
            backgroundColor: player.tank.color,
            border: `2px solid ${VGA_PALETTE.WHITE}`,
            verticalAlign: "middle",
          }}
        />
        <span
          style={{
            color: player.tank.color,
            fontWeight: "bold",
            fontSize: "18px",
          }}
        >
          {player.name}
        </span>
        <span
          style={{
            color: VGA_PALETTE.YELLOW,
            fontSize: "20px",
            marginLeft: 12,
          }}
        >
          {money}$
        </span>
      </div>

      <div
        style={{
          fontSize: "12px",
          color: VGA_PALETTE.GRAY,
          marginBottom: 8,
          flexShrink: 0,
        }}
      >
        {t("shop_instructions")}
      </div>

      {denial && (
        <div
          role="alert"
          style={{
            color: VGA_PALETTE.RED,
            fontSize: "12px",
            marginBottom: 8,
          }}
        >
          {t(SHOP_DENIAL_KEYS[denial])}
        </div>
      )}

      {/* Weapon list */}
      <div
        style={{
          textAlign: "left",
          marginBottom: 10,
          overflowY: "auto",
          flex: "1 1 auto",
          minHeight: 0,
          paddingRight: 4,
        }}
      >
        {SHOP_WEAPON_IDS.map((wid) => {
          const def = WEAPON_REGISTRY[wid];
          const currentStock = inventory[wid] ?? 0;
          const purchaseCount = purchaseCounters[wid] ?? 0;
          const policy = getShopPolicy(wid);
          const scopedCounters = {
            [player.id]: purchaseCounters,
          };
          const buyPreview = applyShopTransaction({
            player,
            counters: scopedCounters,
            weaponId: wid,
            delta: 1,
          });
          const sellPreview = applyShopTransaction({
            player,
            counters: scopedCounters,
            weaponId: wid,
            delta: -1,
          });
          const buyReason = buyPreview.ok ? null : buyPreview.reason;
          const sellReason = sellPreview.ok ? null : sellPreview.reason;
          const canBuy = !controlsDisabled && buyPreview.ok;
          const canSell = !controlsDisabled && sellPreview.ok;
          const buyReasonId = `shop-buy-reason-${wid}`;
          const sellReasonId = `shop-sell-reason-${wid}`;

          return (
            <div
              key={wid}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "5px 8px",
                marginBottom: 4,
                backgroundColor: "#111",
                border: `1px solid ${VGA_PALETTE.DARK_GRAY}`,
              }}
            >
              {/* Weapon info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{ display: "flex", justifyContent: "space-between" }}
                >
                  <span style={{ color: def.color, fontWeight: "bold" }}>
                    {t(WEAPON_KEYS[wid])}
                  </span>
                  <span style={{ color: VGA_PALETTE.YELLOW }}>
                    {def.price}$
                  </span>
                </div>
                <div
                  style={{
                    fontSize: "11px",
                    color: VGA_PALETTE.GRAY,
                    lineHeight: 1.2,
                  }}
                >
                  {t(WEAPON_DESC_KEYS[wid])}
                </div>
                <div
                  style={{
                    fontSize: "11px",
                    color: VGA_PALETTE.CYAN,
                    lineHeight: 1.2,
                  }}
                >
                  {t("shop_bought", {
                    count: purchaseCount,
                    max: policy.maxPurchasesPerVisit,
                  })}
                </div>
                {buyReason && (
                  <div
                    id={buyReasonId}
                    style={{
                      fontSize: "11px",
                      color: VGA_PALETTE.RED,
                      lineHeight: 1.2,
                    }}
                  >
                    {t(SHOP_DENIAL_KEYS[buyReason])}
                  </div>
                )}
                {sellReason && sellReason !== buyReason && (
                  <div
                    id={sellReasonId}
                    style={{
                      fontSize: "11px",
                      color: VGA_PALETTE.RED,
                      lineHeight: 1.2,
                    }}
                  >
                    {t(SHOP_DENIAL_KEYS[sellReason])}
                  </div>
                )}
              </div>

              {/* Stock */}
              <div
                style={{
                  textAlign: "center",
                  minWidth: 42,
                  color: VGA_PALETTE.CYAN,
                }}
              >
                {t("shop_stock")}
                <br />
                <strong style={{ fontSize: "13px" }}>{currentStock}</strong>
              </div>

              {/* +/- buttons */}
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <button
                  type="button"
                  onClick={() => onBuySell(wid, 1)}
                  disabled={!canBuy}
                  aria-describedby={buyReason ? buyReasonId : undefined}
                  className="retro-inc-btn"
                  style={{
                    background: canBuy ? "#003300" : "#222",
                    color: canBuy ? VGA_PALETTE.GREEN : "#555",
                    borderColor: canBuy
                      ? VGA_PALETTE.GREEN
                      : VGA_PALETTE.DARK_GRAY,
                    cursor: canBuy ? "pointer" : "not-allowed",
                  }}
                  title={t("title_buy")}
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() => onBuySell(wid, -1)}
                  disabled={!canSell}
                  aria-describedby={
                    sellReason
                      ? sellReason === buyReason
                        ? buyReasonId
                        : sellReasonId
                      : undefined
                  }
                  className="retro-inc-btn"
                  style={{
                    background: canSell ? "#330000" : "#222",
                    color: canSell ? VGA_PALETTE.RED : "#555",
                    borderColor: canSell
                      ? VGA_PALETTE.RED
                      : VGA_PALETTE.DARK_GRAY,
                    cursor: canSell ? "pointer" : "not-allowed",
                  }}
                  title={t("title_sell")}
                >
                  −
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Ready button */}
      <div style={{ flexShrink: 0 }}>
        <button
          type="button"
          onClick={onReady}
          disabled={controlsDisabled}
          className="retro-btn"
          style={{ padding: "8px 32px" }}
        >
          {t("btn_ready_next_player")}
        </button>

        <div
          style={{ fontSize: "12px", color: VGA_PALETTE.DARK_GRAY, marginTop: 6 }}
        >
          {t("ai_auto_buy_note")}
        </div>
      </div>
    </div>
  );
}
