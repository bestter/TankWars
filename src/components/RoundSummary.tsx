/**
 * TankWars - RoundSummary React Component (src/components/RoundSummary.tsx)
 *
 * Retro VGA-style centered overlay shown when GamePhase === 'SUMMARY' (fin de manche).
 * Displays earnings, survivors, and cumulative money (the "score").
 *
 * - Thick VGA borders, monospace, high-contrast palette (Cyan/Magenta/Green/Yellow).
 * - Reuses the live canvas + fireworks underneath (per spec: do not clear animation/music).
 * - Purely presentational; all logic (awards, phase) lives in GameEngine + GameCanvas (decoupled).
 */

import type { Player } from '../types/player';
import type { RoundResult } from '../types/game';
import { VGA_PALETTE } from '../types/game';

export interface RoundSummaryProps {
  round: number;
  /** Live players from engine (money has already been mutated by awardEndOfRoundEarnings) */
  players: ReadonlyArray<Player>;
  result: RoundResult | null;
  onGoToShop: () => void;
}

export function RoundSummary({ round, players, result, onGoToShop }: RoundSummaryProps) {
  const alivePlayers = players.filter((p) => !p.tank.isDead);
  const sorted = [...alivePlayers].sort((a, b) => (b.money ?? 0) - (a.money ?? 0));

  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 25,
        pointerEvents: 'auto',
        backgroundColor: 'rgba(0, 0, 0, 0.92)',
        border: `4px solid ${VGA_PALETTE.CYAN}`,
        boxShadow: '0 0 0 2px #000, 0 0 0 6px #222',
        fontFamily: 'monospace',
        color: VGA_PALETTE.WHITE,
        minWidth: 420,
        maxWidth: '88%',
        padding: '14px 18px 18px',
        textAlign: 'center',
      }}
    >
      {/* Header */}
      <div
        style={{
          fontSize: '18px',
          fontWeight: 'bold',
          color: VGA_PALETTE.MAGENTA,
          marginBottom: 6,
          letterSpacing: 1,
        }}
      >
        FIN DE MANCHE {round}
      </div>
      <div style={{ fontSize: '11px', color: VGA_PALETTE.GRAY, marginBottom: 12 }}>
        Résultats &amp; gains • Survivants : {alivePlayers.length} / {players.length}
      </div>

      {/* Players list with earnings */}
      <div style={{ marginBottom: 14, textAlign: 'left' }}>
        {sorted.length === 0 && (
          <div style={{ color: VGA_PALETTE.GRAY, textAlign: 'center' }}>Aucun survivant</div>
        )}

        {sorted.map((p) => {
          const currentMoney = p.money ?? 0;
          // Simple visual: we don't have per-player pre-money here, but the award already happened in engine
          return (
            <div
              key={p.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 8px',
                marginBottom: 4,
                backgroundColor: '#111',
                border: `1px solid ${VGA_PALETTE.DARK_GRAY}`,
              }}
            >
              <span
                style={{
                  display: 'inline-block',
                  width: 12,
                  height: 12,
                  backgroundColor: p.tank.color,
                  border: `1px solid ${VGA_PALETTE.WHITE}`,
                  flexShrink: 0,
                }}
              />
              <span style={{ color: p.tank.color, fontWeight: 'bold', minWidth: 70 }}>
                {p.name}
              </span>
              <span style={{ color: VGA_PALETTE.GREEN, marginLeft: 'auto' }}>
                {currentMoney}$
              </span>
              <span style={{ color: VGA_PALETTE.CYAN, fontSize: 10 }}>
                (base 500 + 300/kill)
              </span>
            </div>
          );
        })}
      </div>

      {/* Summary stats */}
      <div
        style={{
          fontSize: '10px',
          color: VGA_PALETTE.GRAY,
          marginBottom: 14,
          lineHeight: 1.3,
        }}
      >
        Dégâts infligés cette manche :{' '}
        {result ? Object.values(result.damageDealt).reduce((a, b) => a + b, 0) : 0} pts<br />
        Terrain détruit : ~{result?.terrainDestroyed ?? 0} unités
      </div>

      {/* Big action button (VGA retro style, identical language to New Game button) */}
      <button
        onClick={onGoToShop}
        style={{
          padding: '10px 28px',
          fontSize: '15px',
          backgroundColor: '#222',
          color: VGA_PALETTE.WHITE,
          border: `3px solid ${VGA_PALETTE.CYAN}`,
          cursor: 'pointer',
          fontFamily: 'monospace',
          fontWeight: 'bold',
          letterSpacing: 0.5,
        }}
      >
        Aller à la Boutique →
      </button>

      <div style={{ fontSize: '9px', color: VGA_PALETTE.DARK_GRAY, marginTop: 8 }}>
        Les gains ont été ajoutés à votre argent total
      </div>
    </div>
  );
}
