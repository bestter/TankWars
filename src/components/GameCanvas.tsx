/**
 * Bestter's TankWars - GameCanvas React Component (src/components/GameCanvas.tsx)
 *
 * This component is ONLY responsible for:
 * - Owning the <canvas> DOM element (via ref)
 * - Creating and owning the GameEngine (via ref)
 * - Starting/stopping the high-frequency loop
 * - Passing user input (fire commands) into the engine
 *
 * All physics, projectile simulation, terrain mutation, and rendering
 * logic lives inside GameEngine (strict decoupling).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { GameEngine } from '../game/engine/GameEngine';
import type { CurrentTurnInfo } from '../game/engine/TurnManager';
import { VGA_PALETTE } from '../types/game';
import { AISimpleStrategy } from '../game/entities/ai/AISimpleStrategy';
import type { Player } from '../types/player';
import { GameHUD } from './GameHUD';
import { WindBanner } from './WindBanner';
import { RoundSummary } from './RoundSummary';
import { WeaponShop } from './WeaponShop';
import type { WeaponId } from '../types/weapon';
import { WEAPON_REGISTRY, DEFAULT_INVENTORY } from '../types/weapon';
import type { GamePhase, RoundResult } from '../types/game';

export interface GameCanvasProps {
  /** Joueurs pré-configurés depuis le MainMenu (phase initiale 'MENU'). Si absent → démo 2 joueurs. */
  initialPlayers?: Player[];
  /** Permet de retourner à l'écran titre (démontage engine + ressources). */
  onReturnToMenu?: () => void;
}

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 480;

export function GameCanvas({ initialPlayers, onReturnToMenu }: GameCanvasProps = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  const [wind, setWind] = useState(0);
  const [turnInfo, setTurnInfo] = useState<CurrentTurnInfo | null>(null);
  const [winner, setWinner] = useState<Player | null>(null);
  const [showNewGameButton, setShowNewGameButton] = useState(false);

  // React-owned high-level phase + round summary (per architecture: React owns phase/money/turns)
  const [gamePhase, setGamePhase] = useState<GamePhase>('COMBAT');
  const [roundResult, setRoundResult] = useState<RoundResult | null>(null);

  // Logical manche number for SUMMARY title "FIN DE MANCHE N" (persistent across chained rounds)
  const [currentManche, setCurrentManche] = useState(1);
  /** Last combat round outcome (manche), not whole-match game over */
  const [lastRoundOutcome, setLastRoundOutcome] = useState<{
    isDraw: boolean;
    winner: Player | null;
  } | null>(null);

  // Ref to avoid stale closure in engine callbacks registered in mount effect (gamePhase updates)
  const gamePhaseRef = useRef<GamePhase>('COMBAT');

  // === SHOP (boutique) state - sequential per living player ===
  const [shopPlayers, setShopPlayers] = useState<Player[]>([]);
  const [currentShopIndex, setCurrentShopIndex] = useState(0);

  // Refs to avoid stale closures in the setTimeout-based AI shopping chain (process/advance).
  // The shopping sequence uses async setTimeout recursion; direct state reads in those callbacks
  // would see values from the render when the first timeout was scheduled.
  const shopPlayersRef = useRef<Player[]>([]);
  const currentShopIndexRef = useRef(0);
  /** Prevents double finishShopPhase from chained AI timeouts */
  const shopFinishingRef = useRef(false);
  const shopAiTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Snapshot of players for safe UI rendering (avoids reading refs during render)
  const [uiPlayers, setUiPlayers] = useState<Player[]>([]);

  // Snapshot des joueurs initiaux au montage (évite de mettre initialPlayers dans les deps du useEffect one-shot)
  const initialPlayersRef = useRef(initialPlayers);

  // Timer for round celebration fireworks (10s auto-advance or skip with SPACE)
  const celebrationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearShopAiTimeout = (): void => {
    if (shopAiTimeoutRef.current !== null) {
      clearTimeout(shopAiTimeoutRef.current);
      shopAiTimeoutRef.current = null;
    }
  };

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
    setGamePhase('SUMMARY');
    gamePhaseRef.current = 'SUMMARY';
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

    const ctx = canvas.getContext('2d', {
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

    // === PLAYERS: provenance MainMenu (via props) OU démo 2 joueurs (standalone / New Game) ===
    // Note: positions sont des placeholders. setPlayers → TankManager.spawnTanks les recalcule sur le terrain généré.
    const demoPlayers: Player[] = [
      {
        id: 'player-1',
        name: 'You',
        isHuman: true,
        tank: {
          id: 'tank-1',
          position: { x: 180, y: 320 },
          angle: 45,
          power: 50,
          health: 100,
          maxHealth: 100,
          shield: 40,
          maxShield: 40,
          isDead: false,
          color: '#FF5555',
          currentWeapon: 'MISSILE',
        },
        money: 200,
        inventory: { ...DEFAULT_INVENTORY },
      },
      {
        id: 'player-2',
        name: 'AI Bot',
        isHuman: false,
        tank: {
          id: 'tank-2',
          position: { x: 620, y: 295 },
          angle: 135,
          power: 50,
          health: 100,
          maxHealth: 100,
          shield: 40,
          maxShield: 40,
          isDead: false,
          color: '#55FF55',
          currentWeapon: 'MISSILE',
        },
        money: 200,
        inventory: { ...DEFAULT_INVENTORY },
      },
    ];

    const snapshotPlayers = initialPlayersRef.current;
    const players: Player[] = snapshotPlayers && snapshotPlayers.length >= 2
      ? snapshotPlayers.map((p) => ({ ...p })) // clone shallow (objets Player mutés par l'engine ensuite)
      : demoPlayers;

    // Initialize players (this also calls setupInputListeners + starts first turn)
    engine.setPlayers(players);
    setUiPlayers(players);

    // Inject the simple AI strategy (requis pour tout joueur !isHuman, qu'il vienne du menu ou de la démo)
    engine.setAIEngine(new AISimpleStrategy());
    engine.onWindChange = setWind;

    // Wire callbacks (keep only what's actually useful; the "settled" log was firing every frame
    // while idle, causing massive spam during SHOP / between turns / SUMMARY).
    engine.onProjectileHit = (hit) => {
      console.log('[GameEngine] Hit:', hit.weaponId, 'at', hit.x.toFixed(1), hit.y.toFixed(1));
    };

    // Note: GameEngine.onAllProjectilesSettled is intentionally left unassigned here.
    // The real "projectiles just settled" event for turn advancement is wired internally
    // via connectToPhysics() → PhysicsEngine.onAllProjectilesSettled (transition-based only).
    // The previous unconditional assignment was causing huge console spam (120 logs/sec)
    // whenever count===0 (normal during SHOP AI purchases, SUMMARY, idle, etc.).

    // Listen to turn/HUD updates for real-time display
    engine.onTurnHudUpdate = (info: CurrentTurnInfo) => {
      setTurnInfo(info);
    };

    const tm = engine.getTurnManager();

    /**
     * Combat round ends when a tank is eliminated (or all destroyed).
     * Always SUMMARY → SHOP → next manche (full roster respawns). No match Game Over here.
     */
    engine.onRoundEnded = (payload) => {
      if (gamePhaseRef.current !== 'COMBAT') return;

      tm.pauseForInterRound();

      const res = engine.awardEndOfRoundEarnings();
      setRoundResult(res);
      setLastRoundOutcome({
        isDraw: payload.isDraw,
        winner: payload.roundWinner,
      });
      setUiPlayers([...engine.getTankManager().getPlayers()]);
      setWinner(null);
      setShowNewGameButton(false);

      engine.triggerRoundCelebration(payload.roundWinner ?? undefined);
      setCurrentManche((prev) => prev + 1);
      setGamePhase('CELEBRATION');
      gamePhaseRef.current = 'CELEBRATION';

      // Auto-advance to SUMMARY after ~10s of fireworks, unless skipped via SPACE/click
      clearCelebrationTimer();
      celebrationTimerRef.current = setTimeout(() => {
        if (gamePhaseRef.current === 'CELEBRATION') {
          goToSummary();
        }
      }, 10000);
    };

    engineRef.current = engine;
    gamePhaseRef.current = 'COMBAT';

    // Start the internal physics loop
    engine.start();

    // === CONTINUOUS RENDERING LOOP ===
    let rafId: number;
    const renderLoop = () => {
      if (ctx) {
        // 1. Clear the canvas every frame
        ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      }
      renderFrame(); // This calls engine.render(ctx) which draws terrain, tanks, projectiles
      rafId = requestAnimationFrame(renderLoop);
    };
    renderLoop();

    return () => {
      clearShopAiTimeout();
      // inline to avoid exhaustive-deps on stable clear func
      if (celebrationTimerRef.current !== null) {
        clearTimeout(celebrationTimerRef.current);
        celebrationTimerRef.current = null;
      }
      engine.stop();
      engine.getTurnManager().removeInputListeners();
      if (rafId) cancelAnimationFrame(rafId);
      engineRef.current = null;
      ctxRef.current = null;
    };
  }, []);

  // Sync gamePhaseRef to avoid stale values inside onTurnChange / engine callbacks (registered once in mount effect)
  useEffect(() => {
    gamePhaseRef.current = gamePhase;
  }, [gamePhase]);

  // Global SPACE (or click handled in handleCanvasClick) to skip round celebration fireworks
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (gamePhaseRef.current === 'CELEBRATION' && (e.key === ' ' || e.key === 'Spacebar' || e.key.toLowerCase() === 'space')) {
        e.preventDefault();
        // inline logic (dupe of goToSummary) so effect can use [] without exhaustive-deps warning
        clearCelebrationTimer();
        const eng = engineRef.current;
        if (eng) {
          eng.clearRoundCelebration();
        }
        setGamePhase('SUMMARY');
        gamePhaseRef.current = 'SUMMARY';
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [clearCelebrationTimer]);

  /** Canvas click = Spacebar: fire current human tank's selected weapon. */
  const handleCanvasClick = (): void => {
    const engine = engineRef.current;
    if (!engine) return;
    if (gamePhaseRef.current === 'CELEBRATION') {
      // Skip the fireworks celebration early
      goToSummary();
      return;
    }
    if (gamePhaseRef.current !== 'COMBAT' && gamePhaseRef.current !== 'RESOLUTION') {
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

  const endMatchFromShop = (
    engine: GameEngine,
    survivors: Player[],
  ): void => {
    clearShopAiTimeout();
    shopFinishingRef.current = true;
    engine.getTurnManager().pauseForInterRound();
    setShopPlayers([]);
    shopPlayersRef.current = [];

    if (survivors.length === 1) {
      const matchWinner = engine.getTankManager().getWinner();
      if (matchWinner) {
        engine.declareMatchWinner(matchWinner);
        setWinner(matchWinner);
      }
    } else {
      if (!engine.isGameOver()) {
        engine.declareMatchDraw();
      }
      setWinner(null);
    }

    setShowNewGameButton(false);
    setGamePhase('GAME_OVER');
    gamePhaseRef.current = 'GAME_OVER';
    setTimeout(() => setShowNewGameButton(true), 7000);
    shopFinishingRef.current = false;
  };

  // SUMMARY → SHOP transition (full sequential shop per spec)
  const handleGoToShop = (): void => {
    const engine = engineRef.current;
    if (!engine) return;

    clearShopAiTimeout();
    shopFinishingRef.current = false;
    engine.getTurnManager().pauseForInterRound();

    // Full match roster shops (eliminated tanks respawn next manche after startNextRound)
    const roster = [...engine.getTankManager().getPlayers()];
    if (roster.length < 2) {
      endMatchFromShop(engine, roster);
      return;
    }

    setShopPlayers(roster);
    shopPlayersRef.current = roster;
    setUiPlayers(roster);
    setCurrentShopIndex(0);
    currentShopIndexRef.current = 0;
    setGamePhase('SHOP');
    gamePhaseRef.current = 'SHOP';

    if (!roster[0].isHuman) {
      shopAiTimeoutRef.current = setTimeout(() => {
        shopAiTimeoutRef.current = null;
        processNextShopperIfAI();
      }, 50);
    }
  };

  /**
   * Handler for the big "Jouer la manche suivante" button in SUMMARY.
   * Reuses the existing SHOP flow: this preserves money/inventory (earnings from award already applied),
   * lets players buy, then finishShopPhase calls startNextRound (new terrain via TerrainManager,
   * spawnTanks for survivors only with health reset + random reposition minDist 100px) + COMBAT.
   */
  const handleNextRound = (): void => {
    handleGoToShop();
  };

  /**
   * Handler for the discreet "New Game (Revenir au menu)" button.
   * Fully clears match history (reset engine), resets scores/money (by discarding state),
   * switches parent App to MENU phase (shows welcome/config screen).
   */
  const handleNewGameFromSummary = (): void => {
    const engine = engineRef.current;
    if (engine) {
      engine.resetGame();
    }
    if (onReturnToMenu) {
      onReturnToMenu();
    }
  };

  // (handleStartNextRound removed — finishShopPhase now handles the transition cleanly)

  // === Boutique handlers (mutation on the live Player objects, consistent with previous money awards) ===

  /** Achat / vente d'une arme pour le joueur courant de la boutique */
  /* eslint-disable react-hooks/immutability */
  const handleShopBuySell = (weaponId: WeaponId, delta: 1 | -1): void => {
    if (shopPlayers.length === 0) return;

    // We get the live object from the engine snapshot (same reference the engine mutates)
    const enginePlayers = engineRef.current?.getTankManager().getPlayers() ?? [];
    const idx = currentShopIndexRef.current;
    const currentPlayer = enginePlayers.find((p) => p.id === shopPlayersRef.current[idx]?.id) || shopPlayersRef.current[idx];

    if (!currentPlayer || !currentPlayer.isHuman) return;

    const def = WEAPON_REGISTRY[weaponId];
    if (!def) return;

    const currentStock = currentPlayer.inventory?.[weaponId] ?? 0;

    if (delta > 0) {
      // Achat
      if ((currentPlayer.money ?? 0) >= def.price) {
        currentPlayer.money = (currentPlayer.money ?? 0) - def.price;
        currentPlayer.inventory = {
          ...currentPlayer.inventory,
          [weaponId]: currentStock + 1,
        };
      }
    } else {
      // Vente (remboursement plein)
      if (currentStock > 0) {
        currentPlayer.money = (currentPlayer.money ?? 0) + def.price;
        currentPlayer.inventory = {
          ...currentPlayer.inventory,
          [weaponId]: currentStock - 1,
        };
      }
    }

    // Force React re-render of the shop UI (we mutated the shared engine object)
    setShopPlayers((prev) => [...prev]);
  };

  /** Le joueur humain courant a cliqué "Prêt" */
  /* eslint-disable react-hooks/immutability */
  const handleShopReady = (): void => {
    advanceToNextShopper();
  };

  /** Logique d'achat automatique simple pour les IA (Phase 1 - stupide mais fonctionnel) */
  const autoBuyForAI = (aiPlayer: Player): void => {
    if (!aiPlayer || aiPlayer.isHuman) return;

    // (affordable weapons computed inside the spending loop)

    // Stratégie très simple : l'IA dépense jusqu'à 70% de son argent
    // en achetant d'abord des armes plus chères (NUKE, CLUSTER) puis du basique.
    // MISSILE is unlimited and not in shop, so never auto-bought.
    const preferredOrder: WeaponId[] = ['NUKE', 'CLUSTER', 'DRILLER', 'GRENADE'];

    let spent = 0;
    const budget = Math.floor((aiPlayer.money ?? 0) * 0.7);

    for (const wid of preferredOrder) {
      const def = WEAPON_REGISTRY[wid];
      if (!def) continue;

      let buysThisWeapon = 0;
      const maxBuysPerWeapon = 12;

      while (
        buysThisWeapon < maxBuysPerWeapon &&
        (aiPlayer.money ?? 0) >= def.price &&
        spent + def.price <= budget &&
        (aiPlayer.money ?? 0) > 80 // garde un peu d'argent
      ) {
        const currentStock = aiPlayer.inventory?.[wid] ?? 0;
        aiPlayer.money = (aiPlayer.money ?? 0) - def.price;
        aiPlayer.inventory = { ...aiPlayer.inventory, [wid]: currentStock + 1 };
        spent += def.price;
        buysThisWeapon++;
      }
    }
  };

  /** Avance dans la séquence boutique (appelé par humain "Prêt" ou après traitement IA) */
  const advanceToNextShopper = (): void => {
    const currentLen = shopPlayersRef.current.length;
    const nextIndex = currentShopIndexRef.current + 1;

    if (nextIndex >= currentLen) {
      // Tous les joueurs ont fait leurs achats → fin de la boutique
      finishShopPhase();
    } else {
      setCurrentShopIndex(nextIndex);
      currentShopIndexRef.current = nextIndex;

      // Si le suivant est une IA, on la traite immédiatement (using fresh ref data)
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

  /** Traite le shopper courant s'il s'agit d'une IA (achats auto + avance) */
  const processNextShopperIfAI = (): void => {
    if (shopFinishingRef.current || gamePhaseRef.current !== 'SHOP') return;

    const currentLen = shopPlayersRef.current.length;
    if (currentLen === 0) return;
    const idx = currentShopIndexRef.current;
    const current = shopPlayersRef.current[idx];
    if (!current || current.isHuman) return;

    autoBuyForAI(current);
    advanceToNextShopper();
  };

  /** Termine complètement la phase boutique et lance la nouvelle manche */
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

    setLastRoundOutcome(null);
    setUiPlayers([...engine.getTankManager().getPlayers()]);
    setRoundResult(null);
    setShopPlayers([]);
    shopPlayersRef.current = [];
    setCurrentShopIndex(0);
    currentShopIndexRef.current = 0;

    clearCelebrationTimer();
    setGamePhase('COMBAT');
    gamePhaseRef.current = 'COMBAT';
    shopFinishingRef.current = false;
  };

  // Restart a brand new game
  const handleNewGame = () => {
    const engine = engineRef.current;
    if (!engine) return;

    // Reset engine state
    engine.resetGame();

    // Recreate fresh players
    const newPlayers: Player[] = [
      {
        id: 'player-1',
        name: 'You',
        isHuman: true,
        tank: {
          id: 'tank-1',
          position: { x: 180, y: 320 },
          angle: 45,
          power: 50,
          health: 100,
          maxHealth: 100,
          shield: 40,
          maxShield: 40,
          isDead: false,
          color: '#FF5555',
          currentWeapon: 'MISSILE',
        },
        money: 200,
        inventory: { ...DEFAULT_INVENTORY },
      },
      {
        id: 'player-2',
        name: 'AI Bot',
        isHuman: false,
        tank: {
          id: 'tank-2',
          position: { x: 620, y: 295 },
          angle: 135,
          power: 50,
          health: 100,
          maxHealth: 100,
          shield: 40,
          maxShield: 40,
          isDead: false,
          color: '#55FF55',
          currentWeapon: 'MISSILE',
        },
        money: 200,
        inventory: { ...DEFAULT_INVENTORY },
      },
    ];

    engine.setPlayers(newPlayers);
    engine.setAIEngine(new AISimpleStrategy());

    // Reset local UI state + round tracking refs (for clean new match)
    setWinner(null);
    setShowNewGameButton(false);
    setTurnInfo(null);
    clearCelebrationTimer();
    setGamePhase('COMBAT');
    gamePhaseRef.current = 'COMBAT';
    setRoundResult(null);
    setCurrentManche(1);
    setUiPlayers(newPlayers);
    setShopPlayers([]);
    shopPlayersRef.current = [];
    setCurrentShopIndex(0);
    currentShopIndexRef.current = 0;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      {onReturnToMenu && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', width: CANVAS_WIDTH }}>
          <button
            onClick={onReturnToMenu}
            style={{ fontSize: 11, padding: '3px 9px' }}
            title="Retour à l'écran d'accueil et configuration des joueurs"
          >
            MENU
          </button>
        </div>
      )}

      <div style={{ position: 'relative' }}>
        {(gamePhase === 'COMBAT' || gamePhase === 'RESOLUTION') && (
          <WindBanner windForce={wind} />
        )}

        <canvas
          ref={canvasRef}
          onClick={handleCanvasClick}
          style={{
            border: `3px solid ${VGA_PALETTE.GRAY}`,
            imageRendering: 'pixelated',
            cursor: winner ? 'default' : 'crosshair',
            background: '#000000',
          }}
        />

        {/* Retro VGA HUD overlay (superposed on canvas) — only during active combat */}
        {(gamePhase === 'COMBAT' || gamePhase === 'RESOLUTION') && (
          <GameHUD
            turnInfo={turnInfo}
            onWeaponSelect={handleWeaponSelect}
          />
        )}

        {/* Round Summary overlay (fin de manche) — keeps canvas + fireworks visible underneath */}
        {gamePhase === 'SUMMARY' && (
          <RoundSummary
            round={currentManche}
            players={uiPlayers}
            result={roundResult}
            roundOutcome={lastRoundOutcome}
            onNextRound={handleNextRound}
            onNewGame={handleNewGameFromSummary}
          />
        )}

        {/* Weapon Shop overlay — full sequential boutique (humans one-by-one + AI auto) */}
        {gamePhase === 'SHOP' && shopPlayers.length > 0 && (
          <>
            {shopPlayers[currentShopIndex]?.isHuman ? (
              <WeaponShop
                player={shopPlayers[currentShopIndex]}
                shopIndex={currentShopIndex}
                totalShoppers={shopPlayers.length}
                onBuySell={handleShopBuySell}
                onReady={handleShopReady}
              />
            ) : (
              // Pendant qu'une IA achète automatiquement (très rapide)
              <div className="retro-ai-overlay">
                L'IA <strong style={{ color: shopPlayers[currentShopIndex]?.tank.color }}>
                  {shopPlayers[currentShopIndex]?.name}
                </strong> fait ses achats...
              </div>
            )}
          </>
        )}

        {/* Phase indicator minimal pour SUMMARY seulement (le SHOP a maintenant son propre UI) */}
        {gamePhase === 'SUMMARY' && (
          <div className="retro-badge">
            PHASE: {gamePhase}
          </div>
        )}

        {/* Celebration banner during pre-SUMMARY fireworks (from winning tank) */}
        {gamePhase === 'CELEBRATION' && (
          <div
            style={{
              position: 'absolute',
              top: 12,
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'rgba(0,0,0,0.7)',
              color: VGA_PALETTE.YELLOW,
              font: 'bold 14px monospace',
              padding: '4px 12px',
              border: `2px solid ${VGA_PALETTE.YELLOW}`,
              zIndex: 20,
              pointerEvents: 'none',
              textShadow: '0 0 4px #000',
            }}
          >
            CELEBRATION — Appuyez sur ESPACE (ou cliquez) pour continuer
          </div>
        )}

        {/* === GAME OVER OVERLAY === */}
        {/* For draws (winner === null via onDraw), we rely on SUMMARY showing "Aucun survivant"
            or the delayed New Game button. No big colored text to avoid null access. */}
        {winner && gamePhase === 'GAME_OVER' && (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              textAlign: 'center',
              pointerEvents: 'none',
              zIndex: 10,
            }}
          >
            <div
              style={{
                fontSize: '72px',
                fontWeight: 'bold',
                color: winner.tank.color,
                textShadow: '0 0 20px #000, 0 0 40px #000',
                fontFamily: 'monospace',
                marginBottom: '12px',
              }}
            >
              {winner.name} WINS!
            </div>
            <div style={{ fontSize: '24px', color: '#AAAAAA' }}>
              Game Over
            </div>
          </div>
        )}
      </div>

      {/* New Game Button - appears after delay */}
      {showNewGameButton && (
        <button
          onClick={handleNewGame}
          className="retro-newgame-btn"
        >
          New Game ?
        </button>
      )}

      <div style={{ color: VGA_PALETTE.GRAY, fontSize: 12, textAlign: 'center' }}>
        <strong>Controls:</strong> ← → angle • ↑ ↓ power • SPACE or click to fire • A/E switch weapon<br />
        Each round lasts until a tank is destroyed; shop opens after each round
      </div>
    </div>
  );
}

