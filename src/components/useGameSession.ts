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
import { setRNG, createSeededRNG } from "../utils/random";

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
  slot,
  token,
}: UseGameSessionProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  const [state, dispatch] = useReducer(gameCanvasReducer, INITIAL_STATE);
  const {
    gamePhase,
    shopPlayers,
    currentShopIndex,
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

  const clearShopAiTimeout = useCallback((): void => {
    if (shopAiTimeoutRef.current !== null) {
      clearTimeout(shopAiTimeoutRef.current);
      shopAiTimeoutRef.current = null;
    }
  }, []);

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

    // For online: use a seeded RNG derived from roomId so that all clients
    // produce the exact same random spawns (TankManager.spawnTanks + shuffle).
    // This makes initial tank positions identical across windows.
    if (gameMode === 'online' && roomId) {
      const seed = roomId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      setRNG(createSeededRNG(seed));
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
    if (gameMode === 'online' && roomId && slot != null && token) {
      const wsBase = import.meta.env.DEV ? 'ws://localhost:8787' : (typeof window !== 'undefined' ? `wss://${window.location.host}` : '');
      const wsUrl = `${wsBase}/api/rooms/${roomId}/ws?slot=${slot}&token=${encodeURIComponent(token)}`;
      gameWs = new WebSocket(wsUrl);

      gameWs.onopen = () => {
        console.log('[Game] Combat WS connected to server');
      };

      gameWs.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          const tm = engine.getTurnManager();

          if (msg.type === 'SHOT' && msg.command) {
            // For the firer, we already executed the full local fire for immediate feedback.
            // For other clients (or to be safe), replay only if the slot in the message is not our local slot.
            // This avoids double execution on the firer.
            if (msg.slot !== slot) {
              tm.executeRemoteFire(msg.command);
            }
          }

          if (msg.type === 'STATE_UPDATE') {
            if (msg.heights && Array.isArray(msg.heights)) {
              engine.getTerrain().loadHeights(msg.heights);
            }
            if (msg.players) {
              engine.getTankManager().setPlayers(msg.players);
              dispatch({ type: "SET_UI_PLAYERS", players: msg.players });
            }
            if (typeof msg.currentPlayerIndex === 'number') {
              tm.syncTurn(msg.currentPlayerIndex);
            }
            // wind etc. can be synced similarly
          }
        } catch (e) {
          console.warn('[Game] invalid WS message', e);
        }
      };

      gameWs.onclose = () => {
        console.log('[Game] Combat WS closed');
      };
      gameWs.onerror = (e) => {
        console.warn('[Game] Combat WS error', e);
      };
    }

    // === PLAYERS: provenance MainMenu (via props) OU démo 2 joueurs (standalone / New Game) ===
    const snapshotPlayers = initialPlayersRef.current;
    const players: Player[] =
      snapshotPlayers && snapshotPlayers.length >= 2
        ? snapshotPlayers.map((p) => ({ ...p }))
        : createDemoPlayers();

    // Initialize players (this also calls setupInputListeners + starts first turn)
    engine.setPlayers(players);
    dispatch({ type: "SET_UI_PLAYERS", players });

    if (localPlayerId) {
      engine.setLocalPlayerId(localPlayerId);
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

    const tm = engine.getTurnManager();

    /**
     * Combat round ends on last man standing (0 or 1 tanks remain alive).
     */
    engine.onRoundEnded = (payload) => {
      if (gamePhaseRef.current !== "COMBAT") return;

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
      clearShopAiTimeout();
      clearCelebrationTimer();
      if (gameWs) {
        try { gameWs.close(); } catch { void 0; /* ignore close errors */ }
      }
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
  };

  const handleShopReady = (): void => {
    advanceToNextShopper();
  };

  const advanceToNextShopper = (): void => {
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

    const nextPlayers = [...engine.getTankManager().getPlayers()];
    dispatch({ type: "FINISH_SHOP", uiPlayers: nextPlayers });
    shopPlayersRef.current = [];
    currentShopIndexRef.current = 0;

    clearCelebrationTimer();
    shopFinishingRef.current = false;
  };

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
  };
}
