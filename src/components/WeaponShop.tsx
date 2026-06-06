import { useTranslation } from "react-i18next";
import type { Player } from "../types/player";
import {
  WEAPON_REGISTRY,
  type WeaponId,
  SHOP_WEAPON_IDS,
} from "../types/weapon";
import { VGA_PALETTE } from "../types/game";

const WEAPON_KEYS: Record<WeaponId, "weapons.MISSILE" | "weapons.GRENADE" | "weapons.CLUSTER" | "weapons.NUKE" | "weapons.THERMONUCLEAR" | "weapons.DRILLER" | "weapons.BULLET"> = {
  MISSILE: "weapons.MISSILE",
  GRENADE: "weapons.GRENADE",
  CLUSTER: "weapons.CLUSTER",
  NUKE: "weapons.NUKE",
  THERMONUCLEAR: "weapons.THERMONUCLEAR",
  DRILLER: "weapons.DRILLER",
  BULLET: "weapons.BULLET",
};

const WEAPON_DESC_KEYS: Record<WeaponId, "weapons.desc.MISSILE" | "weapons.desc.GRENADE" | "weapons.desc.CLUSTER" | "weapons.desc.NUKE" | "weapons.desc.THERMONUCLEAR" | "weapons.desc.DRILLER" | "weapons.desc.BULLET"> = {
  MISSILE: "weapons.desc.MISSILE",
  GRENADE: "weapons.desc.GRENADE",
  CLUSTER: "weapons.desc.CLUSTER",
  NUKE: "weapons.desc.NUKE",
  THERMONUCLEAR: "weapons.desc.THERMONUCLEAR",
  DRILLER: "weapons.desc.DRILLER",
  BULLET: "weapons.desc.BULLET",
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
}

export function WeaponShop({
  player,
  shopIndex,
  totalShoppers,
  onBuySell,
  onReady,
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
        padding: "16px 20px 20px",
        backgroundColor: "rgba(0, 0, 0, 0.94)",
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: 8 }}>
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
          marginBottom: 12,
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
        style={{ fontSize: "12px", color: VGA_PALETTE.GRAY, marginBottom: 10 }}
      >
        {t("shop_instructions")}
      </div>

      {/* Weapon list */}
      <div style={{ textAlign: "left", marginBottom: 16 }}>
        {SHOP_WEAPON_IDS.map((wid) => {
          const def = WEAPON_REGISTRY[wid];
          const currentStock = inventory[wid] ?? 0;
          const canAfford = money >= def.price;
          const canSell = currentStock > 0;

          return (
            <div
              key={wid}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                marginBottom: 5,
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
                    fontSize: "12px",
                    color: VGA_PALETTE.GRAY,
                    lineHeight: 1.2,
                  }}
                >
                  {t(WEAPON_DESC_KEYS[wid])}
                </div>
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
                  onClick={() => onBuySell(wid, 1)}
                  disabled={!canAfford}
                  className="retro-inc-btn"
                  style={{
                    background: canAfford ? "#003300" : "#222",
                    color: canAfford ? VGA_PALETTE.GREEN : "#555",
                    borderColor: canAfford
                      ? VGA_PALETTE.GREEN
                      : VGA_PALETTE.DARK_GRAY,
                    cursor: canAfford ? "pointer" : "not-allowed",
                  }}
                  title={t("title_buy")}
                >
                  +
                </button>
                <button
                  onClick={() => onBuySell(wid, -1)}
                  disabled={!canSell}
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
      <button
        onClick={onReady}
        className="retro-btn"
        style={{ padding: "10px 36px" }}
      >
        {t("btn_ready_next_player")}
      </button>

      <div
        style={{ fontSize: "12px", color: VGA_PALETTE.DARK_GRAY, marginTop: 8 }}
      >
        {t("ai_auto_buy_note")}
      </div>
    </div>
  );
}
