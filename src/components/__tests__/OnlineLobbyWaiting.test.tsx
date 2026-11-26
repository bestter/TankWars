// @vitest-environment jsdom
import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { OnlineLobbyWaiting, type OnlineLobbyWaitingProps } from '../OnlineLobbyWaiting';
import type { JoinedInfo, SlotUI } from '../onlineLobbyTypes';

const translateCopyStatus = vi.hoisted(() => vi.fn((key: string) => key));

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'link_copied' || key === 'link_copy_failed') return translateCopyStatus(key);
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
  let mockOnDismissCopyFeedback: Mock<(slot: number) => void>;
  let mockOnLeaveRoom: Mock<() => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    translateCopyStatus.mockImplementation((key) => key);

    mockSetMyName = vi.fn();
    mockOnJoin = vi.fn();
    mockOnCopyLink = vi.fn();
    mockOnDismissCopyFeedback = vi.fn();
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
        onDismissCopyFeedback={mockOnDismissCopyFeedback}
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
        onDismissCopyFeedback={mockOnDismissCopyFeedback}
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
        onDismissCopyFeedback={mockOnDismissCopyFeedback}
        onLeaveRoom={mockOnLeaveRoom}
      />
    );

    expect(screen.getByText('you_are_player_2')).toBeDefined();

    const input = screen.getByLabelText('join_name_label') as HTMLInputElement;
    expect(input.getAttribute('maxLength')).toBe('16');
    expect(input.getAttribute('autocomplete')).toBe('nickname');
    expect(input.getAttribute('enterkeyhint')).toBe('done');

    // Type a name
    fireEvent.change(input, { target: { value: 'Bob Player' } });
    expect(mockSetMyName).toHaveBeenCalledWith('Bob Player');

    // Join button disabled because myName is empty
    const joinBtn = screen.getByRole('button', { name: 'join_room_btn' });
    expect(joinBtn.hasAttribute('disabled')).toBe(true);
    expect(joinBtn.getAttribute('type')).toBe('submit');

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
        onDismissCopyFeedback={mockOnDismissCopyFeedback}
        onLeaveRoom={mockOnLeaveRoom}
      />
    );

    const activeJoinBtn = screen.getByRole('button', { name: 'join_room_btn' });
    expect(activeJoinBtn.hasAttribute('disabled')).toBe(false);

    fireEvent.submit(input.closest('form')!);
    expect(mockOnJoin).toHaveBeenCalledTimes(1);

    fireEvent.click(activeJoinBtn);
    expect(mockOnJoin).toHaveBeenCalledTimes(2);

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
        onDismissCopyFeedback={mockOnDismissCopyFeedback}
        onLeaveRoom={mockOnLeaveRoom}
      />
    );

    expect(screen.getByRole('button', { name: 'joining' }).hasAttribute('disabled')).toBe(true);
  });

  it('renders waiting view with disambiguated slot links, external status regions, failure URL fallback, and localized AI indicators', () => {
    const { rerender } = render(
      <OnlineLobbyWaiting
        view="waiting"
        roomId="ROOM-WAIT"
        numPlayers={3}
        myName="Alice"
        setMyName={mockSetMyName}
        slotsInfo={defaultSlotsInfo}
        roster={defaultRoster}
        isJoining={false}
        copyFeedback={{ 1: { status: 'copied', appendAnnouncementSpace: false } }}
        serverGameLive={false}
        connected={true}
        onJoin={mockOnJoin}
        onCopyLink={mockOnCopyLink}
        onDismissCopyFeedback={mockOnDismissCopyFeedback}
        onLeaveRoom={mockOnLeaveRoom}
      />
    );

    expect(screen.getByRole('heading', { level: 2, name: 'room_created' })).toBeDefined();

    // Disambiguated Copy buttons and Open links per slot
    const copyBtn0 = screen.getByRole('button', { name: 'copy_link — slot_label_1' });
    const copyBtn1 = screen.getByRole('button', { name: 'copy_link — slot_label_2' });
    expect(copyBtn0).not.toBe(copyBtn1);
    expect(copyBtn1.hasAttribute('data-copied')).toBe(true);

    const openLink0 = screen.getByRole('link', { name: 'open_link — slot_label_1' });
    const openLink1 = screen.getByRole('link', { name: 'open_link — slot_label_2' });
    expect(openLink0).not.toBe(openLink1);

    // Status live region lives outside the button
    const statuses = screen.getAllByRole('status');
    expect(statuses.some((el) => el.textContent === 'link_copied' && !copyBtn1.contains(el))).toBe(true);

    // Click copy link for Slot 0
    fireEvent.click(copyBtn0);
    expect(mockOnCopyLink).toHaveBeenCalledWith(defaultSlotsInfo[0].url, 0);

    // Localized role and AI slot indicator (no hardcoded French)
    expect(screen.getByText(/slot_label_2 — controller_human/)).toBeDefined();
    expect(screen.getByText(/slot_label_3 — slot_ai_expert/)).toBeDefined();
    expect(screen.getByText('lobby_ai_no_link')).toBeDefined();

    // Copy failure shows external status and non-blocking selectable fallback URL
    rerender(
      <OnlineLobbyWaiting
        view="waiting"
        roomId="ROOM-WAIT"
        numPlayers={3}
        myName="Alice"
        setMyName={mockSetMyName}
        slotsInfo={defaultSlotsInfo}
        roster={defaultRoster}
        isJoining={false}
        copyFeedback={{ 1: { status: 'failed', appendAnnouncementSpace: false } }}
        serverGameLive={false}
        connected={true}
        onJoin={mockOnJoin}
        onCopyLink={mockOnCopyLink}
        onDismissCopyFeedback={mockOnDismissCopyFeedback}
        onLeaveRoom={mockOnLeaveRoom}
      />
    );
    expect(screen.getByRole('button', { name: 'copy_link — slot_label_2' }).hasAttribute('data-failed')).toBe(true);
    expect(screen.getAllByRole('status').some((el) => el.textContent === 'link_copy_failed')).toBe(true);
    const fallbackInput = screen.getByRole('textbox', { name: 'invite_url_label_2' }) as HTMLInputElement;
    expect(fallbackInput.readOnly).toBe(true);
    expect(fallbackInput.value).toBe(defaultSlotsInfo[1].url);

    const closeFallbackBtn = screen.getByRole('button', { name: 'copy_fallback_close — slot_label_2' });
    fireEvent.click(closeFallbackBtn);
    expect(mockOnDismissCopyFeedback).toHaveBeenCalledWith(1);
    expect(document.activeElement).toBe(copyBtn1);
  });

  it.each(['fallback field', 'fallback close button', 'another invitation'] as const)(
    'preserves a usable focus target after a successful retry from %s',
    (focusedControl) => {
      const props = {
        view: 'waiting', roomId: 'ROOM-WAIT', numPlayers: 3,
        myName: 'Alice', setMyName: mockSetMyName,
        slotsInfo: defaultSlotsInfo, roster: defaultRoster,
        isJoining: false, serverGameLive: false, connected: true,
        onJoin: mockOnJoin, onCopyLink: mockOnCopyLink,
        onDismissCopyFeedback: mockOnDismissCopyFeedback, onLeaveRoom: mockOnLeaveRoom,
      } satisfies Omit<OnlineLobbyWaitingProps, 'copyFeedback'>;
      const renderLobby = (copyFeedback: OnlineLobbyWaitingProps['copyFeedback']) => (
        <StrictMode>
          <OnlineLobbyWaiting {...props} copyFeedback={copyFeedback} />
        </StrictMode>
      );
      const { rerender } = render(renderLobby({ 1: { status: 'failed', appendAnnouncementSpace: false } }));
      const field = screen.getByRole('textbox', { name: 'invite_url_label_2' });
      const close = screen.getByRole('button', { name: 'copy_fallback_close — slot_label_2' });
      const otherCopy = screen.getByRole('button', { name: 'copy_link — slot_label_1' });
      const retry = screen.getByRole('button', { name: 'copy_link — slot_label_2' });
      const controls = { 'fallback field': field, 'fallback close button': close, 'another invitation': otherCopy };
      fireEvent.click(retry);
      controls[focusedControl].focus();

      rerender(renderLobby({ 1: { status: 'copied', appendAnnouncementSpace: false } }));

      expect(screen.queryByRole('textbox', { name: 'invite_url_label_2' })).toBeNull();
      expect(document.activeElement).toBe(focusedControl === 'another invitation' ? otherCopy : retry);
    },
  );

  it('retranslates a persistent copy failure in the existing status region', () => {
    const props = {
      view: 'waiting', roomId: 'ROOM-WAIT', numPlayers: 3,
      myName: 'Alice', setMyName: mockSetMyName,
      slotsInfo: defaultSlotsInfo, roster: defaultRoster,
      isJoining: false, serverGameLive: false, connected: true,
      onJoin: mockOnJoin, onCopyLink: mockOnCopyLink,
      onDismissCopyFeedback: mockOnDismissCopyFeedback, onLeaveRoom: mockOnLeaveRoom,
      copyFeedback: { 1: { status: 'failed', appendAnnouncementSpace: true } },
    } satisfies OnlineLobbyWaitingProps;
    translateCopyStatus.mockReturnValue('Copie impossible');
    const { rerender } = render(<OnlineLobbyWaiting {...props} />);
    const [, status] = screen.getAllByRole('status');
    const field = screen.getByRole('textbox', { name: 'invite_url_label_2' });
    field.focus();
    expect(status.textContent).toBe('Copie impossible\u00A0');

    translateCopyStatus.mockReturnValue('Could not copy');
    rerender(<OnlineLobbyWaiting {...props} />);

    expect(screen.getAllByRole('status')[1]).toBe(status);
    expect(status.textContent).toBe('Could not copy\u00A0');
    expect(document.activeElement).toBe(field);
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
        onDismissCopyFeedback={mockOnDismissCopyFeedback}
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
        onDismissCopyFeedback={mockOnDismissCopyFeedback}
        onLeaveRoom={mockOnLeaveRoom}
      />
    );

    const leaveBtn = screen.getByRole('button', { name: 'leave_room' });
    fireEvent.click(leaveBtn);
    expect(mockOnLeaveRoom).toHaveBeenCalledTimes(1);

    expect(screen.getByText('lobby_connected')).toBeDefined();
    expect(document.querySelector('[aria-hidden="true"]')?.textContent).toContain('●');
  });
});
