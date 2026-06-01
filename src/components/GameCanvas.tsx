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
import { VGA_PALETTE, type FireCommand } from '../types/game';

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 480;

export function GameCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  const [wind, setWind] = useState(12); // demo wind value

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

    // === GAME ENGINE (the heart of the high-frequency loop) ===
    const engine = new GameEngine(CANVAS_WIDTH, CANVAS_HEIGHT, {
      gravity: 260,
      baseShotSpeed: 420,
    });

    // Seed some demo tanks for collision testing
    engine.setTanks([
      { id: 'tank-1', position: { x: 180, y: 320 }, radius: 14 },
      { id: 'tank-2', position: { x: 620, y: 295 }, radius: 14 },
    ]);

    engine.setWindForce(wind);

    // Wire callbacks (React can react to game events without owning physics)
    engine.onProjectileHit = (hit) => {
      console.log('[GameEngine] Hit:', hit.weaponId, 'at', hit.x.toFixed(1), hit.y.toFixed(1));
    };

    engine.onAllProjectilesSettled = () => {
      console.log('[GameEngine] All projectiles settled');
    };

    engineRef.current = engine;

    // Start the internal requestAnimationFrame loop
    engine.start();

    // Initial draw
    renderFrame();

    return () => {
      engine.stop();
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
      </div>

      <canvas
        ref={canvasRef}
        onClick={handleCanvasClick}
        style={{
          border: `3px solid ${VGA_PALETTE.GRAY}`,
          imageRendering: 'pixelated',
          cursor: 'crosshair',
          background: '#000000',
        }}
      />

      <div style={{ color: VGA_PALETTE.GRAY, fontSize: 12, textAlign: 'center' }}>
        Click canvas to fire a random-angle test shot from left • Use buttons for different weapons<br />
        Projectiles respect gravity + wind and create real craters on impact
      </div>
    </div>
  );
}

