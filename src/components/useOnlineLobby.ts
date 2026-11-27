import { parseCreatedParticipation, persistParticipation, type OnlineEntryMessage, type OnlineParticipation } from '../utils/onlineParticipation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RoomSlotConfig, ServerGameMessage, ServerRosterUpdate } from '../types/room';
import type { Player } from '../types/player';
import { getOnlineApiBase, getOnlineWsBase } from '../utils/onlineApi';
import { isStrictOnlineMessage, ONLINE_PROTOCOL_VERSION } from '../game/online/protocol';
import type { CopySlotFeedback, CopySlotStatus, JoinedInfo, LobbyView, OnlineLobbyProps, SlotUI } from './onlineLobbyTypes';

function isServerRosterUpdate(value: unknown): value is ServerRosterUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== 'ROSTER_UPDATE' || !Array.isArray(record.roster)) return false;
  if (
    record.numPlayers !== undefined &&
    (typeof record.numPlayers !== 'number' || !Number.isInteger(record.numPlayers) || record.numPlayers < 2 || record.numPlayers > 4)
  ) {
    return false;
  }
  if (record.gameStarted !== undefined && typeof record.gameStarted !== 'boolean') return false;
  const seenSlots = new Set<number>();
  return record.roster.every((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    if (
      typeof item.slot !== 'number' ||
      !Number.isInteger(item.slot) ||
      item.slot < 0 ||
      item.slot >= 4 ||
      seenSlots.has(item.slot)
    ) {
      return false;
    }
    seenSlots.add(item.slot);
    return typeof item.name === 'string' && (item.type === 'human' || item.type === 'ai');
  });
}

export function useOnlineLobby({
  initialParticipation,
  initialRoomId,
  initialSlot,
  initialToken,
  onPersistenceWarning,
  onStartGame,
  onExitToLocalMenu,
}: OnlineLobbyProps) {
  const { t } = useTranslation();

  const [view, setView] = useState<LobbyView>(initialParticipation?.engaged ? 'waiting' : initialRoomId && initialSlot !== undefined ? 'joining' : 'create');
  const [numPlayers, setNumPlayers] = useState<2 | 3 | 4>(initialParticipation?.mode === 'host' ? initialParticipation.slots.length as 2 | 3 | 4 : 2);

  // Host creation config (per slot)
  const [slotConfigs, setSlotConfigs] = useState<RoomSlotConfig[]>([
    { type: 'human', id: 'slot-0' },
    { type: 'ai', aiProfile: 'v1-random', id: 'slot-1' },
  ]);

  const [roomId, setRoomId] = useState<string | null>(initialRoomId ?? null);
  const mySlotRef = useRef<number | null>(initialSlot ?? null);
  const myTokenRef = useRef<string | null>(initialToken ?? null);
  const [myName, setMyName] = useState<string>(initialParticipation?.name ?? '');

  const [slotsInfo, setSlotsInfo] = useState<SlotUI[]>(initialParticipation?.slots ?? []);
  const [roster, setRoster] = useState<JoinedInfo[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [roundPreparationFailed, setRoundPreparationFailed] = useState(false);
  const [storageWarning, setStorageWarning] = useState<OnlineEntryMessage | null>(null);
  const participationRef = useRef(initialParticipation);
  const [error, setError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<Record<number, CopySlotFeedback | undefined>>({});
  const copyTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const lastCopyAnnouncementBySlotRef = useRef<Map<number, CopySlotFeedback>>(new Map());
  const nextCopyAttemptIdRef = useRef(0);
  const activeCopyAttemptBySlotRef = useRef<Map<number, number>>(new Map());

  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(false);
  const onStartGameRef = useRef(onStartGame);
  const gameStartedRef = useRef(false);
  const missedGameStartRef = useRef(false);
  const rosterRef = useRef<JoinedInfo[]>([]);
  const serverNumPlayersRef = useRef(0);
  const serverGameLiveRef = useRef(false);
  const [serverGameLive, setServerGameLive] = useState(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionRef = useRef<{ rId: string; slot: number; token: string; name: string } | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    onStartGameRef.current = onStartGame;
  }, [onStartGame]);

  const saveParticipation = useCallback((value: OnlineParticipation) => {
    participationRef.current = value;
    if (persistParticipation(value)) setStorageWarning(null);
    else if (onPersistenceWarning) onPersistenceWarning('online_restore_unavailable');
    else setStorageWarning('online_restore_unavailable');
  }, [onPersistenceWarning]);

  const updateName = (name: string) => {
    setMyName(name);
    const value = participationRef.current;
    if (value) saveParticipation({ ...value, name });
  };

  const clearReconnectTimer = useCallback((): void => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const expectedHumansToStart = useCallback((): number => {
    if (slotsInfo.length > 0) {
      return slotsInfo.filter((s) => s.type === 'human').length;
    }
    return serverNumPlayersRef.current || numPlayers || 2;
  }, [numPlayers, slotsInfo]);

  const isRosterReadyToStart = useCallback(
    (rosterEntries: JoinedInfo[]): boolean => {
      const humansJoined = rosterEntries.filter((r) => r.type === 'human').length;
      return humansJoined >= expectedHumansToStart();
    },
    [expectedHumansToStart],
  );

  const requestGameStartCatchUp = useCallback((ws: WebSocket): void => {
    if (gameStartedRef.current || ws.readyState !== WebSocket.OPEN) return;
    missedGameStartRef.current = true;
    ws.send(JSON.stringify({
      type: 'REQUEST_GAME_START',
      protocolVersion: ONLINE_PROTOCOL_VERSION,
      roundNumber: 0,
      lastSeenShotId: 0,
      lastAppliedShopEpoch: 0,
    }));
  }, []);

  // Keep slotConfigs in sync with numPlayers (exact same pattern as local MainMenu — no setState inside effect)
  const changeNumPlayers = (n: 2 | 3 | 4): void => {
    if (n === numPlayers) return;
    setNumPlayers(n);
    setSlotConfigs((prev) => {
      const next = [...prev];
      while (next.length < n) {
        const idx = next.length;
        next.push(
          idx === 0
            ? { type: 'human', id: `slot-${idx}` }
            : { type: 'ai', aiProfile: 'v1-random' as const, id: `slot-${idx}` }
        );
      }
      return next.slice(0, n);
    });
  };

  const canCreate = slotConfigs.every((c) => c.type === 'human' || !!c.aiProfile);

  const handleServerGameStart = useCallback(
    (start: Extract<ServerGameMessage, { type: 'GAME_START' }>, rId: string, slot: number, token: string, ws: WebSocket) => {
      if (gameStartedRef.current) return;
      gameStartedRef.current = true;
      clearReconnectTimer();

      const localPlayer = start.players[slot];
      const localPlayerId = localPlayer ? localPlayer.id : `player-${slot + 1}`;

      onStartGameRef.current(start.players as Player[], {
        roomId: rId,
        localPlayerId,
        gameMode: 'online',
        initialMap: start.map,
        initialCurrentPlayerIndex: start.currentPlayerIndex,
        slot,
        token,
        ws, // Transmet la WebSocket ouverte pour la réutiliser en combat
      });

      if (wsRef.current === ws) {
        wsRef.current = null;
      }
    },
    [clearReconnectTimer],
  );

  const connectWebSocketRef = useRef<(rId: string, slot: number, token: string, name: string) => void>(() => {});

  const scheduleReconnect = useCallback(() => {
    if (gameStartedRef.current || !connectionRef.current) return;
    clearReconnectTimer();
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      const p = connectionRef.current;
      if (!p || gameStartedRef.current) return;
      connectWebSocketRef.current(p.rId, p.slot, p.token, p.name);
    }, 2000);
  }, [clearReconnectTimer]);

  // Core WS connection + protocol handling (MVP)
  const connectWebSocket = useCallback(
    (rId: string, slot: number, token: string, nameForClaim: string) => {
      connectionRef.current = { rId, slot, token, name: nameForClaim };
      clearReconnectTimer();

      if (wsRef.current) {
        try {
          wsRef.current.onclose = null;
          wsRef.current.onmessage = null;
          wsRef.current.close();
        } catch {
          // ignore close errors
        }
      }

      const nameParam = nameForClaim ? `&name=${encodeURIComponent(nameForClaim)}` : '';
      const wsUrl = `${getOnlineWsBase()}/api/rooms/${encodeURIComponent(rId)}/ws?protocolVersion=${ONLINE_PROTOCOL_VERSION}&slot=${slot}&token=${encodeURIComponent(token)}${nameParam}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      const cleanup = () => {
        if (wsRef.current === ws) {
          ws.close();
          wsRef.current = null;
        }
      };

      ws.onopen = () => {
        setConnected(true);
        setError(null);
        // Reconnect or late attach: pull GAME_START if the match already went live.
        if (
          missedGameStartRef.current ||
          serverGameLiveRef.current ||
          isRosterReadyToStart(rosterRef.current)
        ) {
          requestGameStartCatchUp(ws);
        }
      };

      ws.onmessage = (ev) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          return;
        }

        if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) return;
        if (isStrictOnlineMessage(parsed) && parsed.type === 'ROUND_PREPARATION_FAILED') {
          setRoundPreparationFailed(parsed.reason === 'EXHAUSTED');
          setError(t(parsed.reason === 'NEW_GAME_REQUIRED' ? 'round_new_game_required' : 'round_preparation_failed'));
          return;
        }
        if (isStrictOnlineMessage(parsed) && parsed.type === 'PROTOCOL_MISMATCH') {
          setError(t('protocol_mismatch_body'));
          connectionRef.current = null;
          return;
        }
        if (parsed.type === 'ROSTER_UPDATE') {
          if (!isServerRosterUpdate(parsed)) return;
          setRoster(parsed.roster);
          rosterRef.current = parsed.roster;
          if (typeof parsed.numPlayers === 'number') {
            serverNumPlayersRef.current = parsed.numPlayers;
          }

          const rosterComplete = isRosterReadyToStart(parsed.roster);

          if (parsed.gameStarted) {
            serverGameLiveRef.current = true;
            setServerGameLive(true);
          }
          if (parsed.gameStarted || rosterComplete) {
            requestGameStartCatchUp(ws);
          }
        }

        if (parsed.type === 'GAME_START') {
          if (!isStrictOnlineMessage(parsed) || parsed.type !== 'GAME_START') {
            console.error('[Lobby] Invalid GAME_START map');
            setError(t('round_new_game_required'));
            return;
          }
          handleServerGameStart(parsed, rId, slot, token, ws);
        }
      };

      ws.onerror = () => {
        setError(t('room_error_generic'));
        setConnected(false);
      };

      ws.onclose = (ev: CloseEvent) => {
        setConnected(false);
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        if (ev.code === 4402) {
          setError(t('protocol_mismatch_body'));
          connectionRef.current = null;
          return;
        }
        if (ev.code === 4001 || (typeof ev.reason === 'string' && ev.reason.includes('replaced'))) {
          connectionRef.current = null;
          return;
        }
        if (!gameStartedRef.current && connectionRef.current) {
          scheduleReconnect();
        }
      };

      const sendIdentify = () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'IDENTIFY', name: nameForClaim }));
        }
      };
      setTimeout(sendIdentify, 50);

      return cleanup;
    },
    [clearReconnectTimer, handleServerGameStart, isRosterReadyToStart, requestGameStartCatchUp, scheduleReconnect, t],
  );

  useEffect(() => {
    connectWebSocketRef.current = connectWebSocket;
  }, [connectWebSocket]);

  // Keep latest callbacks in refs so the catch-up interval does not re-subscribe every render.
  const isRosterReadyToStartRef = useRef(isRosterReadyToStart);
  const requestGameStartCatchUpRef = useRef(requestGameStartCatchUp);
  useEffect(() => {
    isRosterReadyToStartRef.current = isRosterReadyToStart;
    requestGameStartCatchUpRef.current = requestGameStartCatchUp;
  }, [isRosterReadyToStart, requestGameStartCatchUp]);

  // Retry GAME_START catch-up while the match is live but this tab missed the broadcast
  useEffect(() => {
    if (view !== 'waiting' && view !== 'joining') return;
    const retryId = setInterval(() => {
      if (gameStartedRef.current) return;
      const ws = wsRef.current;
      if (ws?.readyState !== WebSocket.OPEN) return;

      const shouldRetry =
        missedGameStartRef.current ||
        serverGameLiveRef.current ||
        isRosterReadyToStartRef.current(rosterRef.current);
      if (!shouldRetry) return;

      requestGameStartCatchUpRef.current(ws);
    }, 2000);
    return () => clearInterval(retryId);
  }, [view]);

  // Cleanup WS and copy feedback timers on unmount
  useEffect(() => {
    const currentWsRef = wsRef;
    const copyTimers = copyTimersRef.current;
    const activeCopyAttempts = activeCopyAttemptBySlotRef.current;
    const lastCopyAnnouncements = lastCopyAnnouncementBySlotRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearReconnectTimer();
      for (const timer of copyTimers.values()) {
        clearTimeout(timer);
      }
      copyTimers.clear();
      activeCopyAttempts.clear();
      lastCopyAnnouncements.clear();
      connectionRef.current = null;
      if (currentWsRef.current && !gameStartedRef.current) {
        currentWsRef.current.onclose = null;
        currentWsRef.current.onmessage = null;
        currentWsRef.current.onopen = null;
        currentWsRef.current.onerror = null;
        currentWsRef.current.close();
        currentWsRef.current = null;
      }
    };
  }, [clearReconnectTimer]);

  useEffect(() => {
    if (!initialParticipation?.engaged) return;
    const value = initialParticipation;
    let active = true;
    queueMicrotask(() => {
      if (active) connectWebSocketRef.current(value.room, value.slot, value.token, value.name);
    });
    return () => { active = false; };
  }, [initialParticipation]);

  // --- Create room (host) ---
  const handleCreateRoom = async () => {
    if (!canCreate || isCreating) return;
    setIsCreating(true);
    setError(null);

    try {
      const payload = {
        numPlayers,
        slots: slotConfigs,
        // Send the current origin so the server can generate correct shareable links (important for local dev on localhost:5173)
        origin: typeof window !== 'undefined' ? window.location.origin : undefined,
      };

      const res = await fetch(`${getOnlineApiBase()}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error('[OnlineLobby] Create room failed with status', res.status);
        throw new Error(text || `HTTP ${res.status}`);
      }

      const response: unknown = await res.json();
      if (!mountedRef.current) return;
      const host = parseCreatedParticipation(response, t('default_player_name_1').slice(0, 16));
      if (!host) throw new Error('Invalid room response');
      const data = { roomId: host.room, slots: host.slots };
      setRoomId(data.roomId);
      setSlotsInfo(data.slots);

      // Host defaults to slot 0 (first link). They can also copy any other.
      const hostSlot = 0;
      const hostInfo = data.slots.find((s) => s.slot === hostSlot);
      mySlotRef.current = hostSlot;
      myTokenRef.current = hostInfo?.url ? new URL(hostInfo.url).searchParams.get('token') : null;
      setMyName(host.name);

      if (!myTokenRef.current) throw new Error('Missing host credentials');
      saveParticipation(host);

      // Switch to waiting view immediately (host also "joins" their slot via WS)
      setView('waiting');

      // Auto-connect the host as well (they share their own link conceptually)
      if (hostInfo?.url) {
        const u = new URL(hostInfo.url);
        connectWebSocket(data.roomId, hostSlot, u.searchParams.get('token') || '', host.name);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('[OnlineLobby] Failed to create room (is the worker running on port 8787?):', errorMessage);
      setError(t('room_error_generic'));
    } finally {
      setIsCreating(false);
    }
  };

  // --- Join flow (from link or manual) ---
  const handleJoin = async () => {
    if (!roomId || mySlotRef.current === null || !myTokenRef.current || !myName.trim() || isJoining) return;
    setIsJoining(true);
    setError(null);

    try {
      saveParticipation({ version: 1, room: roomId, slot: mySlotRef.current,
        token: myTokenRef.current, name: myName.trim(), engaged: true,
        mode: initialParticipation?.mode ?? 'guest', slots: slotsInfo });
      connectWebSocket(roomId, mySlotRef.current, myTokenRef.current, myName.trim());
      setView('waiting');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('[OnlineLobby] Failed to initiate join:', errorMessage);
      setError(t('room_error_generic'));
    } finally {
      setIsJoining(false);
    }
  };

  // --- Copy helper ---
  const invalidateSlotCopyAttempt = useCallback((slot: number): number => {
    nextCopyAttemptIdRef.current += 1;
    const attemptId = nextCopyAttemptIdRef.current;
    activeCopyAttemptBySlotRef.current.set(slot, attemptId);
    const previousTimer = copyTimersRef.current.get(slot);
    if (previousTimer !== undefined) {
      clearTimeout(previousTimer);
      copyTimersRef.current.delete(slot);
    }
    return attemptId;
  }, []);

  const dismissCopyFeedback = useCallback((slot: number) => {
    invalidateSlotCopyAttempt(slot);
    setCopyFeedback((prev) => {
      if (!(slot in prev)) return prev;
      const next = { ...prev };
      delete next[slot];
      return next;
    });
  }, [invalidateSlotCopyAttempt]);

  const copyLink = async (url: string | null, slot: number) => {
    if (!url) return;
    const attemptId = invalidateSlotCopyAttempt(slot);

    let status: CopySlotStatus = 'copied';
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(url);
    } catch {
      status = 'failed';
    }

    if (!mountedRef.current || activeCopyAttemptBySlotRef.current.get(slot) !== attemptId) {
      return;
    }

    const previousAnnouncement = lastCopyAnnouncementBySlotRef.current.get(slot);
    const announcement = {
      status,
      appendAnnouncementSpace: previousAnnouncement?.status === status && !previousAnnouncement.appendAnnouncementSpace,
    };
    lastCopyAnnouncementBySlotRef.current.set(slot, announcement);

    setCopyFeedback((prev) => ({
      ...prev,
      [slot]: announcement,
    }));

    if (status === 'copied') {
      const timer = setTimeout(() => {
        if (copyTimersRef.current.get(slot) === timer) {
          copyTimersRef.current.delete(slot);
        }
        if (!mountedRef.current || activeCopyAttemptBySlotRef.current.get(slot) !== attemptId) {
          return;
        }
        setCopyFeedback((prev) => {
          const next = { ...prev };
          delete next[slot];
          return next;
        });
      }, 2000);
      copyTimersRef.current.set(slot, timer);
    }
  };

  // --- Change a slot type (host only, before create) ---
  const updateSlot = (idx: number, patch: Partial<RoomSlotConfig>) => {
    setSlotConfigs((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };

  const leaveRoom = () => {
    connectionRef.current = null;
    clearReconnectTimer();
    for (const timer of copyTimersRef.current.values()) {
      clearTimeout(timer);
    }
    copyTimersRef.current.clear();
    activeCopyAttemptBySlotRef.current.clear();
    lastCopyAnnouncementBySlotRef.current.clear();
    setCopyFeedback({});
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    onExitToLocalMenu?.();
  };

  const isJoinMode = !!initialRoomId && initialSlot !== undefined;

  return {
    view,
    roundPreparationFailed,
    retryPreparation: () => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        setError(null);
        setRoundPreparationFailed(false);
        requestGameStartCatchUp(ws);
      }
    },
    numPlayers,
    slotConfigs,
    roomId,
    myName,
    setMyName: updateName,
    slotsInfo,
    roster,
    isCreating,
    isJoining,
    error,
    storageWarning,
    copyFeedback,
    serverGameLive,
    connected,
    canCreate,
    isJoinMode,
    changeNumPlayers,
    handleCreateRoom,
    handleJoin,
    copyLink,
    dismissCopyFeedback,
    updateSlot,
    leaveRoom,
    onExitToLocalMenu,
  };
}

export type OnlineLobbyViewModel = ReturnType<typeof useOnlineLobby>;
