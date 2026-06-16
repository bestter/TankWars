/**
 * TankWars Online Lobby (src/components/OnlineLobby.tsx)
 *
 * Handles:
 * - Host creation flow (select N + per-slot Human/IA, call backend, show all shareable URLs)
 * - Join flow (from ?room=...&slot=...&token=..., enter name, connect)
 * - Live waiting room with roster updates via WebSocket
 * - Auto-start when all human slots are filled (per user spec)
 *
 * Uses native WebSocket (no extra deps). Fully retro VGA styling.
 * All user-facing strings come from i18n (t()).
 *
 * MVP scope: 1-round deathmatch only. Full multi-round + shop in later iteration.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CreateRoomResponse, RoomSlotConfig, ServerGameMessage, ServerRosterUpdate } from '../types/room';
import type { Player } from '../types/player';
import { VGA_PALETTE } from '../types/game';

export interface OnlineLobbyProps {
  /** When provided via URL params we are in "join" mode for that slot */
  initialRoomId?: string;
  initialSlot?: number;
  initialToken?: string;

  /** Called when the game actually starts (server sent GAME_START). Parent transitions to GameCanvas. */
  onStartGame: (players: Player[], meta: { roomId: string; localPlayerId: string; gameMode: 'online'; initialHeights?: number[]; initialWind?: number; initialCurrentPlayerIndex?: number; slot?: number; token?: string }) => void;

  /** Optional: return to the pure local MainMenu */
  onExitToLocalMenu?: () => void;
}

type LobbyView = 'create' | 'waiting' | 'joining';

interface SlotUI {
  slot: number;
  type: 'human' | 'ai';
  aiProfile?: string;
  url: string | null; // only for humans after create
}

interface JoinedInfo {
  slot: number;
  name: string;
  type: 'human' | 'ai';
}

const API_BASE = import.meta.env.DEV ? 'http://localhost:8787' : ''; // wrangler dev default port
const WS_BASE = import.meta.env.DEV ? 'ws://localhost:8787' : (typeof window !== 'undefined' ? `wss://${window.location.host}` : '');

export function OnlineLobby({ initialRoomId, initialSlot, initialToken, onStartGame, onExitToLocalMenu }: OnlineLobbyProps) {
  const { t } = useTranslation();

  const [view, setView] = useState<LobbyView>(initialRoomId && initialSlot !== undefined ? 'joining' : 'create');
  const [numPlayers, setNumPlayers] = useState<2 | 3 | 4>(2);

  // Host creation config (per slot)
  const [slotConfigs, setSlotConfigs] = useState<RoomSlotConfig[]>([
    { type: 'human' },
    { type: 'ai', aiProfile: 'v1-random' },
  ]);

  const [roomId, setRoomId] = useState<string | null>(initialRoomId ?? null);
  const [mySlot, setMySlot] = useState<number | null>(initialSlot ?? null);
  const [myToken, setMyToken] = useState<string | null>(initialToken ?? null);
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

  // Keep slotConfigs in sync with numPlayers (exact same pattern as local MainMenu — no setState inside effect)
  const changeNumPlayers = (n: 2 | 3 | 4): void => {
    if (n === numPlayers) return;
    setNumPlayers(n);
    setSlotConfigs((prev) => {
      const next = [...prev];
      while (next.length < n) {
        const idx = next.length;
        next.push(idx === 0 ? { type: 'human' } : { type: 'ai', aiProfile: 'v1-random' as const });
      }
      return next.slice(0, n);
    });
  };

  const canCreate = slotConfigs.every((c) => c.type === 'human' || !!c.aiProfile);

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

      const res = await fetch(`${API_BASE}/api/rooms`, {
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
      setMySlot(hostSlot);
      setMyToken(hostInfo?.url ? new URL(hostInfo.url).searchParams.get('token') : null);
      setMyName(t('default_player_name_1'));

      // Switch to waiting view immediately (host also "joins" their slot via WS)
      setView('waiting');

      // Auto-connect the host as well (they share their own link conceptually)
      if (hostInfo?.url) {
        const u = new URL(hostInfo.url);
        connectWebSocket(data.roomId, hostSlot, u.searchParams.get('token') || '', t('default_player_name_1'));
      }
    } catch (e) {
      console.error('[OnlineLobby] Failed to create room (is the worker running on port 8787?)', e);
      setError(t('room_error_generic'));
    } finally {
      setIsCreating(false);
    }
  };

  // --- Join flow (from link or manual) ---
  const handleJoin = async () => {
    if (!roomId || mySlot === null || !myToken || !myName.trim() || isJoining) return;
    setIsJoining(true);
    setError(null);

    try {
      connectWebSocket(roomId, mySlot, myToken, myName.trim());
      setView('waiting');
    } catch (e) {
      console.error('[OnlineLobby] Failed to initiate join', e);
      setError(t('room_error_generic'));
    } finally {
      setIsJoining(false);
    }
  };

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
      });

      try {
        ws.close();
      } catch {
        // ignore close errors
      }
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
      const wsUrl = `${WS_BASE}/api/rooms/${rId}/ws?slot=${slot}&token=${encodeURIComponent(token)}${nameParam}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setError(null);
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
          if (r.gameStarted) {
            setServerGameLive(true);
            if (!gameStartedRef.current) {
              missedGameStartRef.current = true;
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'REQUEST_GAME_START' }));
              }
            }
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
    },
    [clearReconnectTimer, handleServerGameStart, scheduleReconnect, t],
  );

  useEffect(() => {
    connectWebSocketRef.current = connectWebSocket;
  }, [connectWebSocket]);

  // Retry GAME_START catch-up while the match is live but this tab missed the broadcast
  useEffect(() => {
    if (view !== 'waiting' && view !== 'joining') return;
    const retryId = setInterval(() => {
      if (gameStartedRef.current || !missedGameStartRef.current) return;
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'REQUEST_GAME_START' }));
      }
    }, 2000);
    return () => clearInterval(retryId);
  }, [view]);

  // Cleanup WS on unmount
  useEffect(() => {
    return () => {
      clearReconnectTimer();
      gameStartedRef.current = false;
      missedGameStartRef.current = false;
      connectionRef.current = null;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [clearReconnectTimer]);

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

  // --- Render ---
  const isJoinMode = !!initialRoomId && initialSlot !== undefined;

  return (
    <div className="retro-menu-container" style={{ padding: 12 }}>
      <div className="retro-menu-frame" style={{ maxWidth: 820, margin: '0 auto' }}>
        <div className="retro-menu-inner">
          <h1 className="retro-title" style={{ fontSize: 28 }}>{t('main_title')}</h1>
          <p className="retro-subtitle" style={{ marginBottom: 12 }}>{t('create_online_game')}</p>

          {error && (
            <div style={{ color: VGA_PALETTE.RED, marginBottom: 10, fontSize: 13 }}>{error}</div>
          )}

          {/* CREATE VIEW (host) */}
          {view === 'create' && !isJoinMode && (
            <>
              <div style={{ marginBottom: 10, color: '#AAAAAA', fontSize: 12 }}>{t('num_players_label')}</div>
              <div style={{ marginBottom: 14 }}>
                {[2, 3, 4].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`retro-num-btn ${n === numPlayers ? 'active' : ''}`}
                    onClick={() => changeNumPlayers(n as 2 | 3 | 4)}
                  >
                    {n}
                  </button>
                ))}
              </div>

              <div style={{ marginBottom: 8, color: '#AAAAAA', fontSize: 12 }}>
                {t('battle_configuration')} — {t('auto_start_note')}
              </div>

              {import.meta.env.DEV && (
                <div style={{ fontSize: 11, color: '#666', marginBottom: 8 }}>
                  Dev: Assurez-vous que <code>npm run worker:dev</code> tourne dans un autre terminal (port 8787 par défaut).
                </div>
              )}

              {slotConfigs.map((cfg, idx) => (
                <div key={idx} style={{ marginBottom: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ width: 92, color: VGA_PALETTE.YELLOW, fontSize: 12 }}>
                    {t('slot_label', { num: idx + 1 })}
                  </span>

                  <select
                    value={cfg.type === 'human' ? 'human' : `ai:${cfg.aiProfile}`}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === 'human') {
                        updateSlot(idx, { type: 'human', aiProfile: undefined });
                      } else {
                        const prof = v.split(':')[1] as 'v1-random' | 'v2-heuristic' | 'v3-sniper' | 'v4-smart' | undefined;
                        updateSlot(idx, { type: 'ai', aiProfile: prof });
                      }
                    }}
                    style={{ background: '#111', color: '#fff', border: '1px solid #555', padding: '2px 6px' }}
                  >
                    <option value="human">{t('slot_human')}</option>
                    <option value="ai:v1-random">{t('slot_ai_simple')}</option>
                    <option value="ai:v2-heuristic">{t('slot_ai_ok')}</option>
                    <option value="ai:v3-sniper">{t('slot_ai_sniper')}</option>
                    <option value="ai:v4-smart">{t('slot_ai_expert')}</option>
                  </select>

                  <span style={{ fontSize: 11, color: '#666' }}>
                    {cfg.type === 'human' ? 'URL générée' : 'serveur (pas d’URL)'}
                  </span>
                </div>
              ))}

              <div style={{ marginTop: 14, textAlign: 'center' }}>
                <button
                  type="button"
                  className="retro-start-btn"
                  onClick={handleCreateRoom}
                  disabled={!canCreate || isCreating}
                  style={{ opacity: canCreate && !isCreating ? 1 : 0.6 }}
                >
                  {isCreating ? t('creating_room') : t('create_room_btn')}
                </button>
              </div>

              <div style={{ marginTop: 16, textAlign: 'center' }}>
                <button type="button" onClick={onExitToLocalMenu} style={{ fontSize: 12 }}>
                  {t('online_back_to_local')}
                </button>
              </div>
            </>
          )}

          {/* JOINING / WAITING VIEW (shared) */}
          {(view === 'waiting' || view === 'joining') && (
            <>
              <div style={{ color: VGA_PALETTE.CYAN, marginBottom: 8, fontSize: 13 }}>
                {roomId ? `${t('room_code_label')}: ${roomId}` : t('connecting')}
              </div>

              {view === 'joining' && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ marginBottom: 6 }}>{t('you_are_player', { num: (initialSlot ?? 0) + 1, slot: initialSlot })}</div>
                  <input
                    type="text"
                    placeholder={t('enter_name_placeholder')}
                    value={myName}
                    onChange={(e) => setMyName(e.target.value)}
                    style={{ width: '100%', padding: 6, background: '#000', color: '#fff', border: '1px solid #555' }}
                  />
                  <button
                    type="button"
                    className="retro-start-btn"
                    style={{ marginTop: 8, width: '100%' }}
                    onClick={handleJoin}
                    disabled={!myName.trim() || isJoining}
                  >
                    {isJoining ? t('joining') : t('join_room_btn')}
                  </button>
                </div>
              )}

              {/* After creation or successful join: show links (host) + roster */}
              {view === 'waiting' && slotsInfo.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ color: '#AAAAAA', fontSize: 12, marginBottom: 4 }}>{t('room_created')}</div>
                  {slotsInfo.map((s) => (
                    <div key={s.slot} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 12 }}>
                      <span style={{ color: s.type === 'human' ? VGA_PALETTE.FLASH_GREEN : '#888', width: 140 }}>
                        {t('slot_label', { num: s.slot + 1 })} — {s.type === 'human' ? 'HUMAIN' : `IA ${s.aiProfile || ''}`}
                      </span>
                      {s.url && (
                        <>
                          <button type="button" onClick={() => copyLink(s.url, s.slot)} style={{ fontSize: 11 }}>
                            {copyFeedback[s.slot] ? t('link_copied') : t('copy_link')}
                          </button>
                          <a href={s.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: VGA_PALETTE.ELECTRIC_CYAN }}>
                            {t('open_link')}
                          </a>
                        </>
                      )}
                      {!s.url && <span style={{ color: '#666' }}>(IA — pas de lien)</span>}
                    </div>
                  ))}
                </div>
              )}

              {/* Live roster */}
              <div style={{ marginBottom: 8, color: VGA_PALETTE.YELLOW, fontSize: 13 }}>
                {t('waiting_room_title')} — {t('players_connected', { joined: roster.length, total: numPlayers || slotsInfo.length || 2 })}
              </div>

              <div style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>
                {roster.length === 0 && <span>{t('waiting_for_players')}</span>}
                {roster.map((r) => (
                  <div key={r.slot} style={{ color: r.type === 'ai' ? '#888' : '#fff' }}>
                    {t('slot_label', { num: r.slot + 1 })} : {r.name} {r.type === 'ai' ? `(${t('slot_status_ai')})` : ''}
                  </div>
                ))}
              </div>

              <div style={{ color: '#666', fontSize: 11, marginBottom: 12 }}>{t('auto_start_note')}</div>

              {serverGameLive && (
                <div style={{ color: VGA_PALETTE.FLASH_GREEN, fontSize: 12, marginBottom: 8 }}>
                  {t('all_ready_auto_start')}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button type="button" onClick={() => {
                  if (wsRef.current) wsRef.current.close();
                  onExitToLocalMenu?.();
                }}>
                  {t('leave_room')}
                </button>
              </div>

              {connected && <div style={{ marginTop: 8, fontSize: 11, color: VGA_PALETTE.FLASH_GREEN }}>● Connecté</div>}
            </>
          )}

          <div className="retro-legal" style={{ marginTop: 16 }}>
            {t('legal_footer')}
          </div>
        </div>
      </div>
    </div>
  );
}
