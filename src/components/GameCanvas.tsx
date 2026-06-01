/**
 * TankWars - GameCanvas React Component (src/components/GameCanvas.tsx)
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

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 480;

export function GameCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  const [wind, setWind] = useState(12);
  const [turnInfo, setTurnInfo] = useState<CurrentTurnInfo | null>(null);
  const [winner, setWinner] = useState<import('../types/player').Player | null>(null);
  const [showNewGameButton, setShowNewGameButton] = useState(false);

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

    // === Create real players (1 Human + 1 AI) ===
    const players: Player[] = [
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

    // Initialize players (this also calls setupInputListeners + starts first turn)
    engine.setPlayers(players);

    // Inject the simple AI strategy
    engine.setAIEngine(new AISimpleStrategy());

    engine.setWindForce(wind);

    // Wire callbacks
    engine.onProjectileHit = (hit) => {
      console.log('[GameEngine] Hit:', hit.weaponId, 'at', hit.x.toFixed(1), hit.y.toFixed(1));
    };

    engine.onAllProjectilesSettled = () => {
      console.log('[GameEngine] All projectiles settled');
    };

    // Listen to turn/HUD updates for real-time display
    engine.onTurnHudUpdate = (info: CurrentTurnInfo) => {
      setTurnInfo(info);
    };

    // Game Over handling
    engine.onGameOver = (winningPlayer) => {
      setWinner(winningPlayer);
      setShowNewGameButton(false);

      // Show "New game ?" button after 7 seconds
      setTimeout(() => {
        setShowNewGameButton(true);
      }, 7000);
    };

    engineRef.current = engine;

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

    engine.fireProjectile(from, command, 'player-demo');
  };

  // Helper to fire a specific weapon (for future UI)
  const fireWeapon = (weaponId: import('../types/weapon').WeaponId) => {
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

    // Reset local UI state
    setWinner(null);
    setShowNewGameButton(false);
    setTurnInfo(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      {/* === HUD : Angle et Puissance (comme dans les jeux originaux) === */}
      <div style={{
        backgroundColor: '#111111',
        border: `2px solid ${VGA_PALETTE.GRAY}`,
        padding: '6px 20px',
        fontFamily: 'monospace',
        color: VGA_PALETTE.WHITE,
        minWidth: '420px',
        textAlign: 'center',
        fontSize: '14px',
        marginBottom: '4px'
      }}>
        {turnInfo ? (
          <>
            <strong style={{ color: turnInfo.isHuman ? '#FF5555' : '#55FF55' }}>
              {turnInfo.playerName}
            </strong>
            {'  |  '}
            Angle: <strong style={{ color: VGA_PALETTE.CYAN }}>{turnInfo.angle}°</strong>
            {'  |  '}
            Power: <strong style={{ color: VGA_PALETTE.YELLOW }}>{turnInfo.power}</strong>
            {turnInfo.isInputLocked && (
              <span style={{ color: VGA_PALETTE.RED, marginLeft: 12 }}>[RESOLUTION...]</span>
            )}
          </>
        ) : (
          <span>Waiting for game start...</span>
        )}
      </div>

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

        {/* === GAME OVER OVERLAY === */}
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
          style={{
            marginTop: '16px',
            padding: '12px 32px',
            fontSize: '20px',
            backgroundColor: '#222',
            color: VGA_PALETTE.WHITE,
            border: `3px solid ${VGA_PALETTE.CYAN}`,
            cursor: 'pointer',
            fontFamily: 'monospace',
          }}
        >
          New Game ?
        </button>
      )}

      <div style={{ color: VGA_PALETTE.GRAY, fontSize: 12, textAlign: 'center' }}>
        <strong>Controls:</strong> ← → Adjust angle • ↑ ↓ Adjust power • SPACE to fire<br />
        The AI will play automatically after your turn (with thinking delay)
      </div>
    </div>
  );
}

