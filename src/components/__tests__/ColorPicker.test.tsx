// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ColorPicker } from '../ColorPicker';
import type { Color } from '../../types/game';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => key + (params ? '_' + params.color : ''),
  }),
}));

describe('ColorPicker', () => {
  const mockColorPool = [
    '#ff0000' as Color,
    '#00ff00' as Color,
    '#0000ff' as Color,
  ];

  const mockOnColorSelect = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it('renders all colors in the color pool', () => {
    render(
      <ColorPicker
        selectedColor={mockColorPool[0]}
        onColorSelect={mockOnColorSelect}
        unavailableColors={new Set()}
        colorPool={mockColorPool}
      />
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(3);

    // Check titles
    expect(buttons[0].title).toBe('color_select_title_#ff0000');
    expect(buttons[1].title).toBe('color_select_title_#00ff00');
    expect(buttons[2].title).toBe('color_select_title_#0000ff');
  });

  it('highlights the selected color', () => {
    render(
      <ColorPicker
        selectedColor={mockColorPool[1]}
        onColorSelect={mockOnColorSelect}
        unavailableColors={new Set()}
        colorPool={mockColorPool}
      />
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons[1].className).toContain('selected');
    expect(buttons[0].className).not.toContain('selected');
    expect(buttons[2].className).not.toContain('selected');
  });

  it('marks unavailable colors as disabled and shows unavailable mark', () => {
    const unavailableSet = new Set<Color>([mockColorPool[2]]);
    render(
      <ColorPicker
        selectedColor={mockColorPool[0]}
        onColorSelect={mockOnColorSelect}
        unavailableColors={unavailableSet}
        colorPool={mockColorPool}
      />
    );

    const buttons = screen.getAllByRole('button');

    // Third button should be disabled
    expect(buttons[2].hasAttribute('disabled')).toBe(true);
    expect(buttons[2].className).toContain('unavailable');
    expect(buttons[2].title).toBe('color_unavailable_title');

    // Should have an X mark
    expect(buttons[2].textContent).toBe('✕');

    // Others should be enabled
    expect(buttons[0].hasAttribute('disabled')).toBe(false);
    expect(buttons[1].hasAttribute('disabled')).toBe(false);
  });

  it('calls onColorSelect when an available color is clicked', () => {
    render(
      <ColorPicker
        selectedColor={mockColorPool[0]}
        onColorSelect={mockOnColorSelect}
        unavailableColors={new Set()}
        colorPool={mockColorPool}
      />
    );

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[1]); // Click green

    expect(mockOnColorSelect).toHaveBeenCalledTimes(1);
    expect(mockOnColorSelect).toHaveBeenCalledWith(mockColorPool[1]);
  });

  it('does not call onColorSelect when an unavailable color is clicked', () => {
    const unavailableSet = new Set<Color>([mockColorPool[2]]);
    render(
      <ColorPicker
        selectedColor={mockColorPool[0]}
        onColorSelect={mockOnColorSelect}
        unavailableColors={unavailableSet}
        colorPool={mockColorPool}
      />
    );

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[2]); // Try to click blue (unavailable)

    expect(mockOnColorSelect).not.toHaveBeenCalled();
  });
});
