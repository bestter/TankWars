// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MainMenu } from '../MainMenu';
import type { Player } from '../../types/player';

const translationState = vi.hoisted(() => ({
  aiNames: {} as Record<string, string>,
}));

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const aiName = translationState.aiNames[key];
      if (aiName !== undefined) return aiName;
      if (options && options.players !== undefined) {
        return `${key}_${String(options.players)}`;
      }
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
    translationState.aiNames = {
      ai_name_simple: 'Simple',
      ai_name_ok: 'OK',
      ai_name_sniper: 'Sniper',
      ai_name_expert: 'Expert',
    };
  });

  it('renders initial setup with 2 players (1 human, 1 CPU)', () => {
    const onStartGame = vi.fn();
    render(<MainMenu onStartGame={onStartGame} />);

    expect(screen.getByText('main_title')).toBeDefined();
    expect(screen.getByText('battle_configuration')).toBeDefined();

    // 2 player inputs by default
    const inputs = screen.getAllByRole('textbox');
    expect(inputs.length).toBe(2);
    expect((inputs[1] as HTMLInputElement).value).toBe('Simple');

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
    expect(inputs.map((input) => (input as HTMLInputElement).value)).toEqual([
      'default_player_name_1',
      'Simple',
      'Simple-1',
      'Simple-2',
    ]);

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

  it('rejects duplicate manual names case-insensitively after trimming', () => {
    const onStartGame = vi.fn();
    render(<MainMenu onStartGame={onStartGame} />);

    const inputs = screen.getAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: 'Patate' } });
    fireEvent.blur(inputs[0]);
    fireEvent.change(inputs[1], { target: { value: '  patate  ' } });
    fireEvent.blur(inputs[1]);

    expect(inputs[0].getAttribute('aria-invalid')).toBe('false');
    expect(inputs[0].classList.contains('retro-input-conflict-source')).toBe(true);
    expect(inputs[1].getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe(
      'player_name_duplicate_error_1',
    );
    expect(
      screen.getByRole('button', { name: 'start_battle_button' }).hasAttribute('disabled'),
    ).toBe(true);

    fireEvent.change(inputs[1], { target: { value: 'Carotte' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'start_battle_button' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('rejects duplicate accented and Unicode names case-insensitively', () => {
    render(<MainMenu onStartGame={vi.fn()} />);

    const inputs = screen.getAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: 'Élise' } });
    fireEvent.blur(inputs[0]);
    fireEvent.change(inputs[1], { target: { value: '  ÉLISE  ' } });
    fireEvent.blur(inputs[1]);

    expect(inputs[0].getAttribute('aria-invalid')).toBe('false');
    expect(inputs[0].classList.contains('retro-input-conflict-source')).toBe(true);
    expect(inputs[1].getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe(
      'player_name_duplicate_error_1',
    );
    expect(
      screen.getByRole('button', { name: 'start_battle_button' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('validates pending duplicate names when another button is pressed', () => {

    render(<MainMenu onStartGame={vi.fn()} />);

    const inputs = screen.getAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: 'Patate' } });
    fireEvent.change(inputs[1], { target: { value: 'PATATE' } });
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '3' }));

    expect(screen.getByRole('alert')).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'start_battle_button' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('validates duplicate names and blocks starting the game', () => {
    const onStartGame = vi.fn();
    render(<MainMenu onStartGame={onStartGame} />);

    const inputs = screen.getAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: 'Patate' } });
    fireEvent.change(inputs[1], { target: { value: 'patate' } });
    fireEvent.click(screen.getByRole('button', { name: 'start_battle_button' }));

    expect(onStartGame).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeDefined();
  });

  it('marks only the edited field invalid for a triple duplicate', () => {
    render(<MainMenu onStartGame={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '3' }));

    const inputs = screen.getAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: 'Patate' } });
    fireEvent.change(inputs[1], { target: { value: 'PATATE' } });
    fireEvent.change(inputs[2], { target: { value: ' patate ' } });
    fireEvent.blur(inputs[2]);

    expect(inputs[0].getAttribute('aria-invalid')).toBe('false');
    expect(inputs[1].getAttribute('aria-invalid')).toBe('false');
    expect(inputs[2].getAttribute('aria-invalid')).toBe('true');
    expect(inputs[0].classList.contains('retro-input-conflict-source')).toBe(true);
    expect(inputs[1].classList.contains('retro-input-conflict-source')).toBe(true);
    expect(screen.getByRole('alert').textContent).toBe(
      'player_name_duplicate_error_1, 2',
    );
    expect(
      screen.getByRole('button', { name: 'start_battle_button' }).hasAttribute('disabled'),
    ).toBe(true);
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

  it.each([
    ['v1-random', 'Simple'],
    ['v2-heuristic', 'OK'],
    ['v3-sniper', 'Sniper'],
    ['v4-smart', 'Expert'],
  ] as const)('names the selected %s profile %s', (profile, expectedName) => {
    render(<MainMenu onStartGame={vi.fn()} />);

    fireEvent.change(screen.getAllByRole('combobox')[1], {
      target: { value: profile },
    });

    expect((screen.getAllByRole('textbox')[1] as HTMLInputElement).value).toBe(
      expectedName,
    );
  });

  it('numbers repeated AI profiles from all other current players', () => {
    render(<MainMenu onStartGame={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '4' }));

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[1], { target: { value: 'v3-sniper' } });
    fireEvent.change(selects[2], { target: { value: 'v3-sniper' } });
    fireEvent.change(selects[3], { target: { value: 'v3-sniper' } });

    expect(
      screen.getAllByRole('textbox').map((input) => (input as HTMLInputElement).value),
    ).toEqual(['default_player_name_1', 'Sniper', 'Sniper-1', 'Sniper-2']);
  });

  it('counts a matching AI configured in a later player slot', () => {
    render(<MainMenu onStartGame={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '4' }));

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[3], { target: { value: 'v3-sniper' } });
    fireEvent.change(selects[2], { target: { value: 'v3-sniper' } });

    const inputs = screen.getAllByRole('textbox');
    expect((inputs[2] as HTMLInputElement).value).toBe('Sniper-1');
    expect((inputs[3] as HTMLInputElement).value).toBe('Sniper');
  });

  it('counts a manually renamed AI as an occurrence of its profile', () => {
    render(<MainMenu onStartGame={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '3' }));

    const inputs = screen.getAllByRole('textbox');
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(inputs[1], { target: { value: 'Ace Bot' } });
    fireEvent.change(selects[2], { target: { value: 'v2-heuristic' } });
    fireEvent.change(selects[2], { target: { value: 'v1-random' } });

    expect((inputs[1] as HTMLInputElement).value).toBe('Ace Bot');
    expect((inputs[2] as HTMLInputElement).value).toBe('Simple-1');
  });

  it('preserves the AI name when switching its controller back to human', () => {
    const onStartGame = vi.fn();
    render(<MainMenu onStartGame={onStartGame} />);

    const controller = screen.getAllByRole('combobox')[1];
    const nameInput = screen.getAllByRole('textbox')[1] as HTMLInputElement;
    fireEvent.change(controller, { target: { value: 'v3-sniper' } });
    expect(nameInput.value).toBe('Sniper');

    fireEvent.change(controller, { target: { value: 'human' } });
    expect(nameInput.value).toBe('Sniper');

    fireEvent.click(screen.getByRole('button', { name: 'start_battle_button' }));
    const players: Player[] = onStartGame.mock.calls[0][0];
    expect(players[1].name).toBe('Sniper');
    expect(players[1].isHuman).toBe(true);
    expect(players[1].aiProfile).toBeUndefined();
  });

  it('avoids AI name collisions with human names regardless of case or whitespace', () => {
    render(<MainMenu onStartGame={vi.fn()} />);

    const inputs = screen.getAllByRole('textbox');
    fireEvent.change(screen.getAllByRole('combobox')[1], {
      target: { value: 'human' },
    });
    fireEvent.change(inputs[0], { target: { value: '  simple  ' } });
    fireEvent.change(inputs[1], { target: { value: 'Patate' } });
    fireEvent.click(screen.getByRole('button', { name: '3' }));

    expect((screen.getAllByRole('textbox')[2] as HTMLInputElement).value).toBe(
      'Simple-1',
    );
  });

  it('avoids AI name collisions with a differently profiled AI', () => {
    render(<MainMenu onStartGame={vi.fn()} />);

    fireEvent.change(screen.getAllByRole('combobox')[1], {
      target: { value: 'v4-smart' },
    });
    fireEvent.change(screen.getAllByRole('textbox')[1], {
      target: { value: 'simple' },
    });
    fireEvent.click(screen.getByRole('button', { name: '3' }));

    expect((screen.getAllByRole('textbox')[2] as HTMLInputElement).value).toBe(
      'Simple-1',
    );
  });

  it('uses the first available AI suffix when generated names have a gap', () => {
    render(<MainMenu onStartGame={vi.fn()} />);

    const inputs = screen.getAllByRole('textbox');
    fireEvent.change(screen.getAllByRole('combobox')[1], {
      target: { value: 'human' },
    });
    fireEvent.change(inputs[0], { target: { value: 'Simple' } });
    fireEvent.change(inputs[1], { target: { value: 'Simple-2' } });
    fireEvent.click(screen.getByRole('button', { name: '3' }));

    expect((screen.getAllByRole('textbox')[2] as HTMLInputElement).value).toBe(
      'Simple-1',
    );
  });

  it('renames only the selected player and does not renumber existing names', () => {
    render(<MainMenu onStartGame={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '4' }));

    fireEvent.change(screen.getAllByRole('combobox')[1], {
      target: { value: 'v4-smart' },
    });

    expect(
      screen.getAllByRole('textbox').map((input) => (input as HTMLInputElement).value),
    ).toEqual(['default_player_name_1', 'Expert', 'Simple-1', 'Simple-2']);
  });

  it('keeps an assigned AI name frozen across translation changes', () => {
    const onStartGame = vi.fn();
    const view = render(<MainMenu onStartGame={onStartGame} />);
    fireEvent.change(screen.getAllByRole('combobox')[1], {
      target: { value: 'v3-sniper' },
    });
    expect((screen.getAllByRole('textbox')[1] as HTMLInputElement).value).toBe('Sniper');

    translationState.aiNames = {
      ai_name_simple: 'Simple EN',
      ai_name_ok: 'OK EN',
      ai_name_sniper: 'Sniper EN',
      ai_name_expert: 'Expert EN',
    };
    view.rerender(<MainMenu onStartGame={onStartGame} />);
    expect((screen.getAllByRole('textbox')[1] as HTMLInputElement).value).toBe('Sniper');

    fireEvent.change(screen.getAllByRole('combobox')[1], {
      target: { value: 'v4-smart' },
    });
    expect((screen.getAllByRole('textbox')[1] as HTMLInputElement).value).toBe(
      'Expert EN',
    );
  });

  it('keeps an AI name editable after profile selection', () => {
    const onStartGame = vi.fn();
    render(<MainMenu onStartGame={onStartGame} />);
    fireEvent.change(screen.getAllByRole('combobox')[1], {
      target: { value: 'v4-smart' },
    });
    fireEvent.change(screen.getAllByRole('textbox')[1], {
      target: { value: 'Ace Bot' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'start_battle_button' }));

    const players: Player[] = onStartGame.mock.calls[0][0];
    expect(players[1].name).toBe('Ace Bot');
    expect(players[1].aiProfile).toBe('v4-smart');
  });

  it('triggers onPlayOnline callback when clicking the online multiplayer button', () => {
    const onStartGame = vi.fn();
    const onPlayOnline = vi.fn();
    render(<MainMenu onStartGame={onStartGame} onPlayOnline={onPlayOnline} />);

    const onlineButton = screen.getByRole('button', { name: 'online_multiplayer_button' });
    fireEvent.click(onlineButton);

    expect(onPlayOnline).toHaveBeenCalledTimes(1);
  });

  it('allows online play while local duplicate names remain invalid', () => {
    const onStartGame = vi.fn();
    const onPlayOnline = vi.fn();
    render(<MainMenu onStartGame={onStartGame} onPlayOnline={onPlayOnline} />);

    const inputs = screen.getAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: 'Patate' } });
    fireEvent.change(inputs[1], { target: { value: 'patate' } });
    fireEvent.click(screen.getByRole('button', { name: 'online_multiplayer_button' }));

    expect(onPlayOnline).toHaveBeenCalledTimes(1);
    expect(onStartGame).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'start_battle_button' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('detects duplicate created by switching AI to human and blocks start on click', () => {
    const onStartGame = vi.fn();
    render(<MainMenu onStartGame={onStartGame} />);

    const inputs = screen.getAllByRole('textbox');
    const selects = screen.getAllByRole('combobox');
    const startButton = screen.getByRole('button', { name: 'start_battle_button' });

    // Rename player 1 (Human) to "Sniper"
    fireEvent.change(inputs[0], { target: { value: 'Sniper' } });
    fireEvent.blur(inputs[0]);

    // Set player 2 name to "Sniper" while still AI
    fireEvent.change(inputs[1], { target: { value: 'Sniper' } });

    // Switch player 2 controller to human
    fireEvent.change(selects[1], { target: { value: 'human' } });

    // Both players have name "Sniper", but visibleErrorIds is not committed yet; start is enabled
    expect(startButton.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();

    // Clicking Start triggers validation, reveals error, and blocks onStartGame
    fireEvent.click(startButton);

    expect(onStartGame).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeDefined();
    expect(startButton.hasAttribute('disabled')).toBe(true);
  });

  it('clears duplicate error when reducing player count removes the conflicting slot', () => {
    const onStartGame = vi.fn();
    render(<MainMenu onStartGame={onStartGame} />);

    // Expand to 4 players
    fireEvent.click(screen.getByRole('button', { name: '4' }));

    let inputs = screen.getAllByRole('textbox');
    expect(inputs.length).toBe(4);

    fireEvent.change(inputs[0], { target: { value: 'Patate' } });
    fireEvent.blur(inputs[0]);

    // Player 4 duplicates Player 1's name
    fireEvent.change(inputs[3], { target: { value: 'Patate' } });
    fireEvent.blur(inputs[3]);

    const startButton = screen.getByRole('button', { name: 'start_battle_button' });
    expect(screen.getByRole('alert')).toBeDefined();
    expect(startButton.hasAttribute('disabled')).toBe(true);

    // Reduce to 2 players (slots 3 and 4 are removed)
    fireEvent.click(screen.getByRole('button', { name: '2' }));

    inputs = screen.getAllByRole('textbox');
    expect(inputs.length).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(startButton.hasAttribute('disabled')).toBe(false);

    // Start now works cleanly
    fireEvent.click(startButton);
    expect(onStartGame).toHaveBeenCalledTimes(1);
    expect(onStartGame.mock.calls[0][0].length).toBe(2);
  });
});


