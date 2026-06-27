// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { GameControlsExplanation } from '../GameControlsExplanation';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => `translated_${key}`,
  }),
}));

describe('GameControlsExplanation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it('renders translated text correctly', () => {
    render(<GameControlsExplanation />);

    // Check if the title is rendered strongly
    const strongElement = screen.getByText('translated_controls_title');
    expect(strongElement.tagName).toBe('STRONG');

    // Check if other texts are rendered
    expect(screen.getByText(/translated_controls_body/)).toBeDefined();
    expect(screen.getByText(/translated_controls_explanation/)).toBeDefined();
  });

  it('applies the correct inline styles', () => {
    const { container } = render(<GameControlsExplanation />);
    const divElement = container.firstChild as HTMLElement;

    // JSDOM converts hex colors to rgb
    expect(divElement.style.color).toBe('rgb(170, 170, 170)');
    expect(divElement.style.fontSize).toBe('12px');
    expect(divElement.style.textAlign).toBe('center');
  });
});
