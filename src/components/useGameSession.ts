import { useCallback, useEffect, useRef, useReducer, useState } from "react";
import { GameEngine } from "../game/engine/GameEngine";
import type { CurrentTurnInfo } from "../game/engine/TurnManager";
import { VGA_PALETTE } from "../types/game";
import { AIByProfileStrategy } from "../game/entities/ai/AIByProfileStrategy";
import type { Player } from "../types/player";
import type { WeaponId } from "../types/weapon";
import { WEAPON_REGISTRY, DEFAULT_INVENTORY } from "../types/weapon";
import type { GamePhase } from "../types/game";
import { gameCanvasReducer, INITIAL_STATE } from "./gameCanvasReducer";
import { autoBuyForAI } from "../game/entities/ai/aiShopHelper";
import { trackEvent } from "../utils/analytics";
import { setRNG, createSeededRNG, seedFromRoomRound } from "../utils/random";
import { getOnlineWsBase } from "../utils/onlineApi";
import {
  clearOnlineSession,
  persistOnlineSession,
  type OnlineCanvasSnapshot,
} from "../utils/onlineSession";

function buildInitialCanvasState(
  resume?: OnlineCanvasSnapshot,
): typeof INITIAL_STATE {
  if (!resume) return INITIAL_STATE;
  return { ...INITIAL_STATE, ...resume };
}

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 480;

function createDemoPlayers(): Player[] {
  return [
    {
      id: "player-1",
      name: "You",
      isHuman: true,
      tank: {
        id: "tank-1",
        position: { x: 180, y: 320 },
        angle: 45,
        power: 50,
        health: 100,
        maxHealth: 100,
        shield: 40,
        maxShield: 40,
        isDead: false,
        color: VGA_PALETTE.BLUE,
        currentWeapon: "MISSILE",
      },
      money: 200,
      inventory: { ...DEFAULT_INVENTORY },
    },
    {
      id: "player-2",
      name: "AI Bot",
      isHuman: false,
      tank: {
        id: "tank-2",
        position: { x: 620, y: 295 },
        angle: 135,
        power: 50,
        health: 100,
        maxHealth: 100,
        shield: 40,
        maxShield: 40,
        isDead: false,
        color: VGA_PALETTE.RED,
        currentWeapon: "MISSILE",
      },
      money: 200,
      inventory: { ...DEFAULT_INVENTORY },
    },
  ];
}

interface UseGameSessionProps {
  initialPlayers?: Player[];
  onReturnToMenu?: () => void;
  /** Online mode */
  gameMode?: 'local' | 'online';
  localPlayerId?: string;
  roomId?: string;
  initialHeights?: number[];
  initialWind?: number;
  initialCurrentPlayerIndex?: number;
  resumeCanvas?: OnlineCanvasSnapshot;
  slot?: number;
  token?: string;
  ws?: WebSocket;
}

/**
 * Module-level generation counter for the combat WS mount effect.
 * Lets cleanup defer-close without killing a socket reclaimed by Strict Mode remount.
 */
let combatWsEffectGen = 0;

export function useGameSession({
  initialPlayers,
  onReturnToMenu,
  gameMode = 'local',
  localPlayerId,
  roomId,
  initialHeights,
  initialWind,
  initialCurrentPlayerIndex,
  resumeCanvas,
  slot,
  token,
  ws,
}: UseGameSessionProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const gameWsRef = useRef<WebSocket | null>(null);
  const initialWsRef = useRef(ws);
  /** Outbox for combat WS messages when the socket is not yet OPEN. */
  const pendingCombatMessagesRef = useRef<string[]>([]);
  const roundEndFromNetworkRef = useRef(false);
  const shopSyncRef = useRef({
    applyRemoteAdvance: (nextIndex: number) => {
      void nextIndex;
    },
    applyRemoteBuySell: (players: Player[]) => {
      void players;
    },
    /** Optional final roster (money/inventory) applied only before startNextRound. */
    finishShop: (players?: Player[]) => {
      void players;
    },
  });
  /** Shop WS messages received before this client entered SHOP (SUMMARY/CELEBRATION lag). */
  const pendingShopNextIndexRef = useRef<number | null>(null);
  const pendingShopFinishRef = useRef(false);
  const pendingShopPlayersRef = useRef<Player[] | null>(null);
  const handleGoToShopRef = useRef<() => void>(() => {});
  const finishShopPhaseRef = useRef<(finalPlayers?: Player[]) => void>(() => {});

  const [state, dispatch] = useReducer(
    gameCanvasReducer,
    resumeCanvas,
    buildInitialCanvasState,
  );
  const {
    gamePhase,
    shopPlayers,
    currentShopIndex,
    uiPlayers,
    currentManche,
    roundResult,
    lastRoundOutcome,
    wind: canvasWind,
  } = state;

  // Ref to avoid stale closure in engine callbacks registered in mount effect (gamePhase updates)
  const gamePhaseRef = useRef<GamePhase>("COMBAT");

  // Refs to avoid stale closures in the setTimeout-based AI shopping chain (process/advance).
  const shopPlayersRef = useRef<Player[]>([]);
  const currentShopIndexRef = useRef(0);
  /** Prevents double finishShopPhase from chained AI timeouts */
  const shopFinishingRef = useRef(false);
  const shopAiTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Snapshot des joueurs initiaux au montage (évite de mettre initialPlayers dans les deps du useEffect one-shot)
  const initialPlayersRef = useRef(initialPlayers);

  // Timer for round celebration fireworks (10s auto-advance or skip with SPACE)
  const celebrationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // Sync refs to avoid stale closures
  useEffect(() => {
    gamePhaseRef.current = gamePhase;
  }, [gamePhase]);

  useEffect(() => {
    shopPlayersRef.current = shopPlayers;
  }, [shopPlayers]);

  useEffect(() => {
    currentShopIndexRef.current = currentShopIndex;
  }, [currentShopIndex]);

  const currentMancheRef = useRef(1);
  useEffect(() => {
    currentMancheRef.current = state.currentManche;
  }, [state.currentManche]);

  // Persist online match so refresh / accidental MENU does not drop into the waiting-room lobby.
  useEffect(() => {
    if (
      gameMode !== "online" ||
      !roomId ||
      slot == null ||
      !token ||
      !localPlayerId
    ) {
      return;
    }
    if (gamePhase === "GAME_OVER") {
      clearOnlineSession();
      return;
    }
    const roster = uiPlayers.length > 0 ? uiPlayers : (initialPlayers ?? []);
    if (roster.length < 2) return;

    persistOnlineSession({
      meta: {
        roomId,
        localPlayerId,
        slot,
        token,
        initialHeights,
        initialWind,
        initialCurrentPlayerIndex,
      },
      players: roster,
      canvas: {
        gamePhase,
        currentManche,
        uiPlayers: roster,
        shopPlayers,
        currentShopIndex,
        roundResult,
        lastRoundOutcome,
        wind: canvasWind,
      },
    });
  }, [
    gameMode,
    roomId,
    slot,
    token,
    localPlayerId,
    gamePhase,
    currentManche,
    uiPlayers,
    shopPlayers,
    currentShopIndex,
    roundResult,
    lastRoundOutcome,
    canvasWind,
    initialPlayers,
    initialHeights,
    initialWind,
    initialCurrentPlayerIndex,
  ]);

  const clearShopAiTimeout = useCallback((): void => {
    if (shopAiTimeoutRef.current !== null) {
      clearTimeout(shopAiTimeoutRef.current);
      shopAiTimeoutRef.current = null;
    }
  }, []);

  const flushCombatMessages = useCallback((): void => {
    const ws = gameWsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (pendingCombatMessagesRef.current.length > 0) {
      const payload = pendingCombatMessagesRef.current.shift();
      if (!payload) continue;
      try {
        ws.send(payload);
      } catch (e) {
        console.warn('[Game] Failed to flush combat message', e);
        pendingCombatMessagesRef.current.unshift(payload);
        break;
      }
    }
  }, []);

  const sendCombatMessage = useCallback(
    (obj: Record<string, unknown>): void => {
      const payload = JSON.stringify(obj);
      const ws = gameWsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(payload);
          return;
        } catch (e) {
          console.warn('[Game] WS send failed, queueuing', e);
        }
      }
      pendingCombatMessagesRef.current.push(payload);
      console.warn(
        `[Game] Queued combat message type=${String(obj.type)} (ws readyState=${ws?.readyState ?? 'null'})`,
      );
    },
    [],
  );

  /**
   * Online: parallel boutique — each human shops their own tank until they press Ready.
   * Local/hotseat: sequential index (classic).
   */
  const [localShopDone, setLocalShopDone] = useState(false);
  const localShopDoneRef = useRef(false);

  const onlineShopPlayer =
    gameMode === 'online' && localPlayerId
      ? shopPlayers.find((p) => p.id === localPlayerId) ?? null
      : null;

  const isLocalShopTurn =
    gameMode === 'online'
      ? !localShopDone && !!onlineShopPlayer?.isHuman
      : !localPlayerId ||
        (!!shopPlayers[currentShopIndex]?.isHuman &&
          shopPlayers[currentShopIndex]?.id === localPlayerId);

  /** Player shown in the shop UI (self online; sequential index offline). */
  const shopDisplayPlayer =
    gameMode === 'online'
      ? onlineShopPlayer
      : (shopPlayers[currentShopIndex] ?? null);

  /** Host (slot 0) applies AI auto-buy once when entering online boutique. */
  const isOnlineShopHost = gameMode === 'online' && slot === 0;

  const clearCelebrationTimer = useCallback(() => {
    if (celebrationTimerRef.current !== null) {
      clearTimeout(celebrationTimerRef.current);
      celebrationTimerRef.current = null;
    }
  }, []);

  const goToSummary = useCallback(() => {
    clearCelebrationTimer();
    const eng = engineRef.current;
    if (eng) {
      eng.clearRoundCelebration();
    }
    dispatch({ type: "GO_TO_SUMMARY" });
    gamePhaseRef.current = "SUMMARY";
  }, [clearCelebrationTimer]);

  // Stable render function that delegates to the engine
  const renderFrame = () => {
    const ctx = ctxRef.current;
    const engine = engineRef.current;
    if (ctx && engine) {
      engine.render(ctx);
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // === CANVAS SETUP (never during render) ===
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;

    const ctx = canvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });
    if (!ctx) return;

    ctxRef.current = ctx;

    let fireChannel: BroadcastChannel | null = null;
    let gameWs: WebSocket | null = null;

    // === GAME ENGINE ===
    const engine = new GameEngine(CANVAS_WIDTH, CANVAS_HEIGHT, {
      gravity: 260,
      baseShotSpeed: 420,
    });

    // Online: load the authoritative terrain heights sent by the server
    // BEFORE setPlayers, so spawnTanks will snap tank Y positions to the server heights.
    if (gameMode === 'online' && initialHeights && initialHeights.length > 0) {
      try {
        engine.getTerrain().loadHeights(initialHeights);
      } catch (e) {
        console.warn('[useGameSession] could not load initialHeights', e);
      }
    }

    // Online: seeded RNG per combat round so spawnTanks + wind are identical on every client.
    if (gameMode === 'online' && roomId) {
      setRNG(createSeededRNG(seedFromRoomRound(roomId, 1)));
    }

    // Cross-tab sync for online dev testing (same browser, multiple tabs)
    // When one tab fires, it announces the command via BroadcastChannel so other tabs can replay the exact same shot.
    // This keeps terrain/damage in sync until we have real server-authoritative simulation + WS broadcast.
    /** Dedup remote SHOT replays (reconnect catch-up can re-send the same in-flight shot). */
    let lastReplayedShotKey: string | null = null;

    if (gameMode === 'online' && roomId && localPlayerId) {
      fireChannel = new BroadcastChannel(`tankwars-fire-${roomId}`);

      // Listen for fires announced by other tabs
      fireChannel.onmessage = (ev) => {
        if (ev.data?.type === 'FIRE' && ev.data.command) {
          const tm = engine.getTurnManager();
          // Only replay if it's not our own local fire (to avoid double execution)
          if (ev.data.fromPlayerId !== localPlayerId) {
            tm.executeRemoteFire(ev.data.command);
          }
        }
      };

      // Wrap tryFire so that when *we* successfully fire as local human, we announce to other tabs
      const tm = engine.getTurnManager();
      const origTryFire = tm.tryFire.bind(tm);
      tm.tryFire = () => {
        const ok = origTryFire();
        console.log(`[Game] tm.tryFire called. ok=${ok}, localPlayerId=${localPlayerId}`);
        if (ok && localPlayerId) {
          // Use the exact command captured before ammo consume / weapon auto-switch.
          const command = tm.getLastLocalFireCommand();
          if (command) {
            console.log('[Game] Sending FIRE to server via WebSocket');
            sendCombatMessage({ type: 'FIRE', command });
            // Same-browser multi-tab fallback (does not replace the server path).
            if (fireChannel) {
              fireChannel.postMessage({
                type: 'FIRE',
                fromPlayerId: localPlayerId,
                command,
              });
            }
          }
        }
        return ok;
      };
    }

    // === Game phase persistent WS connection to the room DO for authoritative sync ===
    // This survives the lobby unmount. Client sends FIRE to server; server simulates and broadcasts SHOT + STATE_UPDATE to all sockets in room.
    // Clients apply server state for sync, and replay SHOT for visuals.
    let combatReconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let combatStartTimer: ReturnType<typeof setTimeout> | null = null;
    let isMounted = true;
    /** Bumps on each effect run so Strict Mode remount does not close the live combat socket. */
    const effectGeneration = ++combatWsEffectGen;

    if (gameMode === 'online' && roomId && slot != null && token) {
    const combatRoomId = roomId;
    const combatSlot = slot;
    const combatToken = token;
    const wsBase = getOnlineWsBase();
    const localSlotNum = Number(combatSlot);

    const clearCombatReconnect = (): void => {
      if (combatReconnectTimer !== null) {
        clearTimeout(combatReconnectTimer);
        combatReconnectTimer = null;
      }
    };

    function bindCombatWsHandlers(ws: WebSocket): void {
      ws.onopen = () => {
        console.log('[Game] Combat WS connected to server');
        flushCombatMessages();
        // Pull turn index + any in-flight SHOT we may have missed during transition/reconnect.
        try {
          ws.send(JSON.stringify({ type: 'REQUEST_GAME_START' }));
        } catch {
          // ignore
        }
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          const tm = engine.getTurnManager();

          if (msg.type === 'GAME_START' && typeof msg.currentPlayerIndex === 'number') {
            console.log(`[Game] Received GAME_START: currentPlayerIndex=${msg.currentPlayerIndex}`);
            tm.syncTurn(msg.currentPlayerIndex);
            if (typeof msg.wind === 'number') {
              engine.setWindForce(msg.wind);
            }
          }

          if (msg.type === 'SHOT' && msg.command) {
            const shotSlot =
              typeof msg.slot === 'number' ? msg.slot : Number(msg.slot);
            console.log('[Game] Received SHOT from slot=', shotSlot, ', cmd=', msg.command);
            // For the firer, we already executed the full local fire for immediate feedback.
            // Replay for every other slot so observers always see the projectile.
            if (
              !Number.isNaN(shotSlot) &&
              shotSlot !== localSlotNum &&
              gamePhaseRef.current === 'COMBAT' &&
              !tm.isInterRoundPaused()
            ) {
              const shotKey = `${shotSlot}:${msg.command.angle}:${msg.command.power}:${msg.command.weaponId}:${String(msg.ownerId ?? '')}`;
              if (shotKey === lastReplayedShotKey && engine.getActiveProjectiles().length > 0) {
                console.log('[Game] Skipping duplicate in-flight SHOT replay');
              } else {
                lastReplayedShotKey = shotKey;
                tm.executeRemoteFire(msg.command, {
                  fromSlot: shotSlot,
                  ownerId: typeof msg.ownerId === 'string' ? msg.ownerId : undefined,
                });
              }
            } else {
              console.log(
                `[Game] SHOT not replayed (shotSlot=${shotSlot}, localSlot=${localSlotNum}, phase=${gamePhaseRef.current}, paused=${tm.isInterRoundPaused()})`,
              );
            }
          }

          if (msg.type === 'STATE_UPDATE') {
            console.log(`[Game] Received STATE_UPDATE: currentPlayerIndex=${msg.currentPlayerIndex}`);
            // MVP: server only coordinates turn order. Clients run local physics after SHOT replay.
            // Do NOT apply server players/heights here — the DO stub still carries placeholder
            // spawn Y values (≈280) which teleport tanks into the sky and reset crater terrain.
            // Ignore late turn updates after round end (prevents desync back into "waiting for shot").
            if (
              gamePhaseRef.current === 'COMBAT' &&
              !tm.isInterRoundPaused()
            ) {
              if (typeof msg.currentPlayerIndex === 'number') {
                tm.syncTurn(msg.currentPlayerIndex);
              }
              if (typeof msg.wind === 'number') {
                engine.setWindForce(msg.wind);
              }
            }
          }

          if (msg.type === 'SHOP_BUY_SELL' && Array.isArray(msg.players) && msg.slot !== slot) {
            shopSyncRef.current.applyRemoteBuySell(msg.players);
          }

          // Authoritative parallel shop state from the Durable Object.
          if (msg.type === 'SHOP_STATE') {
            if (Array.isArray(msg.players) && msg.players.length > 0) {
              shopSyncRef.current.applyRemoteBuySell(msg.players);
            }
            if (msg.done === true) {
              shopSyncRef.current.finishShop(
                Array.isArray(msg.players) && msg.players.length > 0
                  ? msg.players
                  : undefined,
              );
            } else if (typeof msg.shopIndex === 'number' && msg.mode !== 'parallel') {
              // Legacy sequential cursor (older server).
              shopSyncRef.current.applyRemoteAdvance(msg.shopIndex);
            }
            // Parallel mode: readySlots is informational only; combat starts on SHOP_FINISH.
          }

          // Legacy advance relay (older server / mid-deploy). Prefer SHOP_STATE.
          if (msg.type === 'SHOP_ADVANCE' && typeof msg.nextIndex === 'number' && msg.slot !== slot) {
            shopSyncRef.current.applyRemoteAdvance(msg.nextIndex);
          }

          // Server authority for boutique end. Must not setPlayers after combat already started
          // (that stomped spawnTanks and re-applied isDead → P1 "turn" but cannot fire).
          if (msg.type === 'SHOP_FINISH' && Array.isArray(msg.players)) {
            shopSyncRef.current.finishShop(msg.players);
          }

          if (msg.type === 'ROUND_END' && Array.isArray(msg.players) && msg.slot !== slot) {
            if (gamePhaseRef.current === 'COMBAT') {
              roundEndFromNetworkRef.current = true;
              engine.syncRoundEndFromRemote(
                msg.players,
                typeof msg.roundWinnerId === 'string' ? msg.roundWinnerId : null,
                !!msg.isDraw,
              );
            }
          }
        } catch (e) {
          console.warn('[Game] invalid WS message', e);
        }
      };

      ws.onclose = () => {
        console.log('[Game] Combat WS closed');
        if (gameWsRef.current === ws) {
          gameWsRef.current = null;
          if (gamePhaseRef.current !== 'GAME_OVER' && isMounted) {
            clearCombatReconnect();
            combatReconnectTimer = setTimeout(() => {
              combatReconnectTimer = null;
              connectCombatWs();
            }, 2000);
          }
        }
      };
      ws.onerror = (e) => {
        console.warn('[Game] Combat WS error', e);
      };
    }

    function connectCombatWs(): void {
      if (!isMounted) return;
      if (
        gameWsRef.current?.readyState === WebSocket.OPEN ||
        gameWsRef.current?.readyState === WebSocket.CONNECTING
      ) {
        return;
      }
      const wsUrl = `${wsBase}/api/rooms/${combatRoomId}/ws?slot=${combatSlot}&token=${encodeURIComponent(combatToken)}`;
      gameWs = new WebSocket(wsUrl);
      gameWsRef.current = gameWs;
      bindCombatWsHandlers(gameWs);
    }

    const incomingWs = initialWsRef.current;
    if (incomingWs && incomingWs.readyState === WebSocket.OPEN) {
      console.log('[Game] Re-using existing WebSocket connection from lobby');
      gameWs = incomingWs;
      gameWsRef.current = incomingWs;
      bindCombatWsHandlers(incomingWs);
      // Lobby socket is already OPEN — onopen will not fire again; flush + catch-up now.
      flushCombatMessages();
      try {
        incomingWs.send(JSON.stringify({ type: 'REQUEST_GAME_START' }));
      } catch {
        // ignore
      }
    } else {
      console.log('[Game] No existing active WS or not open. Connecting new WebSocket...');
      combatStartTimer = setTimeout(connectCombatWs, 50);
    }
    }

    // === PLAYERS: provenance MainMenu (via props) OU démo 2 joueurs (standalone / New Game) ===
    const snapshotPlayers = initialPlayersRef.current;
    const players: Player[] =
      snapshotPlayers && snapshotPlayers.length >= 2
        ? snapshotPlayers.map((p) => ({ ...p }))
        : createDemoPlayers();

    // Online: set local player id BEFORE setPlayers so startFirstTurn locks input correctly.
    if (localPlayerId) {
      engine.setLocalPlayerId(localPlayerId);
    }

    const resumed = resumeCanvas;
    const tm = engine.getTurnManager();

    if (resumed && resumed.uiPlayers.length >= 2) {
      engine.getTankManager().setPlayers(resumed.uiPlayers.map((p) => ({ ...p })));
      gamePhaseRef.current = resumed.gamePhase;
      shopPlayersRef.current = resumed.shopPlayers;
      currentShopIndexRef.current = resumed.currentShopIndex;

      if (resumed.gamePhase === 'COMBAT') {
        tm.resumeForCombat();
        tm.setupInputListeners();
        if (typeof initialCurrentPlayerIndex === 'number') {
          tm.syncTurn(initialCurrentPlayerIndex);
        }
      } else {
        engine.enterInterRoundPhase();
      }
      if (resumed.wind) {
        engine.setWindForce(resumed.wind);
      }
      dispatch({ type: "SET_UI_PLAYERS", players: resumed.uiPlayers });
    } else {
      engine.setPlayers(players);
      if (gameMode === 'online' && typeof initialCurrentPlayerIndex === 'number') {
        tm.syncTurn(initialCurrentPlayerIndex);
      }
      dispatch({ type: "SET_UI_PLAYERS", players });
    }

    // Also set wind if provided (for HUD etc.; main sync will come from server updates)
    if (gameMode === 'online' && typeof initialWind === 'number') {
      // The engine has onWindChange but for initial we can set via internal if needed.
      // For now the first wind update will come, or we can dispatch it.
      // Simple: the wind banner will pick it up on first change; for start we can live with server value later.
    }

    let humanCount = 0;
    let aiCount = 0;
    const aiProfiles: string[] = [];
    for (const p of players) {
      if (p.isHuman) {
        humanCount++;
      } else {
        aiCount++;
        aiProfiles.push(p.aiProfile ?? "v1-random");
      }
    }

    // Track game start event with Cloudflare Zaraz
    trackEvent("game_start", {
      playerCount: players.length,
      humanCount,
      aiCount,
      aiProfiles,
    });

    // Inject profile-aware AI (v1-random = IA Simple / Mr. Simple; v2-heuristic = IA OK smarter).
    engine.setAIEngine(new AIByProfileStrategy());

    engine.onWindChange = (w) => dispatch({ type: "SET_WIND", wind: w });

    // Envoi de l'événement SHOT_SETTLED au serveur en mode multijoueur lorsque le coup local s'est stabilisé
    engine.getTurnManager().onShotSettled = () => {
      console.log(`[Game] onShotSettled callback triggered. gameMode=${gameMode}, localPlayerId=${localPlayerId}`);
      if (gameMode === 'online' && localPlayerId) {
        const tm = engine.getTurnManager();
        const currentPlayer = tm.getCurrentPlayer();
        console.log(`[Game] onShotSettled: currentPlayer.id=${currentPlayer?.id}, localPlayerId=${localPlayerId}`);
        // Prefer identity match; also accept "still awaiting server turn" so a late
        // index desync cannot drop the only message that advances the room.
        const shouldNotify =
          (currentPlayer && currentPlayer.id === localPlayerId) ||
          tm.isAwaitingServerTurnAfterLocalShot();
        if (shouldNotify) {
          console.log('[Game] Sending SHOT_SETTLED to server');
          sendCombatMessage({ type: 'SHOT_SETTLED', slot });
        }
      }
    };

    // Wire callbacks
    engine.onProjectileHit = (hit) => {
      console.log(
        "[GameEngine] Hit:",
        hit.weaponId,
        "at",
        "(coordinates redacted)",
      );
    };

    // Listen to turn/HUD updates for real-time display
    engine.onTurnHudUpdate = (info: CurrentTurnInfo) => {
      dispatch({ type: "SET_TURN_INFO", info });
    };

    /**
     * Combat round ends on last man standing (0 or 1 tanks remain alive).
     */
    engine.onRoundEnded = (payload) => {
      if (gamePhaseRef.current !== "COMBAT") return;

      const fromNetwork = roundEndFromNetworkRef.current;
      roundEndFromNetworkRef.current = false;

      if (
        gameMode === "online" &&
        !fromNetwork &&
        gameWsRef.current?.readyState === WebSocket.OPEN
      ) {
        gameWsRef.current.send(
          JSON.stringify({
            type: "ROUND_END",
            players: [...engine.getTankManager().getPlayers()],
            roundWinnerId: payload.roundWinner?.id ?? null,
            isDraw: payload.isDraw,
            slot,
          }),
        );
      }

      tm.pauseForInterRound();

      const res = engine.awardEndOfRoundEarnings();
      const nextPlayers = [...engine.getTankManager().getPlayers()];

      // Track round end event (custom Zaraz analytics)
      const winner = payload.roundWinner;
      const winnerType = winner ? (winner.isHuman ? "human" : "ai") : "none";
      const winnerProfile = winner && !winner.isHuman ? (winner.aiProfile ?? "v1-random") : undefined;

      let nextHumanCount = 0;
      let nextAiCount = 0;
      for (const p of nextPlayers) {
        if (p.isHuman) nextHumanCount++;
        else nextAiCount++;
      }

      trackEvent("round_end", {
        roundNumber: currentMancheRef.current,
        winnerId: winner ? winner.id : null,
        winnerType,
        winnerProfile,
        humanCount: nextHumanCount,
        aiCount: nextAiCount,
      });

      // Trigger the engine-level fireworks celebration
      engine.triggerRoundCelebration(payload.roundWinner || undefined);

      dispatch({
        type: "START_CELEBRATION",
        payload: {
          roundWinner: payload.roundWinner,
          roundResult: res,
          uiPlayers: nextPlayers,
        },
      });
      gamePhaseRef.current = "CELEBRATION";

      // Auto-advance to SUMMARY after ~10s of fireworks, unless skipped via SPACE/click
      clearCelebrationTimer();
      celebrationTimerRef.current = setTimeout(() => {
        if (gamePhaseRef.current === "CELEBRATION") {
          goToSummary();
        }
      }, 10000);
    };

    engineRef.current = engine;
    gamePhaseRef.current = "COMBAT";

    // Start the internal physics loop
    engine.start();

    // === CONTINUOUS RENDERING LOOP ===
    let rafId: number;
    const renderLoop = () => {
      if (ctx) {
        ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      }
      renderFrame();
      rafId = requestAnimationFrame(renderLoop);
    };
    renderLoop();

    return () => {
      isMounted = false;
      if (combatStartTimer !== null) {
        clearTimeout(combatStartTimer);
      }
      if (combatReconnectTimer !== null) {
        clearTimeout(combatReconnectTimer);
      }
      clearShopAiTimeout();
      clearCelebrationTimer();
      // Defer close so React Strict Mode remount can reuse the same lobby/combat socket
      // without dropping the DO mapping mid-handshake (which made P2 miss P1's SHOT).
      const wsToClose = gameWs;
      const genAtCleanup = effectGeneration;
      setTimeout(() => {
        if (combatWsEffectGen !== genAtCleanup) return; // a newer effect owns the session
        if (wsToClose && (wsToClose.readyState === WebSocket.OPEN || wsToClose.readyState === WebSocket.CONNECTING)) {
          try {
            wsToClose.close();
          } catch {
            void 0;
          }
        }
        if (gameWsRef.current === wsToClose) {
          gameWsRef.current = null;
        }
      }, 0);
      if (fireChannel) {
        try { fireChannel.close(); } catch { void 0; /* ignore close errors */ }
      }
      engine.stop();
      engine.getTurnManager().removeInputListeners();
      if (rafId) cancelAnimationFrame(rafId);
      engineRef.current = null;
      ctxRef.current = null;
    };
  }, [clearCelebrationTimer, clearShopAiTimeout, goToSummary]); // eslint-disable-line react-hooks/exhaustive-deps -- complex effect with conditional online logic; re-running on those is acceptable for game session mount

  // Global SPACE to skip round celebration fireworks
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        gamePhaseRef.current === "CELEBRATION" &&
        (e.key === " " ||
          e.key === "Spacebar" ||
          e.key.toLowerCase() === "space")
      ) {
        e.preventDefault();
        goToSummary();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [goToSummary]);

  /** Canvas click = Spacebar: fire current human tank's selected weapon. */
  const handleCanvasClick = (): void => {
    const engine = engineRef.current;
    if (!engine) return;
    if (gamePhaseRef.current === "CELEBRATION") {
      goToSummary();
      return;
    }
    if (
      gamePhaseRef.current !== "COMBAT" &&
      gamePhaseRef.current !== "RESOLUTION"
    ) {
      return;
    }
    engine.getTurnManager().tryFire();
  };

  // Weapon selection from HUD (clicks). Delegates to TurnManager (decoupled)
  const handleWeaponSelect = (weaponId: WeaponId): void => {
    const engine = engineRef.current;
    if (!engine) return;
    const tm = engine.getTurnManager();
    tm.selectWeapon(weaponId);
  };

  const endMatchFromShop = (engine: GameEngine, survivors: Player[]): void => {
    clearShopAiTimeout();
    shopFinishingRef.current = true;
    engine.getTurnManager().pauseForInterRound();

    let matchWinner: Player | null = null;
    if (survivors.length === 1) {
      const w = engine.getTankManager().getWinner();
      if (w) {
        engine.declareMatchWinner(w);
        matchWinner = w;
      }
    } else {
      if (!engine.isGameOver()) {
        engine.declareMatchDraw();
      }
    }

    dispatch({ type: "END_MATCH_FROM_SHOP", winner: matchWinner });

    // Track game over event (custom Zaraz analytics)
    const winnerType = matchWinner ? (matchWinner.isHuman ? "human" : "ai") : "draw";
    const winnerProfile = matchWinner && !matchWinner.isHuman ? (matchWinner.aiProfile ?? "v1-random") : undefined;

    trackEvent("game_over", {
      winnerId: matchWinner ? matchWinner.id : null,
      winnerType,
      winnerProfile,
      totalRounds: currentMancheRef.current,
    });

    setTimeout(() => dispatch({ type: "SHOW_NEW_GAME_BUTTON", show: true }), 7000);
    shopFinishingRef.current = false;
  };

  // SUMMARY → SHOP transition
  const handleGoToShop = (): void => {
    const engine = engineRef.current;
    if (!engine) return;

    clearShopAiTimeout();
    shopFinishingRef.current = false;
    localShopDoneRef.current = false;
    setLocalShopDone(false);
    engine.getTurnManager().pauseForInterRound();

    let roster = [...engine.getTankManager().getPlayers()];
    if (roster.length < 2) {
      endMatchFromShop(engine, roster);
      return;
    }

    // Online host: deterministic AI auto-buy once, then share roster via SHOP_ENTER.
    if (gameMode === 'online' && isOnlineShopHost) {
      for (const p of roster) {
        if (!p.isHuman) autoBuyForAI(p);
      }
      engine.getTankManager().setPlayers(roster);
    }

    dispatch({ type: "START_SHOP", roster });
    shopPlayersRef.current = roster;
    currentShopIndexRef.current = 0;
    gamePhaseRef.current = "SHOP";

    if (pendingShopPlayersRef.current) {
      engine.getTankManager().setPlayers(pendingShopPlayersRef.current);
      dispatch({ type: "MUTATE_SHOP_PLAYERS", players: pendingShopPlayersRef.current });
      shopPlayersRef.current = pendingShopPlayersRef.current;
      roster = pendingShopPlayersRef.current;
    }

    if (pendingShopFinishRef.current) {
      pendingShopFinishRef.current = false;
      pendingShopNextIndexRef.current = null;
      finishShopPhaseRef.current();
      return;
    }

    // Online parallel boutique: every human shops; server waits for all SHOP_READY.
    if (gameMode === 'online') {
      sendCombatMessage({
        type: 'SHOP_ENTER',
        players: [...engine.getTankManager().getPlayers()],
        slot,
      });
      return;
    }

    // Local / hotseat: sequential shop index.
    const pendingNext = pendingShopNextIndexRef.current;
    if (pendingNext !== null) {
      pendingShopNextIndexRef.current = null;
      if (pendingNext >= shopPlayersRef.current.length) {
        finishShopPhaseRef.current();
        return;
      }
      if (pendingNext > 0) {
        currentShopIndexRef.current = pendingNext;
        dispatch({ type: "ADVANCE_SHOPPER", nextIndex: pendingNext });
      }
    }

    if (!roster[0]?.isHuman) {
      shopAiTimeoutRef.current = setTimeout(() => {
        shopAiTimeoutRef.current = null;
        processNextShopperIfAI();
      }, 50);
    }
  };

  const handleNextRound = (): void => {
    handleGoToShop();
  };

  const handleNewGameFromSummary = (): void => {
    if (gameMode === 'online') {
      handleGoToShop();
      return;
    }
    const engine = engineRef.current;
    if (engine) {
      engine.resetGame();
    }
    if (onReturnToMenu) {
      onReturnToMenu();
    }
  };

  /** Achat / vente d'une arme pour le joueur courant de la boutique */
  const handleShopBuySell = (weaponId: WeaponId, delta: 1 | -1): void => {
    if (shopPlayers.length === 0) return;
    if (gameMode === 'online' && localShopDoneRef.current) return;

    const engine = engineRef.current;
    if (!engine) return;

    const enginePlayers = engine.getTankManager().getPlayers();
    // Online parallel: always mutate the local human. Offline: sequential index.
    const currentPlayer =
      gameMode === 'online' && localPlayerId
        ? enginePlayers.find((p) => p.id === localPlayerId) ?? null
        : enginePlayers.find(
            (p) => p.id === shopPlayersRef.current[currentShopIndexRef.current]?.id,
          ) || shopPlayersRef.current[currentShopIndexRef.current];

    if (!currentPlayer || !currentPlayer.isHuman) return;

    if (gameMode === 'online' && localPlayerId && currentPlayer.id !== localPlayerId) {
      return;
    }

    const def = WEAPON_REGISTRY[weaponId];
    if (!def) return;

    const currentStock = currentPlayer.inventory?.[weaponId] ?? 0;

    const updatedPlayers = enginePlayers.map((p) => {
      if (p.id === currentPlayer.id) {
        if (delta > 0) {
          // Achat
          if ((p.money ?? 0) >= def.price) {
            return {
              ...p,
              money: (p.money ?? 0) - def.price,
              inventory: {
                ...p.inventory,
                [weaponId]: currentStock + 1,
              },
            };
          }
        } else {
          // Vente
          if (currentStock > 0) {
            return {
              ...p,
              money: (p.money ?? 0) + def.price,
              inventory: {
                ...p.inventory,
                [weaponId]: currentStock - 1,
              },
            };
          }
        }
      }
      return p;
    });

    // Mettre à jour les joueurs dans le TankManager de l'engine de façon immuable
    engine.getTankManager().setPlayers(updatedPlayers);

    dispatch({ type: "MUTATE_SHOP_PLAYERS", players: updatedPlayers });

    if (gameMode === 'online') {
      // Send only the local player so parallel buys merge cleanly on the server.
      const localUpdated =
        updatedPlayers.find((p) => p.id === localPlayerId) ?? currentPlayer;
      sendCombatMessage({ type: 'SHOP_BUY_SELL', player: localUpdated, slot });
    }
  };

  const handleShopReady = (): void => {
    if (gameMode === 'online' && localPlayerId) {
      if (localShopDoneRef.current) return;
      const eng = engineRef.current;
      const me = eng
        ?.getTankManager()
        .getPlayers()
        .find((p) => p.id === localPlayerId);
      if (!me?.isHuman) return;

      localShopDoneRef.current = true;
      setLocalShopDone(true);

      const players = eng
        ? [...eng.getTankManager().getPlayers()]
        : [...shopPlayersRef.current];
      // Parallel shop: server waits until every human slot has SHOP_READY.
      sendCombatMessage({ type: 'SHOP_READY', players, slot });
      return;
    }

    const idx = currentShopIndexRef.current;
    const shopper = shopPlayersRef.current[idx];
    if (localPlayerId && shopper && shopper.id !== localPlayerId) return;
    advanceToNextShopper();
  };

  /** Local / hotseat only — online shop cursor is server-driven via SHOP_STATE. */
  const advanceToNextShopper = (): void => {
    if (gameMode === 'online') {
      // Online must not locally finish or skip ahead; wait for SHOP_STATE / SHOP_FINISH.
      return;
    }

    const currentLen = shopPlayersRef.current.length;
    const nextIndex = currentShopIndexRef.current + 1;

    if (nextIndex >= currentLen) {
      finishShopPhase();
    } else {
      dispatch({ type: "ADVANCE_SHOPPER", nextIndex });
      currentShopIndexRef.current = nextIndex;

      const nextPlayer = shopPlayersRef.current[nextIndex];
      if (nextPlayer && !nextPlayer.isHuman) {
        clearShopAiTimeout();
        shopAiTimeoutRef.current = setTimeout(() => {
          shopAiTimeoutRef.current = null;
          processNextShopperIfAI();
        }, 80);
      }
    }
  };

  const processNextShopperIfAI = (): void => {
    if (shopFinishingRef.current || gamePhaseRef.current !== "SHOP") return;
    // Online parallel: AI already auto-bought on host enter — no sequential AI shop turns.
    if (gameMode === 'online') return;

    const currentLen = shopPlayersRef.current.length;
    if (currentLen === 0) return;
    const idx = currentShopIndexRef.current;
    const current = shopPlayersRef.current[idx];
    if (!current || current.isHuman) return;

    autoBuyForAI(current);
    advanceToNextShopper();
  };

  /**
   * Leave boutique and start the next combat round.
   * @param finalPlayers Optional money/inventory snapshot from the server — applied ONLY
   *   before startNextRound. Re-applying shop players after spawn restored isDead and left
   *   P1 unable to fire while P2 waited for P1's shot.
   */
  const finishShopPhase = (finalPlayers?: Player[]): void => {
    if (shopFinishingRef.current) return;
    // Duplicate SHOP_FINISH / SHOP_STATE after combat already began for this round.
    if (gamePhaseRef.current === "COMBAT" && shopPlayersRef.current.length === 0) {
      return;
    }

    const engine = engineRef.current;
    if (!engine) return;

    shopFinishingRef.current = true;
    clearShopAiTimeout();
    pendingShopFinishRef.current = false;
    pendingShopNextIndexRef.current = null;
    localShopDoneRef.current = false;
    setLocalShopDone(false);

    if (finalPlayers && finalPlayers.length >= 2) {
      engine.getTankManager().setPlayers(finalPlayers);
      shopPlayersRef.current = finalPlayers;
    } else if (pendingShopPlayersRef.current && pendingShopPlayersRef.current.length >= 2) {
      engine.getTankManager().setPlayers(pendingShopPlayersRef.current);
      shopPlayersRef.current = pendingShopPlayersRef.current;
    }
    pendingShopPlayersRef.current = null;

    // Re-seed before each new combat round — RNG may have diverged (fireworks, shop, etc.)
    if (gameMode === 'online' && roomId) {
      setRNG(createSeededRNG(seedFromRoomRound(roomId, currentMancheRef.current)));
    }

    const tm = engine.getTurnManager();
    const roster = engine.getTankManager().getPlayers();

    if (roster.length < 2) {
      shopFinishingRef.current = false;
      endMatchFromShop(engine, [...roster]);
      return;
    }

    const started = engine.startNextRound();
    if (!started) {
      shopFinishingRef.current = false;
      endMatchFromShop(engine, [...roster]);
      return;
    }

    // Fresh round: spawn revived everyone; unlock local human on server turn 0.
    tm.resumeForCombat();
    tm.syncTurn(0);

    const nextPlayers = [...engine.getTankManager().getPlayers()];
    dispatch({ type: "FINISH_SHOP", uiPlayers: nextPlayers });
    gamePhaseRef.current = "COMBAT";
    shopPlayersRef.current = [];
    currentShopIndexRef.current = 0;

    clearCelebrationTimer();
    shopFinishingRef.current = false;
  };

  useEffect(() => {
    handleGoToShopRef.current = handleGoToShop;
    finishShopPhaseRef.current = finishShopPhase;

    shopSyncRef.current.applyRemoteBuySell = (players: Player[]) => {
      const eng = engineRef.current;
      if (!eng) return;

      // While still shopping, keep our in-progress cart for the local human.
      let merged = players;
      if (
        gameMode === "online" &&
        localPlayerId &&
        gamePhaseRef.current === "SHOP" &&
        !localShopDoneRef.current
      ) {
        const localLive = eng
          .getTankManager()
          .getPlayers()
          .find((p) => p.id === localPlayerId);
        if (localLive) {
          merged = players.map((p) => (p.id === localPlayerId ? localLive : p));
        }
      }

      eng.getTankManager().setPlayers(merged);
      pendingShopPlayersRef.current = merged;
      if (gamePhaseRef.current === "SHOP") {
        dispatch({ type: "MUTATE_SHOP_PLAYERS", players: merged });
        shopPlayersRef.current = merged;
      }
    };

    shopSyncRef.current.applyRemoteAdvance = (nextIndex: number) => {
      // Legacy sequential cursor only — online uses parallel SHOP_READY set.
      if (gameMode === 'online') return;
      if (shopFinishingRef.current) return;

      const phase = gamePhaseRef.current;
      if (phase !== "SHOP") {
        pendingShopNextIndexRef.current = Math.max(
          pendingShopNextIndexRef.current ?? -1,
          nextIndex,
        );
        if (phase === "SUMMARY") {
          handleGoToShopRef.current();
        }
        return;
      }

      if (nextIndex >= shopPlayersRef.current.length) {
        finishShopPhase();
        return;
      }

      currentShopIndexRef.current = nextIndex;
      dispatch({ type: "ADVANCE_SHOPPER", nextIndex });

      const nextPlayer = shopPlayersRef.current[nextIndex];
      if (nextPlayer && !nextPlayer.isHuman) {
        clearShopAiTimeout();
        shopAiTimeoutRef.current = setTimeout(() => {
          shopAiTimeoutRef.current = null;
          processNextShopperIfAI();
        }, 80);
      }
    };

    shopSyncRef.current.finishShop = (finalPlayers?: Player[]) => {
      if (shopFinishingRef.current) return;

      // Duplicate SHOP_FINISH after we already started the next combat round: ignore.
      if (gamePhaseRef.current === "COMBAT" && shopPlayersRef.current.length === 0) {
        return;
      }

      const phase = gamePhaseRef.current;
      if (phase !== "SHOP") {
        if (finalPlayers && finalPlayers.length >= 2) {
          pendingShopPlayersRef.current = finalPlayers;
        }
        pendingShopFinishRef.current = true;
        pendingShopNextIndexRef.current = null;
        if (phase === "SUMMARY") {
          // Enter shop then immediately finish with pending roster.
          handleGoToShopRef.current();
        }
        // CELEBRATION: keep pending; SUMMARY → SHOP will drain it.
        return;
      }
      finishShopPhase(finalPlayers);
    };

    return () => {
      clearShopAiTimeout();
    };
  });

  const handleNewGame = () => {
    const engine = engineRef.current;
    if (!engine) return;

    engine.resetGame();

    const newPlayers = createDemoPlayers();
    engine.setAIEngine(new AIByProfileStrategy());
    engine.setPlayers(newPlayers);

    dispatch({ type: "RESET_GAME", newPlayers });
    shopPlayersRef.current = [];
    currentShopIndexRef.current = 0;
    clearCelebrationTimer();
  };

  const handleAdjustAngle = (delta: number): void => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.getTurnManager().adjustAngle(delta);
  };

  const handleAdjustPower = (delta: number): void => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.getTurnManager().adjustPower(delta);
  };

  const handleCycleWeapon = (delta: 1 | -1): void => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.getTurnManager().cycleWeapon(delta);
  };

  const handleFire = (): void => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.getTurnManager().tryFire();
  };

  return {
    canvasRef,
    state,
    CANVAS_WIDTH,
    CANVAS_HEIGHT,
    handleCanvasClick,
    handleWeaponSelect,
    handleShopBuySell,
    handleShopReady,
    handleNextRound,
    handleNewGameFromSummary,
    handleNewGame,
    handleAdjustAngle,
    handleAdjustPower,
    handleCycleWeapon,
    handleFire,
    isLocalShopTurn,
    shopDisplayPlayer,
    localShopDone,
  };
}
