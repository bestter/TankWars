import { useCallback, useEffect, useRef, useReducer } from "react";
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
}

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
}: UseGameSessionProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const gameWsRef = useRef<WebSocket | null>(null);
  const roundEndFromNetworkRef = useRef(false);
  const shopSyncRef = useRef({
    applyRemoteAdvance: (nextIndex: number) => {
      void nextIndex;
    },
    finishShop: () => {},
  });

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

  /** Online: true only when the active shop slot belongs to this client. */
  const isLocalShopTurn =
    gameMode !== 'online' ||
    !localPlayerId ||
    (!!shopPlayers[currentShopIndex]?.isHuman &&
      shopPlayers[currentShopIndex]?.id === localPlayerId);

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
        if (ok && localPlayerId) {
          const player = tm.getCurrentPlayer();
          if (player) {
            const command = {
              angle: player.tank.angle,
              power: player.tank.power,
              weaponId: player.tank.currentWeapon,
            };
            // Prefer sending to server WS for authoritative processing and broadcast to all room sockets
            if (gameWs && gameWs.readyState === WebSocket.OPEN) {
              gameWs.send(JSON.stringify({ type: 'FIRE', command }));
            } else if (fireChannel) {
              // Fallback for demo tab sync if no WS
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

    if (gameMode === 'online' && roomId && slot != null && token) {
    const combatRoomId = roomId;
    const combatSlot = slot;
    const combatToken = token;
    const wsBase = getOnlineWsBase();

    const clearCombatReconnect = (): void => {
      if (combatReconnectTimer !== null) {
        clearTimeout(combatReconnectTimer);
        combatReconnectTimer = null;
      }
    };

    function bindCombatWsHandlers(ws: WebSocket): void {
      ws.onopen = () => {
        console.log('[Game] Combat WS connected to server');
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          const tm = engine.getTurnManager();

          if (msg.type === 'GAME_START' && typeof msg.currentPlayerIndex === 'number') {
            tm.syncTurn(msg.currentPlayerIndex);
            if (typeof msg.wind === 'number') {
              engine.setWindForce(msg.wind);
            }
          }

          if (msg.type === 'SHOT' && msg.command) {
            // For the firer, we already executed the full local fire for immediate feedback.
            // For other clients (or to be safe), replay only if the slot in the message is not our local slot.
            // This avoids double execution on the firer.
            if (
              msg.slot !== slot &&
              gamePhaseRef.current === 'COMBAT' &&
              engine.isRoundCombatActive() &&
              !tm.isInterRoundPaused()
            ) {
              tm.executeRemoteFire(msg.command, {
                fromSlot: typeof msg.slot === 'number' ? msg.slot : undefined,
                ownerId: typeof msg.ownerId === 'string' ? msg.ownerId : undefined,
              });
            }
          }

          if (msg.type === 'STATE_UPDATE') {
            // MVP: server only coordinates turn order. Clients run local physics after SHOT replay.
            // Do NOT apply server players/heights here — the DO stub still carries placeholder
            // spawn Y values (≈280) which teleport tanks into the sky and reset crater terrain.
            // Ignore late turn updates after round end (prevents desync back into "waiting for shot").
            if (
              gamePhaseRef.current === 'COMBAT' &&
              engine.isRoundCombatActive() &&
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
            if (gamePhaseRef.current === 'SHOP') {
              engine.getTankManager().setPlayers(msg.players);
              dispatch({ type: "MUTATE_SHOP_PLAYERS", players: msg.players });
            }
          }

          if (msg.type === 'SHOP_ADVANCE' && typeof msg.nextIndex === 'number' && msg.slot !== slot) {
            if (gamePhaseRef.current === 'SHOP') {
              shopSyncRef.current.applyRemoteAdvance(msg.nextIndex);
            }
          }

          if (msg.type === 'SHOP_FINISH' && Array.isArray(msg.players) && msg.slot !== slot) {
            if (gamePhaseRef.current === 'SHOP') {
              engine.getTankManager().setPlayers(msg.players);
              dispatch({ type: "MUTATE_SHOP_PLAYERS", players: msg.players });
              shopSyncRef.current.finishShop();
            }
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

    combatStartTimer = setTimeout(connectCombatWs, 150);
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

    // Track game start event with Cloudflare Zaraz
    trackEvent("game_start", {
      playerCount: players.length,
      humanCount: players.filter((p) => p.isHuman).length,
      aiCount: players.filter((p) => !p.isHuman).length,
      aiProfiles: players.reduce((acc, p) => (!p.isHuman ? [...acc, p.aiProfile ?? "v1-random"] : acc), [] as string[]),
    });

    // Inject profile-aware AI (v1-random = IA Simple / Mr. Simple; v2-heuristic = IA OK smarter).
    engine.setAIEngine(new AIByProfileStrategy());

    engine.onWindChange = (w) => dispatch({ type: "SET_WIND", wind: w });

    // Envoi de l'événement SHOT_SETTLED au serveur en mode multijoueur lorsque le coup local s'est stabilisé
    engine.getTurnManager().onShotSettled = () => {
      if (gameMode === 'online' && localPlayerId) {
        const tm = engine.getTurnManager();
        const currentPlayer = tm.getCurrentPlayer();
        if (currentPlayer && currentPlayer.id === localPlayerId) {
          if (gameWsRef.current && gameWsRef.current.readyState === WebSocket.OPEN) {
            console.log('[Game] Sending SHOT_SETTLED to server');
            gameWsRef.current.send(JSON.stringify({ type: 'SHOT_SETTLED', slot }));
          }
        }
      }
    };

    // Wire callbacks
    engine.onProjectileHit = (hit) => {
      console.log(
        "[GameEngine] Hit:",
        hit.weaponId,
        "at",
        hit.x.toFixed(1),
        hit.y.toFixed(1),
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

      trackEvent("round_end", {
        roundNumber: currentMancheRef.current,
        winnerId: winner ? winner.id : null,
        winnerType,
        winnerProfile,
        humanCount: nextPlayers.filter((p) => p.isHuman).length,
        aiCount: nextPlayers.filter((p) => !p.isHuman).length,
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
      if (gameWs) {
        try { gameWs.close(); } catch { void 0; /* ignore close errors */ }
      }
      gameWsRef.current = null;
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
    engine.getTurnManager().pauseForInterRound();

    const roster = [...engine.getTankManager().getPlayers()];
    if (roster.length < 2) {
      endMatchFromShop(engine, roster);
      return;
    }

    dispatch({ type: "START_SHOP", roster });
    shopPlayersRef.current = roster;
    currentShopIndexRef.current = 0;

    if (!roster[0].isHuman) {
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

    const engine = engineRef.current;
    if (!engine) return;

    const enginePlayers = engine.getTankManager().getPlayers();
    const idx = currentShopIndexRef.current;
    const currentPlayer =
      enginePlayers.find((p) => p.id === shopPlayersRef.current[idx]?.id) ||
      shopPlayersRef.current[idx];

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

    if (gameMode === 'online' && gameWsRef.current?.readyState === WebSocket.OPEN) {
      gameWsRef.current.send(
        JSON.stringify({ type: 'SHOP_BUY_SELL', players: updatedPlayers, slot }),
      );
    }
  };

  const handleShopReady = (): void => {
    const idx = currentShopIndexRef.current;
    const shopper = shopPlayersRef.current[idx];
    if (gameMode === 'online' && localPlayerId) {
      if (!shopper || shopper.id !== localPlayerId) return;
    }

    const nextIndex = idx + 1;
    if (gameMode === 'online' && gameWsRef.current?.readyState === WebSocket.OPEN) {
      gameWsRef.current.send(
        JSON.stringify({ type: 'SHOP_ADVANCE', nextIndex, slot }),
      );
    }
    advanceToNextShopper();
  };

  const advanceToNextShopper = (): void => {
    const currentLen = shopPlayersRef.current.length;
    const nextIndex = currentShopIndexRef.current + 1;

    if (nextIndex >= currentLen) {
      if (gameMode === 'online' && gameWsRef.current?.readyState === WebSocket.OPEN) {
        const eng = engineRef.current;
        if (eng) {
          gameWsRef.current.send(
            JSON.stringify({
              type: 'SHOP_FINISH',
              players: [...eng.getTankManager().getPlayers()],
              slot,
            }),
          );
        }
      }
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

    const currentLen = shopPlayersRef.current.length;
    if (currentLen === 0) return;
    const idx = currentShopIndexRef.current;
    const current = shopPlayersRef.current[idx];
    if (!current || current.isHuman) return;

    autoBuyForAI(current);
    advanceToNextShopper();
  };

  const finishShopPhase = (): void => {
    if (shopFinishingRef.current) return;

    const engine = engineRef.current;
    if (!engine) return;

    // Re-seed before each new combat round — RNG may have diverged (fireworks, celebration skip, etc.)
    if (gameMode === 'online' && roomId) {
      setRNG(createSeededRNG(seedFromRoomRound(roomId, currentMancheRef.current)));
    }

    shopFinishingRef.current = true;
    clearShopAiTimeout();

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
    shopSyncRef.current.applyRemoteAdvance = (nextIndex: number) => {
      if (shopFinishingRef.current || gamePhaseRef.current !== "SHOP") return;
      if (nextIndex >= shopPlayersRef.current.length) {
        finishShopPhase();
        return;
      }
      if (currentShopIndexRef.current >= nextIndex) return;

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
    shopSyncRef.current.finishShop = finishShopPhase;
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
  };
}
