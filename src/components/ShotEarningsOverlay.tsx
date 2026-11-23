import { useEffect, type CSSProperties } from "react";
import type { EarningsOverlayState } from "./gameCanvasReducer";

export const EARNINGS_DISPLAY_MS = 3_000;
const DEFAULT_CANVAS_WIDTH = 800;
const DEFAULT_CANVAS_HEIGHT = 480;
const EARNINGS_Y_OFFSET = 38;

type EarningsLineStyle = CSSProperties & {
  "--award-x": string;
  "--award-y": string;
};

function clampUnitRatio(value: number): string {
  const safeValue = Number.isFinite(value) ? value : 0.5;
  const clamped = Math.min(1, Math.max(0, safeValue));
  return String(Number(clamped.toFixed(6)));
}

interface ShotEarningsOverlayProps {
  overlay: EarningsOverlayState;
  canvasWidth?: number;
  canvasHeight?: number;
  onDismiss: () => void;
}

export function ShotEarningsOverlay({
  overlay,
  canvasWidth = DEFAULT_CANVAS_WIDTH,
  canvasHeight = DEFAULT_CANVAS_HEIGHT,
  onDismiss,
}: ShotEarningsOverlayProps) {
  const safeWidth =
    Number.isFinite(canvasWidth) && canvasWidth > 0 ? canvasWidth : DEFAULT_CANVAS_WIDTH;
  const safeHeight =
    Number.isFinite(canvasHeight) && canvasHeight > 0 ? canvasHeight : DEFAULT_CANVAS_HEIGHT;

  useEffect(() => {
    const remainingDisplay = Math.max(
      0,
      EARNINGS_DISPLAY_MS - (Date.now() - overlay.displayedAt),
    );
    const displayTimer = setTimeout(onDismiss, remainingDisplay);
    return () => {
      clearTimeout(displayTimer);
    };
  }, [overlay.displayedAt, overlay.shotId, onDismiss]);

  return (
    <div
      className="shot-earnings-overlay"
      role="status"
      aria-live="polite"
    >
      {overlay.awards.map((award) => {
        const lineStyle: EarningsLineStyle = {
          color: award.color,
          "--award-x": clampUnitRatio(award.x / safeWidth),
          "--award-y": clampUnitRatio((award.y - EARNINGS_Y_OFFSET) / safeHeight),
        };
        return (
          <div
            key={award.playerId}
            className="shot-earnings-line"
            style={lineStyle}
          >
            +{award.amount}$
          </div>
        );
      })}
    </div>
  );
}
