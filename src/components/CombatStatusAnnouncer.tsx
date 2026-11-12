import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { CurrentTurnInfo } from "../game/engine/TurnManager";
import { formatWindDisplay } from "../game/wind";

const WIND_DIR_KEYS: Record<string, "wind_dir_calm" | "wind_dir_west" | "wind_dir_east"> = {
  calm: "wind_dir_calm",
  west: "wind_dir_west",
  east: "wind_dir_east",
};

export interface CombatStatusAnnouncerProps {
  readonly round: number;
  readonly turnInfo: CurrentTurnInfo | null;
  readonly wind: number;
}

interface TurnTracking {
  round: number;
  turn: number;
  playerId: string;
  hasAnnouncedResolving: boolean;
  hasAnnouncedFalling: boolean;
}

export function CombatStatusAnnouncer({ round, turnInfo, wind }: CombatStatusAnnouncerProps) {
  const { t } = useTranslation();
  const regionRef = useRef<HTMLDivElement>(null);
  const trackingRef = useRef<TurnTracking | null>(null);

  useEffect(() => {
    const el = regionRef.current;
    if (!el) return;

    if (!turnInfo) {
      trackingRef.current = null;
      el.textContent = "";
      return;
    }

    const currentTracking = trackingRef.current;
    const isNewTurn =
      !currentTracking ||
      currentTracking.round !== round ||
      currentTracking.turn !== turnInfo.turn ||
      currentTracking.playerId !== turnInfo.playerId;

    if (isNewTurn) {
      const windInfo = formatWindDisplay(wind);
      let announcement: string;
      if (windInfo.direction === "CALM") {
        announcement = t("combat_status_turn_calm", {
          turn: turnInfo.turn,
          player: turnInfo.playerName,
        });
      } else {
        const dirKey = WIND_DIR_KEYS[windInfo.label.toLowerCase()] || "wind_dir_calm";
        announcement = t("combat_status_turn_wind", {
          turn: turnInfo.turn,
          player: turnInfo.playerName,
          direction: t(dirKey),
          strength: windInfo.strength,
        });
      }

      trackingRef.current = {
        round,
        turn: turnInfo.turn,
        playerId: turnInfo.playerId,
        hasAnnouncedResolving: false,
        hasAnnouncedFalling: false,
      };
      el.textContent = announcement;
      return;
    }

    // Même tour : gestion des transitions de tir et de chute
    if (turnInfo.tanksAreFalling) {
      if (!currentTracking.hasAnnouncedFalling) {
        currentTracking.hasAnnouncedFalling = true;
        currentTracking.hasAnnouncedResolving = true;
        el.textContent = t("combat_status_falling");
      }
    } else if (turnInfo.isInputLocked) {
      if (!currentTracking.hasAnnouncedResolving) {
        currentTracking.hasAnnouncedResolving = true;
        el.textContent = t("combat_status_resolving");
      }
    }
  }, [round, turnInfo, wind, t]);

  return (
    <div ref={regionRef} role="status" aria-live="polite" className="visually-hidden" />
  );
}
