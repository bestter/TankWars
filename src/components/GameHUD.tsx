import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { CurrentTurnInfo } from "../game/engine/TurnManager";
import type { WeaponId } from "../types/weapon";
import { WEAPON_REGISTRY } from "../types/weapon";
import { VGA_PALETTE } from "../types/game";

export interface GameHUDProps {
  turnInfo: CurrentTurnInfo | null;
  /** Called when human clicks a weapon button. Parent wires to TurnManager.selectWeapon */
  onWeaponSelect?: (weaponId: WeaponId) => void;
}

const WEAPON_ORDER: readonly WeaponId[] = ['MISSILE', 'GRENADE', 'CLUSTER', 'NUKE', 'THERMONUCLEAR', 'DRILLER', 'BULLET'] as const;

function getShortLabel(id: WeaponId): string {
  switch (id) {
    case 'MISSILE': return 'MIS';
    case 'GRENADE': return 'GRE';
    case 'CLUSTER': return 'CLS';
    case 'NUKE': return 'NUK';
    case 'THERMONUCLEAR': return 'THM';
    case 'DRILLER': return 'DRL';
    case 'BULLET': return 'BLT';
  }
}

const WEAPON_KEYS: Record<WeaponId, "weapons.MISSILE" | "weapons.GRENADE" | "weapons.CLUSTER" | "weapons.NUKE" | "weapons.THERMONUCLEAR" | "weapons.DRILLER" | "weapons.BULLET"> = {
  MISSILE: "weapons.MISSILE",
  GRENADE: "weapons.GRENADE",
  CLUSTER: "weapons.CLUSTER",
  NUKE: "weapons.NUKE",
  THERMONUCLEAR: "weapons.THERMONUCLEAR",
  DRILLER: "weapons.DRILLER",
  BULLET: "weapons.BULLET",
};

export const GameHUD = memo(function GameHUD({ turnInfo, onWeaponSelect }: GameHUDProps) {
  const { t } = useTranslation();
  const isHumanTurn = !!turnInfo?.isHuman;
  const isLocked = !!turnInfo?.isInputLocked;
  const canInteract = isHumanTurn && !isLocked;

  const currentWeapon = turnInfo?.currentWeapon;
  const inventory = turnInfo?.inventory ?? {};

  return (
    <div
      className="retro-hud"
      style={{
        border: `3px solid ${VGA_PALETTE.CYAN}`,
        fontSize: "12px",
        lineHeight: "1.1",
      }}
    >
      {/* === PLAYER === */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          pointerEvents: "none",
        }}
      >
        <span style={{ color: VGA_PALETTE.MAGENTA, fontWeight: "bold" }}>
          P:
        </span>
        {turnInfo ? (
          <>
            <span
              style={{
                display: "inline-block",
                width: 9,
                height: 9,
                backgroundColor: turnInfo.playerColor,
                border: `1px solid ${VGA_PALETTE.WHITE}`,
                marginRight: 2,
                verticalAlign: "middle",
              }}
            />
            <span style={{ color: turnInfo.playerColor, fontWeight: "bold" }}>
              {turnInfo.playerName}
            </span>
          </>
        ) : (
          <span style={{ color: VGA_PALETTE.GRAY }}>-</span>
        )}
      </div>

      {/* === ANGLE / POWER === */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          pointerEvents: "none",
        }}
      >
        <span style={{ color: VGA_PALETTE.CYAN }}>ANG</span>
        <span
          style={{
            color: VGA_PALETTE.YELLOW,
            fontWeight: "bold",
            minWidth: 28,
          }}
        >
          {turnInfo ? `${turnInfo.angle}°` : "--"}
        </span>
        <span style={{ color: VGA_PALETTE.CYAN, marginLeft: 4 }}>POW</span>
        <span
          style={{
            color: VGA_PALETTE.YELLOW,
            fontWeight: "bold",
            minWidth: 20,
          }}
        >
          {turnInfo ? turnInfo.power : "--"}
        </span>
      </div>

      {/* === TURN (within current combat round) === */}
      <div style={{ color: VGA_PALETTE.GRAY, pointerEvents: "none" }}>
        {t("hud_turn")}{" "}
        <span style={{ color: VGA_PALETTE.WHITE }}>
          {turnInfo ? turnInfo.turn : "-"}
        </span>
      </div>

      {/* === WEAPON + SELECTOR (clickable) === */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 3,
          marginLeft: "auto",
          pointerEvents: "auto",
        }}
      >
        <span style={{ color: VGA_PALETTE.MAGENTA, marginRight: 2 }}>{t("hud_weapon")}</span>

        {WEAPON_ORDER.map((wid) => {
          const def = WEAPON_REGISTRY[wid];
          const ammo = inventory[wid] ?? 0;
          const isCurrent = currentWeapon === wid;
          const hasAmmo = wid === "MISSILE" || ammo > 0;
          const selectable = canInteract && hasAmmo;

          const bg = isCurrent ? "#002200" : hasAmmo ? "#111111" : "#0a0a0a";
          const borderCol = isCurrent
            ? VGA_PALETTE.GREEN
            : hasAmmo
              ? VGA_PALETTE.GRAY
              : VGA_PALETTE.DARK_GRAY;
          const textCol = isCurrent
            ? def.color
            : hasAmmo
              ? VGA_PALETTE.WHITE
              : VGA_PALETTE.DARK_GRAY;

          return (
            <button
              key={wid}
              type="button"
              disabled={!selectable}
              onClick={() => {
                if (selectable && onWeaponSelect) {
                  onWeaponSelect(wid);
                }
              }}
              className="retro-weapon-btn"
              style={{
                backgroundColor: bg,
                color: textCol,
                borderColor: borderCol,
                cursor: selectable ? "pointer" : "default",
                opacity: hasAmmo ? 1 : 0.55,
              }}
              title={t(WEAPON_KEYS[wid])}
            >
              {getShortLabel(wid)}:{wid === "MISSILE" ? "∞" : ammo}
            </button>
          );
        })}

        {/* Lock / status indicator */}
        {turnInfo && turnInfo.tanksAreFalling && (
          <span
            style={{
              marginLeft: 6,
              color: VGA_PALETTE.YELLOW,
              fontSize: "12px",
              pointerEvents: "none",
              fontWeight: "bold",
            }}
          >
            {t("status_tanks_falling")}
          </span>
        )}
        {turnInfo && isLocked && !turnInfo.tanksAreFalling && (
          <span
            style={{
              marginLeft: 6,
              color: VGA_PALETTE.RED,
              fontSize: "12px",
              pointerEvents: "none",
            }}
          >
            {t("status_resolving")}
          </span>
        )}
        {turnInfo && !isHumanTurn && !isLocked && !turnInfo.tanksAreFalling && (
          <span
            style={{
              marginLeft: 6,
              color: VGA_PALETTE.CYAN,
              fontSize: "12px",
              pointerEvents: "none",
            }}
          >
            {t("status_ai_turn")}
          </span>
        )}
      </div>

      {/* Current weapon name (small) */}
      {turnInfo && (
        <div
          style={{
            color: VGA_PALETTE.GRAY,
            fontSize: "12px",
            pointerEvents: "none",
            minWidth: 52,
          }}
        >
          {currentWeapon ? t(WEAPON_KEYS[currentWeapon]) : ""}
        </div>
      )}
    </div>
  );
});
