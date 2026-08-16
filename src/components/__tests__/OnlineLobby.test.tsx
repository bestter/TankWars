// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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

    const nameInput = screen.getByPlaceholderText('enter_name_placeholder');
    fireEvent.change(nameInput, { target: { value: 'Pilot X' } });
    expect(joinBtn.hasAttribute('disabled')).toBe(false);
  });
});
