// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MainMenu } from '../MainMenu';
import type { Player } from '../../types/player';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && options.num !== undefined) {
        return `${key}_${options.num}`;
      }
      return key;
    },
  }),
}));

describe('MainMenu (Hotseat configuration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it('renders initial setup with 2 players (1 human, 1 CPU)', () => {
    const onStartGame = vi.fn();
    render(<MainMenu onStartGame={onStartGame} />);

    expect(screen.getByText('main_title')).toBeDefined();
    expect(screen.getByText('battle_configuration')).toBeDefined();

    // 2 player inputs by default
    const inputs = screen.getAllByRole('textbox');
    expect(inputs.length).toBe(2);

    // Start button is present and enabled
    const startButton = screen.getByRole('button', { name: 'start_battle_button' });
    expect(startButton).toBeDefined();
    expect(startButton.hasAttribute('disabled')).toBe(false);
  });

  it('updates player count when clicking 3 or 4 player buttons', () => {
    const onStartGame = vi.fn();
    render(<MainMenu onStartGame={onStartGame} />);

    // Click 3 players
    const btn3 = screen.getByRole('button', { name: '3' });
    fireEvent.click(btn3);

    let inputs = screen.getAllByRole('textbox');
    expect(inputs.length).toBe(3);

    // Click 4 players
    const btn4 = screen.getByRole('button', { name: '4' });
    fireEvent.click(btn4);

    inputs = screen.getAllByRole('textbox');
    expect(inputs.length).toBe(4);

    // Reduce back to 2 players
    const btn2 = screen.getByRole('button', { name: '2' });
    fireEvent.click(btn2);

    inputs = screen.getAllByRole('textbox');
    expect(inputs.length).toBe(2);
  });

  it('disables start button when a player name is empty or only whitespace', () => {
    const onStartGame = vi.fn();
    render(<MainMenu onStartGame={onStartGame} />);

    const inputs = screen.getAllByRole('textbox');
    const startButton = screen.getByRole('button', { name: 'start_battle_button' });

    // Empty first player's name
    fireEvent.change(inputs[0], { target: { value: '   ' } });
    expect(startButton.hasAttribute('disabled')).toBe(true);

    // Fill back
    fireEvent.change(inputs[0], { target: { value: 'TankAce' } });
    expect(startButton.hasAttribute('disabled')).toBe(false);
  });

  it('enforces 16 character name limit', () => {
    const onStartGame = vi.fn();
    render(<MainMenu onStartGame={onStartGame} />);

    const inputs = screen.getAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: 'ThisIsAVeryLongTankCommanderNameExceeding16' } });

    // Should be truncated to 16 chars
    expect((inputs[0] as HTMLInputElement).value).toBe('ThisIsAVeryLongT');
  });

  it('calls onStartGame with valid Player[] structure when clicking start button', () => {
    const onStartGame = vi.fn();
    render(<MainMenu onStartGame={onStartGame} />);

    const inputs = screen.getAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: 'Alice' } });
    fireEvent.change(inputs[1], { target: { value: 'Bob CPU' } });

    const startButton = screen.getByRole('button', { name: 'start_battle_button' });
    fireEvent.click(startButton);

    expect(onStartGame).toHaveBeenCalledTimes(1);
    const players: Player[] = onStartGame.mock.calls[0][0];
    expect(players.length).toBe(2);

    // Player 1 (Human)
    expect(players[0].name).toBe('Alice');
    expect(players[0].isHuman).toBe(true);
    expect(players[0].aiProfile).toBeUndefined();
    expect(players[0].money).toBe(250);
    expect(players[0].tank.health).toBe(100);
    expect(players[0].tank.shield).toBe(40);
    expect(players[0].tank.isDead).toBe(false);

    // Player 2 (AI)
    expect(players[1].name).toBe('Bob CPU');
    expect(players[1].isHuman).toBe(false);
    expect(players[1].aiProfile).toBe('v1-random');
    expect(players[1].money).toBe(250);
    expect(players[1].tank.health).toBe(100);
  });

  it('triggers onPlayOnline callback when clicking the online multiplayer button', () => {
    const onStartGame = vi.fn();
    const onPlayOnline = vi.fn();
    render(<MainMenu onStartGame={onStartGame} onPlayOnline={onPlayOnline} />);

    const onlineButton = screen.getByRole('button', { name: 'online_multiplayer_button' });
    fireEvent.click(onlineButton);

    expect(onPlayOnline).toHaveBeenCalledTimes(1);
  });
});
