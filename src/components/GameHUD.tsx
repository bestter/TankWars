import { memo, useId } from "react";
import { useTranslation } from "react-i18next";
import type { CurrentTurnInfo } from "../game/engine/TurnManager";
import { ALL_WEAPON_IDS, WEAPON_REGISTRY, type WeaponId } from "../types/weapon";
import { VGA_PALETTE } from "../types/game";
import { getAccessibleTankTextColor } from "./accessibleColor";
import { CombatWaitSpinner } from "./CombatWaitSpinner";
import { getHudWaitCauseKey, type HudWaitCauseKey } from "./combatWaitStatus";
import { WEAPON_I18N_KEYS, weaponShortLabel } from "./weaponShortLabel";

export interface GameHUDProps {
  turnInfo: CurrentTurnInfo | null;
  gameMode?: "local" | "online";
  /** Called when human clicks a weapon button. Parent wires to TurnManager.selectWeapon */
  onWeaponSelect?: (weaponId: WeaponId) => void;
}

const WAIT_CAUSE_CLASS: Record<HudWaitCauseKey, string> = {
  status_tanks_falling: "retro-wait-falling",
  status_resolving: "retro-wait-resolving",
  status_ai_turn: "retro-wait-ai",
  status_ai_waiting: "retro-wait-ai",
};

function PlayerReadout({ turnInfo }: Pick<GameHUDProps, "turnInfo">) {
  if (!turnInfo) {
    return <span style={{ color: VGA_PALETTE.GRAY }}>-</span>;
  }
  return (
    <>
      <span
        aria-hidden="true"
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
      <span
        className="retro-hud-player-name"
        style={{ color: getAccessibleTankTextColor(turnInfo.playerColor), fontWeight: "bold" }}
      >
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

function TurnStatus({ turnInfo, gameMode }: Pick<GameHUDProps, "turnInfo" | "gameMode">) {
  const { t } = useTranslation();
  const causeKey = getHudWaitCauseKey(turnInfo, gameMode);
  if (!causeKey) return null;
  return <CombatWaitSpinner label={t(causeKey)} className={WAIT_CAUSE_CLASS[causeKey]} />;
}

function WeaponSelector({ turnInfo, onWeaponSelect }: Pick<GameHUDProps, "turnInfo" | "onWeaponSelect">) {
  const { t } = useTranslation();
  const weaponGroupLabelId = useId();
  const currentWeapon = turnInfo?.currentWeapon;
  const inventory = turnInfo?.inventory ?? {};
  const canInteract = !!turnInfo?.isHuman && !turnInfo.isInputLocked;

  return (
    <div className="retro-hud-weapons" role="group" aria-labelledby={weaponGroupLabelId}>
      <span id={weaponGroupLabelId} style={{ color: VGA_PALETTE.MAGENTA, marginRight: 2 }}>{t("hud_weapon")}</span>
      {ALL_WEAPON_IDS.map((weaponId) => {
        const definition = WEAPON_REGISTRY[weaponId];
        const ammo = inventory[weaponId] ?? 0;
        const isCurrent = currentWeapon === weaponId;
        const hasAmmo = weaponId === "MISSILE" || ammo > 0;
        const selectable = canInteract && hasAmmo;
        const shortLabel = weaponShortLabel(weaponId);
        const weaponName = t(WEAPON_I18N_KEYS[weaponId]);
        const backgroundColor = isCurrent ? "#002200" : hasAmmo ? "#111111" : "#0a0a0a";
        const borderColor = isCurrent
          ? VGA_PALETTE.GREEN
          : hasAmmo
            ? VGA_PALETTE.GRAY
            : "#666666";
        const color = isCurrent
          ? definition.color
          : hasAmmo
            ? VGA_PALETTE.WHITE
            : "#888888";

        return (
          <button
            key={weaponId}
            type="button"
            disabled={!selectable}
            aria-pressed={isCurrent}
            onClick={() => onWeaponSelect?.(weaponId)}
            className="retro-weapon-btn"
            style={{
              backgroundColor,
              color,
              borderColor,
              cursor: selectable ? "pointer" : "default",
              opacity: 1,
            }}
            title={weaponName}
          >
            {weaponId === "MISSILE" ? (
              <>
                <span>{shortLabel}</span>
                <span aria-hidden="true">:∞</span>{" "}
                <span className="visually-hidden">
                  — {weaponName} {t("hud_ammo_unlimited")}
                </span>
              </>
            ) : (
              <>
                <span>
                  {shortLabel}:{ammo}
                </span>{" "}
                <span className="visually-hidden">— {weaponName}</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

export const GameHUD = memo(function GameHUD({ turnInfo, gameMode, onWeaponSelect }: GameHUDProps) {
  const { t } = useTranslation();
  const currentWeapon = turnInfo?.currentWeapon;

  return (
    <div className="retro-hud">
      {/* === PLAYER === */}
      <div className="retro-hud-player">
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
      <TurnStatus turnInfo={turnInfo} gameMode={gameMode} />

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
          {currentWeapon ? t(WEAPON_I18N_KEYS[currentWeapon]) : ""}
        </div>
      )}
    </div>
  );
});
