import { useEffect, useId, useRef, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Player } from "../types/player";
import type { RoundResult } from "../types/game";
import { VGA_PALETTE } from "../types/game";
import { getAccessibleTankTextColor } from "./accessibleColor";
import { useModalDialog } from "./modalDialog";

export interface RoundEndOutcome {
  isDraw: boolean;
  winner: Player | null;
}

export interface RoundSummaryProps {
  round: number;
  /** Full match roster; total money remains visible in the shop. */
  players: ReadonlyArray<Player>;
  result: RoundResult | null;
  roundOutcome: RoundEndOutcome | null;
  onNextRound: () => void;
  onNewGame: () => void;
  freeWeapons?: boolean;
}

export function RoundSummary({
  round,
  players,
  result,
  roundOutcome,
  onNextRound,
  onNewGame,
  freeWeapons = false,
}: RoundSummaryProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const { dialogRef, handleClose } = useModalDialog();
  const nextRoundBtnRef = useRef<HTMLButtonElement | null>(null);
  const newGameBtnRef = useRef<HTMLButtonElement | null>(null);
  const alivePlayers = players.filter((p) => !p.tank.isDead);
  const sorted = players
    .map((player, index) => ({ player, index }))
    .toSorted((left, right) => {
      const earningsDifference =
        (result?.earningsByPlayer[right.player.id] ?? 0) -
        (result?.earningsByPlayer[left.player.id] ?? 0);
      return earningsDifference || left.index - right.index;
    });
  const canContinue = players.length >= 2;

  useEffect(() => {
    if (canContinue) {
      nextRoundBtnRef.current?.focus();
    } else {
      newGameBtnRef.current?.focus();
    }
  }, [canContinue]);

  const handleCancel = (event: SyntheticEvent<HTMLDialogElement, Event>) => {
    event.preventDefault();
    if (canContinue) {
      onNextRound();
    }
  };

  let outcomeLine = t("outcome_round_ended");
  if (roundOutcome?.isDraw) {
    outcomeLine = t("outcome_draw");
  } else if (roundOutcome?.winner) {
    outcomeLine = t("outcome_winner", { name: roundOutcome.winner.name });
  }

  return (
    <dialog
      ref={dialogRef}
      className="retro-modal retro-modal-summary"
      aria-labelledby={titleId}
      onCancel={handleCancel}
      onClose={handleClose}
      style={{
        border: `4px solid ${VGA_PALETTE.CYAN}`,
      }}
    >
      <h2
        id={titleId}
        style={{
          margin: "0 0 6px",
          fontSize: "18px",
          fontWeight: "bold",
          color: VGA_PALETTE.MAGENTA,
          letterSpacing: 1,
        }}
      >
        {t("round_summary_title", { round })}
      </h2>
      <div
        style={{
          fontSize: "13px",
          color: roundOutcome?.winner
            ? getAccessibleTankTextColor(roundOutcome.winner.tank.color)
            : VGA_PALETTE.YELLOW,
          marginBottom: 8,
        }}
      >
        {outcomeLine}
      </div>
      <div
        style={{ fontSize: "12px", color: VGA_PALETTE.GRAY, marginBottom: 12 }}
      >
        {freeWeapons
          ? t("round_survivors_free_weapons", { alive: alivePlayers.length, total: players.length })
          : t("round_survivors", { alive: alivePlayers.length, total: players.length })}
      </div>

      <ul className="round-summary-list" role="list">
        {sorted.map(({ player: p }) => {
          const roundEarnings = result?.earningsByPlayer[p.id] ?? 0;
          const eliminated = p.tank.isDead;
          return (
            <li key={p.id} className="round-summary-row">
              <span
                aria-hidden="true"
                style={{
                  display: "inline-block",
                  width: 12,
                  height: 12,
                  backgroundColor: p.tank.color,
                  border: `1px solid ${VGA_PALETTE.WHITE}`,
                  flexShrink: 0,
                  opacity: eliminated ? 0.55 : undefined,
                }}
              />
              <span
                className="round-summary-name"
                style={{
                  color: getAccessibleTankTextColor(p.tank.color),
                  fontWeight: "bold",
                }}
              >
                {p.name}
                {eliminated ? t("ko_indicator") : ""}
              </span>
              <span
                style={{
                  color: VGA_PALETTE.GREEN,
                  marginLeft: "auto",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <span>+{roundEarnings}$</span>
                {freeWeapons && (
                  <span style={{ color: VGA_PALETTE.YELLOW, fontSize: 11 }}>
                    {t("round_summary_balance", { amount: p.money })}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      <div
        style={{
          fontSize: "12px",
          color: VGA_PALETTE.GRAY,
          marginBottom: 14,
          lineHeight: 1.3,
        }}
      >
        {t("damage_inflicted", {
          damage: result
            ? Object.values(result.damageDealt).reduce((a, b) => a + b, 0)
            : 0,
        })}
        <br />
        {t("terrain_destroyed", { destroyed: result?.terrainDestroyed ?? 0 })}
      </div>

      <button
        ref={nextRoundBtnRef}
        type="button"
        onClick={onNextRound}
        disabled={!canContinue}
        className="retro-btn round-summary-next-btn"
        style={{
          opacity: canContinue ? 1 : 0.45,
          cursor: canContinue ? "pointer" : "not-allowed",
        }}
      >
        {freeWeapons ? t("btn_next_round") : t("btn_go_to_shop")}
      </button>

      <button
        ref={newGameBtnRef}
        type="button"
        onClick={onNewGame}
        className="round-summary-menu-btn"
      >
        {t("btn_return_to_menu")}
      </button>

      <div
        style={{ fontSize: "12px", color: VGA_PALETTE.GRAY, marginTop: 8 }}
      >
        {t("next_round_note")}
      </div>
    </dialog>
  );
}
