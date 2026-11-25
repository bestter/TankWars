// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { WeaponShop } from '../WeaponShop';
import { makePlayer, makeTank } from '../../game/__tests__/helpers';
import { VGA_PALETTE } from '../../types/game';

function installDialogPrototypeMocks() {
  const originalShowModal = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    'showModal',
  );
  const originalClose = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    'close',
  );

  const showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  const close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });

  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    writable: true,
    value: showModal,
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    writable: true,
    value: close,
  });

  return {
    showModal,
    close,
    restore() {
      if (originalShowModal) {
        Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
      } else {
        delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
      }
      if (originalClose) {
        Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
      } else {
        delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
      }
    },
  };
}

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && options.current !== undefined && options.total !== undefined) {
        return `${key} ${options.current}/${options.total}`;
      }
      if (options && options.count !== undefined && options.max !== undefined) {
        return `${key} ${options.count}/${options.max}`;
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

  it('puts reinforcement first and exposes purchase, cancellation and the spent quota', () => {
    const player = makePlayer({ money: 420, inventory: {}, tank: makeTank('shielded', 100, 300, { maxShield: 40, shield: 40 }) });
    const onBuySell = vi.fn();
    const props = { player, shopIndex: 0, totalShoppers: 2, onBuySell, onReady: vi.fn() };
    const { rerender } = render(<WeaponShop {...props} />);
    const buy = screen.getByRole('button', { name: 'shop_shield_buy' });
    const description = document.getElementById(buy.getAttribute('aria-describedby') ?? '');
    expect(description?.textContent).toContain('420 $');
    expect(description?.parentElement).toBe(description?.parentElement?.parentElement?.firstElementChild);
    fireEvent.click(buy);
    expect(onBuySell).toHaveBeenLastCalledWith('REINFORCED_SHIELD', 1);
    const purchaseCounters = { REINFORCED_SHIELD: 1 };
    rerender(<WeaponShop {...props} player={{ ...player, money: 0, reinforcedShieldPending: true }} purchaseCounters={purchaseCounters} />);
    fireEvent.click(screen.getByRole('button', { name: 'shop_shield_cancel' }));
    expect(onBuySell).toHaveBeenLastCalledWith('REINFORCED_SHIELD', -1);
    rerender(<WeaponShop {...props} purchaseCounters={purchaseCounters} />);
    expect(screen.getByRole('button', { name: 'shop_shield_buy' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('status').textContent).toContain('shop_reason_purchase_limit');
    rerender(<WeaponShop {...props} player={{ ...player, id: 'next', money: 419 }} />);
    expect(screen.getByRole('status').textContent).toContain('shop_reason_insufficient_funds');
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

  it('exposes stock caps and per-visit quotas from authoritative counters', () => {
    const player = makePlayer({
      money: 10_000,
      inventory: { NUKE: 2, THERMONUCLEAR: 0, GRENADE: 1 },
    });

    render(
      <WeaponShop
        player={player}
        shopIndex={0}
        totalShoppers={1}
        onBuySell={() => {}}
        onReady={() => {}}
        purchaseCounters={{ THERMONUCLEAR: 1, GRENADE: 12 }}
      />
    );

    expect(document.getElementById('shop-buy-reason-NUKE')?.textContent).toBe(
      'shop_reason_stock_cap',
    );
    expect(
      document.getElementById('shop-buy-reason-THERMONUCLEAR')?.textContent,
    ).toBe('shop_reason_purchase_limit');
    expect(
      document.getElementById('shop-buy-reason-GRENADE')?.textContent,
    ).toBe('shop_reason_purchase_limit');
  });

  it('renders a finite per-visit purchase limit for ordinary weapons', () => {
    render(
      <WeaponShop
        player={makePlayer({ money: 10_000, inventory: { GRENADE: 0 } })}
        shopIndex={0}
        totalShoppers={1}
        onBuySell={() => {}}
        onReady={() => {}}
      />
    );

    expect(screen.getAllByText('shop_bought 0/12').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Infinity/)).toBeNull();
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

  it('renders a native <dialog> named by its h2 heading without inline display', () => {
    const player = makePlayer({ id: 'p-1', name: 'Major Tom' });
    render(
      <WeaponShop
        player={player}
        shopIndex={0}
        totalShoppers={2}
        onBuySell={() => {}}
        onReady={() => {}}
      />
    );

    const dialog = screen.getByRole('dialog', { name: 'shop_header 1/2' }) as HTMLDialogElement;
    const heading = screen.getByRole('heading', { level: 2, name: 'shop_header 1/2' });

    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog.classList.contains('retro-modal-shop')).toBe(true);
    expect(dialog.style.display).toBe('');
    expect(dialog.getAttribute('role')).toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBeNull();
    expect(dialog.getAttribute('aria-labelledby')).toBe(heading.id);
  });

  it('opens with showModal on mount, stays open across hotseat shopper changes, reopens on close, and closes on unmount', () => {
    const mocks = installDialogPrototypeMocks();
    try {
      const p1 = makePlayer({ id: 'p-1', name: 'Alpha' });
      const p2 = makePlayer({ id: 'p-2', name: 'Bravo' });
      const { rerender, unmount } = render(
        <WeaponShop
          player={p1}
          shopIndex={0}
          totalShoppers={2}
          onBuySell={() => {}}
          onReady={() => {}}
        />
      );

      const dialog = screen.getByRole('dialog', { name: 'shop_header 1/2' }) as HTMLDialogElement;
      expect(mocks.showModal).toHaveBeenCalledTimes(1);
      expect(dialog.hasAttribute('open')).toBe(true);

      rerender(
        <WeaponShop
          player={p2}
          shopIndex={1}
          totalShoppers={2}
          onBuySell={() => {}}
          onReady={() => {}}
        />
      );
      expect(dialog.hasAttribute('open')).toBe(true);
      expect(mocks.showModal).toHaveBeenCalledTimes(1);

      dialog.removeAttribute('open');
      fireEvent(dialog, new Event('close'));
      expect(mocks.showModal).toHaveBeenCalledTimes(2);
      expect(dialog.hasAttribute('open')).toBe(true);

      unmount();
      expect(mocks.close).toHaveBeenCalledTimes(1);
    } finally {
      mocks.restore();
    }
  });

  it('focuses ready button on mount and shopper change while preserving scrollTop for same player updates', () => {
    const p1 = makePlayer({ id: 'p-1', name: 'Alpha', money: 1000, inventory: { GRENADE: 0 } });
    const p1Updated = makePlayer({ id: 'p-1', name: 'Alpha', money: 900, inventory: { GRENADE: 1 } });
    const p2 = makePlayer({ id: 'p-2', name: 'Bravo', money: 800, inventory: { GRENADE: 0 } });

    const { rerender } = render(
      <WeaponShop
        player={p1}
        shopIndex={0}
        totalShoppers={2}
        onBuySell={() => {}}
        onReady={() => {}}
      />
    );

    const readyBtn = screen.getByRole('button', { name: 'btn_ready_next_player' });
    expect(document.activeElement).toBe(readyBtn);

    const buyBtn = screen.getAllByTitle('title_buy')[0];
    const weaponList = buyBtn.parentElement?.parentElement?.parentElement as HTMLDivElement;
    expect(weaponList.style.overflowY).toBe('auto');

    weaponList.scrollTop = 140;
    buyBtn.focus();
    expect(document.activeElement).toBe(buyBtn);

    rerender(
      <WeaponShop
        player={p1Updated}
        shopIndex={0}
        totalShoppers={2}
        onBuySell={() => {}}
        onReady={() => {}}
      />
    );
    expect(weaponList.scrollTop).toBe(140);
    expect(document.activeElement).toBe(buyBtn);

    rerender(
      <WeaponShop
        player={p2}
        shopIndex={1}
        totalShoppers={2}
        onBuySell={() => {}}
        onReady={() => {}}
      />
    );
    expect(weaponList.scrollTop).toBe(0);
    expect(document.activeElement).toBe(readyBtn);
  });

  it('intercepts cancel event and invokes onReady only when controlsDisabled is false', () => {
    const player = makePlayer({ id: 'p-1', name: 'Alpha' });
    const onReady = vi.fn();

    const { rerender } = render(
      <WeaponShop
        player={player}
        shopIndex={0}
        totalShoppers={1}
        onBuySell={() => {}}
        onReady={onReady}
      />
    );

    const dialog = screen.getByRole('dialog', { name: 'shop_header 1/1' });
    const cancelEvent = new Event('cancel', { cancelable: true });
    fireEvent(dialog, cancelEvent);
    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);

    rerender(
      <WeaponShop
        player={player}
        shopIndex={0}
        totalShoppers={1}
        onBuySell={() => {}}
        onReady={onReady}
        controlsDisabled
      />
    );

    const disabledCancelEvent = new Event('cancel', { cancelable: true });
    fireEvent(dialog, disabledCancelEvent);
    expect(disabledCancelEvent.defaultPrevented).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);
  });
});
