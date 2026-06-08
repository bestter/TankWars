import { useTranslation } from "react-i18next";
import type { Player } from "../types/player";

export interface GameOverOverlayProps {
  winner: Player | null;
}

export function GameOverOverlay({ winner }: GameOverOverlayProps) {
  const { t } = useTranslation();
  if (!winner) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        textAlign: "center",
        pointerEvents: "none",
        zIndex: 10,
      }}
    >
      <div
        style={{
          fontSize: "72px",
          fontWeight: "bold",
          color: winner.tank.color,
          textShadow: "0 0 20px #000, 0 0 40px #000",
          fontFamily: "monospace",
          marginBottom: "12px",
        }}
      >
        {t("winner_wins", { name: winner.name })}
      </div>
      <div style={{ fontSize: "24px", color: "#AAAAAA" }}>{t("game_over")}</div>
    </div>
  );
}
