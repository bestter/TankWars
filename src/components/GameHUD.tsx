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

const WEAPON_ORDER: readonly WeaponId[] = ['MISSILE', 'GRENADE', 'CLUSTER', 'NUKE', 'THERMONUCLEAR', 'DRILLER', 'BULLET', 'BULLDOZER'] as const;

function getShortLabel(id: WeaponId): string {
  switch (id) {
    case 'MISSILE': return 'MIS';
    case 'GRENADE': return 'GRE';
    case 'CLUSTER': return 'CLS';
    case 'NUKE': return 'NUK';
    case 'THERMONUCLEAR': return 'THM';
    case 'DRILLER': return 'DRL';
    case 'BULLET': return 'BLT';
    case 'BULLDOZER': return 'BLD';
  }
}

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

function PlayerReadout({ turnInfo }: Pick<GameHUDProps, "turnInfo">) {
  if (!turnInfo) {
    return <span style={{ color: VGA_PALETTE.GRAY }}>-</span>;
  }
  return (
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
  );
}

function AimReadout({ turnInfo }: Pick<GameHUDProps, "turnInfo">) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        pointerEvents: "none",
      }}
    >
      <span style={{ color: VGA_PALETTE.CYAN }}>ANG</span>
      <span style={{ color: VGA_PALETTE.YELLOW, fontWeight: "bold", minWidth: 28 }}>
        {turnInfo ? `${turnInfo.angle}°` : "--"}
      </span>
      <span style={{ color: VGA_PALETTE.CYAN, marginLeft: 4 }}>POW</span>
      <span style={{ color: VGA_PALETTE.YELLOW, fontWeight: "bold", minWidth: 20 }}>
        {turnInfo ? turnInfo.power : "--"}
      </span>
    </div>
  );
}

function TurnStatus({ turnInfo }: Pick<GameHUDProps, "turnInfo">) {
  const { t } = useTranslation();
  if (!turnInfo) return null;

  if (turnInfo.tanksAreFalling) {
    return (
      <span style={{ marginLeft: 6, color: VGA_PALETTE.YELLOW, fontSize: "12px", pointerEvents: "none", fontWeight: "bold" }}>
        {t("status_tanks_falling")}
      </span>
    );
  }
  if (turnInfo.isInputLocked) {
    return (
      <span style={{ marginLeft: 6, color: VGA_PALETTE.RED, fontSize: "12px", pointerEvents: "none" }}>
        {t("status_resolving")}
      </span>
    );
  }
  if (!turnInfo.isHuman) {
    return (
      <span style={{ marginLeft: 6, color: VGA_PALETTE.CYAN, fontSize: "12px", pointerEvents: "none" }}>
        {t("status_ai_turn")}
      </span>
    );
  }
  return null;
}

function WeaponSelector({ turnInfo, onWeaponSelect }: GameHUDProps) {
  const { t } = useTranslation();
  const currentWeapon = turnInfo?.currentWeapon;
  const inventory = turnInfo?.inventory ?? {};
  const canInteract = !!turnInfo?.isHuman && !turnInfo.isInputLocked;

  return (
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
      {WEAPON_ORDER.map((weaponId) => {
        const definition = WEAPON_REGISTRY[weaponId];
        const ammo = inventory[weaponId] ?? 0;
        const isCurrent = currentWeapon === weaponId;
        const hasAmmo = weaponId === "MISSILE" || ammo > 0;
        const selectable = canInteract && hasAmmo;
        const backgroundColor = isCurrent ? "#002200" : hasAmmo ? "#111111" : "#0a0a0a";
        const borderColor = isCurrent
          ? VGA_PALETTE.GREEN
          : hasAmmo
            ? VGA_PALETTE.GRAY
            : VGA_PALETTE.DARK_GRAY;
        const color = isCurrent
          ? definition.color
          : hasAmmo
            ? VGA_PALETTE.WHITE
            : VGA_PALETTE.DARK_GRAY;

        return (
          <button
            key={weaponId}
            type="button"
            disabled={!selectable}
            onClick={() => onWeaponSelect?.(weaponId)}
            className="retro-weapon-btn"
            style={{
              backgroundColor,
              color,
              borderColor,
              cursor: selectable ? "pointer" : "default",
              opacity: hasAmmo ? 1 : 0.55,
            }}
            title={t(WEAPON_KEYS[weaponId])}
          >
            {getShortLabel(weaponId)}:{weaponId === "MISSILE" ? "∞" : ammo}
          </button>
        );
      })}
      <TurnStatus turnInfo={turnInfo} />
    </div>
  );
}

export const GameHUD = memo(function GameHUD({ turnInfo, onWeaponSelect }: GameHUDProps) {
  const { t } = useTranslation();
  const currentWeapon = turnInfo?.currentWeapon;

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
        <PlayerReadout turnInfo={turnInfo} />
      </div>

      {/* === ANGLE / POWER === */}
      <AimReadout turnInfo={turnInfo} />

      {/* === TURN (within current combat round) === */}
      <div style={{ color: VGA_PALETTE.GRAY, pointerEvents: "none" }}>
        {t("hud_turn")}{" "}
        <span style={{ color: VGA_PALETTE.WHITE }}>
          {turnInfo ? turnInfo.turn : "-"}
        </span>
      </div>

      {/* === WEAPON + SELECTOR (clickable) === */}
      <WeaponSelector turnInfo={turnInfo} onWeaponSelect={onWeaponSelect} />

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
