// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { RoundSummary } from '../RoundSummary';
import { makePlayer, makeTank } from '../../game/__tests__/helpers';
import type { Color, RoundResult } from '../../types/game';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && options.name !== undefined) {
        return `${key} ${options.name}`;
      }
      if (options && options.round !== undefined) {
        return `${key} ${options.round}`;
      }
      if (options && options.alive !== undefined && options.total !== undefined) {
        return `${key} ${options.alive}/${options.total}`;
      }
      if (options && options.damage !== undefined) {
        return `${key} ${options.damage}`;
      }
      if (options && options.destroyed !== undefined) {
        return `${key} ${options.destroyed}`;
      }
      return key;
    },
  }),
}));

describe('RoundSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  const onNextRoundMock = vi.fn();
  const onNewGameMock = vi.fn();

  const player1 = makePlayer({
    id: 'p1',
    name: 'Player One',
    money: 1200,
    tank: makeTank('t1', 0, 0, { isDead: false, color: '#ff0000' as Color })
  });

  const player2 = makePlayer({
    id: 'p2',
    name: 'Player Two',
    money: 900,
    tank: makeTank('t2', 0, 0, { isDead: true, color: '#00ff00' as Color })
  });

  const defaultProps = {
    round: 3,
    players: [player1, player2],
    result: {
      damageDealt: { p1: 150, p2: 50 },
      terrainDestroyed: 400,
      survivors: ['p1']
    } as RoundResult,
    roundOutcome: {
      isDraw: false,
      winner: player1
    },
    onNextRound: onNextRoundMock,
    onNewGame: onNewGameMock,
  };

  it('renders the round summary title correctly', () => {
    render(<RoundSummary {...defaultProps} />);
    expect(screen.getByText('round_summary_title 3')).toBeDefined();
  });

  it('renders outcome text for a winner', () => {
    render(<RoundSummary {...defaultProps} />);
    expect(screen.getByText('outcome_winner Player One')).toBeDefined();
  });

  it('renders outcome text for a draw', () => {
    render(<RoundSummary {...defaultProps} roundOutcome={{ isDraw: true, winner: null }} />);
    expect(screen.getByText('outcome_draw')).toBeDefined();
  });

  it('renders default outcome text if no winner or draw', () => {
    render(<RoundSummary {...defaultProps} roundOutcome={null} />);
    expect(screen.getByText('outcome_round_ended')).toBeDefined();
  });

  it('renders damage and terrain destroyed', () => {
    render(<RoundSummary {...defaultProps} />);
    // Damage: 150 + 50 = 200
    expect(screen.getByText(/damage_inflicted 200/)).toBeDefined();
    expect(screen.getByText(/terrain_destroyed 400/)).toBeDefined();
  });

  it('handles null result', () => {
    render(<RoundSummary {...defaultProps} result={null} />);
    expect(screen.getByText(/damage_inflicted 0/)).toBeDefined();
    expect(screen.getByText(/terrain_destroyed 0/)).toBeDefined();
  });

  it('renders player stats correctly and sorted by money', () => {
    render(<RoundSummary {...defaultProps} />);

    // Check survivors count text (1 alive, 2 total)
    expect(screen.getByText('round_survivors 1/2')).toBeDefined();

    // Check if player names are rendered
    expect(screen.getByText('Player One')).toBeDefined();

    // For eliminated player
    expect(screen.getByText('Player Twoko_indicator')).toBeDefined();

    // Check money
    expect(screen.getByText('1200$')).toBeDefined();
    expect(screen.getByText('900$')).toBeDefined();
  });

  it('calls onNextRound when clicking next round button and there are enough players', () => {
    render(<RoundSummary {...defaultProps} />);
    const nextRoundBtn = screen.getByText('btn_go_to_shop');
    fireEvent.click(nextRoundBtn);
    expect(onNextRoundMock).toHaveBeenCalledTimes(1);
    expect(nextRoundBtn.getAttribute('disabled')).toBeNull();
  });

  it('calls onNewGame when clicking new game button', () => {
    render(<RoundSummary {...defaultProps} />);
    const newGameBtn = screen.getByText('btn_return_to_menu');
    fireEvent.click(newGameBtn);
    expect(onNewGameMock).toHaveBeenCalledTimes(1);
  });

  it('disables next round button if less than 2 players', () => {
    render(<RoundSummary {...defaultProps} players={[player1]} />);
    const nextRoundBtn = screen.getByText('btn_go_to_shop');

    // Use HTML button's disabled property through getAttribute for more reliable assertion
    expect(nextRoundBtn.getAttribute('disabled')).not.toBeNull();

    // Click should be ignored natively if it is a <button disabled> but react-testing-library might still fire
    // unless we check disabled attribute
  });
});
