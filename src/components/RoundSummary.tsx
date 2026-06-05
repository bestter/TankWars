/**
 * TankWars - RoundSummary React Component (src/components/RoundSummary.tsx)
 *
 * Retro VGA-style centered overlay shown when GamePhase === 'SUMMARY' (fin de manche).
 * Displays earnings, round outcome, and cumulative money.
 *
 * After every round: SUMMARY → SHOP → new manche (new terrain, all tanks respawn).
 * A round ends only when last man standing (0 or 1 alive). Whole-match Game Over is only via "New Game (Revenir au menu)".
 */

import type { Player } from "../types/player";
import type { RoundResult } from "../types/game";
import { VGA_PALETTE } from "../types/game";

export interface RoundEndOutcome {
  isDraw: boolean;
  winner: Player | null;
}

export interface RoundSummaryProps {
  round: number;
  /** Full match roster (money already updated by awardEndOfRoundEarnings) */
  players: ReadonlyArray<Player>;
  result: RoundResult | null;
  roundOutcome: RoundEndOutcome | null;
  onNextRound: () => void;
  onNewGame: () => void;
}

export function RoundSummary({
  round,
  players,
  result,
  roundOutcome,
  onNextRound,
  onNewGame,
}: RoundSummaryProps) {
  const alivePlayers = players.filter((p) => !p.tank.isDead);
  const sorted = [...players].sort((a, b) => (b.money ?? 0) - (a.money ?? 0));
  const canContinue = players.length >= 2;

  let outcomeLine = "Manche terminée";
  if (roundOutcome?.isDraw) {
    outcomeLine = "Manche nulle — tous les tanks détruits";
  } else if (roundOutcome?.winner) {
    outcomeLine = `Vainqueur de la manche : ${roundOutcome.winner.name}`;
  }

  return (
    <div
      className="retro-modal"
      style={{
        border: `4px solid ${VGA_PALETTE.CYAN}`,
        minWidth: 420,
        maxWidth: "88%",
        padding: "14px 18px 18px",
        backgroundColor: "rgba(0, 0, 0, 0.92)",
      }}
    >
      <div
        style={{
          fontSize: "18px",
          fontWeight: "bold",
          color: VGA_PALETTE.MAGENTA,
          marginBottom: 6,
          letterSpacing: 1,
        }}
      >
        FIN DE MANCHE {round}
      </div>
      <div
        style={{
          fontSize: "13px",
          color: roundOutcome?.winner
            ? roundOutcome.winner.tank.color
            : VGA_PALETTE.YELLOW,
          marginBottom: 8,
        }}
      >
        {outcomeLine}
      </div>
      <div
        style={{ fontSize: "12px", color: VGA_PALETTE.GRAY, marginBottom: 12 }}
      >
        Survivants cette manche : {alivePlayers.length} / {players.length} •
        Boutique ensuite
      </div>

      <div style={{ marginBottom: 14, textAlign: "left" }}>
        {sorted.map((p) => {
          const currentMoney = p.money ?? 0;
          const eliminated = p.tank.isDead;
          return (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 8px",
                marginBottom: 4,
                backgroundColor: "#111",
                border: `1px solid ${VGA_PALETTE.DARK_GRAY}`,
                opacity: eliminated ? 0.55 : 1,
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 12,
                  height: 12,
                  backgroundColor: p.tank.color,
                  border: `1px solid ${VGA_PALETTE.WHITE}`,
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  color: p.tank.color,
                  fontWeight: "bold",
                  minWidth: 70,
                }}
              >
                {p.name}
                {eliminated ? " (KO)" : ""}
              </span>
              <span style={{ color: VGA_PALETTE.GREEN, marginLeft: "auto" }}>
                {currentMoney}$
              </span>
              <span style={{ color: VGA_PALETTE.CYAN, fontSize: 12 }}>
                (base 500 + 300/kill si vivant)
              </span>
            </div>
          );
        })}
      </div>

      <div
        style={{
          fontSize: "12px",
          color: VGA_PALETTE.GRAY,
          marginBottom: 14,
          lineHeight: 1.3,
        }}
      >
        Dégâts infligés cette manche :{" "}
        {result
          ? Object.values(result.damageDealt).reduce((a, b) => a + b, 0)
          : 0}{" "}
        pts
        <br />
        Terrain détruit : ~{result?.terrainDestroyed ?? 0} unités
      </div>

      <button
        onClick={onNextRound}
        disabled={!canContinue}
        className="retro-btn"
        style={{
          fontSize: "15px",
          padding: "11px 28px",
          minWidth: 260,
          opacity: canContinue ? 1 : 0.45,
          cursor: canContinue ? "pointer" : "not-allowed",
        }}
      >
        Aller à la boutique → manche suivante
      </button>

      <button
        onClick={onNewGame}
        style={{
          marginTop: 10,
          fontSize: "10px",
          padding: "3px 10px",
          backgroundColor: "transparent",
          border: `1px solid ${VGA_PALETTE.DARK_GRAY}`,
          color: VGA_PALETTE.GRAY,
          cursor: "pointer",
          letterSpacing: 0.5,
        }}
      >
        New Game (Revenir au menu)
      </button>

      <div
        style={{ fontSize: "12px", color: VGA_PALETTE.DARK_GRAY, marginTop: 8 }}
      >
        Prochaine manche : nouveau terrain et nouvelles positions
      </div>
    </div>
  );
}
