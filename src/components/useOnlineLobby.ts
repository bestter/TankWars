import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CreateRoomResponse, RoomSlotConfig, ServerGameMessage, ServerRosterUpdate } from '../types/room';
import type { Player } from '../types/player';
import { getOnlineApiBase, getOnlineWsBase } from '../utils/onlineApi';
import type { JoinedInfo, LobbyView, OnlineLobbyProps, SlotUI } from './onlineLobbyTypes';

export function useOnlineLobby({
  initialRoomId,
  initialSlot,
  initialToken,
  onStartGame,
  onExitToLocalMenu,
}: OnlineLobbyProps) {
  const { t } = useTranslation();

  const [view, setView] = useState<LobbyView>(initialRoomId && initialSlot !== undefined ? 'joining' : 'create');
  const [numPlayers, setNumPlayers] = useState<2 | 3 | 4>(2);

  // Host creation config (per slot)
  const [slotConfigs, setSlotConfigs] = useState<RoomSlotConfig[]>([
    { type: 'human', id: 'slot-0' },
    { type: 'ai', aiProfile: 'v1-random', id: 'slot-1' },
  ]);

  const [roomId, setRoomId] = useState<string | null>(initialRoomId ?? null);
  const mySlotRef = useRef<number | null>(initialSlot ?? null);
  const myTokenRef = useRef<string | null>(initialToken ?? null);
  const [myName, setMyName] = useState<string>('');

  const [slotsInfo, setSlotsInfo] = useState<SlotUI[]>([]);
  const [roster, setRoster] = useState<JoinedInfo[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<Record<number, boolean>>({});

  const wsRef = useRef<WebSocket | null>(null);
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
    ws.send(JSON.stringify({ type: 'REQUEST_GAME_START' }));
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
        initialHeights: start.heights,
        initialWind: start.wind,
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
          wsRef.current.close();
        } catch {
          // ignore close errors
        }
      }

      const nameParam = nameForClaim ? `&name=${encodeURIComponent(nameForClaim)}` : '';
      const wsUrl = `${getOnlineWsBase()}/api/rooms/${rId}/ws?slot=${slot}&token=${encodeURIComponent(token)}${nameParam}`;
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
        let msg: ServerGameMessage;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }

        if (msg.type === 'ROSTER_UPDATE') {
          const r = msg as ServerRosterUpdate;
          setRoster(r.roster);
          rosterRef.current = r.roster;
          if (typeof r.numPlayers === 'number') {
            serverNumPlayersRef.current = r.numPlayers;
          }

          const rosterComplete = isRosterReadyToStart(r.roster);

          if (r.gameStarted) {
            serverGameLiveRef.current = true;
            setServerGameLive(true);
          }
          if (r.gameStarted || rosterComplete) {
            requestGameStartCatchUp(ws);
          }
        }

        if (msg.type === 'GAME_START') {
          handleServerGameStart(msg, rId, slot, token, ws);
        }
      };

      ws.onerror = () => {
        setError(t('room_error_generic'));
        setConnected(false);
      };

      ws.onclose = () => {
        setConnected(false);
        if (wsRef.current === ws) {
          wsRef.current = null;
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

  // Cleanup WS on unmount
  useEffect(() => {
    const currentWsRef = wsRef;
    return () => {
      clearReconnectTimer();
      if (currentWsRef.current && !gameStartedRef.current) {
        currentWsRef.current.close();
      }
    };
  }, [clearReconnectTimer]);

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
        console.error('[OnlineLobby] Create room failed with status', res.status, text);
        throw new Error(text || `HTTP ${res.status}`);
      }

      const data: CreateRoomResponse = await res.json();
      setRoomId(data.roomId);
      setSlotsInfo(data.slots);

      // Host defaults to slot 0 (first link). They can also copy any other.
      const hostSlot = 0;
      const hostInfo = data.slots.find((s) => s.slot === hostSlot);
      mySlotRef.current = hostSlot;
      myTokenRef.current = hostInfo?.url ? new URL(hostInfo.url).searchParams.get('token') : null;
      setMyName(t('default_player_name_1'));

      // Switch to waiting view immediately (host also "joins" their slot via WS)
      setView('waiting');

      // Auto-connect the host as well (they share their own link conceptually)
      if (hostInfo?.url) {
        const u = new URL(hostInfo.url);
        connectWebSocket(data.roomId, hostSlot, u.searchParams.get('token') || '', t('default_player_name_1'));
      }
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      console.error('[OnlineLobby] Failed to create room (is the worker running on port 8787?)', errorMessage);
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
      connectWebSocket(roomId, mySlotRef.current, myTokenRef.current, myName.trim());
      setView('waiting');
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      console.error('[OnlineLobby] Failed to initiate join', errorMessage);
      setError(t('room_error_generic'));
    } finally {
      setIsJoining(false);
    }
  };

  // --- Copy helper ---
  const copyLink = async (url: string | null, slot: number) => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopyFeedback((prev) => ({ ...prev, [slot]: true }));
      setTimeout(() => {
        setCopyFeedback((prev) => ({ ...prev, [slot]: false }));
      }, 1400);
    } catch {
      // Fallback: prompt
      prompt('Copiez ce lien :', url);
    }
  };

  // --- Change a slot type (host only, before create) ---
  const updateSlot = (idx: number, patch: Partial<RoomSlotConfig>) => {
    setSlotConfigs((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };

  const leaveRoom = () => {
    if (wsRef.current) wsRef.current.close();
    onExitToLocalMenu?.();
  };

  const isJoinMode = !!initialRoomId && initialSlot !== undefined;

  return {
    view,
    numPlayers,
    slotConfigs,
    roomId,
    myName,
    setMyName,
    slotsInfo,
    roster,
    isCreating,
    isJoining,
    error,
    copyFeedback,
    serverGameLive,
    connected,
    canCreate,
    isJoinMode,
    changeNumPlayers,
    handleCreateRoom,
    handleJoin,
    copyLink,
    updateSlot,
    leaveRoom,
    onExitToLocalMenu,
  };
}

export type OnlineLobbyViewModel = ReturnType<typeof useOnlineLobby>;
