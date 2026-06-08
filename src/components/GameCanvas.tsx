import { useTranslation } from "react-i18next";
import { VGA_PALETTE } from "../types/game";
import type { Player } from "../types/player";
import { GameHUD } from "./GameHUD";
import { WindBanner } from "./WindBanner";
import { RoundSummary } from "./RoundSummary";
import { WeaponShop } from "./WeaponShop";
import { GameControlsExplanation } from "./GameControlsExplanation";
import { GameOverOverlay } from "./GameOverOverlay";
import { useGameSession } from "./useGameSession";

export interface GameCanvasProps {
  /** Joueurs pré-configurés depuis le MainMenu (phase initiale 'MENU'). Si absent → démo 2 joueurs. */
  initialPlayers?: Player[];
  /** Permet de retourner à l'écran titre (démontage engine + ressources). */
  onReturnToMenu?: () => void;
}

export function GameCanvas({
  initialPlayers,
  onReturnToMenu,
}: GameCanvasProps = {}) {
  const { t } = useTranslation();

  const {
    canvasRef,
    state,
    CANVAS_WIDTH,
    handleCanvasClick,
    handleWeaponSelect,
    handleShopBuySell,
    handleShopReady,
    handleNextRound,
    handleNewGameFromSummary,
    handleNewGame,
  } = useGameSession({ initialPlayers, onReturnToMenu });

  const {
    gamePhase,
    wind,
    turnInfo,
    winner,
    showNewGameButton,
    roundResult,
    currentManche,
    lastRoundOutcome,
    shopPlayers,
    currentShopIndex,
    uiPlayers,
  } = state;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
      }}
    >
      {onReturnToMenu && (
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            width: CANVAS_WIDTH,
          }}
        >
          <button
            type="button"
            onClick={onReturnToMenu}
            style={{ fontSize: 12, padding: "3px 9px" }}
            title={t("btn_menu_title")}
          >
            {t("btn_menu")}
          </button>
        </div>
      )}

      <div style={{ position: "relative" }}>
        {(gamePhase === "COMBAT" || gamePhase === "RESOLUTION") && (
          <WindBanner windForce={wind} />
        )}

        <canvas
          ref={canvasRef}
          onClick={handleCanvasClick}
          style={{
            border: `3px solid ${VGA_PALETTE.GRAY}`,
            imageRendering: "pixelated",
            cursor: winner ? "default" : "crosshair",
            background: "#000000",
          }}
        />

        {/* Retro VGA HUD overlay (superposed on canvas) — only during active combat */}
        {(gamePhase === "COMBAT" || gamePhase === "RESOLUTION") && (
          <GameHUD turnInfo={turnInfo} onWeaponSelect={handleWeaponSelect} />
        )}

        {/* Round Summary overlay (fin de manche) — keeps canvas + fireworks visible underneath */}
        {gamePhase === "SUMMARY" && (
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
        {gamePhase === "SHOP" && shopPlayers.length > 0 && (
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
                L'IA{" "}
                <strong
                  style={{ color: shopPlayers[currentShopIndex]?.tank.color }}
                >
                  {shopPlayers[currentShopIndex]?.name}
                </strong>{" "}
                fait ses achats...
              </div>
            )}
          </>
        )}

        {/* Phase indicator minimal pour SUMMARY seulement (le SHOP a maintenant son propre UI) */}
        {gamePhase === "SUMMARY" && (
          <div className="retro-badge">PHASE: {gamePhase}</div>
        )}

        {/* Celebration banner during pre-SUMMARY fireworks (from winning tank) */}
        {gamePhase === "CELEBRATION" && (
          <div
            className="celebration-banner"
          >
            {t("celebration_banner")}
          </div>
        )}

        {/* === GAME OVER OVERLAY === */}
        {gamePhase === "GAME_OVER" && (
          <GameOverOverlay winner={winner} />
        )}
      </div>

      {/* New Game Button - appears after delay */}
      {showNewGameButton && (
        <button type="button" onClick={handleNewGame} className="retro-newgame-btn">
          {t("btn_new_game")}
        </button>
      )}

      <GameControlsExplanation />
    </div>
  );
}
