import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { drawTankSprite } from "../game/rendering/tankSprite";
import type { Color } from "../types/game";

interface TankPreviewProps {
  color: Color;
}

export function TankPreview({ color }: TankPreviewProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Clear with a solid dark grey/black background to let the neon tank pop
    ctx.fillStyle = "#080808";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw the procedural tank sprite!
    // Centered at x=20, y=13, base width=24, height=15, hull angle 0, independent turret angle 25
    drawTankSprite(ctx, 20, 13, 24, 15, 0, 25, color);
  }, [color]);

  return (
    <div
      className="tank-preview-container"
      title={t("tank_preview_title")}
    >
      <canvas
        ref={canvasRef}
        width={40}
        height={22}
        style={{
          display: "block",
          imageRendering: "pixelated",
        }}
      />
    </div>
  );
}
