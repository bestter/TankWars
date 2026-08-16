// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { GameHUD } from '../GameHUD';
import type { CurrentTurnInfo } from '../../game/engine/TurnManager';
import { VGA_PALETTE } from '../../types/game';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && options.weapon !== undefined) {
        return `${key} ${options.weapon}`;
      }
      return key;
    },
  }),
}));

describe('GameHUD', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it('renders placeholder dashes when turnInfo is null', () => {
    render(<GameHUD turnInfo={null} />);
    expect(screen.getByText('P:')).toBeDefined();
    expect(screen.getByText('ANG')).toBeDefined();
    expect(screen.getByText('POW')).toBeDefined();
  });

  it('renders active player name, angle, power and current weapon', () => {
    const turnInfo: CurrentTurnInfo = {
      playerId: 'p-1',
      playerName: 'Commander Shepard',
      isHuman: true,
      playerColor: VGA_PALETTE.BLUE,
      angle: 42,
      power: 75,
      currentWeapon: 'MISSILE',
      inventory: { MISSILE: 99, GRENADE: 3 },
      turn: 2,
      isInputLocked: false,
      tanksAreFalling: false,
    };

    render(<GameHUD turnInfo={turnInfo} />);

    expect(screen.getByText('Commander Shepard')).toBeDefined();
    expect(screen.getByText('42°')).toBeDefined();
    expect(screen.getByText('75')).toBeDefined();
  });

  it('triggers onWeaponSelect when clicking an owned weapon button', () => {
    const turnInfo: CurrentTurnInfo = {
      playerId: 'p-1',
      playerName: 'Commander Shepard',
      isHuman: true,
      playerColor: VGA_PALETTE.BLUE,
      angle: 45,
      power: 50,
      currentWeapon: 'MISSILE',
      inventory: { MISSILE: 99, GRENADE: 3, CLUSTER: 1 },
      turn: 1,
      isInputLocked: false,
      tanksAreFalling: false,
    };
    const onWeaponSelect = vi.fn();

    render(<GameHUD turnInfo={turnInfo} onWeaponSelect={onWeaponSelect} />);

    // Click on GRENADE button by title
    const grenadeBtn = screen.getByTitle('weapons.GRENADE');
    fireEvent.click(grenadeBtn);

    expect(onWeaponSelect).toHaveBeenCalledWith('GRENADE');
  });

  it('does not allow weapon selection when input is locked during resolution', () => {
    const turnInfo: CurrentTurnInfo = {
      playerId: 'p-1',
      playerName: 'Commander Shepard',
      isHuman: true,
      playerColor: VGA_PALETTE.BLUE,
      angle: 45,
      power: 50,
      currentWeapon: 'MISSILE',
      inventory: { MISSILE: 99, GRENADE: 3 },
      turn: 1,
      isInputLocked: true, // locked!
      tanksAreFalling: false,
    };
    const onWeaponSelect = vi.fn();

    render(<GameHUD turnInfo={turnInfo} onWeaponSelect={onWeaponSelect} />);

    const grenadeBtn = screen.getByTitle('weapons.GRENADE');
    expect(grenadeBtn.hasAttribute('disabled')).toBe(true);
    fireEvent.click(grenadeBtn);

    expect(onWeaponSelect).not.toHaveBeenCalled();
  });
});
