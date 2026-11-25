import { useEffect, useId, useRef, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Player } from "../types/player";
import {
  WEAPON_REGISTRY,
  type WeaponId,
  SHOP_WEAPON_IDS,
} from "../types/weapon";
import { VGA_PALETTE } from "../types/game";
import { SHIELD_METAL_COLOR } from "../game/round/shield";
import { getShopPolicy } from "../game/shop/shopPolicy";
import {
  applyShopTransaction,
  REINFORCED_SHIELD,
  REINFORCED_SHIELD_PRICE,
  type ShopItemId,
  type ShopPlayerCounters,
  type ShopDenial,
} from "../game/shop/shopTransaction";
import { openModalDialog, useModalDialog } from "./modalDialog";

const SHOP_DENIAL_KEYS = {
  SHIELD_ALREADY_REINFORCED: "shop_shield_already_reinforced",
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
  onBuySell: (item: ShopItemId, delta: 1 | -1) => void;
  /** Le joueur a fini ses achats → passer au suivant (humain ou IA) */
  onReady: () => void;
  /** Compteurs autoritaires de cette visite pour le joueur affiché. */
  purchaseCounters?: ShopPlayerCounters;
  /** Désactive toute intention pendant une requête en vol. */
  controlsDisabled?: boolean;
  /** Dernier refus métier ou de session à afficher. */
  denial?: ShopDenial | null;
}

interface WeaponShopRowProps {
  readonly weaponId: WeaponId;
  readonly player: Player;
  readonly inventory: Partial<Record<WeaponId, number>>;
  readonly purchaseCounters: Readonly<Partial<Record<WeaponId, number>>>;
  readonly controlsDisabled: boolean;
  readonly onBuySell: (weaponId: WeaponId, delta: 1 | -1) => void;
}

function getIncButtonStyle(
  enabled: boolean,
  activeBackground: string,
  activeColor: string,
) {
  return {
    background: enabled ? activeBackground : "#222",
    color: enabled ? activeColor : "#555",
    borderColor: enabled ? activeColor : VGA_PALETTE.DARK_GRAY,
    cursor: enabled ? "pointer" : "not-allowed",
  } as const;
}

function computeWeaponRowState({
  weaponId,
  player,
  inventory,
  purchaseCounters,
  controlsDisabled,
}: Omit<WeaponShopRowProps, "onBuySell">) {
  const def = WEAPON_REGISTRY[weaponId];
  const currentStock = inventory[weaponId] ?? 0;
  const purchaseCount = purchaseCounters[weaponId] ?? 0;
  const policy = getShopPolicy(weaponId);
  const scopedCounters = { [player.id]: purchaseCounters };
  const buyPreview = applyShopTransaction({
    player,
    counters: scopedCounters,
    weaponId,
    delta: 1,
  });
  const sellPreview = applyShopTransaction({
    player,
    counters: scopedCounters,
    weaponId,
    delta: -1,
  });
  const buyReason = buyPreview.ok ? null : buyPreview.reason;
  const sellReason = sellPreview.ok ? null : sellPreview.reason;
  const canBuy = !controlsDisabled && buyPreview.ok;
  const canSell = !controlsDisabled && sellPreview.ok;
  const buyReasonId = `shop-buy-reason-${weaponId}`;
  const sellReasonId = `shop-sell-reason-${weaponId}`;
  const showSeparateSellReason = sellReason !== null && sellReason !== buyReason;
  const buyDescribedBy = buyReason ? buyReasonId : undefined;
  let sellDescribedBy: string | undefined;
  if (sellReason) {
    sellDescribedBy = sellReason === buyReason ? buyReasonId : sellReasonId;
  }

  return {
    def,
    currentStock,
    purchaseCount,
    maxPurchasesPerVisit: policy.maxPurchasesPerVisit,
    buyReason,
    sellReason: showSeparateSellReason ? sellReason : null,
    canBuy,
    canSell,
    buyReasonId,
    sellReasonId,
    buyDescribedBy,
    sellDescribedBy,
    buyButtonStyle: getIncButtonStyle(canBuy, "#003300", VGA_PALETTE.GREEN),
    sellButtonStyle: getIncButtonStyle(canSell, "#330000", VGA_PALETTE.RED),
  };
}

function WeaponShopRow({
  weaponId,
  player,
  inventory,
  purchaseCounters,
  controlsDisabled,
  onBuySell,
}: WeaponShopRowProps) {
  const { t } = useTranslation();
  const row = computeWeaponRowState({
    weaponId,
    player,
    inventory,
    purchaseCounters,
    controlsDisabled,
  });

  return (
    <div className="weapon-shop-row">
      {/* Weapon info */}
      <div style={{ flex: "1 1 160px", minWidth: 0 }}>
        <div
          style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 6 }}
        >
          <span style={{ color: row.def.color, fontWeight: "bold", overflowWrap: "break-word" }}>
            {t(WEAPON_KEYS[weaponId])}
          </span>
          <span style={{ color: VGA_PALETTE.YELLOW }}>
            {row.def.price}$
          </span>
        </div>
        <div
          style={{
            fontSize: "12px",
            color: VGA_PALETTE.GRAY,
            lineHeight: 1.2,
          }}
        >
          {t(WEAPON_DESC_KEYS[weaponId])}
        </div>
        <div
          style={{
            fontSize: "12px",
            color: VGA_PALETTE.CYAN,
            lineHeight: 1.2,
          }}
        >
          {t("shop_bought", {
            count: row.purchaseCount,
            max: row.maxPurchasesPerVisit,
          })}
        </div>
        {row.buyReason && (
          <div
            id={row.buyReasonId}
            style={{
              fontSize: "12px",
              color: VGA_PALETTE.RED,
              lineHeight: 1.2,
            }}
          >
            {t(SHOP_DENIAL_KEYS[row.buyReason])}
          </div>
        )}
        {row.sellReason && (
          <div
            id={row.sellReasonId}
            style={{
              fontSize: "12px",
              color: VGA_PALETTE.RED,
              lineHeight: 1.2,
            }}
          >
            {t(SHOP_DENIAL_KEYS[row.sellReason])}
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
        <strong style={{ fontSize: "13px" }}>{row.currentStock}</strong>
      </div>

      {/* +/- buttons */}
      <div className="weapon-shop-actions">
        <button
          type="button"
          onClick={() => onBuySell(weaponId, 1)}
          disabled={!row.canBuy}
          aria-describedby={row.buyDescribedBy}
          className="retro-inc-btn"
          style={row.buyButtonStyle}
          title={t("title_buy")}
        >
          +
        </button>
        <button
          type="button"
          onClick={() => onBuySell(weaponId, -1)}
          disabled={!row.canSell}
          aria-describedby={row.sellDescribedBy}
          className="retro-inc-btn"
          style={row.sellButtonStyle}
          title={t("title_sell")}
        >
          −
        </button>
      </div>
    </div>
  );
}

function ReinforcedShieldRow({ player, purchaseCounters, controlsDisabled, onBuySell }: Pick<WeaponShopRowProps, "player" | "controlsDisabled"> & {
  purchaseCounters: ShopPlayerCounters;
  onBuySell: WeaponShopProps["onBuySell"];
}) {
  const { t } = useTranslation();
  const descriptionId = useId();
  const pending = player.reinforcedShieldPending === true;
  const purchase = applyShopTransaction({
    player,
    counters: { [player.id]: purchaseCounters },
    equipmentId: REINFORCED_SHIELD,
    delta: 1,
  });
  const canAct = !controlsDisabled && (pending || purchase.ok);
  return (
    <div className="weapon-shop-shield-row">
      <div id={descriptionId}>
        <strong style={{ color: SHIELD_METAL_COLOR }}>{t("shop_shield_name")}</strong>
        <span> · {REINFORCED_SHIELD_PRICE} $</span>
        <div>{t("shop_shield_description")}</div>
        <div role="status">
          {pending ? t("shop_shield_pending") : !purchase.ok && t(SHOP_DENIAL_KEYS[purchase.reason])}
        </div>
      </div>
      <button
        type="button"
        className="retro-btn"
        disabled={!canAct}
        aria-describedby={descriptionId}
        onClick={() => onBuySell(REINFORCED_SHIELD, pending ? -1 : 1)}
      >
        {t(pending ? "shop_shield_cancel" : "shop_shield_buy")}
      </button>
    </div>
  );
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
  const titleId = useId();
  const { dialogRef, handleClose } = useModalDialog();
  const weaponListRef = useRef<HTMLDivElement | null>(null);
  const readyButtonRef = useRef<HTMLButtonElement | null>(null);
  const money = player.money ?? 0;
  const inventory = player.inventory ?? {};

  useEffect(() => {
    void player.id;
    if (dialogRef.current) {
      openModalDialog(dialogRef.current);
    }
    if (weaponListRef.current) {
      weaponListRef.current.scrollTop = 0;
    }
    if (!readyButtonRef.current?.disabled) {
      readyButtonRef.current?.focus();
    }
  }, [dialogRef, player.id]);

  const handleCancel = (event: SyntheticEvent<HTMLDialogElement, Event>) => {
    event.preventDefault();
    if (!controlsDisabled) {
      onReady();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="retro-modal retro-modal-shop"
      aria-labelledby={titleId}
      onCancel={handleCancel}
      onClose={handleClose}
      style={{
        border: `4px solid ${VGA_PALETTE.MAGENTA}`,
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: 6, flexShrink: 0 }}>
        <h2
          id={titleId}
          style={{
            margin: 0,
            color: VGA_PALETTE.CYAN,
            fontSize: "13px",
            fontWeight: "normal",
          }}
        >
          {t("shop_header", { current: shopIndex + 1, total: totalShoppers })}
        </h2>
      </div>

      <div
        className="weapon-shop-player-header"
        style={{
          display: "flex",
          flexWrap: "wrap",
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
            flexShrink: 0,
          }}
        />
        <span
          style={{
            color: player.tank.color,
            fontWeight: "bold",
            fontSize: "18px",
            overflowWrap: "anywhere",
          }}
        >
          {player.name}
        </span>
        <span
          style={{
            color: VGA_PALETTE.YELLOW,
            fontSize: "20px",
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
        ref={weaponListRef}
        style={{
          textAlign: "left",
          marginBottom: 10,
          overflowY: "auto",
          flex: "1 1 auto",
          minHeight: 96,
          paddingRight: 4,
        }}
      >
        <ReinforcedShieldRow
          player={player}
          purchaseCounters={purchaseCounters}
          controlsDisabled={controlsDisabled}
          onBuySell={onBuySell}
        />
        {SHOP_WEAPON_IDS.map((wid) => (
          <WeaponShopRow
            key={wid}
            weaponId={wid}
            player={player}
            inventory={inventory}
            purchaseCounters={purchaseCounters}
            controlsDisabled={controlsDisabled}
            onBuySell={onBuySell}
          />
        ))}
      </div>

      {/* Ready button */}
      <div style={{ flexShrink: 0 }}>
        <button
          ref={readyButtonRef}
          type="button"
          onClick={onReady}
          disabled={controlsDisabled}
          className="retro-btn weapon-shop-ready-btn"
        >
          {t("btn_ready_next_player")}
        </button>

        <div
          style={{ fontSize: "12px", color: VGA_PALETTE.DARK_GRAY, marginTop: 6 }}
        >
          {t("ai_auto_buy_note")}
        </div>
      </div>
    </dialog>
  );
}
