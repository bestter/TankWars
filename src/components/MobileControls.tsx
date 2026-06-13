import { memo, useRef, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { VGA_PALETTE } from "../types/game";
import type { CurrentTurnInfo } from "../game/engine/TurnManager";

export interface MobileControlsProps {
  turnInfo: CurrentTurnInfo | null;
  onAdjustAngle: (delta: number) => void;
  onAdjustPower: (delta: number) => void;
  onCycleWeapon: (delta: 1 | -1) => void;
  onFire: () => void;
}

export const MobileControls = memo(function MobileControls({
  turnInfo,
  onAdjustAngle,
  onAdjustPower,
  onCycleWeapon,
  onFire,
}: MobileControlsProps) {
  const { t } = useTranslation();
  const [isTouch, setIsTouch] = useState(() => {
    if (typeof window === "undefined") return false;
    const mediaQuery = window.matchMedia("(pointer: coarse)");
    return (
      mediaQuery.matches ||
      "ontouchstart" in window ||
      navigator.maxTouchPoints > 0
    );
  });

  // Détection des écrans tactiles / mobiles (écouteur de changements de configuration)
  useEffect(() => {
    const mediaQuery = window.matchMedia("(pointer: coarse)");
    const checkTouch = () => {
      setIsTouch(
        mediaQuery.matches ||
          "ontouchstart" in window ||
          navigator.maxTouchPoints > 0
      );
    };
    mediaQuery.addEventListener("change", checkTouch);
    return () => mediaQuery.removeEventListener("change", checkTouch);
  }, []);

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startAction = (action: () => void) => {
    stopAction();
    action();
    timeoutRef.current = setTimeout(() => {
      intervalRef.current = setInterval(action, 80);
    }, 250);
  };

  const stopAction = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (intervalRef.current) clearInterval(intervalRef.current);
    timeoutRef.current = null;
    intervalRef.current = null;
  };

  // Nettoyage au démontage
  useEffect(() => {
    return () => stopAction();
  }, []);

  if (!isTouch) return null;

  const isHumanTurn = !!turnInfo?.isHuman;
  const isLocked = !!turnInfo?.isInputLocked;
  const canInteract = isHumanTurn && !isLocked;

  return (
    <div className="mobile-controls-panel">
      {/* Colonne Gauche: Angle */}
      <div className="mobile-control-group">
        <span className="mobile-group-label" style={{ color: VGA_PALETTE.CYAN }}>
          ANGLE
        </span>
        <div className="mobile-button-row">
          <button
            type="button"
            className="retro-mobile-btn btn-angle"
            disabled={!canInteract}
            onMouseDown={() => startAction(() => onAdjustAngle(-1))}
            onMouseUp={stopAction}
            onMouseLeave={stopAction}
            onTouchStart={(e) => {
              e.preventDefault();
              startAction(() => onAdjustAngle(-1));
            }}
            onTouchEnd={stopAction}
            onTouchCancel={stopAction}
          >
            ◀
          </button>
          <button
            type="button"
            className="retro-mobile-btn btn-angle"
            disabled={!canInteract}
            onMouseDown={() => startAction(() => onAdjustAngle(1))}
            onMouseUp={stopAction}
            onMouseLeave={stopAction}
            onTouchStart={(e) => {
              e.preventDefault();
              startAction(() => onAdjustAngle(1));
            }}
            onTouchEnd={stopAction}
            onTouchCancel={stopAction}
          >
            ▶
          </button>
        </div>
      </div>

      {/* Colonne Milieu: Puissance */}
      <div className="mobile-control-group">
        <span className="mobile-group-label" style={{ color: VGA_PALETTE.YELLOW }}>
          POWER
        </span>
        <div className="mobile-button-row">
          <button
            type="button"
            className="retro-mobile-btn btn-power"
            disabled={!canInteract}
            onMouseDown={() => startAction(() => onAdjustPower(-1))}
            onMouseUp={stopAction}
            onMouseLeave={stopAction}
            onTouchStart={(e) => {
              e.preventDefault();
              startAction(() => onAdjustPower(-1));
            }}
            onTouchEnd={stopAction}
            onTouchCancel={stopAction}
          >
            ▼
          </button>
          <button
            type="button"
            className="retro-mobile-btn btn-power"
            disabled={!canInteract}
            onMouseDown={() => startAction(() => onAdjustPower(1))}
            onMouseUp={stopAction}
            onMouseLeave={stopAction}
            onTouchStart={(e) => {
              e.preventDefault();
              startAction(() => onAdjustPower(1));
            }}
            onTouchEnd={stopAction}
            onTouchCancel={stopAction}
          >
            ▲
          </button>
        </div>
      </div>

      {/* Colonne Droite: Arme & Tir */}
      <div className="mobile-control-group mobile-actions-group">
        <button
          type="button"
          className="retro-mobile-btn btn-weapon"
          disabled={!canInteract}
          onClick={() => onCycleWeapon(1)}
        >
          {t("mobile_weapon_btn", "WEAPON 🔄")}
        </button>
        <button
          type="button"
          className="retro-mobile-btn btn-fire"
          disabled={!canInteract}
          onClick={onFire}
          style={{
            backgroundColor: canInteract ? VGA_PALETTE.RED : "#330000",
            borderColor: canInteract ? VGA_PALETTE.WHITE : VGA_PALETTE.DARK_GRAY,
            color: canInteract ? VGA_PALETTE.WHITE : VGA_PALETTE.GRAY,
          }}
        >
          {t("mobile_fire_btn", "FIRE ! 💥")}
        </button>
      </div>
    </div>
  );
});
