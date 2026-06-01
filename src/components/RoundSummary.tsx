/**
 * TankWars - RoundSummary React Component (src/components/RoundSummary.tsx)
 *
 * Retro VGA-style centered overlay shown when GamePhase === 'SUMMARY' (fin de manche).
 * Displays earnings, survivors, and cumulative money (the "score").
 *
 * Updated for manche chaining:
 * - Big primary button "Jouer la manche suivante" → preserves players/scores/money/inventory, new terrain, reset health, reposition.
 * - Small discreet "New Game (Revenir au menu)" → full reset + MENU phase.
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
  /** Gros bouton principal : enchaîne la manche en conservant scores/argent/inventaire (passe par SHOP) */
  onNextRound: () => void;
  /** Bouton discret : reset complet + retour MENU (nouvelle partie) */
  onNewGame: () => void;
}

export function RoundSummary({ round, players, result, onNextRound, onNewGame }: RoundSummaryProps) {
  const alivePlayers = players.filter((p) => !p.tank.isDead);
  const sorted = [...alivePlayers].sort((a, b) => (b.money ?? 0) - (a.money ?? 0));

  return (
    <div
      className="retro-modal"
      style={{
        border: `4px solid ${VGA_PALETTE.CYAN}`,
        minWidth: 420,
        maxWidth: '88%',
        padding: '14px 18px 18px',
        backgroundColor: 'rgba(0, 0, 0, 0.92)',
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
      <div style={{ fontSize: '12px', color: VGA_PALETTE.GRAY, marginBottom: 12 }}>
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
              <span style={{ color: VGA_PALETTE.CYAN, fontSize: 12 }}>
                (base 500 + 300/kill)
              </span>
            </div>
          );
        })}
      </div>

      {/* Summary stats */}
      <div
        style={{
          fontSize: '12px',
          color: VGA_PALETTE.GRAY,
          marginBottom: 14,
          lineHeight: 1.3,
        }}
      >
        Dégâts infligés cette manche :{' '}
        {result ? Object.values(result.damageDealt).reduce((a, b) => a + b, 0) : 0} pts<br />
        Terrain détruit : ~{result?.terrainDestroyed ?? 0} unités
      </div>

      {/* Gros bouton principal pour enchaîner les manches (conserve progression: scores, argent, inventaire) */}
      <button
        onClick={onNextRound}
        className="retro-btn"
        style={{
          fontSize: '15px',
          padding: '11px 28px',
          minWidth: 260,
        }}
      >
        Jouer la manche suivante
      </button>

      {/* Bouton discret et petit : New Game complet (reset + retour menu) */}
      <button
        onClick={onNewGame}
        style={{
          marginTop: 10,
          fontSize: '10px',
          padding: '3px 10px',
          backgroundColor: 'transparent',
          border: `1px solid ${VGA_PALETTE.DARK_GRAY}`,
          color: VGA_PALETTE.GRAY,
          cursor: 'pointer',
          letterSpacing: 0.5,
        }}
      >
        New Game (Revenir au menu)
      </button>

      <div style={{ fontSize: '12px', color: VGA_PALETTE.DARK_GRAY, marginTop: 8 }}>
        Les gains ont été ajoutés à votre argent total
      </div>
    </div>
  );
}
