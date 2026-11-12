import {
  memo,
  useCallback,
  useRef,
  useEffect,
  useState,
  type PointerEvent,
} from "react";
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

type ButtonPointerEvent = PointerEvent<HTMLButtonElement>;

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
  // Maintien actif : premier appui prioritaire, associé à son pointerId.
  const activeHoldRef = useRef<number | null>(null);
  // Pointeur dont la capture implicite a été libérée volontairement.
  const releasedCapturePointerRef = useRef<number | null>(null);

  const stopAction = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (intervalRef.current) clearInterval(intervalRef.current);
    timeoutRef.current = null;
    intervalRef.current = null;
    activeHoldRef.current = null;
    releasedCapturePointerRef.current = null;
  }, []);

  const startAction = (pointerId: number, action: () => void) => {
    stopAction();
    activeHoldRef.current = pointerId;
    action();
    timeoutRef.current = setTimeout(() => {
      intervalRef.current = setInterval(action, 80);
    }, 250);
  };

  const isHumanTurn = !!turnInfo?.isHuman;
  const isLocked = !!turnInfo?.isInputLocked;
  const canInteract = isHumanTurn && !isLocked;
  const playerId = turnInfo?.playerId ?? null;
  const controlsActive = isTouch && canInteract;

  // Arrêt au démontage, à la disparition des commandes, au verrouillage,
  // à la perte du tour humain et au changement de joueur. Les mises à jour
  // ordinaires du HUD ne modifient pas ces dépendances.
  useEffect(() => stopAction, [controlsActive, playerId, stopAction]);

  // Arrêt à la perte de focus de la fenêtre ou lorsque le document est masqué.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) stopAction();
    };
    window.addEventListener("blur", stopAction);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", stopAction);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [stopAction]);

  const stopIfOwner = (e: ButtonPointerEvent) => {
    if (activeHoldRef.current === e.pointerId) stopAction();
  };

  const holdProps = (action: () => void) => ({
    onPointerDown: (e: ButtonPointerEvent) => {
      // Souris gauche, contact tactile ou pointe du stylet seulement.
      if (e.button !== 0 || (e.buttons & ~1) !== 0) return;
      if (!canInteract || activeHoldRef.current !== null) return;
      const target = e.currentTarget;
      startAction(e.pointerId, action);
      // Libère la capture implicite (tactile) pour recevoir pointerleave.
      if (target.hasPointerCapture?.(e.pointerId)) {
        releasedCapturePointerRef.current = e.pointerId;
        target.releasePointerCapture(e.pointerId);
      }
    },
    onPointerUp: stopIfOwner,
    onPointerCancel: stopIfOwner,
    onPointerLeave: stopIfOwner,
    onPointerMove: (e: ButtonPointerEvent) => {
      if (activeHoldRef.current !== e.pointerId) return;
      // Filet de sécurité si une capture empêche pointerleave.
      const r = e.currentTarget.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      ) {
        stopAction();
      }
    },
    onLostPointerCapture: (e: ButtonPointerEvent) => {
      if (releasedCapturePointerRef.current === e.pointerId) {
        releasedCapturePointerRef.current = null;
        return;
      }
      stopIfOwner(e);
    },
  });

  if (!isTouch) return null;

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
            className="retro-mobile-btn retro-mobile-adjust-btn btn-angle"
            aria-label="Réduire l'angle"
            disabled={!canInteract}
            {...holdProps(() => onAdjustAngle(-1))}
          >
            ◀
          </button>
          <button
            type="button"
            className="retro-mobile-btn retro-mobile-adjust-btn btn-angle"
            aria-label="Augmenter l'angle"
            disabled={!canInteract}
            {...holdProps(() => onAdjustAngle(1))}
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
            className="retro-mobile-btn retro-mobile-adjust-btn btn-power"
            aria-label="Réduire la puissance"
            disabled={!canInteract}
            {...holdProps(() => onAdjustPower(-1))}
          >
            ▼
          </button>
          <button
            type="button"
            className="retro-mobile-btn retro-mobile-adjust-btn btn-power"
            aria-label="Augmenter la puissance"
            disabled={!canInteract}
            {...holdProps(() => onAdjustPower(1))}
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
