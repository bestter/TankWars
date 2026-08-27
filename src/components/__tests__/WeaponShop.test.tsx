// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { WeaponShop } from '../WeaponShop';
import { makePlayer, makeTank } from '../../game/__tests__/helpers';
import { VGA_PALETTE } from '../../types/game';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && options.current !== undefined && options.total !== undefined) {
        return `${key} ${options.current}/${options.total}`;
      }
      return key;
    },
  }),
}));

describe('WeaponShop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it('renders player name, funds and weapon catalog', () => {
    const player = makePlayer({
      id: 'p-1',
      name: 'Major Tom',
      money: 450,
      inventory: { MISSILE: 99, GRENADE: 2, CLUSTER: 0 },
      tank: makeTank('tank-1', 100, 200, { color: VGA_PALETTE.CYAN }),
    });

    const onBuySell = vi.fn();
    const onReady = vi.fn();

    render(
      <WeaponShop
        player={player}
        shopIndex={0}
        totalShoppers={2}
        onBuySell={onBuySell}
        onReady={onReady}
      />
    );

    expect(screen.getByText('Major Tom')).toBeDefined();
    expect(screen.getByText(/450/)).toBeDefined();
    expect(screen.getByText(/shop_header 1\/2/)).toBeDefined();
    expect(screen.queryByText('weapons.MISSILE')).toBeNull();
  });

  it('triggers onBuySell when clicking purchase button on an affordable weapon', () => {
    const player = makePlayer({
      id: 'p-1',
      name: 'Major Tom',
      money: 300,
      inventory: { GRENADE: 1 },
    });

    const onBuySell = vi.fn();
    const onReady = vi.fn();

    render(
      <WeaponShop
        player={player}
        shopIndex={0}
        totalShoppers={1}
        onBuySell={onBuySell}
        onReady={onReady}
      />
    );

    // Click buy button (+) for the first weapon (GRENADE)
    const buyButtons = screen.getAllByTitle('title_buy');
    fireEvent.click(buyButtons[0]);

    expect(onBuySell).toHaveBeenCalledWith('GRENADE', 1);
  });

  it('triggers onBuySell when clicking sell button on an owned weapon', () => {
    const player = makePlayer({
      id: 'p-1',
      name: 'Major Tom',
      money: 100,
      inventory: { GRENADE: 3 },
    });

    const onBuySell = vi.fn();
    const onReady = vi.fn();

    render(
      <WeaponShop
        player={player}
        shopIndex={0}
        totalShoppers={1}
        onBuySell={onBuySell}
        onReady={onReady}
      />
    );

    // Click sell button (-) for GRENADE
    const sellButtons = screen.getAllByTitle('title_sell');
    fireEvent.click(sellButtons[0]);

    expect(onBuySell).toHaveBeenCalledWith('GRENADE', -1);
  });

  it('disables buy button if player does not have enough funds', () => {
    const player = makePlayer({
      id: 'p-1',
      name: 'Broke Soldier',
      money: 10, // NUKE and THERMONUCLEAR cost more than 10
      inventory: { NUKE: 0, THERMONUCLEAR: 0 },
    });

    render(
      <WeaponShop
        player={player}
        shopIndex={0}
        totalShoppers={1}
        onBuySell={() => {}}
        onReady={() => {}}
      />
    );

    const buyButtons = screen.getAllByTitle('title_buy');
    // For NUKE (index 2 in shop list)
    expect(buyButtons[2].hasAttribute('disabled')).toBe(true);
  });

  it('exposes the domain denial and never invokes a disabled purchase', () => {
    const player = makePlayer({
      id: 'p-1',
      name: 'Broke Soldier',
      money: 0,
      inventory: { GRENADE: 0 },
    });
    const onBuySell = vi.fn();

    render(
      <WeaponShop
        player={player}
        shopIndex={0}
        totalShoppers={1}
        onBuySell={onBuySell}
        onReady={() => {}}
      />
    );

    const grenadeBuy = screen.getAllByTitle('title_buy')[0];
    const reasonId = grenadeBuy.getAttribute('aria-describedby');
    expect(reasonId).toBe('shop-buy-reason-GRENADE');
    expect(document.getElementById(reasonId ?? '')?.textContent).toBe(
      'shop_reason_insufficient_funds',
    );
    fireEvent.click(grenadeBuy);
    expect(onBuySell).not.toHaveBeenCalled();
  });

  it('disables sell button if player has 0 count of weapon', () => {
    const player = makePlayer({
      id: 'p-1',
      name: 'Major Tom',
      money: 500,
      inventory: { CLUSTER: 0 },
    });

    render(
      <WeaponShop
        player={player}
        shopIndex={0}
        totalShoppers={1}
        onBuySell={() => {}}
        onReady={() => {}}
      />
    );

    const sellButtons = screen.getAllByTitle('title_sell');
    // CLUSTER is index 1
    expect(sellButtons[1].hasAttribute('disabled')).toBe(true);
  });

  it('calls onReady when clicking the ready button', () => {
    const player = makePlayer();
    const onReady = vi.fn();

    render(
      <WeaponShop
        player={player}
        shopIndex={0}
        totalShoppers={2}
        onBuySell={() => {}}
        onReady={onReady}
      />
    );

    const readyBtn = screen.getByRole('button', { name: 'btn_ready_next_player' });
    fireEvent.click(readyBtn);

    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('blocks every callback while an authoritative intention is pending', () => {
    const player = makePlayer({ money: 1_000, inventory: { GRENADE: 2 } });
    const onBuySell = vi.fn();
    const onReady = vi.fn();

    render(
      <WeaponShop
        player={player}
        shopIndex={0}
        totalShoppers={1}
        onBuySell={onBuySell}
        onReady={onReady}
        controlsDisabled
      />
    );

    fireEvent.click(screen.getAllByTitle('title_buy')[0]);
    fireEvent.click(screen.getAllByTitle('title_sell')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'btn_ready_next_player' }));
    expect(onBuySell).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
  });
});
