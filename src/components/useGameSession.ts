import { useCallback, useEffect, useRef, useReducer, useState } from "react";
import { GameEngine, type ResolvedShotPreview } from "../game/engine/GameEngine";
import type { CurrentTurnInfo } from "../game/engine/TurnManager";
import { VGA_PALETTE } from "../types/game";
import { AIByProfileStrategy } from "../game/entities/ai/AIByProfileStrategy";
import type { Player } from "../types/player";
import type { WeaponId } from "../types/weapon";
import type { TerrainMaterial } from "../types/terrain";
import { ALL_WEAPON_IDS, DEFAULT_INVENTORY } from "../types/weapon";
import type { GamePhase } from "../types/game";
import {
  gameCanvasReducer,
  INITIAL_STATE,
  ZEUS_ANNOUNCEMENT_DURATION_MS,
  type EarningsOverlayState,
  type PendingFireIntent,
  type PendingShopIntent,
  type ShopClientSessionState,
} from "./gameCanvasReducer";
import { autoBuyForAI } from "../game/entities/ai/aiShopHelper";
import { trackEvent } from "../utils/analytics";
import { setRNG, createSeededRNG, seedFromRoomRound } from "../utils/random";
import { getOnlineWsBase } from "../utils/onlineApi";
import {
  clearOnlineSession,
  persistOnlineSession,
  type OnlineCanvasSnapshot,
} from "../utils/onlineSession";
import {
  applyShopTransaction,
  normalizeRosterAtShopOpen,
} from "../game/shop/shopTransaction";
import {
  ONLINE_PROTOCOL_VERSION,
  PROTOCOL_MISMATCH_CLOSE_CODE,
  type ClientFireMessage,
  type FireRejectedMessage,
  type RequestGameStartMessage,
  type RoundEndMessage,
  type ShopBuySellMessage,
  type ShopEnterMessage,
  type ShopStateMessage,
  type ShopReadyMessage,
  type ShotMessage,
  type ShotEarningsMessage,
} from "../game/online/protocol";
import { DeferredTransitionBuffer } from "../game/online/deferredTransitions";
import { AuthoritativeShotQueue } from "../game/online/authoritativeShotQueue";
import { dispatchCombatMessage } from "./online/combatMessageDispatch";
import type {
  ZeusAppointment,
  ZeusStrikeResult,
} from "../game/zeus/zeusDomain";

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

export function buildOverlayAwards(
  awards: ReadonlyArray<{ playerId: string; amount: number }>,
  roster: ReadonlyArray<Player>,
): EarningsOverlayState["awards"] {
  const playersById = new Map(roster.map((player) => [player.id, player]));
  const overlayAwards: EarningsOverlayState["awards"] = [];
  for (const award of awards) {
    if (award.amount <= 0) continue;
    const player = playersById.get(award.playerId);
    if (!player) continue;
    overlayAwards.push({
      playerId: player.id,
      playerName: player.name,
      color: player.tank.color,
      amount: award.amount,
      x: player.tank.position.x,
      y: player.tank.position.y,
    });
  }
  return overlayAwards;
}

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

/**
 * Module-level generation counter for the combat WS mount effect.
 * Lets cleanup defer-close without killing a socket reclaimed by Strict Mode remount.
 */
let combatWsEffectGen = 0;

interface AuthoritativeEconomyPlayer {
  readonly id: string;
  readonly money: number;
  readonly inventory: Partial<Record<WeaponId, number>>;
  readonly currentWeapon: WeaponId;
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
  /** Outbox for combat WS messages when the socket is not yet OPEN. */
  const pendingCombatMessagesRef = useRef<string[]>([]);
  const roundEndFromNetworkRef = useRef(false);
  const authoritySlotRef = useRef<number | null>(resumeCanvas?.authoritySlot ?? null);
  const authorityEpochRef = useRef(resumeCanvas?.authorityEpoch ?? 0);
  const lastAppliedShotIdRef = useRef(resumeCanvas?.lastAppliedShotId ?? 0);
  const lastSeenShotIdRef = useRef(resumeCanvas?.lastSeenShotId ?? 0);
  const shotQueueRef = useRef<AuthoritativeShotQueue | null>(null);
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
  const authoritativeEconomyRef = useRef<AuthoritativeEconomyPlayer[]>([]);
  const reapplyAuthoritativeEconomyRef = useRef<() => void>(() => {});
  const transitionBufferRef = useRef<DeferredTransitionBuffer | null>(null);
  const protocolMismatchRef = useRef(false);
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
  const handleGoToShopRef = useRef<() => void>(() => {});
  const finishShopPhaseRef = useRef<
    (
      finalPlayers?: Player[],
      shopEpoch?: number,
      nextRoundNumber?: number,
    ) => void
  >(() => {});
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
        initialMaterials,
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
        authoritySlot: authoritySlotRef.current,
        authorityEpoch: authorityEpochRef.current,
        lastAppliedShotId: lastAppliedShotIdRef.current,
        lastAppliedZeusStrikeId: lastAppliedZeusStrikeIdRef.current,
        roundEarningsByPlayer:
          engineRef.current?.getRoundEarningsByPlayer() ??
          roundResult?.earningsByPlayer ??
          {},
        earningsOverlay: state.earningsOverlay,
        shopSession,
        lastAppliedShopEpoch,
        lastCompletedRoundNumber,
        lastSeenShotId,
        pendingFireIntent: state.pendingFireIntent,
        fireRejection: state.fireRejection,
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
    initialMaterials,
    initialWind,
    initialCurrentPlayerIndex,
    state.earningsOverlay,
    shopSession,
    lastAppliedShopEpoch,
    lastCompletedRoundNumber,
    lastSeenShotId,
    state.pendingFireIntent,
    state.fireRejection,
  ]);

  const clearShopAiTimeout = useCallback((): void => {
    if (shopAiTimeoutRef.current !== null) {
      clearTimeout(shopAiTimeoutRef.current);
      shopAiTimeoutRef.current = null;
    }
  }, []);

  const flushCombatMessages = useCallback((): void => {
    if (protocolMismatchRef.current) return;
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
    (obj: object): void => {
      if (protocolMismatchRef.current) return;
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
        `[Game] Queued combat message type=${"type" in obj ? String(obj.type) : "unknown"} (ws readyState=${ws?.readyState ?? 'null'})`,
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

    let gameWs: WebSocket | null = null;

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

    // === Game phase persistent WS connection to the room DO for authoritative sync ===
    // This survives the lobby unmount. FIRE is only an intention: every client,
    // including the shooter, launches physics from the persisted SHOT echo.
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

    const buildCatchUpRequest = (): RequestGameStartMessage => ({
      type: "REQUEST_GAME_START",
      protocolVersion: ONLINE_PROTOCOL_VERSION,
      roundNumber: currentMancheRef.current,
      lastSeenShotId: lastSeenShotIdRef.current,
      lastAppliedShopEpoch: lastAppliedShopEpochRef.current,
    });
    const transitionBuffer = new DeferredTransitionBuffer();
    transitionBufferRef.current = transitionBuffer;

    const acknowledgePendingFire = (message: ShotMessage): void => {
      if (pendingFireRef.current?.actionId !== message.actionId) return;
      pendingFireRef.current = null;
      dispatch({ type: "SET_FIRE_PENDING", intent: null });
      dispatch({ type: "SET_FIRE_REJECTION", reason: null });
    };

    const idleTransitions = {
      apply: (): void => {
        reapplyAuthoritativeEconomyRef.current();
      },
    };

    const shotQueue = new AuthoritativeShotQueue({
      getGamePhase: () => gamePhaseRef.current,
      isInterRoundPaused: () => tm.isInterRoundPaused(),
      lastSeenShotId: () => lastSeenShotIdRef.current,
      markSeen: (shotId) => {
        lastSeenShotIdRef.current = Math.max(lastSeenShotIdRef.current, shotId);
        dispatch({ type: "SET_LAST_SEEN_SHOT", shotId });
      },
      acknowledgePendingFire,
      executeRemoteFire: (message, mode) => {
        tm.executeRemoteFire(message.command, {
          fromSlot: message.slot,
          ownerId: message.ownerId,
          identity: {
            shotId: message.shotId,
            isFirstShotOfRound: message.isFirstShotOfRound,
          },
          mode,
        });
      },
      onIdle: () => idleTransitions.apply(),
      lockForCatchUp: () => tm.lockForCatchUp(),
      unlockAfterCatchUp: () => tm.unlockAfterCatchUp(),
    });
    shotQueueRef.current = shotQueue;

    tm.onAuthoritativeShotSettled = (shotId) => {
      shotQueue.onShotSettled(shotId);
    };

    tm.setFireIntentHandler((command) => {
      if (pendingFireRef.current) return;
      if (fireRejectionTimerRef.current !== null) {
        clearTimeout(fireRejectionTimerRef.current);
        fireRejectionTimerRef.current = null;
      }
      const actionId = crypto.randomUUID();
      const pending: PendingFireIntent = {
        actionId,
        command: { ...command },
      };
      pendingFireRef.current = pending;
      dispatch({ type: "SET_FIRE_PENDING", intent: pending });
      dispatch({ type: "SET_FIRE_REJECTION", reason: null });
      const message: ClientFireMessage = {
        type: "FIRE",
        actionId,
        command: pending.command,
      };
      sendCombatMessage(message);
    });

    const clearCombatReconnect = (): void => {
      if (combatReconnectTimer !== null) {
        clearTimeout(combatReconnectTimer);
        combatReconnectTimer = null;
      }
    };

    const submitShotEarnings = (preview: ResolvedShotPreview): void => {
      if (authoritySlotRef.current !== localSlotNum) return;
      const message: ShotEarningsMessage = {
        type: "SHOT_EARNINGS",
        shotId: preview.shotId,
        authorityEpoch: authorityEpochRef.current,
        awards: preview.awards.map(({ playerId, amount }) => ({ playerId, amount })),
        deadSlots: engine.getTankManager().getPlayers().map((player) => player.tank.isDead),
        roundOutcome: preview.roundOutcome,
        directHitVictimIds: preview.directHitVictimIds,
      };
      sendCombatMessage(message);
    };
    submitShotEarningsRef.current = submitShotEarnings;

    const syncWireEconomy = (value: unknown): void => {
      if (!Array.isArray(value)) return;
      const updates: AuthoritativeEconomyPlayer[] = [];
      for (const entry of value) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
        const wirePlayer = entry as Record<string, unknown>;
        if (
          typeof wirePlayer.id !== 'string' ||
          typeof wirePlayer.money !== 'number' ||
          !Number.isSafeInteger(wirePlayer.money) ||
          wirePlayer.money < 0
        ) return;
        if (
          !wirePlayer.inventory ||
          typeof wirePlayer.inventory !== "object" ||
          Array.isArray(wirePlayer.inventory) ||
          !wirePlayer.tank ||
          typeof wirePlayer.tank !== "object" ||
          Array.isArray(wirePlayer.tank)
        ) return;
        const inventory: Partial<Record<WeaponId, number>> = {};
        for (const [weaponId, stock] of Object.entries(
          wirePlayer.inventory as Record<string, unknown>,
        )) {
          if (
            !ALL_WEAPON_IDS.includes(weaponId as WeaponId) ||
            typeof stock !== "number" ||
            !Number.isSafeInteger(stock) ||
            stock < 0
          ) return;
          inventory[weaponId as WeaponId] = stock;
        }
        const currentWeapon = (wirePlayer.tank as Record<string, unknown>)[
          "currentWeapon"
        ];
        if (
          typeof currentWeapon !== "string" ||
          !ALL_WEAPON_IDS.includes(currentWeapon as WeaponId)
        ) return;
        updates.push({
          id: wirePlayer.id,
          money: wirePlayer.money,
          inventory,
          currentWeapon: currentWeapon as WeaponId,
        });
      }
      authoritativeEconomyRef.current = updates;
      reapplyAuthoritativeEconomyRef.current();
    };

    reapplyAuthoritativeEconomyRef.current = (): void => {
      const livePlayers = engine.getTankManager().getPlayers();
      const livePlayersById = new Map(
        livePlayers.map((player) => [player.id, player]),
      );
      for (const update of authoritativeEconomyRef.current) {
        const livePlayer = livePlayersById.get(update.id);
        if (!livePlayer) continue;
        livePlayer.money = update.money;
        livePlayer.inventory = { ...update.inventory };
        livePlayer.tank.currentWeapon = update.currentWeapon;
      }
      dispatch({ type: "SET_UI_PLAYERS", players: [...livePlayers] });
    };

    const applyFireRejection = (message: FireRejectedMessage): void => {
      const pending = pendingFireRef.current;
      if (
        !pending ||
        message.actionId === undefined ||
        pending.actionId !== message.actionId
      ) return;
      const roster = engine.getTankManager().getPlayers();
      const localPlayer = roster[localSlotNum];
      if (localPlayer) {
        localPlayer.inventory = { ...message.inventory };
        localPlayer.tank.currentWeapon = message.currentWeapon;
        authoritativeEconomyRef.current =
          authoritativeEconomyRef.current.map((entry) =>
            entry.id === localPlayer.id
              ? {
                  ...entry,
                  inventory: { ...message.inventory },
                  currentWeapon: message.currentWeapon,
                }
              : entry,
          );
        dispatch({ type: "SET_UI_PLAYERS", players: [...roster] });
      }
      pendingFireRef.current = null;
      dispatch({ type: "SET_FIRE_PENDING", intent: null });
      tm.rejectPendingFireIntent();
      dispatch({ type: "SET_FIRE_REJECTION", reason: message.reason });
    };

    const applyRoundEndMessage = (message: RoundEndMessage): void => {
      if (message.roundNumber <= lastCompletedRoundNumberRef.current) return;
      if (gamePhaseRef.current !== 'COMBAT') return;
      lastCompletedRoundNumberRef.current = Math.max(
        lastCompletedRoundNumberRef.current,
        message.roundNumber,
      );
      dispatch({
        type: "SET_LAST_COMPLETED_ROUND",
        roundNumber: message.roundNumber,
      });
      roundEndFromNetworkRef.current = true;
      engine.syncRoundEndFromRemote(
        message.players,
        message.roundWinnerId,
        message.isDraw,
      );
    };

    const applyShopStateMessage = (message: ShopStateMessage): void => {
      if (message.shopEpoch <= lastAppliedShopEpochRef.current) return;
      const pending = shopSessionRef.current.pendingIntent;
      const localPlayer = message.players[localSlotNum];
      let acknowledged = false;
      if (pending?.shopEpoch === message.shopEpoch) {
        if (pending.kind === "READY") {
          acknowledged = message.readySlots.includes(localSlotNum);
        } else if (localPlayer) {
          acknowledged =
            localPlayer.money === pending.expectedMoney &&
            (localPlayer.inventory[pending.weaponId] ?? 0) ===
              pending.expectedStock &&
            (message.purchasesByPlayerId[localPlayer.id]?.[
              pending.weaponId
            ] ?? 0) === pending.expectedPurchaseCount;
        }
      }
      const relevantPending =
        pending?.shopEpoch === message.shopEpoch ? pending : null;
      const nextShopSession: ShopClientSessionState = {
        epoch: message.shopEpoch,
        roundNumber: message.roundNumber,
        counters: message.purchasesByPlayerId,
        readySlots: message.readySlots,
        aiShopApplied: message.aiShopApplied,
        authoritativeReceived: true,
        pendingIntent: acknowledged ? null : relevantPending,
        denial: null,
      };
      const liveById = new Map(
        engine.getTankManager().getPlayers().map((player) => [player.id, player]),
      );
      const mergedPlayers = message.players.map((authoritativePlayer) => {
        const livePlayer = liveById.get(authoritativePlayer.id);
        if (!livePlayer) return authoritativePlayer;
        return {
          ...livePlayer,
          name: authoritativePlayer.name,
          isHuman: authoritativePlayer.isHuman,
          aiProfile: authoritativePlayer.aiProfile,
          money: authoritativePlayer.money,
          inventory: { ...authoritativePlayer.inventory },
          tank: {
            ...livePlayer.tank,
            currentWeapon: authoritativePlayer.tank.currentWeapon,
          },
        };
      });

      clearCelebrationTimer();
      engine.clearRoundCelebration();
      shopSessionRef.current = nextShopSession;
      engine.getTankManager().setPlayers(mergedPlayers);
      shopPlayersRef.current = mergedPlayers;
      localShopDoneRef.current = message.readySlots.includes(localSlotNum);
      setLocalShopDone(localShopDoneRef.current);
      dispatch({
        type: "APPLY_SHOP_STATE",
        shopEpoch: message.shopEpoch,
        roundNumber: message.roundNumber,
        readySlots: message.readySlots,
        players: mergedPlayers,
        counters: message.purchasesByPlayerId,
        aiShopApplied: message.aiShopApplied,
      });
      dispatch({
        type: "SET_SHOP_PENDING",
        intent: nextShopSession.pendingIntent,
      });
      currentMancheRef.current = Math.max(
        currentMancheRef.current,
        message.roundNumber + 1,
      );
      lastCompletedRoundNumberRef.current = Math.max(
        lastCompletedRoundNumberRef.current,
        message.roundNumber,
      );
      gamePhaseRef.current = "SHOP";
      tm.pauseForInterRound();
    };

    idleTransitions.apply = (): void => {
      reapplyAuthoritativeEconomyRef.current();
      for (const item of transitionBuffer.drain()) {
        if (item.kind === "ROUND_END") {
          applyRoundEndMessage(item.message);
        } else if (item.kind === "SHOP_STATE") {
          applyShopStateMessage(item.message);
        } else {
          applyShopFinishRef.current(
            item.message.players,
            item.message.shopEpoch,
            item.message.nextRoundNumber,
          );
          if (
            gamePhaseRef.current === "COMBAT" &&
            shotQueue.pendingCount > 0
          ) {
            shotQueue.drain();
            return;
          }
        }
      }
    };

    const retryPendingActions = (): void => {
      const pendingFire = pendingFireRef.current;
      if (pendingFire) {
        const retry: ClientFireMessage = {
          type: "FIRE",
          actionId: pendingFire.actionId,
          command: pendingFire.command,
        };
        sendCombatMessage(retry);
      }
      const shopSession = shopSessionRef.current;
      if (
        gamePhaseRef.current === "SHOP" &&
        !shopSession.authoritativeReceived &&
        shopSession.roundNumber !== null
      ) {
        const retry: ShopEnterMessage = {
          type: "SHOP_ENTER",
          roundNumber: shopSession.roundNumber,
        };
        sendCombatMessage(retry);
      }
      const pendingShop = shopSession.pendingIntent;
      if (pendingShop?.kind === "BUY_SELL") {
        const retry: ShopBuySellMessage = {
          type: "SHOP_BUY_SELL",
          shopEpoch: pendingShop.shopEpoch,
          actionId: pendingShop.actionId,
          weaponId: pendingShop.weaponId,
          delta: pendingShop.delta,
        };
        sendCombatMessage(retry);
      } else if (pendingShop?.kind === "READY") {
        const retry: ShopReadyMessage = {
          type: "SHOP_READY",
          shopEpoch: pendingShop.shopEpoch,
          actionId: pendingShop.actionId,
        };
        sendCombatMessage(retry);
      }
    };

    function bindCombatWsHandlers(ws: WebSocket): void {
      ws.onopen = () => {
        console.log('[Game] Combat WS connected to server');
        flushCombatMessages();
        retryPendingActions();
        // Pull ordered shots and any active shop transition missed during reconnect.
        try {
          ws.send(JSON.stringify(buildCatchUpRequest()));
        } catch {
          // ignore
        }
      };

      ws.onmessage = (ev) => {
        try {
          dispatchCombatMessage(
            {
              engine,
              shotQueue,
              transitionBuffer,
              localSlotNum,
              dispatch,
              protocolMismatchRef,
              authoritySlotRef,
              authorityEpochRef,
              lastAppliedShotIdRef,
              pendingShotPreviewsRef,
              shopSessionRef,
              gamePhaseRef,
              applyFireRejection,
              applyShopStateMessage,
              applyRoundEndMessage,
              applyShopFinish: (
                players,
                shopEpoch,
                nextRoundNumber,
              ) => {
                applyShopFinishRef.current(players, shopEpoch, nextRoundNumber);
              },
              submitShotEarnings,
              syncWireEconomy,
              buildOverlayAwards,
            },
            JSON.parse(ev.data) as unknown,
          );
        } catch (e) {
          console.warn('[Game] invalid WS message', e);
        }
      };

      ws.onclose = (ev: CloseEvent) => {
        console.log('[Game] Combat WS closed', ev.code, ev.reason);
        if (gameWsRef.current === ws) {
          gameWsRef.current = null;
          if (
            ev.code === 4001 ||
            ev.code === PROTOCOL_MISMATCH_CLOSE_CODE ||
            (typeof ev.reason === 'string' && ev.reason.includes('replaced'))
          ) {
            console.log('[Game] Socket superseded by another connection, skipping reconnect');
            return;
          }
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
      retryPendingActions();
      try {
        incomingWs.send(JSON.stringify(buildCatchUpRequest()));
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
          const deadSlots = engine.getTankManager().getPlayers().map((p) => Boolean(p.tank.isDead));
          const shotId = shotQueueRef.current?.activeServerShotId ?? null;
          if (shotId !== null) {
            sendCombatMessage({ type: 'SHOT_SETTLED', shotId, slot, deadSlots });
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
        "(coordinates redacted)",
      );
    };

    // Listen to turn/HUD updates for real-time display
    engine.onTurnHudUpdate = (info: CurrentTurnInfo) => {
      dispatch({ type: "SET_TURN_INFO", info });
    };

    engine.onZeusAppointed = (appointment: ZeusAppointment) => {
      if (
        gameMode === "online" &&
        appointment.appointmentId <= lastZeusAppointmentIdRef.current
      ) return;
      lastZeusAppointmentIdRef.current = appointment.appointmentId;
      const player = engine.getTankManager().getPlayerById(appointment.zeusId);
      if (!player) return;
      if (zeusAnnouncementTimerRef.current !== null) {
        clearTimeout(zeusAnnouncementTimerRef.current);
      }
      dispatch({
        type: "SHOW_ZEUS_ANNOUNCEMENT",
        announcement: {
          appointmentId: appointment.appointmentId,
          playerName: player.name,
          displayedAt: Date.now(),
        },
      });
      zeusAnnouncementTimerRef.current = setTimeout(() => {
        zeusAnnouncementTimerRef.current = null;
        dispatch({ type: "HIDE_ZEUS_ANNOUNCEMENT" });
      }, ZEUS_ANNOUNCEMENT_DURATION_MS);
    };

    engine.onZeusStrikeApplied = (result: ZeusStrikeResult) => {
      if (
        gameMode === "online" &&
        result.strikeId <= lastAppliedZeusStrikeIdRef.current
      ) return;
      lastAppliedZeusStrikeIdRef.current = result.strikeId;
      const roster = [...engine.getTankManager().getPlayers()];
      dispatch({ type: "SET_UI_PLAYERS", players: roster });
      const awards = buildOverlayAwards([result.award], roster);
      if (awards.length > 0) {
        dispatch({
          type: "SHOW_EARNINGS",
          overlay: {
            shotId: -result.strikeId,
            awards,
            displayedAt: Date.now(),
          },
        });
      }
    };

    engine.onShotResolved = (preview) => {
      if (gameMode === "online") {
        pendingShotPreviewsRef.current.set(preview.shotId, preview);
        submitShotEarningsRef.current(preview);
        return;
      }
      const roster = [...engine.getTankManager().getPlayers()];
      dispatch({ type: "SET_UI_PLAYERS", players: roster });
      const awards = buildOverlayAwards(preview.awards, roster);
      if (awards.length > 0) {
        dispatch({
          type: "SHOW_EARNINGS",
          overlay: {
            shotId: preview.shotId,
            awards,
            displayedAt: Date.now(),
          },
        });
      }
    };

    /**
     * Combat round ends on last man standing (0 or 1 tanks remain alive).
     */
    engine.onRoundEnded = (payload) => {
      if (gamePhaseRef.current !== "COMBAT") return;
      clearZeusAnnouncement();

      const fromNetwork = roundEndFromNetworkRef.current;
      roundEndFromNetworkRef.current = false;

      void fromNetwork;

      tm.pauseForInterRound();

      const res = engine.buildRoundResult();
      const nextPlayers = [...engine.getTankManager().getPlayers()];
      lastCompletedRoundNumberRef.current = Math.max(
        lastCompletedRoundNumberRef.current,
        currentMancheRef.current,
      );
      dispatch({
        type: "SET_LAST_COMPLETED_ROUND",
        roundNumber: currentMancheRef.current,
      });

      // Track round end event (custom Zaraz analytics)
      const winner = payload.roundWinner;
      const winnerType = winner ? (winner.isHuman ? "human" : "ai") : "none";
      const winnerProfile = winner && !winner.isHuman ? (winner.aiProfile ?? "v1-random") : undefined;

      const nextHumanCount = nextPlayers.reduce((count, p) => count + (p.isHuman ? 1 : 0), 0);

      trackEvent("round_end", {
        roundNumber: currentMancheRef.current,
        winnerId: winner ? winner.id : null,
        winnerType,
        winnerProfile,
        humanCount: nextHumanCount,
        aiCount: nextPlayers.length - nextHumanCount,
      });

      // Trigger the engine-level fireworks celebration
      engine.triggerRoundCelebration(payload.roundWinner || undefined);

      currentMancheRef.current += 1;
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
        combatStartTimer = null;
      }
      if (combatReconnectTimer !== null) {
        clearTimeout(combatReconnectTimer);
        combatReconnectTimer = null;
      }
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

      const wsToClose = gameWs;
      const genAtCleanup = effectGeneration;
      // Defer close so React Strict Mode remount can reuse the same lobby/combat socket
      // without dropping the DO mapping mid-handshake (which made P2 miss P1's SHOT).
      setTimeout(() => {
        if (combatWsEffectGen !== genAtCleanup) return; // a newer effect owns the session
        if (wsToClose) {
          wsToClose.onopen = null;
          wsToClose.onmessage = null;
          wsToClose.onclose = null;
          wsToClose.onerror = null;
          if (wsToClose.readyState === WebSocket.OPEN || wsToClose.readyState === WebSocket.CONNECTING) {
            try {
              wsToClose.close();
            } catch {
              void 0;
            }
          }
        }
        if (gameWsRef.current === wsToClose) {
          gameWsRef.current = null;
        }
      }, 0);

      engine.stop();
      tm.setFireIntentHandler(null);
      tm.onAuthoritativeShotSettled = undefined;
      tm.removeInputListeners();
      reapplyAuthoritativeEconomyRef.current = () => {};
      transitionBufferRef.current?.drain();
      transitionBufferRef.current = null;
      shotQueueRef.current = null;
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

    const completedRoundNumber =
      gameMode === "online"
        ? lastCompletedRoundNumberRef.current
        : Math.max(1, currentMancheRef.current - 1);

    if (gameMode !== "online") {
      roster = normalizeRosterAtShopOpen(roster);
      engine.getTankManager().setPlayers(roster);
    }

    dispatch({
      type: "START_SHOP",
      roster,
      mode: gameMode,
      completedRoundNumber,
    });
    const nextShopEpoch =
      gameMode === "online"
        ? null
        : lastAppliedShopEpochRef.current + 1;
    shopSessionRef.current = {
      ...INITIAL_STATE.shopSession,
      epoch: nextShopEpoch,
      roundNumber: completedRoundNumber,
      authoritativeReceived: gameMode !== "online",
    };
    shopPlayersRef.current = roster;
    currentShopIndexRef.current = 0;
    gamePhaseRef.current = "SHOP";

    const pendingFinish = pendingShopFinishRef.current;
    if (pendingFinish !== null) {
      pendingShopFinishRef.current = null;
      finishShopPhaseRef.current(
        pendingFinish.players,
        pendingFinish.shopEpoch,
        pendingFinish.nextRoundNumber,
      );
      return;
    }

    // Online parallel boutique: every human shops; server waits for all SHOP_READY.
    if (gameMode === 'online') {
      const message: ShopEnterMessage = {
        type: "SHOP_ENTER",
        roundNumber: completedRoundNumber,
      };
      sendCombatMessage(message);
      return;
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

    if (
      gameMode === "online" &&
      (shopSessionRef.current.epoch === null ||
        !shopSessionRef.current.authoritativeReceived ||
        shopSessionRef.current.pendingIntent)
    ) {
      return;
    }

    const transaction = applyShopTransaction({
      player: currentPlayer,
      counters: shopSessionRef.current.counters,
      weaponId,
      delta,
    });
    if (!transaction.ok) {
      dispatch({ type: "SET_SHOP_DENIAL", denial: transaction.reason });
      return;
    }

    if (gameMode === "online") {
      const shopEpoch = shopSessionRef.current.epoch;
      if (
        shopEpoch === null ||
        !shopSessionRef.current.authoritativeReceived ||
        shopSessionRef.current.pendingIntent
      ) return;
      const actionId = crypto.randomUUID();
      const expectedPurchaseCount =
        transaction.counters[currentPlayer.id]?.[weaponId] ?? 0;
      const intent: PendingShopIntent = {
        kind: "BUY_SELL",
        actionId,
        shopEpoch,
        weaponId,
        delta,
        expectedMoney: transaction.player.money,
        expectedStock: transaction.player.inventory[weaponId] ?? 0,
        expectedPurchaseCount,
      };
      shopSessionRef.current = {
        ...shopSessionRef.current,
        pendingIntent: intent,
        denial: null,
      };
      dispatch({ type: "SET_SHOP_PENDING", intent });
      const message: ShopBuySellMessage = {
        type: "SHOP_BUY_SELL",
        shopEpoch,
        actionId,
        weaponId,
        delta,
      };
      sendCombatMessage(message);
      return;
    }

    const updatedPlayers = enginePlayers.map((player) =>
      player.id === currentPlayer.id ? transaction.player : player,
    );
    engine.getTankManager().setPlayers(updatedPlayers);
    shopPlayersRef.current = updatedPlayers;
    shopSessionRef.current = {
      ...shopSessionRef.current,
      counters: transaction.counters,
      denial: null,
    };
    dispatch({
      type: "APPLY_LOCAL_SHOP_TRANSACTION",
      players: updatedPlayers,
      counters: transaction.counters,
      denial: null,
    });
  };

  const handleShopReady = (): void => {
    if (gameMode === 'online' && localPlayerId) {
      const shopEpoch = shopSessionRef.current.epoch;
      if (
        localShopDoneRef.current ||
        shopEpoch === null ||
        !shopSessionRef.current.authoritativeReceived ||
        shopSessionRef.current.pendingIntent
      ) return;
      const eng = engineRef.current;
      const me = eng
        ?.getTankManager()
        .getPlayers()
        .find((p) => p.id === localPlayerId);
      if (!me?.isHuman) return;

      const actionId = crypto.randomUUID();
      const intent: PendingShopIntent = {
        kind: "READY",
        actionId,
        shopEpoch,
      };
      shopSessionRef.current = {
        ...shopSessionRef.current,
        pendingIntent: intent,
        denial: null,
      };
      dispatch({ type: "SET_SHOP_PENDING", intent });
      const message: ShopReadyMessage = {
        type: "SHOP_READY",
        shopEpoch,
        actionId,
      };
      sendCombatMessage(message);
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

    const safeInventory = Object.create(null) as NonNullable<Player["inventory"]>;
    if (current.inventory && typeof current.inventory === "object") {
      for (const k in current.inventory) {
        if (Object.prototype.hasOwnProperty.call(current.inventory, k)) {
          if (k !== "__proto__" && k !== "prototype" && k !== "constructor") {
            (safeInventory as Record<string, unknown>)[k] = (current.inventory as Record<string, unknown>)[k];
          }
        }
      }
    }

    const safeAiPlayer = {
      ...current,
      inventory: safeInventory,
    } as Player;

    const autoBuy = autoBuyForAI(
      safeAiPlayer,
      shopSessionRef.current.counters,
    );
    const updatedAiPlayer = autoBuy.player;

    const engine = engineRef.current;
    const basePlayers = engine
      ? engine.getTankManager().getPlayers()
      : shopPlayersRef.current;
    const updatedPlayers = basePlayers.map((p) =>
      p.id === current.id ? updatedAiPlayer : p,
    );

    if (engine) {
      engine.getTankManager().setPlayers(updatedPlayers);
    }
    shopPlayersRef.current = updatedPlayers;
    shopSessionRef.current = {
      ...shopSessionRef.current,
      counters: autoBuy.counters,
    };
    dispatch({
      type: "APPLY_LOCAL_SHOP_TRANSACTION",
      players: updatedPlayers,
      counters: autoBuy.counters,
      denial: null,
    });

    advanceToNextShopper();
  };

  /**
   * Leave boutique and start the next combat round.
   * @param finalPlayers Optional money/inventory snapshot from the server — applied ONLY
   *   before startNextRound. Re-applying shop players after spawn restored isDead and left
   *   P1 unable to fire while P2 waited for P1's shot.
   */
  const finishShopPhase = (
    finalPlayers?: Player[],
    shopEpoch?: number,
    nextRoundNumber?: number,
  ): void => {
    if (shopFinishingRef.current) return;
    if (
      shopEpoch !== undefined &&
      shopEpoch <= lastAppliedShopEpochRef.current
    ) return;
    // Duplicate SHOP_FINISH / SHOP_STATE after combat already began for this round.
    if (gamePhaseRef.current === "COMBAT" && shopPlayersRef.current.length === 0) {
      return;
    }

    const engine = engineRef.current;
    if (!engine) return;

    shopFinishingRef.current = true;
    clearShopAiTimeout();
    pendingShopFinishRef.current = null;
    localShopDoneRef.current = false;
    setLocalShopDone(false);

    if (finalPlayers && finalPlayers.length >= 2) {
      engine.getTankManager().setPlayers(finalPlayers);
      shopPlayersRef.current = finalPlayers;
    }

    if (nextRoundNumber !== undefined) {
      currentMancheRef.current = Math.max(
        currentMancheRef.current,
        nextRoundNumber,
      );
    }

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
    engine.setRoundNumber(currentMancheRef.current);
    if (!started) {
      shopFinishingRef.current = false;
      endMatchFromShop(engine, [...roster]);
      return;
    }

    // Fresh round: startNextRound already anchors and starts the first local turn.
    // Online clients must still cancel that speculative local AI turn and follow slot 0.
    tm.resumeForCombat();
    if (gameMode === 'online') tm.syncTurn(0);

    const nextPlayers = [...engine.getTankManager().getPlayers()];
    const completedShopEpoch =
      shopEpoch ??
      (gameMode !== "online"
        ? shopSessionRef.current.epoch ?? undefined
        : undefined);
    if (completedShopEpoch !== undefined) {
      lastAppliedShopEpochRef.current = Math.max(
        lastAppliedShopEpochRef.current,
        completedShopEpoch,
      );
    }
    dispatch({
      type: "FINISH_SHOP",
      uiPlayers: nextPlayers,
      shopEpoch: completedShopEpoch,
      nextRoundNumber,
    });
    gamePhaseRef.current = "COMBAT";
    shopPlayersRef.current = [];
    currentShopIndexRef.current = 0;

    clearCelebrationTimer();
    shopFinishingRef.current = false;
  };

  useEffect(() => {
    handleGoToShopRef.current = handleGoToShop;
    finishShopPhaseRef.current = finishShopPhase;
    applyShopFinishRef.current = (
      finalPlayers: Player[],
      shopEpoch: number,
      nextRoundNumber: number,
    ) => {
      if (shopFinishingRef.current) return;
      if (shopEpoch <= lastAppliedShopEpochRef.current) return;

      const phase = gamePhaseRef.current;
      if (phase !== "SHOP") {
        lastCompletedRoundNumberRef.current = Math.max(
          lastCompletedRoundNumberRef.current,
          nextRoundNumber - 1,
        );
        currentMancheRef.current = Math.max(
          currentMancheRef.current,
          nextRoundNumber,
        );
        pendingShopFinishRef.current = {
          players: finalPlayers,
          shopEpoch,
          nextRoundNumber,
        };
        if (phase === "CELEBRATION") {
          clearCelebrationTimer();
          engineRef.current?.clearRoundCelebration();
        }
        if (phase === "COMBAT" || phase === "CELEBRATION") {
          dispatch({ type: "GO_TO_SUMMARY" });
          gamePhaseRef.current = "SUMMARY";
        }
        if (
          phase === "COMBAT" ||
          phase === "CELEBRATION" ||
          phase === "SUMMARY"
        ) {
          // Enter a transient shop then immediately apply the persisted terminal result.
          handleGoToShopRef.current();
        }
        return;
      }
      finishShopPhase(finalPlayers, shopEpoch, nextRoundNumber);
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
