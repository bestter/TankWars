import { useEffect, useRef } from 'react';
import { drawTankSprite } from '../game/rendering/tankSprite';
import type { Color } from '../types/game';

interface TankPreviewProps {
  color: Color;
}

export function TankPreview({ color }: TankPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear with a solid dark grey/black background to let the neon tank pop
    ctx.fillStyle = '#080808';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw the procedural tank sprite!
    // Centered at x=20, y=13, base width=24, height=15, hull angle 0, independent turret angle 25
    drawTankSprite(ctx, 20, 13, 24, 15, 0, 25, color);
  }, [color]);

  return (
    <div
      style={{
        border: '1px solid #333333',
        borderRadius: '2px',
        background: '#080808',
        padding: '2px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: 'inset 0 0 3px rgba(0,0,0,0.8)',
        flexShrink: 0,
      }}
      title="Aperçu du tank"
    >
      <canvas
        ref={canvasRef}
        width={40}
        height={22}
        style={{
          display: 'block',
          imageRendering: 'pixelated',
        }}
      />
    </div>
  );
}
