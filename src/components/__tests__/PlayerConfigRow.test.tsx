// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PlayerConfigRow } from '../PlayerConfigRow';
import type { PlayerConfig } from '../MainMenu';
import { VGA_PALETTE } from '../../types/game';

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

describe('PlayerConfigRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  const sampleColorPool = [VGA_PALETTE.BLUE, VGA_PALETTE.RED, VGA_PALETTE.GREEN] as const;

  it('renders human player row with name input and human controller select', () => {
    const cfg: PlayerConfig = {
      id: 'p-1',
      name: 'Player 1',
      isHuman: true,
      color: VGA_PALETTE.BLUE,
    };
    const onNameChange = vi.fn();
    const onColorSelect = vi.fn();
    const onTypeChange = vi.fn();
    const onUpdatePlayer = vi.fn();

    render(
      <PlayerConfigRow
        cfg={cfg}
        index={0}
        unavailableColors={new Set([VGA_PALETTE.RED])}
        colorPool={sampleColorPool}
        nameInputRef={() => {}}
        onNameChange={onNameChange}
        onColorSelect={onColorSelect}
        onTypeChange={onTypeChange}
        onUpdatePlayer={onUpdatePlayer}
      />
    );

    const input = screen.getByRole('textbox');
    expect((input as HTMLInputElement).value).toBe('Player 1');

    const select = screen.getByRole('combobox');
    expect((select as HTMLSelectElement).value).toBe('human');
  });

  it('triggers onNameChange when editing the name input', () => {
    const cfg: PlayerConfig = {
      id: 'p-1',
      name: 'Player 1',
      isHuman: true,
      color: VGA_PALETTE.BLUE,
    };
    const onNameChange = vi.fn();

    render(
      <PlayerConfigRow
        cfg={cfg}
        index={0}
        unavailableColors={new Set()}
        colorPool={sampleColorPool}
        nameInputRef={() => {}}
        onNameChange={onNameChange}
        onColorSelect={() => {}}
        onTypeChange={() => {}}
        onUpdatePlayer={() => {}}
      />
    );

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Commander Z' } });

    expect(onNameChange).toHaveBeenCalledWith(0, 'Commander Z');
  });

  it('triggers onUpdatePlayer with AI profile when changing controller to an AI option', () => {
    const cfg: PlayerConfig = {
      id: 'p-1',
      name: 'Player 1',
      isHuman: true,
      color: VGA_PALETTE.BLUE,
    };
    const onUpdatePlayer = vi.fn();

    render(
      <PlayerConfigRow
        cfg={cfg}
        index={0}
        unavailableColors={new Set()}
        colorPool={sampleColorPool}
        nameInputRef={() => {}}
        onNameChange={() => {}}
        onColorSelect={() => {}}
        onTypeChange={() => {}}
        onUpdatePlayer={onUpdatePlayer}
      />
    );

    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'v3-sniper' } });

    expect(onUpdatePlayer).toHaveBeenCalledWith(0, {
      isHuman: false,
      aiProfile: 'v3-sniper',
    });
  });

  it('triggers onTypeChange when changing controller from AI back to human', () => {
    const cfg: PlayerConfig = {
      id: 'p-2',
      name: 'CPU Bot',
      isHuman: false,
      aiProfile: 'v2-heuristic',
      color: VGA_PALETTE.RED,
    };
    const onTypeChange = vi.fn();

    render(
      <PlayerConfigRow
        cfg={cfg}
        index={1}
        unavailableColors={new Set()}
        colorPool={sampleColorPool}
        nameInputRef={() => {}}
        onNameChange={() => {}}
        onColorSelect={() => {}}
        onTypeChange={onTypeChange}
        onUpdatePlayer={() => {}}
      />
    );

    const select = screen.getByRole('combobox');
    expect((select as HTMLSelectElement).value).toBe('v2-heuristic');

    fireEvent.change(select, { target: { value: 'human' } });

    expect(onTypeChange).toHaveBeenCalledWith(1, true);
  });
});
