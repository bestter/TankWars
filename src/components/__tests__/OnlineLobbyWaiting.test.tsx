// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { OnlineLobbyWaiting } from '../OnlineLobbyWaiting';
import type { JoinedInfo, SlotUI } from '../onlineLobbyTypes';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options) {
        if (options.num !== undefined) return `${key}_${options.num}`;
        if (options.joined !== undefined && options.total !== undefined) return `${key}_${options.joined}_${options.total}`;
      }
      return key;
    },
  }),
}));

describe('OnlineLobbyWaiting component', () => {
  const defaultSlotsInfo: SlotUI[] = [
    { slot: 0, type: 'human', url: 'https://tankwars.pages.dev/?room=TEST1&slot=0' },
    { slot: 1, type: 'human', url: 'https://tankwars.pages.dev/?room=TEST1&slot=1' },
    { slot: 2, type: 'ai', aiProfile: 'v4-smart', url: null },
  ];

  const defaultRoster: JoinedInfo[] = [
    { slot: 0, name: 'Alice', type: 'human' },
  ];

  let mockSetMyName: Mock<(name: string) => void>;
  let mockOnJoin: Mock<() => void>;
  let mockOnCopyLink: Mock<(url: string | null, slot: number) => void>;
  let mockOnLeaveRoom: Mock<() => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();

    mockSetMyName = vi.fn();
    mockOnJoin = vi.fn();
    mockOnCopyLink = vi.fn();
    mockOnLeaveRoom = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders room code when roomId is provided and connecting text when null', () => {
    const { rerender } = render(
      <OnlineLobbyWaiting
        view="waiting"
        roomId="ROOM-1234"
        numPlayers={3}
        myName="Alice"
        setMyName={mockSetMyName}
        slotsInfo={defaultSlotsInfo}
        roster={defaultRoster}
        isJoining={false}
        copyFeedback={{}}
        serverGameLive={false}
        connected={true}
        onJoin={mockOnJoin}
        onCopyLink={mockOnCopyLink}
        onLeaveRoom={mockOnLeaveRoom}
      />
    );

    expect(screen.getByText('room_code_label: ROOM-1234')).toBeDefined();

    rerender(
      <OnlineLobbyWaiting
        view="waiting"
        roomId={null}
        numPlayers={3}
        myName="Alice"
        setMyName={mockSetMyName}
        slotsInfo={defaultSlotsInfo}
        roster={defaultRoster}
        isJoining={false}
        copyFeedback={{}}
        serverGameLive={false}
        connected={true}
        onJoin={mockOnJoin}
        onCopyLink={mockOnCopyLink}
        onLeaveRoom={mockOnLeaveRoom}
      />
    );

    expect(screen.getByText('connecting')).toBeDefined();
  });

  it('renders joining view and handles name input & join button interactions', () => {
    const { rerender } = render(
      <OnlineLobbyWaiting
        view="joining"
        roomId="ROOM-JOIN"
        numPlayers={2}
        myName=""
        initialSlot={1}
        setMyName={mockSetMyName}
        slotsInfo={[]}
        roster={[]}
        isJoining={false}
        copyFeedback={{}}
        serverGameLive={false}
        connected={true}
        onJoin={mockOnJoin}
        onCopyLink={mockOnCopyLink}
        onLeaveRoom={mockOnLeaveRoom}
      />
    );

    expect(screen.getByText('you_are_player_2')).toBeDefined();

    const input = screen.getByRole('textbox');
    expect(input.getAttribute('maxLength')).toBe('16');

    // Type a name
    fireEvent.change(input, { target: { value: 'Bob Player' } });
    expect(mockSetMyName).toHaveBeenCalledWith('Bob Player');

    // Join button disabled because myName is empty
    const joinBtn = screen.getByRole('button', { name: 'join_room_btn' });
    expect(joinBtn.hasAttribute('disabled')).toBe(true);

    // Re-render with valid myName
    rerender(
      <OnlineLobbyWaiting
        view="joining"
        roomId="ROOM-JOIN"
        numPlayers={2}
        myName="Bob"
        initialSlot={1}
        setMyName={mockSetMyName}
        slotsInfo={[]}
        roster={[]}
        isJoining={false}
        copyFeedback={{}}
        serverGameLive={false}
        connected={true}
        onJoin={mockOnJoin}
        onCopyLink={mockOnCopyLink}
        onLeaveRoom={mockOnLeaveRoom}
      />
    );

    const activeJoinBtn = screen.getByRole('button', { name: 'join_room_btn' });
    expect(activeJoinBtn.hasAttribute('disabled')).toBe(false);

    fireEvent.click(activeJoinBtn);
    expect(mockOnJoin).toHaveBeenCalledTimes(1);

    // When isJoining is true
    rerender(
      <OnlineLobbyWaiting
        view="joining"
        roomId="ROOM-JOIN"
        numPlayers={2}
        myName="Bob"
        initialSlot={1}
        setMyName={mockSetMyName}
        slotsInfo={[]}
        roster={[]}
        isJoining={true}
        copyFeedback={{}}
        serverGameLive={false}
        connected={true}
        onJoin={mockOnJoin}
        onCopyLink={mockOnCopyLink}
        onLeaveRoom={mockOnLeaveRoom}
      />
    );

    expect(screen.getByRole('button', { name: 'joining' }).hasAttribute('disabled')).toBe(true);
  });

  it('renders waiting view with slot links, copy link buttons, and AI indicators', () => {
    render(
      <OnlineLobbyWaiting
        view="waiting"
        roomId="ROOM-WAIT"
        numPlayers={3}
        myName="Alice"
        setMyName={mockSetMyName}
        slotsInfo={defaultSlotsInfo}
        roster={defaultRoster}
        isJoining={false}
        copyFeedback={{ 1: true }}
        serverGameLive={false}
        connected={true}
        onJoin={mockOnJoin}
        onCopyLink={mockOnCopyLink}
        onLeaveRoom={mockOnLeaveRoom}
      />
    );

    expect(screen.getByText('room_created')).toBeDefined();

    // Slot 0 (copy_link), Slot 1 (link_copied because copyFeedback[1] === true)
    expect(screen.getByText('copy_link')).toBeDefined();
    expect(screen.getByText('link_copied')).toBeDefined();

    // Click copy link for Slot 0
    const copyBtn0 = screen.getByText('copy_link');
    fireEvent.click(copyBtn0);
    expect(mockOnCopyLink).toHaveBeenCalledWith(defaultSlotsInfo[0].url, 0);

    // AI slot indicator
    expect(screen.getByText('(IA — pas de lien)')).toBeDefined();
  });

  it('renders live roster with connected count and server live message', () => {
    const fullRoster: JoinedInfo[] = [
      { slot: 0, name: 'Alice', type: 'human' },
      { slot: 1, name: 'Bob', type: 'human' },
      { slot: 2, name: 'CPU Smart', type: 'ai' },
    ];

    render(
      <OnlineLobbyWaiting
        view="waiting"
        roomId="ROOM-FULL"
        numPlayers={3}
        myName="Alice"
        setMyName={mockSetMyName}
        slotsInfo={defaultSlotsInfo}
        roster={fullRoster}
        isJoining={false}
        copyFeedback={{}}
        serverGameLive={true}
        connected={true}
        onJoin={mockOnJoin}
        onCopyLink={mockOnCopyLink}
        onLeaveRoom={mockOnLeaveRoom}
      />
    );

    expect(screen.getByText(/players_connected_3_3/i)).toBeDefined();
    expect(screen.getByText(/slot_label_1 : Alice/i)).toBeDefined();
    expect(screen.getByText(/slot_label_2 : Bob/i)).toBeDefined();
    expect(screen.getByText(/slot_label_3 : CPU Smart/i)).toBeDefined();

    // Server game live indicator
    expect(screen.getByText('all_ready_auto_start')).toBeDefined();
  });

  it('handles leave room button and displays connected indicator', () => {
    render(
      <OnlineLobbyWaiting
        view="waiting"
        roomId="ROOM-LEAVE"
        numPlayers={2}
        myName="Alice"
        setMyName={mockSetMyName}
        slotsInfo={defaultSlotsInfo}
        roster={defaultRoster}
        isJoining={false}
        copyFeedback={{}}
        serverGameLive={false}
        connected={true}
        onJoin={mockOnJoin}
        onCopyLink={mockOnCopyLink}
        onLeaveRoom={mockOnLeaveRoom}
      />
    );

    const leaveBtn = screen.getByRole('button', { name: 'leave_room' });
    fireEvent.click(leaveBtn);
    expect(mockOnLeaveRoom).toHaveBeenCalledTimes(1);

    expect(screen.getByText('● Connecté')).toBeDefined();
  });
});
