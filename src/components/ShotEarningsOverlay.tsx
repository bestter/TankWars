import { useEffect } from "react";
import type { EarningsOverlayState } from "./gameCanvasReducer";

export const EARNINGS_DISPLAY_MS = 3_000;
const DEFAULT_CANVAS_WIDTH = 800;
const DEFAULT_CANVAS_HEIGHT = 480;
const EARNINGS_Y_OFFSET = 38;

function clampPercent(value: number, min: number, max: number): string {
  const clamped = Math.min(max, Math.max(min, value));
  return `${Number(clamped.toFixed(4))}%`;
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
  const safeWidth = canvasWidth > 0 ? canvasWidth : DEFAULT_CANVAS_WIDTH;
  const safeHeight = canvasHeight > 0 ? canvasHeight : DEFAULT_CANVAS_HEIGHT;

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
      {overlay.awards.map((award) => (
        <div
          key={award.playerId}
          className="shot-earnings-line"
          style={{
            color: award.color,
            left: clampPercent((award.x / safeWidth) * 100, 8, 92),
            top: clampPercent(((award.y - EARNINGS_Y_OFFSET) / safeHeight) * 100, 10, 95),
          }}
        >
          +{award.amount}$
        </div>
      ))}
    </div>
  );
}
