// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { TankPreview } from '../TankPreview';
import type { Color } from '../../types/game';
import { drawTankSprite } from '../../game/rendering/tankSprite';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// Mock drawTankSprite
vi.mock('../../game/rendering/tankSprite', () => ({
  drawTankSprite: vi.fn(),
}));

describe('TankPreview', () => {
  let mockGetContext: Mock;
  let mockFillRect: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();

    mockFillRect = vi.fn();
    mockGetContext = vi.fn().mockReturnValue({
      fillRect: mockFillRect,
      fillStyle: '',
    });

    // Mock getContext on HTMLCanvasElement
    HTMLCanvasElement.prototype.getContext = mockGetContext;
  });

  it('renders a canvas with correct dimensions and title', () => {
    const { container } = render(<TankPreview color={"#ff0000" as Color} />);

    const div = container.querySelector('.tank-preview-container') as HTMLDivElement;
    expect(div).not.toBeNull();
    expect(div.title).toBe('tank_preview_title');

    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    expect(canvas).not.toBeNull();
    expect(canvas.width).toBe(40);
    expect(canvas.height).toBe(22);
  });

  it('calls drawTankSprite with the correct parameters on render', () => {
    const color = "#00ff00" as Color;
    render(<TankPreview color={color} />);

    expect(mockGetContext).toHaveBeenCalledWith('2d');
    expect(mockFillRect).toHaveBeenCalledWith(0, 0, 40, 22);

    expect(drawTankSprite).toHaveBeenCalledTimes(1);

    // drawTankSprite(ctx, 20, 13, 24, 15, 0, 25, color)
    expect(drawTankSprite).toHaveBeenCalledWith(
      expect.anything(), // ctx
      20,
      13,
      24,
      15,
      0,
      25,
      color
    );
  });

  it('redraws the tank when the color prop changes', () => {
    const { rerender } = render(<TankPreview color={"#ff0000" as Color} />);

    expect(drawTankSprite).toHaveBeenCalledTimes(1);
    expect(drawTankSprite).toHaveBeenLastCalledWith(
      expect.anything(), 20, 13, 24, 15, 0, 25, "#ff0000"
    );

    rerender(<TankPreview color={"#0000ff" as Color} />);

    expect(drawTankSprite).toHaveBeenCalledTimes(2);
    expect(drawTankSprite).toHaveBeenLastCalledWith(
      expect.anything(), 20, 13, 24, 15, 0, 25, "#0000ff"
    );
  });

  it('handles null context gracefully', () => {
    // Return null from getContext
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(null);

    expect(() => render(<TankPreview color={"#ff0000" as Color} />)).not.toThrow();
    expect(drawTankSprite).not.toHaveBeenCalled();
  });
});
