import { describe, it, expect, vi, beforeEach } from 'vitest';
import { drawTankSprite } from '../tankSprite';
import { VGA_PALETTE } from '../../../types/game';

describe('drawTankSprite', () => {
  let mockCtx: Record<string, unknown>;

  beforeEach(() => {
    mockCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn(),
      lineWidth: 0,
      lineCap: '',
      fillStyle: '',
      strokeStyle: '',
    };
  });

  it('draws a tank sprite without throwing errors', () => {
    expect(() => {
      drawTankSprite(
        mockCtx as unknown as CanvasRenderingContext2D,
        100,
        200,
        20,
        15,
        45,
        90,
        VGA_PALETTE.RED,
      );
    }).not.toThrow();
  });

  it('saves and restores the context state appropriately', () => {
    drawTankSprite(
      mockCtx as unknown as CanvasRenderingContext2D,
      100, 200, 20, 15, 0, 0, VGA_PALETTE.BLUE,
    );

    expect(mockCtx.save).toHaveBeenCalledTimes(2);
    expect(mockCtx.restore).toHaveBeenCalledTimes(2);
  });

  it('translates to the correct x, y position', () => {
    drawTankSprite(
      mockCtx as unknown as CanvasRenderingContext2D,
      150, 250, 20, 15, 0, 0, VGA_PALETTE.GREEN,
    );

    expect(mockCtx.translate).toHaveBeenNthCalledWith(1, 150, 250);
  });
});
