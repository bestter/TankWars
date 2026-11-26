// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GameHUD } from '../GameHUD';
import { getAccessibleTankTextColor } from '../accessibleColor';
import { weaponShortLabel } from '../weaponShortLabel';
import { ALL_WEAPON_IDS } from '../../types/weapon';
import type { CurrentTurnInfo } from '../../game/engine/TurnManager';
import { VGA_PALETTE } from '../../types/game';
import fr from '../../locales/fr.json';
import en from '../../locales/en.json';

const localeMode = vi.hoisted(() => ({ current: 'key' as 'key' | 'fr' | 'en' }));

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (localeMode.current !== 'key') {
        let current: unknown = localeMode.current === 'fr' ? fr : en;
        for (const segment of key.split('.')) {
          if (current && typeof current === 'object' && segment in current) {
            current = (current as Record<string, unknown>)[segment];
          } else {
            current = undefined;
            break;
          }
        }
        if (typeof current === 'string') return current;
      }
      if (options && options.weapon !== undefined) {
        return `${key} ${options.weapon}`;
      }
      return key;
    },
  }),
}));

describe('GameHUD', () => {
  beforeEach(() => {
    localeMode.current = 'key';
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

    const playerNameEl = screen.getByText('Commander Shepard');
    expect(playerNameEl).toBeDefined();
    expect(playerNameEl.style.color).not.toBe('rgb(85, 85, 255)');
    const expectedHex = getAccessibleTankTextColor(VGA_PALETTE.BLUE);
    expect(expectedHex).toBe('#7F7FFF');
    expect(playerNameEl.style.color).toBe('rgb(127, 127, 255)');
    expect(document.querySelector('.retro-hud-player [aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByText('42°')).toBeDefined();
    expect(screen.getByText('75')).toBeDefined();

    const weaponsGroup = screen.getByRole('group', { name: 'hud_weapon' });
    expect(weaponsGroup).toBeDefined();
    const missileBtn = screen.getByRole('button', { name: 'MIS — weapons.MISSILE hud_ammo_unlimited' });
    const grenadeBtn = screen.getByRole('button', { name: 'GRE:3 — weapons.GRENADE' });
    expect(weaponsGroup.contains(missileBtn)).toBe(true);
    expect(missileBtn.getAttribute('aria-pressed')).toBe('true');
    expect(grenadeBtn.getAttribute('aria-pressed')).toBe('false');
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

  it.each([
    [{ tanksAreFalling: true }, 'local' as const, 'status_tanks_falling'],
    [{ isResolving: true, isInputLocked: true }, 'local' as const, 'status_resolving'],
    [{ isHuman: false, isInputLocked: true, isResolving: false }, 'local' as const, 'status_ai_turn'],
    [{ isHuman: false, isInputLocked: true, isResolving: false }, 'online' as const, 'status_ai_waiting'],
    [{ tanksAreFalling: true, isResolving: true, isHuman: false }, 'local' as const, 'status_tanks_falling'],
    [{ isResolving: true, isHuman: false, isInputLocked: true }, 'local' as const, 'status_resolving'],
  ])('renders the applicable turn status %# with a single accessible spinner', (overrides, gameMode, expected) => {
    const turnInfo: CurrentTurnInfo = {
      playerId: 'p-1',
      playerName: 'Commander Shepard',
      isHuman: true,
      playerColor: VGA_PALETTE.BLUE,
      angle: 45,
      power: 50,
      currentWeapon: 'MISSILE',
      inventory: { MISSILE: 99 },
      turn: 1,
      isInputLocked: false,
      tanksAreFalling: false,
      isResolving: false,
      ...overrides,
    };

    render(<GameHUD turnInfo={turnInfo} gameMode={gameMode} />);
    expect(screen.getByText(expected)).toBeDefined();
    const spinners = screen.getAllByRole('progressbar', { name: expected });
    expect(spinners).toHaveLength(1);
    expect(spinners[0].getAttribute('value')).toBeNull();
    expect(spinners[0].getAttribute('tabindex')).toBeNull();
    expect(spinners[0].closest('.retro-wait-status')).not.toBeNull();
  });

  it.each<[Partial<CurrentTurnInfo>, 'local' | 'online']>([
    [{ isHuman: true, isInputLocked: false, isResolving: false }, 'local'],
    [{ isHuman: true, isInputLocked: true, isResolving: false }, 'online'],
    [{ isCatchUp: true, tanksAreFalling: true, isResolving: true, isHuman: false }, 'online'],
    [{ isHuman: false, isInputLocked: true, isResolving: false, isSpecialTurn: true }, 'local'],
    [{ isHuman: false, isInputLocked: true, isResolving: false, isAwaitingServerTurn: true }, 'online'],
  ])('does not render any wait cause or spinner for non-wait state %#', (overrides, gameMode) => {
    const turnInfo: CurrentTurnInfo = {
      playerId: 'p-1',
      playerName: 'Commander Shepard',
      isHuman: true,
      playerColor: VGA_PALETTE.BLUE,
      angle: 45,
      power: 50,
      currentWeapon: 'MISSILE',
      inventory: { MISSILE: 99 },
      turn: 1,
      isInputLocked: false,
      tanksAreFalling: false,
      isResolving: false,
      ...overrides,
    };

    render(<GameHUD turnInfo={turnInfo} gameMode={gameMode} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(document.querySelector('.retro-wait-status')).toBeNull();
  });

  it.each(['fr', 'en'] as const)('renders localized wait causes in %s', (locale) => {
    localeMode.current = locale;
    const dict = locale === 'fr' ? fr : en;
    const base: CurrentTurnInfo = {
      playerId: 'p-1',
      playerName: 'CPU',
      isHuman: false,
      playerColor: VGA_PALETTE.BLUE,
      angle: 45,
      power: 50,
      currentWeapon: 'MISSILE',
      inventory: { MISSILE: 99 },
      turn: 1,
      isInputLocked: true,
      tanksAreFalling: false,
      isResolving: false,
    };

    const { rerender } = render(<GameHUD turnInfo={base} gameMode="local" />);
    expect(screen.getByRole('progressbar', { name: dict.status_ai_turn })).toBeDefined();

    rerender(<GameHUD turnInfo={base} gameMode="online" />);
    expect(screen.getByRole('progressbar', { name: dict.status_ai_waiting })).toBeDefined();

    rerender(<GameHUD turnInfo={{ ...base, isResolving: true }} gameMode="online" />);
    expect(screen.getByRole('progressbar', { name: dict.status_resolving })).toBeDefined();

    rerender(<GameHUD turnInfo={{ ...base, isResolving: true, tanksAreFalling: true }} gameMode="local" />);
    expect(screen.getByRole('progressbar', { name: dict.status_tanks_falling })).toBeDefined();
  });

  it('disables a weapon button when the player has no ammunition', () => {
    const turnInfo: CurrentTurnInfo = {
      playerId: 'p-1',
      playerName: 'Commander Shepard',
      isHuman: true,
      playerColor: VGA_PALETTE.BLUE,
      angle: 45,
      power: 50,
      currentWeapon: 'MISSILE',
      inventory: { MISSILE: 99, GRENADE: 0 },
      turn: 1,
      isInputLocked: false,
      tanksAreFalling: false,
    };

    render(<GameHUD turnInfo={turnInfo} />);
    expect(screen.getByTitle('weapons.GRENADE').hasAttribute('disabled')).toBe(true);
  });

  it('renders the wait spinner inside .retro-hud outside .retro-hud-weapons without capturing keyboard focus', async () => {
    const turnInfo: CurrentTurnInfo = {
      playerId: 'p-1',
      playerName: 'Commander Shepard',
      isHuman: true,
      playerColor: VGA_PALETTE.BLUE,
      angle: 45,
      power: 50,
      currentWeapon: 'MISSILE',
      inventory: { MISSILE: 99, GRENADE: 2 },
      turn: 1,
      isInputLocked: false,
      tanksAreFalling: true,
    };

    render(<GameHUD turnInfo={turnInfo} />);

    const weaponLabel = screen.getByText('hud_weapon');
    const weaponsContainer = weaponLabel.closest('.retro-hud-weapons');
    expect(weaponsContainer).not.toBeNull();
    expect(screen.getByTitle('weapons.MISSILE').closest('.retro-hud-weapons')).toBe(weaponsContainer);

    const spinner = screen.getByRole('progressbar', { name: 'status_tanks_falling' });
    const waitStatus = spinner.closest('.retro-wait-status');
    expect(waitStatus).not.toBeNull();
    expect(waitStatus?.closest('.retro-hud')).not.toBeNull();
    expect(waitStatus?.closest('.retro-hud-weapons')).toBeNull();
    expect(spinner.getAttribute('tabindex')).toBeNull();

    const user = userEvent.setup();
    for (let step = 0; step < 4; step++) {
      await user.tab();
      expect(document.activeElement).not.toBe(spinner);
      expect(waitStatus?.contains(document.activeElement)).toBe(false);
    }
  });

  it('activates a weapon button with keyboard Space/Enter', async () => {
    const user = userEvent.setup();
    const onWeaponSelect = vi.fn();
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
      isInputLocked: false,
      tanksAreFalling: false,
    };

    render(<GameHUD turnInfo={turnInfo} onWeaponSelect={onWeaponSelect} />);
    const grenadeBtn = screen.getByRole('button', { name: 'GRE:3 — weapons.GRENADE' });
    grenadeBtn.focus();
    await user.keyboard('{Enter}');
    expect(onWeaponSelect).toHaveBeenCalledWith('GRENADE');
  });

  it.each(['fr', 'en'] as const)('includes visible short label, full weapon name, and quantity in accessible names in %s (WCAG 2.5.3)', (locale) => {
    localeMode.current = locale;
    const dict = locale === 'fr' ? fr : en;
    const inventory: Partial<Record<(typeof ALL_WEAPON_IDS)[number], number>> = {
      MISSILE: 99,
      GRENADE: 3,
      CLUSTER: 2,
      NUKE: 1,
      THERMONUCLEAR: 0,
      DRILLER: 4,
      BULLET: 5,
      BULLDOZER: 2,
    };
    const turnInfo: CurrentTurnInfo = {
      playerId: 'p-1',
      playerName: 'Commander Shepard',
      isHuman: true,
      playerColor: VGA_PALETTE.BLUE,
      angle: 45,
      power: 50,
      currentWeapon: 'MISSILE',
      inventory,
      turn: 1,
      isInputLocked: false,
      tanksAreFalling: false,
    };

    render(<GameHUD turnInfo={turnInfo} />);

    for (const weaponId of ALL_WEAPON_IDS) {
      const short = weaponShortLabel(weaponId);
      const fullName = dict.weapons[weaponId];
      if (weaponId === 'MISSILE') {
        const btn = screen.getByRole('button', {
          name: `${short} — ${fullName} ${dict.hud_ammo_unlimited}`,
        });
        expect(btn).toBeDefined();
      } else {
        const qty = inventory[weaponId] ?? 0;
        const btn = screen.getByRole('button', {
          name: `${short}:${qty} — ${fullName}`,
        });
        expect(btn).toBeDefined();
      }
    }
  });
});
