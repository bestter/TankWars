// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { GameOverOverlay } from '../GameOverOverlay';
import { makePlayer, makeTank } from '../../game/__tests__/helpers';
import type { Color } from '../../types/game';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && options.name !== undefined) {
        return `${key} ${options.name}`;
      }
      return key;
    },
  }),
}));

describe('GameOverOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it('renders nothing when winner is null', () => {
    const { container } = render(<GameOverOverlay winner={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders correctly when winner is provided', () => {
    const winner = makePlayer({
      id: 'player1',
      name: 'Player One',
      tank: makeTank('tank-1', 120, 300, { color: '#ff0000' as Color }),
    });

    render(<GameOverOverlay winner={winner} />);

    // Check if the winner string is rendered with correct color
    const winnerElement = screen.getByText('winner_wins Player One');
    expect(winnerElement).not.toBeNull();

    // Check color style manually since jest-dom isn't explicitly used for styles right here, or we can use generic property access
    expect(winnerElement.style.color).toBe('rgb(255, 0, 0)'); // hex #ff0000 translates to rgb(255, 0, 0) in jsdom style parsing

    // Check game_over text
    const gameOverElement = screen.getByText('game_over');
    expect(gameOverElement).not.toBeNull();
  });

  it('structures max-length 16-char winner name inside .game-over-overlay hierarchy', () => {
    const winner = makePlayer({
      id: 'player-max',
      name: 'MMMMMMMMMMMMMMMM',
      tank: makeTank('tank-max', 120, 300, { color: '#55ffff' as Color }),
    });

    const { container } = render(<GameOverOverlay winner={winner} />);

    const overlay = container.querySelector('.game-over-overlay');
    const winnerElement = overlay?.querySelector('.game-over-winner');
    const subtitleElement = overlay?.querySelector('.game-over-subtitle');

    expect(overlay).not.toBeNull();
    expect(winnerElement?.textContent).toBe('winner_wins MMMMMMMMMMMMMMMM');
    expect(subtitleElement?.textContent).toBe('game_over');
  });
});
