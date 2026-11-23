import { useTranslation } from "react-i18next";
import type { Player } from "../types/player";

export interface GameOverOverlayProps {
  winner: Player | null;
}

export function GameOverOverlay({ winner }: GameOverOverlayProps) {
  const { t } = useTranslation();
  if (!winner) return null;
  return (
    <div className="game-over-overlay">
      <div
        className="game-over-winner"
        style={{ color: winner.tank.color }}
      >
        {t("winner_wins", { name: winner.name })}
      </div>
      <div className="game-over-subtitle">{t("game_over")}</div>
    </div>
  );
}
