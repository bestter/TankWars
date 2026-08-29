import { useCallback, useEffect, useRef, useReducer, useState } from "react";
import { GameEngine, type ResolvedShotPreview } from "../game/engine/GameEngine";
import { AIByProfileStrategy } from "../game/entities/ai/AIByProfileStrategy";
import type { Player } from "../types/player";
import type { WeaponId } from "../types/weapon";
import type { TerrainMaterial } from "../types/terrain";
import type { GamePhase } from "../types/game";
import {
  gameCanvasReducer,
  INITIAL_STATE,
  type PendingFireIntent,
  type ShopClientSessionState,
} from "./gameCanvasReducer";
import { trackEvent } from "../utils/analytics";
import { setRNG, createSeededRNG, seedFromRoomRound } from "../utils/random";
import {
  type OnlineCanvasSnapshot,
} from "../utils/onlineSession";
import { attachOnlineCombat } from "./online/attachOnlineCombat";
import {
  buildOverlayAwards,
  createDemoPlayers,
} from "./sessionPresentation";
import {
  applyAuthoritativeShopFinish,
  startShopPhase,
  type CompleteShopRoundHost,
} from "./shop/completeShopRound";
import { shopBuySell, shopReady } from "./shop/shopPlayerActions";
import { usePersistOnlineCanvas } from "./usePersistOnlineCanvas";
import { wireEngineSessionCallbacks } from "./wireEngineSession";

function buildInitialCanvasState(
  resume?: OnlineCanvasSnapshot,
): typeof INITIAL_STATE {
  if (!resume) return INITIAL_STATE;
  return { ...INITIAL_STATE, ...resume };
}

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 480;

export { buildOverlayAwards } from "./sessionPresentation";

interface UseGameSessionProps {
  initialPlayers?: Player[];
  onReturnToMenu?: () => void;
  /** Online mode */
  gameMode?: 'local' | 'online';
  localPlayerId?: string;
  roomId?: string;
  initialHeights?: number[];
  initialMaterials?: TerrainMaterial[];
  initialWind?: number;
  initialCurrentPlayerIndex?: number;
  resumeCanvas?: OnlineCanvasSnapshot;
  slot?: number;
  token?: string;
  ws?: WebSocket;
}

export function useGameSession({
  initialPlayers,
  onReturnToMenu,
  gameMode = 'local',
  localPlayerId,
  roomId,
  initialHeights,
  initialMaterials,
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
  const roundEndFromNetworkRef = useRef(false);
  const authoritySlotRef = useRef<number | null>(resumeCanvas?.authoritySlot ?? null);
  const authorityEpochRef = useRef(resumeCanvas?.authorityEpoch ?? 0);
  const lastAppliedShotIdRef = useRef(resumeCanvas?.lastAppliedShotId ?? 0);
  const lastSeenShotIdRef = useRef(resumeCanvas?.lastSeenShotId ?? 0);
  const lastAppliedShopEpochRef = useRef(
    resumeCanvas?.lastAppliedShopEpoch ?? 0,
  );
  const lastCompletedRoundNumberRef = useRef(
    resumeCanvas?.lastCompletedRoundNumber ?? 0,
  );
  const shopSessionRef = useRef<ShopClientSessionState>(
    resumeCanvas?.shopSession ?? INITIAL_STATE.shopSession,
  );
  const pendingFireRef = useRef<PendingFireIntent | null>(
    resumeCanvas?.pendingFireIntent ?? null,
  );
  const fireRejectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const protocolMismatchRef = useRef(false);
  const combatSendRef = useRef<(message: object) => void>(() => {});
  const combatActiveShotIdRef = useRef<() => number | null>(() => null);
  // Appointment IDs only deduplicate broadcasts during this mounted session.
  // Reconnects restore the active Zeus from ZEUS_STATE without replaying the appointment.
  const lastZeusAppointmentIdRef = useRef(0);
  const lastAppliedZeusStrikeIdRef = useRef(resumeCanvas?.lastAppliedZeusStrikeId ?? 0);
  const pendingShotPreviewsRef = useRef<Map<number, ResolvedShotPreview>>(new Map());
  const submitShotEarningsRef = useRef<(preview: ResolvedShotPreview) => void>(() => {});
  /** Shop WS messages received before this client entered SHOP (SUMMARY/CELEBRATION lag). */
  const pendingShopFinishRef = useRef<{
    players: Player[];
    shopEpoch: number;
    nextRoundNumber: number;
  } | null>(null);
  const applyShopFinishRef = useRef<
    (players: Player[], shopEpoch: number, nextRoundNumber: number) => void
  >(() => {});

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
    shopSession,
    lastAppliedShopEpoch,
    lastCompletedRoundNumber,
    lastSeenShotId,
  } = state;

  // Ref to avoid stale closure in engine callbacks registered in mount effect (gamePhase updates)
  const gamePhaseRef = useRef<GamePhase>(gamePhase);

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
  const zeusAnnouncementTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => {
    shopSessionRef.current = shopSession;
  }, [shopSession]);

  useEffect(() => {
    lastAppliedShopEpochRef.current = lastAppliedShopEpoch;
  }, [lastAppliedShopEpoch]);

  useEffect(() => {
    lastCompletedRoundNumberRef.current = lastCompletedRoundNumber;
  }, [lastCompletedRoundNumber]);

  useEffect(() => {
    lastSeenShotIdRef.current = lastSeenShotId;
  }, [lastSeenShotId]);

  useEffect(() => {
    if (state.fireRejection === null) return;
    const timeoutId = setTimeout(() => {
      if (fireRejectionTimerRef.current === timeoutId) {
        fireRejectionTimerRef.current = null;
      }
      dispatch({ type: "SET_FIRE_REJECTION", reason: null });
    }, 3500);
    fireRejectionTimerRef.current = timeoutId;
    return () => {
      clearTimeout(timeoutId);
      if (fireRejectionTimerRef.current === timeoutId) {
        fireRejectionTimerRef.current = null;
      }
    };
  }, [state.fireRejection]);

  usePersistOnlineCanvas({
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
    initialMaterials,
    initialWind,
    initialCurrentPlayerIndex,
    earningsOverlay: state.earningsOverlay,
    shopSession,
    lastAppliedShopEpoch,
    lastCompletedRoundNumber,
    lastSeenShotId,
    pendingFireIntent: state.pendingFireIntent,
    fireRejection: state.fireRejection,
    engineRef,
    authoritySlotRef,
    authorityEpochRef,
    lastAppliedShotIdRef,
    lastAppliedZeusStrikeIdRef,
  });

  const clearShopAiTimeout = useCallback((): void => {
    if (shopAiTimeoutRef.current !== null) {
      clearTimeout(shopAiTimeoutRef.current);
      shopAiTimeoutRef.current = null;
    }
  }, []);

  const sendCombatMessage = useCallback((obj: object): void => {
    combatSendRef.current(obj);
  }, []);

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

  const clearCelebrationTimer = useCallback(() => {
    if (celebrationTimerRef.current !== null) {
      clearTimeout(celebrationTimerRef.current);
      celebrationTimerRef.current = null;
    }
  }, []);

  const clearZeusAnnouncement = useCallback((): void => {
    if (zeusAnnouncementTimerRef.current !== null) {
      clearTimeout(zeusAnnouncementTimerRef.current);
      zeusAnnouncementTimerRef.current = null;
    }
    dispatch({ type: "HIDE_ZEUS_ANNOUNCEMENT" });
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

  const dismissEarningsOverlay = useCallback((): void => {
    dispatch({ type: "HIDE_EARNINGS" });
  }, []);

  // Stable render function that delegates to the engine
  const renderFrame = () => {
    const ctx = ctxRef.current;
    const engine = engineRef.current;
    if (ctx && engine) {
      engine.render(ctx);
    }
  };

  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup
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

    // === GAME ENGINE ===
    const engine = new GameEngine(CANVAS_WIDTH, CANVAS_HEIGHT, {
      gravity: 260,
      baseShotSpeed: 420,
    });
    const tm = engine.getTurnManager();

    // Online: load the authoritative terrain heights sent by the server
    // BEFORE setPlayers, so spawnTanks will snap tank Y positions to the server heights.
    if (gameMode === 'online' && initialHeights && initialHeights.length > 0) {
      try {
        engine.getTerrain().loadHeights(initialHeights, initialMaterials);
      } catch (e) {
        console.warn('[useGameSession] could not load initialHeights', e);
      }
    }

    // Online: seeded RNG per combat round so spawnTanks + wind are identical on every client.
    if (gameMode === 'online' && roomId) {
      setRNG(createSeededRNG(seedFromRoomRound(roomId, 1)));
    }

    let onlineCombat: ReturnType<typeof attachOnlineCombat> | null = null;
    if (gameMode === "online" && roomId && slot != null && token) {
      onlineCombat = attachOnlineCombat({
        engine,
        dispatch,
        roomId,
        slot,
        token,
        incomingWs: initialWsRef.current,
        gameWsRef,
        protocolMismatchRef,
        authoritySlotRef,
        authorityEpochRef,
        lastAppliedShotIdRef,
        lastSeenShotIdRef,
        lastAppliedShopEpochRef,
        lastCompletedRoundNumberRef,
        currentMancheRef,
        gamePhaseRef,
        shopSessionRef,
        shopPlayersRef,
        localShopDoneRef,
        pendingFireRef,
        fireRejectionTimerRef,
        pendingShotPreviewsRef,
        submitShotEarningsRef,
        roundEndFromNetworkRef,
        applyShopFinish: (players, shopEpoch, nextRoundNumber) => {
          applyShopFinishRef.current(players, shopEpoch, nextRoundNumber);
        },
        clearCelebrationTimer,
        setLocalShopDone,
        buildOverlayAwards,
      });
      combatSendRef.current = onlineCombat.send;
      combatActiveShotIdRef.current = onlineCombat.activeServerShotId;
    }

    // === PLAYERS: provenance MainMenu (via props) OU démo 2 joueurs (standalone / New Game) ===
    const snapshotPlayers = initialPlayersRef.current;
    const players: Player[] =
      snapshotPlayers && snapshotPlayers.length >= 2
        ? snapshotPlayers.map((p) => ({ ...p }))
        : createDemoPlayers();

    // Online: set local player id BEFORE setPlayers so startFirstTurn locks input correctly.
    engine.setLocalMatch(gameMode !== "online");
    if (localPlayerId) {
      engine.setLocalPlayerId(localPlayerId);
    }

    const resumed = resumeCanvas;
    if (resumed && resumed.uiPlayers.length >= 2) {
      engine.getTankManager().setPlayers(resumed.uiPlayers.map((p) => ({ ...p })));
      engine.restoreRoundEarningsByPlayer(resumed.roundEarningsByPlayer);
      engine.setRoundNumber(resumed.currentManche);
      gamePhaseRef.current = resumed.gamePhase;
      shopPlayersRef.current = resumed.shopPlayers;
      currentShopIndexRef.current = resumed.currentShopIndex;

      if (resumed.gamePhase === 'COMBAT') {
        tm.resumeForCombat();
        tm.setupInputListeners();
        if (typeof initialCurrentPlayerIndex === 'number' && Number.isInteger(initialCurrentPlayerIndex)) {
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
      engine.setRoundNumber(1);
      if (gameMode === 'online' && typeof initialCurrentPlayerIndex === 'number' && Number.isInteger(initialCurrentPlayerIndex)) {
        tm.syncTurn(initialCurrentPlayerIndex);
      }
      dispatch({ type: "SET_UI_PLAYERS", players });
    }

    // Also set wind if provided (for HUD etc.; main sync will come from server updates)
    if (gameMode === 'online' && typeof initialWind === 'number' && Number.isFinite(initialWind)) {
      // The engine has onWindChange but for initial we can set via internal if needed.
      // For now the first wind update will come, or we can dispatch it.
      // Simple: the wind banner will pick it up on first change; for start we can live with server value later.
    }

    const playerStats = players.reduce(
      (acc, p) => {
        if (p.isHuman) {
          acc.humanCount++;
        } else {
          acc.aiProfiles.push(p.aiProfile ?? "v1-random");
        }
        return acc;
      },
      { humanCount: 0, aiProfiles: [] as string[] }
    );

    // Track game start event with Cloudflare Zaraz
    trackEvent("game_start", {
      playerCount: players.length,
      humanCount: playerStats.humanCount,
      aiCount: players.length - playerStats.humanCount,
      aiProfiles: playerStats.aiProfiles,
    });

    // Inject profile-aware AI (v1-random = IA SIMPLE; v2-heuristic = IA OK).
    engine.setAIEngine(new AIByProfileStrategy());

    wireEngineSessionCallbacks({
      engine,
      dispatch,
      gameMode,
      localPlayerId,
      slot,
      sendCombatMessage,
      combatActiveShotId: () => combatActiveShotIdRef.current(),
      gamePhaseRef,
      currentMancheRef,
      lastCompletedRoundNumberRef,
      lastZeusAppointmentIdRef,
      lastAppliedZeusStrikeIdRef,
      zeusAnnouncementTimerRef,
      celebrationTimerRef,
      pendingShotPreviewsRef,
      submitShotEarningsRef,
      roundEndFromNetworkRef,
      clearZeusAnnouncement,
      clearCelebrationTimer,
      goToSummary,
    });

    engineRef.current = engine;

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
      onlineCombat?.detach();
      combatSendRef.current = () => {};
      combatActiveShotIdRef.current = () => null;
      if (celebrationTimerRef.current !== null) {
        clearTimeout(celebrationTimerRef.current);
        celebrationTimerRef.current = null;
      }
      if (shopAiTimeoutRef.current !== null) {
        clearTimeout(shopAiTimeoutRef.current);
        shopAiTimeoutRef.current = null;
      }
      clearShopAiTimeout();
      clearCelebrationTimer();
      if (fireRejectionTimerRef.current !== null) {
        clearTimeout(fireRejectionTimerRef.current);
        fireRejectionTimerRef.current = null;
      }
      if (zeusAnnouncementTimerRef.current !== null) {
        clearTimeout(zeusAnnouncementTimerRef.current);
        zeusAnnouncementTimerRef.current = null;
      }

      engine.stop();
      tm.setFireIntentHandler(null);
      tm.onAuthoritativeShotSettled = undefined;
      tm.removeInputListeners();
      if (rafId) cancelAnimationFrame(rafId);
      engineRef.current = null;
      ctxRef.current = null;
    };
  }, [clearCelebrationTimer, clearShopAiTimeout, clearZeusAnnouncement, goToSummary]); // eslint-disable-line react-hooks/exhaustive-deps -- complex effect with conditional online logic; re-running on those is acceptable for game session mount

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

  const shopRoundHost: CompleteShopRoundHost = {
    gameMode,
    roomId,
    localPlayerId,
    engineRef,
    shopFinishingRef,
    lastAppliedShopEpochRef,
    lastCompletedRoundNumberRef,
    gamePhaseRef,
    shopPlayersRef,
    pendingShopFinishRef,
    localShopDoneRef,
    currentMancheRef,
    currentShopIndexRef,
    shopSessionRef,
    shopAiTimeoutRef,
    dispatch,
    clearShopAiTimeout,
    clearCelebrationTimer,
    setLocalShopDone,
    sendCombatMessage,
  };

  const handleNextRound = (): void => {
    startShopPhase(shopRoundHost);
  };

  const handleNewGameFromSummary = (): void => {
    if (gameMode === "online") {
      startShopPhase(shopRoundHost);
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

  const handleShopBuySell = (weaponId: WeaponId, delta: 1 | -1): void => {
    shopBuySell(shopRoundHost, weaponId, delta);
  };

  const handleShopReady = (): void => {
    shopReady(shopRoundHost);
  };

  useEffect(() => {
    applyShopFinishRef.current = (players, shopEpoch, nextRoundNumber) => {
      applyAuthoritativeShopFinish(
        shopRoundHost,
        players,
        shopEpoch,
        nextRoundNumber,
      );
    };

    // No cleanup here: this effect refreshes handler refs on every render.
    // Clearing shopAiTimeout on each paint cancelled the local AI shop delay
    // (human Ready → overlay "IA fait ses achats…" → stuck until next round).
  });

  const handleNewGame = () => {
    const engine = engineRef.current;
    if (!engine) return;

    engine.resetGame();

    const newPlayers = createDemoPlayers();
    engine.setAIEngine(new AIByProfileStrategy());
    engine.setPlayers(newPlayers);
    engine.setRoundNumber(1);

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
    dismissEarningsOverlay,
    isLocalShopTurn,
    shopDisplayPlayer,
    localShopDone,
  };
}
