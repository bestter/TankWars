// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { StrictMode } from 'react';
import { readParticipation, type OnlineParticipation } from '../../utils/onlineParticipation';
import { useOnlineLobby } from '../useOnlineLobby';
import type { CreateRoomResponse } from '../../types/room';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('useOnlineLobby', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes in create mode with 2 slots by default', () => {
    const onStartGame = vi.fn();
    const onExitToLocalMenu = vi.fn();

    const { result } = renderHook(() =>
      useOnlineLobby({
        onStartGame,
        onExitToLocalMenu,
      })
    );

    expect(result.current.view).toBe('create');
    expect(result.current.numPlayers).toBe(2);
    expect(result.current.slotConfigs.length).toBe(2);
    expect(result.current.slotConfigs[0].type).toBe('human');
    expect(result.current.slotConfigs[1].type).toBe('ai');
    expect(result.current.canCreate).toBe(true);
  });

  it('restores an engaged host once under Strict Mode without creating a room', async () => {
    const session: OnlineParticipation = { version: 1, room: 'synthetic-room', slot: 0,
      token: 'synthetic-token', name: 'Host', engaged: true, mode: 'host', slots: [
        { slot: 0, type: 'human', url: 'http://localhost/?room=synthetic-room&slot=0&token=synthetic-token' },
        { slot: 1, type: 'human', url: 'http://localhost/?room=synthetic-room&slot=1&token=synthetic-guest' },
      ] };
    const socket = { close: vi.fn(), send: vi.fn(), readyState: 0,
      onopen: null, onmessage: null, onclose: null, onerror: null };
    const construct = vi.fn(function () { return socket; });
    vi.stubGlobal('WebSocket', construct);
    const fetchSpy = vi.spyOn(global, 'fetch');
    const { result, unmount } = renderHook(() => useOnlineLobby({ initialRoomId: session.room,
      initialSlot: session.slot, initialToken: session.token, initialParticipation: session,
      onStartGame: vi.fn() }), { wrapper: StrictMode });
    await act(async () => {});
    expect(construct).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.slotsInfo).toEqual(session.slots);
    expect(result.current.myName).toBe('Host');
    expect(result.current.view).toBe('waiting');
    unmount();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.onclose).toBeNull();
    vi.unstubAllGlobals();
  });

  it('updates slot configs when changing number of players', () => {
    const { result } = renderHook(() =>
      useOnlineLobby({
        onStartGame: vi.fn(),
      })
    );

    act(() => {
      result.current.changeNumPlayers(3);
    });

    expect(result.current.numPlayers).toBe(3);
    expect(result.current.slotConfigs.length).toBe(3);

    act(() => {
      result.current.changeNumPlayers(4);
    });

    expect(result.current.numPlayers).toBe(4);
    expect(result.current.slotConfigs.length).toBe(4);
  });

  it('updates slot type and profile with onUpdateSlot', () => {
    const { result } = renderHook(() =>
      useOnlineLobby({
        onStartGame: vi.fn(),
      })
    );

    act(() => {
      result.current.updateSlot(1, { type: 'human', aiProfile: undefined });
    });

    expect(result.current.slotConfigs[1].type).toBe('human');
    expect(result.current.slotConfigs[1].aiProfile).toBeUndefined();

    act(() => {
      result.current.updateSlot(1, { type: 'ai', aiProfile: 'v3-sniper' });
    });

    expect(result.current.slotConfigs[1].type).toBe('ai');
    expect(result.current.slotConfigs[1].aiProfile).toBe('v3-sniper');
  });

  it('creates a room and switches to waiting view', async () => {
    const mockResponse: CreateRoomResponse = {
      ok: true,
      roomId: 'room-xyz',
      numPlayers: 2,
      slots: [
        { slot: 0, type: 'human', url: 'http://localhost/?room=room-xyz&slot=0&token=TOK0' },
        { slot: 1, type: 'human', url: 'http://localhost/?room=room-xyz&slot=1&token=TOK1' },
      ],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    // Mock WebSocket to prevent actual network attempt
    const mockWs = {
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    const wsConstructor = vi.fn().mockImplementation(function () {
      return mockWs;
    }) as unknown as typeof WebSocket;
    global.WebSocket = wsConstructor;

    const { result } = renderHook(() =>
      useOnlineLobby({
        onStartGame: vi.fn(),
      })
    );

    await act(async () => {
      await result.current.handleCreateRoom();
    });

    expect(result.current.view).toBe('waiting');
    expect(result.current.roomId).toBe('room-xyz');
    expect(result.current.slotsInfo.length).toBe(2);
    expect(readParticipation()).toMatchObject({ mode: 'host', engaged: true, room: 'room-xyz', slots: mockResponse.slots });
  });

  it('does not reconnect if websocket is closed with superseded code 4001 or replaced reason', async () => {
    vi.useFakeTimers();
    const mockWs = {
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1,
      onopen: null as (() => void) | null,
      onmessage: null as ((ev: { data: string }) => void) | null,
      onerror: null as (() => void) | null,
      onclose: null as ((ev: unknown) => void) | null,
    };
    const wsConstructor = vi.fn().mockImplementation(function () {
      return mockWs;
    }) as unknown as typeof WebSocket;
    global.WebSocket = wsConstructor;

    const { result } = renderHook(() =>
      useOnlineLobby({
        initialRoomId: 'room-123',
        initialSlot: 0,
        initialToken: 'TOK0',
        onStartGame: vi.fn(),
      })
    );

    act(() => {
      result.current.setMyName('Player 1');
    });

    await act(async () => {
      await result.current.handleJoin();
    });

    expect(wsConstructor).toHaveBeenCalledTimes(1);

    // Simulate WebSocket closing because it was replaced by another connection
    act(() => {
      if (mockWs.onclose) {
        mockWs.onclose({ code: 4001, reason: 'replaced by new connection for same slot' });
      }
    });

    // Fast-forward timers
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    // Should NOT have attempted any reconnect
    expect(wsConstructor).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('handles create room failure with missing error text', async () => {
    // Suppress console.error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockRejectedValue(new Error('Network error reading text')),
    });

    const { result } = renderHook(() =>
      useOnlineLobby({
        onStartGame: vi.fn(),
      })
    );

    await act(async () => {
      await result.current.handleCreateRoom();
    });

    expect(result.current.error).toBe('room_error_generic');
    expect(consoleSpy).toHaveBeenCalledWith('[OnlineLobby] Create room failed with status', 500);

    consoleSpy.mockRestore();
  });

  it('cleans up WebSocket and timers on unmount', async () => {
    const mockWs = {
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1,
      onopen: null as (() => void) | null,
      onmessage: null as ((ev: { data: string }) => void) | null,
      onerror: null as (() => void) | null,
      onclose: null as ((ev: unknown) => void) | null,
    };
    const wsConstructor = vi.fn().mockImplementation(function () {
      return mockWs;
    }) as unknown as typeof WebSocket;
    global.WebSocket = wsConstructor;

    const { result, unmount } = renderHook(() =>
      useOnlineLobby({
        initialRoomId: 'room-cleanup-123',
        initialSlot: 0,
        initialToken: 'TOK_CLEANUP',
        onStartGame: vi.fn(),
      })
    );

    act(() => {
      result.current.setMyName('Unmounting Player');
    });

    await act(async () => {
      await result.current.handleJoin();
    });

    expect(wsConstructor).toHaveBeenCalledTimes(1);

    // Unmount the hook
    unmount();

    // WebSocket close must have been called on unmount
    expect(mockWs.close).toHaveBeenCalled();
  });
});
