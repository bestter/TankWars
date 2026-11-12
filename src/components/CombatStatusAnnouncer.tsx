import { memo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { CurrentTurnInfo } from "../game/engine/TurnManager";
import { formatWindDisplay } from "../game/wind";
import { getWindDirectionKey } from "./windI18n";

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

function areAnnouncerPropsEqual(
  prev: CombatStatusAnnouncerProps,
  next: CombatStatusAnnouncerProps,
): boolean {
  if (prev.round !== next.round || prev.wind !== next.wind) return false;
  const a = prev.turnInfo;
  const b = next.turnInfo;
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.turn === b.turn &&
    a.playerId === b.playerId &&
    a.playerName === b.playerName &&
    a.isInputLocked === b.isInputLocked &&
    a.isResolving === b.isResolving &&
    a.tanksAreFalling === b.tanksAreFalling &&
    a.isCatchUp === b.isCatchUp
  );
}

export const CombatStatusAnnouncer = memo(function CombatStatusAnnouncer({
  round,
  turnInfo,
  wind,
}: CombatStatusAnnouncerProps) {
  const { t } = useTranslation();
  const regionRef = useRef<HTMLDivElement>(null);
  const trackingRef = useRef<TurnTracking | null>(null);

  const hasTurnInfo = turnInfo !== null;
  const turn = turnInfo?.turn ?? 0;
  const playerId = turnInfo?.playerId ?? "";
  const playerName = turnInfo?.playerName ?? "";
  const isInputLocked = turnInfo?.isInputLocked ?? false;
  const isResolvingProp = turnInfo?.isResolving;
  const tanksAreFalling = turnInfo?.tanksAreFalling ?? false;
  const isCatchUp = turnInfo?.isCatchUp ?? false;

  useEffect(() => {
    return () => {
      trackingRef.current = null;
    };
  }, []);

  useEffect(() => {
    const el = regionRef.current;
    if (!el) return;

    if (!hasTurnInfo || isCatchUp) {
      trackingRef.current = null;
      el.textContent = "";
      return;
    }

    const currentTracking = trackingRef.current;
    const isNewTurn =
      !currentTracking ||
      currentTracking.round !== round ||
      currentTracking.turn !== turn ||
      currentTracking.playerId !== playerId;

    if (isNewTurn) {
      const windInfo = formatWindDisplay(wind);
      let announcement: string;
      if (windInfo.direction === "CALM") {
        announcement = t("combat_status_turn_calm", {
          turn,
          player: playerName,
        });
      } else {
        announcement = t("combat_status_turn_wind", {
          turn,
          player: playerName,
          direction: t(getWindDirectionKey(windInfo)),
          strength: windInfo.strength,
        });
      }

      trackingRef.current = {
        round,
        turn,
        playerId,
        hasAnnouncedResolving: false,
        hasAnnouncedFalling: false,
      };
      el.textContent = announcement;
      return;
    }

    // Même tour : gestion des transitions de tir et de chute
    const isResolving = isResolvingProp ?? isInputLocked;
    if (tanksAreFalling) {
      if (!currentTracking.hasAnnouncedFalling) {
        currentTracking.hasAnnouncedFalling = true;
        currentTracking.hasAnnouncedResolving = true;
        el.textContent = t("combat_status_falling");
      }
    } else if (isResolving) {
      if (!currentTracking.hasAnnouncedResolving) {
        currentTracking.hasAnnouncedResolving = true;
        el.textContent = t("combat_status_resolving");
      }
    }
  }, [
    round,
    hasTurnInfo,
    turn,
    playerId,
    playerName,
    isInputLocked,
    isResolvingProp,
    tanksAreFalling,
    isCatchUp,
    wind,
    t,
  ]);

  return (
    <div ref={regionRef} role="status" aria-live="polite" className="visually-hidden" />
  );
}, areAnnouncerPropsEqual);
