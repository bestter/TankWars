// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { OnlineLobby } from '../OnlineLobby';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && options.num !== undefined) {
        return `${key}_${options.num}`;
      }
      if (options && options.joined !== undefined && options.total !== undefined) {
        return `${key}_${options.joined}_${options.total}`;
      }
      return key;
    },
  }),
}));

describe('OnlineLobby', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it('renders creation view by default with player selector and create button', () => {
    const onStartGame = vi.fn();
    const onExitToLocalMenu = vi.fn();

    render(
      <OnlineLobby
        onStartGame={onStartGame}
        onExitToLocalMenu={onExitToLocalMenu}
      />
    );

    expect(screen.getByText('create_online_game')).toBeDefined();
    expect(screen.getByText('create_room_btn')).toBeDefined();

    // Player count buttons 2, 3, 4
    const btn3 = screen.getByRole('button', { name: '3' });
    fireEvent.click(btn3);

    // Should now have 3 slot selects
    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBe(3);
  });

  it('calls onExitToLocalMenu when clicking the exit button', () => {
    const onExitToLocalMenu = vi.fn();

    render(
      <OnlineLobby
        onStartGame={() => {}}
        onExitToLocalMenu={onExitToLocalMenu}
      />
    );

    const exitBtn = screen.getByRole('button', { name: 'online_back_to_local' });
    fireEvent.click(exitBtn);

    expect(onExitToLocalMenu).toHaveBeenCalledTimes(1);
  });

  it('renders joining view when initialRoomId, initialSlot, and initialToken are provided', () => {
    render(
      <OnlineLobby
        initialRoomId="room-abc-123"
        initialSlot={1}
        initialToken="TOKEN123"
        onStartGame={() => {}}
        onExitToLocalMenu={() => {}}
      />
    );

    expect(screen.getByText(/room-abc-123/)).toBeDefined();
    expect(screen.getByPlaceholderText('enter_name_placeholder')).toBeDefined();

    const joinBtn = screen.getByRole('button', { name: 'join_room_btn' });
    // Empty name disables join button
    expect(joinBtn.hasAttribute('disabled')).toBe(true);

    const nameInput = screen.getByLabelText('join_name_label');
    fireEvent.change(nameInput, { target: { value: 'Pilot X' } });
    expect(joinBtn.hasAttribute('disabled')).toBe(false);
  });

  it('announces lobby errors via role="alert"', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'unavailable',
    }) as unknown as typeof fetch;

    try {
      render(<OnlineLobby onStartGame={() => {}} onExitToLocalMenu={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: 'create_room_btn' }));
      const alert = await screen.findByText('room_error_generic');
      expect(alert.getAttribute('role')).toBe('alert');
    } finally {
      globalThis.fetch = originalFetch;
      consoleSpy.mockRestore();
    }
  });

  it('mutates slot A live status region when alternating A -> B -> A copies before timer expiry', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const mockWs = {
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    vi.stubGlobal('WebSocket', vi.fn().mockImplementation(function () { return mockWs; }));

    try {
      render(
        <OnlineLobby
          initialParticipation={{
            version: 1,
            room: 'ROOM-ABA',
            slot: 0,
            token: 'TOK0',
            name: 'Host',
            engaged: true,
            mode: 'host',
            slots: [
              { slot: 0, type: 'human', url: 'https://tankwars.pages.dev/?room=ROOM-ABA&slot=0&token=TOK0' },
              { slot: 1, type: 'human', url: 'https://tankwars.pages.dev/?room=ROOM-ABA&slot=1&token=TOK1' },
            ],
          }}
          onStartGame={() => {}}
          onExitToLocalMenu={() => {}}
        />
      );

      const copyBtnA = screen.getByRole('button', { name: 'copy_link — slot_label_1' });
      const copyBtnB = screen.getByRole('button', { name: 'copy_link — slot_label_2' });
      const statusRegions = screen.getAllByRole('status');
      const statusA = statusRegions[0];

      await act(async () => {
        fireEvent.click(copyBtnA);
      });
      expect(statusA.textContent).toBe('link_copied');

      await act(async () => {
        fireEvent.click(copyBtnB);
      });
      expect(statusRegions[1].textContent).toBe('link_copied');

      await act(async () => {
        fireEvent.click(copyBtnA);
      });
      expect(statusA.textContent).toBe('link_copied\u00A0');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
