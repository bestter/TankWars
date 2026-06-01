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

import { useEffect, useRef, useState } from 'react';
import { GameEngine } from '../game/engine/GameEngine';
import type { CurrentTurnInfo } from '../game/engine/TurnManager';
import { VGA_PALETTE, type FireCommand } from '../types/game';
import { AISimpleStrategy } from '../game/entities/ai/AISimpleStrategy';
import type { Player } from '../types/player';
import { GameHUD } from './GameHUD';
import { RoundSummary } from './RoundSummary';
import { WeaponShop } from './WeaponShop';
import type { WeaponId } from '../types/weapon';
import { WEAPON_REGISTRY } from '../types/weapon';
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

  const [wind, setWind] = useState(12);
  const [turnInfo, setTurnInfo] = useState<CurrentTurnInfo | null>(null);
  const [winner, setWinner] = useState<Player | null>(null);
  const [showNewGameButton, setShowNewGameButton] = useState(false);

  // React-owned high-level phase + round summary (per architecture: React owns phase/money/turns)
  const [gamePhase, setGamePhase] = useState<GamePhase>('COMBAT');
  const [roundResult, setRoundResult] = useState<RoundResult | null>(null);

  // Logical manche number for SUMMARY title "FIN DE MANCHE N" (persistent across chained rounds)
  const [currentManche, setCurrentManche] = useState(1);

  // Ref to avoid stale closure in engine callbacks registered in mount effect (gamePhase updates)
  const gamePhaseRef = useRef<GamePhase>('COMBAT');

  // Ref for round tracking (read inside onTurnChange callback which is registered once at mount;
  // engine's internal round resets on each startNextRound, we use this to detect wraps within session)
  const lastSeenEngineRoundRef = useRef(0);

  // === SHOP (boutique) state - sequential per living player ===
  const [shopPlayers, setShopPlayers] = useState<Player[]>([]);
  const [currentShopIndex, setCurrentShopIndex] = useState(0);

  // Refs to avoid stale closures in the setTimeout-based AI shopping chain (process/advance).
  // The shopping sequence uses async setTimeout recursion; direct state reads in those callbacks
  // would see values from the render when the first timeout was scheduled.
  const shopPlayersRef = useRef<Player[]>([]);
  const currentShopIndexRef = useRef(0);

  // Snapshot of players for safe UI rendering (avoids reading refs during render)
  const [uiPlayers, setUiPlayers] = useState<Player[]>([]);

  // Snapshot des joueurs initiaux au montage (évite de mettre initialPlayers dans les deps du useEffect one-shot)
  const initialPlayersRef = useRef(initialPlayers);

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
        inventory: { MISSILE: 5, GRENADE: 2 },
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
        inventory: { MISSILE: 5, GRENADE: 2 },
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

    engine.setWindForce(wind);

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

    // Game Over handling (takes precedence over SUMMARY)
    engine.onGameOver = (winningPlayer) => {
      setWinner(winningPlayer);
      setShowNewGameButton(false);
      setGamePhase('GAME_OVER');
      gamePhaseRef.current = 'GAME_OVER';

      // Show "New game ?" button after 7 seconds
      setTimeout(() => {
        setShowNewGameButton(true);
      }, 7000);
    };

    // Draw (partie nulle) - 0 survivors
    engine.onDraw = () => {
      setWinner(null);
      setShowNewGameButton(false);
      setGamePhase('GAME_OVER');
      gamePhaseRef.current = 'GAME_OVER';

      setTimeout(() => {
        setShowNewGameButton(true);
      }, 7000);
    };

    // === Round progression + end-of-manche chaining ===
    // TurnManager increments currentRound on wrap (full player cycle = end of a "manche").
    // We trigger the inter-round SUMMARY (for chaining) only when >=2 players are still alive.
    // If the round wraps with 0 or 1 survivor, we treat it as match end (draw or win)
    // instead of starting a pointless new "manche".
    const tm = engine.getTurnManager();
    tm.onTurnChange = (_player, round) => {
      // Always keep turnInfo fresh
      // (the engine already calls notifyHudUpdate which sets via onTurnHudUpdate)

      if (round > lastSeenEngineRoundRef.current) {
        lastSeenEngineRoundRef.current = round;

        // Trigger SUMMARY (fin de manche) after each full cycle to support "Jouer la manche suivante".
        // Uses ref to avoid stale gamePhase from mount-time closure.
        // (We intentionally ignore alive count here: chaining works for survivors even if >1 alive;
        // when <=1 the GAME_OVER path from engine will take precedence.)
        if (round >= 2 && gamePhaseRef.current !== 'GAME_OVER') {
          const aliveCount = engine.getTankManager().getAlivePlayers().length;

          if (aliveCount >= 2) {
            // Normal inter-round chaining: award earnings, show SUMMARY so players can shop
            // and continue the match on new terrain with preserved money/inventory.
            const res = engine.awardEndOfRoundEarnings();
            setRoundResult(res);

            engine.triggerRoundCelebration();

            tm.pauseForInterRound();
            setGamePhase('SUMMARY');
            gamePhaseRef.current = 'SUMMARY';
          } else {
            // The round wrapped but the match is already over (0 or 1 survivor).
            // This can happen if everyone died on the last shot of the cycle.
            // Award what we can, show final SUMMARY (UI will say "Aucun survivant" if 0).
            // Do not start a new chaining cycle.
            const res = engine.awardEndOfRoundEarnings();
            setRoundResult(res);
            tm.pauseForInterRound();
            setGamePhase('SUMMARY');
            gamePhaseRef.current = 'SUMMARY';
          }
        }
        // else: round==1 after startNextRound (new session) → stay in COMBAT
      }
    };

    engineRef.current = engine;

    // Initialize tracking refs (first onTurnChange for round=1 happens inside setPlayers before listener assign,
    // but subsequent wraps and post-startNextRound calls will use these)
    lastSeenEngineRoundRef.current = 1;
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
      engine.stop();
      engine.getTurnManager().removeInputListeners();
      if (rafId) cancelAnimationFrame(rafId);
      engineRef.current = null;
      ctxRef.current = null;
    };
  }, []);

  // Keep wind in sync with engine (wind can also be changed by game rules later)
  useEffect(() => {
    const engine = engineRef.current;
    engine?.setWindForce(wind);
  }, [wind]);

  // Sync gamePhaseRef to avoid stale values inside onTurnChange / engine callbacks (registered once in mount effect)
  useEffect(() => {
    gamePhaseRef.current = gamePhase;
  }, [gamePhase]);

  // === INPUT: Click to fire test shot ===
  const handleCanvasClick = (/* event: React.MouseEvent<HTMLCanvasElement> */): void => {
    const engine = engineRef.current;
    const canvas = canvasRef.current;
    if (!engine || !canvas) return;

    void canvas.getBoundingClientRect(); // placeholder until real tank positioning is wired

    // Fire from left side for demo (you can later hook this to real tank position + UI)
    const from = { x: 120, y: 260 };

    const command: FireCommand = {
      angle: -25 + (Math.random() - 0.5) * 30,
      power: 55 + Math.random() * 25,
      weaponId: 'MISSILE',
    };

    engine.fireProjectile(from, command, 'player-demo'); // demo owner for attribution
  };

  // Helper to fire a specific weapon (for future UI)
  const fireWeapon = (weaponId: WeaponId) => {
    const engine = engineRef.current;
    if (!engine) return;

    const from = { x: 120 + Math.random() * 40, y: 255 };
    const command: FireCommand = {
      angle: -45 + Math.random() * 25,
      power: 60 + Math.random() * 20,
      weaponId,
    };
    engine.fireProjectile(from, command, 'player-demo');
  };

  // Weapon selection from HUD (clicks). Delegates to TurnManager (decoupled)
  const handleWeaponSelect = (weaponId: WeaponId): void => {
    const engine = engineRef.current;
    if (!engine) return;
    const tm = engine.getTurnManager();
    tm.selectWeapon(weaponId);
  };

  // SUMMARY → SHOP transition (full sequential shop per spec)
  const handleGoToShop = (): void => {
    const engine = engineRef.current;
    if (!engine) return;

    engine.getTurnManager().pauseForInterRound();

    // Snapshot only living players for the shop phase (order preserved)
    const living = engine.getTankManager().getAlivePlayers();
    setShopPlayers(living);
    shopPlayersRef.current = living;
    setUiPlayers(living);
    setCurrentShopIndex(0);
    currentShopIndexRef.current = 0;
    setGamePhase('SHOP');
    gamePhaseRef.current = 'SHOP';

    // Guard: if no one left to shop (pure draw), don't enter broken shop state
    if (living.length === 0) {
      setGamePhase('GAME_OVER');
      gamePhaseRef.current = 'GAME_OVER';
      setTimeout(() => setShowNewGameButton(true), 1000);
      return;
    }

    // If the very first player in shop is an AI, process it immediately
    if (!living[0].isHuman) {
      // Small delay so the UI has time to render the SHOP phase if needed
      setTimeout(() => processNextShopperIfAI(), 50);
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
    // en achetant d'abord des armes plus chères (NUKE, CLUSTER) puis du basique
    const preferredOrder: WeaponId[] = ['NUKE', 'CLUSTER', 'DRILLER', 'GRENADE', 'MISSILE'];

    let spent = 0;
    const budget = Math.floor((aiPlayer.money ?? 0) * 0.7);

    for (const wid of preferredOrder) {
      const def = WEAPON_REGISTRY[wid];
      if (!def) continue;

      while (
        (aiPlayer.money ?? 0) >= def.price &&
        spent + def.price <= budget &&
        (aiPlayer.money ?? 0) > 80 // garde un peu d'argent
      ) {
        const currentStock = aiPlayer.inventory?.[wid] ?? 0;
        aiPlayer.money = (aiPlayer.money ?? 0) - def.price;
        aiPlayer.inventory = { ...aiPlayer.inventory, [wid]: currentStock + 1 };
        spent += def.price;
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
        setTimeout(() => processNextShopperIfAI(), 80);
      }
    }
  };

  /** Traite le shopper courant s'il s'agit d'une IA (achats auto + avance) */
  const processNextShopperIfAI = (): void => {
    const currentLen = shopPlayersRef.current.length;
    if (currentLen === 0) return;
    const idx = currentShopIndexRef.current;
    const current = shopPlayersRef.current[idx];
    if (!current || current.isHuman) return;

    // IA achète automatiquement
    autoBuyForAI(current);

    // Passe au suivant
    advanceToNextShopper();
  };

  /** Termine complètement la phase boutique et lance la nouvelle manche */
  const finishShopPhase = (): void => {
    const engine = engineRef.current;
    if (!engine) return;

    // Réinitialise terrain + tanks (ancrage) + tours → COMBAT
    engine.startNextRound();

    // Refresh UI snapshot with the newly positioned living players
    const freshLiving = engine.getTankManager().getAlivePlayers();
    setUiPlayers(freshLiving);

    setRoundResult(null);
    setShopPlayers([]);
    shopPlayersRef.current = [];
    setCurrentShopIndex(0);
    currentShopIndexRef.current = 0;

    // Reset engine-round tracking ref for the new combat session (so round=1 after reset does not re-trigger SUMMARY)
    lastSeenEngineRoundRef.current = 0;

    // Advance logical manche for next SUMMARY title ("FIN DE MANCHE N")
    setCurrentManche((prev) => prev + 1);

    setGamePhase('COMBAT');
    gamePhaseRef.current = 'COMBAT';
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
        inventory: { MISSILE: 5, GRENADE: 2 },
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
        inventory: { MISSILE: 5, GRENADE: 2 },
      },
    ];

    engine.setPlayers(newPlayers);
    engine.setAIEngine(new AISimpleStrategy());

    // Reset local UI state + round tracking refs (for clean new match)
    setWinner(null);
    setShowNewGameButton(false);
    setTurnInfo(null);
    setGamePhase('COMBAT');
    gamePhaseRef.current = 'COMBAT';
    setRoundResult(null);
    lastSeenEngineRoundRef.current = 0;
    setCurrentManche(1);
    setUiPlayers(newPlayers);
    setShopPlayers([]);
    shopPlayersRef.current = [];
    setCurrentShopIndex(0);
    currentShopIndexRef.current = 0;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <label style={{ color: VGA_PALETTE.GRAY, fontSize: 13 }}>
          Wind: <strong style={{ color: VGA_PALETTE.CYAN }}>{wind}</strong>
        </label>
        <input
          type="range"
          min={-60}
          max={60}
          step={2}
          value={wind}
          onChange={(e) => setWind(Number(e.target.value))}
          style={{ width: 180 }}
        />

        <button onClick={() => fireWeapon('MISSILE')} style={{ fontSize: 12 }}>
          Fire Missile
        </button>
        <button onClick={() => fireWeapon('GRENADE')} style={{ fontSize: 12 }}>
          Fire Grenade
        </button>
        <button onClick={() => fireWeapon('NUKE')} style={{ fontSize: 12 }}>
          Fire Nuke
        </button>

        {/* Retour menu principal (démontage canvas/engine pour économiser ressources) */}
        {onReturnToMenu && (
          <button
            onClick={onReturnToMenu}
            style={{ fontSize: 11, padding: '3px 9px', marginLeft: 4 }}
            title="Retour à l'écran d'accueil et configuration des joueurs"
          >
            MENU
          </button>
        )}
      </div>

      <div style={{ position: 'relative' }}>
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
            wind={wind}
            onWeaponSelect={handleWeaponSelect}
          />
        )}

        {/* Round Summary overlay (fin de manche) — keeps canvas + fireworks visible underneath */}
        {gamePhase === 'SUMMARY' && (
          <RoundSummary
            round={currentManche}
            players={uiPlayers}
            result={roundResult}
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

        {/* === GAME OVER OVERLAY === */}
        {/* For draws (winner === null via onDraw), we rely on SUMMARY showing "Aucun survivant"
            or the delayed New Game button. No big colored text to avoid null access. */}
        {winner && (
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
        <strong>Controls:</strong> ← → Adjust angle • ↑ ↓ Adjust power • SPACE to fire • A/E switch weapon<br />
        Multiple combat rounds until only one (or zero) survivor remains
      </div>
    </div>
  );
}

