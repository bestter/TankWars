import { useEffect } from "react";
import type { EarningsOverlayState } from "./gameCanvasReducer";

export const EARNINGS_DISPLAY_MS = 3_000;

interface ShotEarningsOverlayProps {
  overlay: EarningsOverlayState;
  onDismiss: () => void;
}

export function ShotEarningsOverlay({
  overlay,
  onDismiss,
}: ShotEarningsOverlayProps) {
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
          style={{ color: award.color, left: award.x, top: award.y - 38 }}
        >
          +{award.amount}$
        </div>
      ))}
    </div>
  );
}
