import { useTranslation, Trans } from "react-i18next";
import { VGA_PALETTE } from "../types/game";
import type { Player } from "../types/player";
import { GameHUD } from "./GameHUD";
import { WindBanner } from "./WindBanner";
import { RoundSummary } from "./RoundSummary";
import { WeaponShop } from "./WeaponShop";
import { GameControlsExplanation } from "./GameControlsExplanation";
import { GameOverOverlay } from "./GameOverOverlay";
import { useGameSession } from "./useGameSession";
import { MobileControls } from "./MobileControls";
import type { OnlineCanvasSnapshot } from "../utils/onlineSession";
import type { TerrainMaterial } from "../types/terrain";
import { ShotEarningsOverlay } from "./ShotEarningsOverlay";
import type { FireRejectedReason } from "../game/online/protocol";

const FIRE_REJECTION_KEYS = {
  MALFORMED: "fire_rejected_malformed",
  NOT_YOUR_TURN: "fire_rejected_not_your_turn",
  SHOT_IN_FLIGHT: "fire_rejected_shot_in_flight",
  ROUND_ENDED: "fire_rejected_round_ended",
  NO_AMMO: "fire_rejected_no_ammo",
  ILLEGAL_INVENTORY: "fire_rejected_illegal_inventory",
} as const satisfies Record<FireRejectedReason, string>;

export interface GameCanvasProps {
  /** Joueurs pré-configurés depuis le MainMenu (phase initiale 'MENU'). Si absent → démo 2 joueurs. */
  initialPlayers?: Player[];
  /** Permet de retourner à l'écran titre (démontage engine + ressources). */
  onReturnToMenu?: () => void;
  /** Online multiplayer info (passed from lobby start) */
  gameMode?: "local" | "online";
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

export function GameCanvas({
  initialPlayers,
  onReturnToMenu,
  gameMode,
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
    handleAdjustAngle,
    handleAdjustPower,
    handleCycleWeapon,
    handleFire,
    isLocalShopTurn,
    shopDisplayPlayer,
    localShopDone,
    dismissEarningsOverlay,
  } = useGameSession({ initialPlayers, onReturnToMenu, gameMode, localPlayerId, roomId, initialHeights, initialMaterials, initialWind, initialCurrentPlayerIndex, resumeCanvas, slot, token, ws });

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
    earningsOverlay,
    zeusAnnouncement,
    shopSession,
    fireRejection,
    protocolMismatch,
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

        {earningsOverlay && (
          <ShotEarningsOverlay
            overlay={earningsOverlay}
            onDismiss={dismissEarningsOverlay}
          />
        )}

        {zeusAnnouncement && (
          <div className="zeus-announcement" role="status" aria-live="polite">
            {t("zeus_appointed_announcement", {
              name: zeusAnnouncement.playerName,
            })}
          </div>
        )}

        <canvas
          ref={canvasRef}
          onClick={handleCanvasClick}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleCanvasClick();
            }
          }}
          tabIndex={0}
          role="img"
          aria-label={t("canvas_game_aria_label")}
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

        {/* Contrôles tactiles pour mobile — seulement en combat */}
        {(gamePhase === "COMBAT" || gamePhase === "RESOLUTION") && (
          <MobileControls
            turnInfo={turnInfo}
            onAdjustAngle={handleAdjustAngle}
            onAdjustPower={handleAdjustPower}
            onCycleWeapon={handleCycleWeapon}
            onFire={handleFire}
          />
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

        {/* Weapon Shop — online: parallel (each human shops self); local: sequential index */}
        {gamePhase === "SHOP" && shopPlayers.length > 0 && (
          <>
            {gameMode === "online" && !shopSession.authoritativeReceived ? (
              <div className="retro-ai-overlay">
                {t("shop_waiting_state")}
              </div>
            ) : gameMode === "online" ? (
              isLocalShopTurn && shopDisplayPlayer ? (
                <WeaponShop
                  player={shopDisplayPlayer}
                  shopIndex={Math.max(
                    0,
                    shopPlayers.findIndex((p) => p.id === shopDisplayPlayer.id),
                  )}
                  totalShoppers={shopPlayers.filter((p) => p.isHuman).length}
                  onBuySell={handleShopBuySell}
                  onReady={handleShopReady}
                  purchaseCounters={shopSession.counters[shopDisplayPlayer.id]}
                  controlsDisabled={shopSession.pendingIntent !== null}
                  denial={shopSession.denial}
                />
              ) : (
                <div className="retro-ai-overlay">
                  {localShopDone
                    ? t("shop_waiting_others")
                    : t("shop_waiting_opponent", {
                        name: shopPlayers[currentShopIndex]?.name ?? "",
                      })}
                </div>
              )
            ) : shopPlayers[currentShopIndex]?.isHuman ? (
              isLocalShopTurn ? (
                <WeaponShop
                  player={shopPlayers[currentShopIndex]}
                  shopIndex={currentShopIndex}
                  totalShoppers={shopPlayers.length}
                  onBuySell={handleShopBuySell}
                  onReady={handleShopReady}
                  purchaseCounters={
                    shopSession.counters[shopPlayers[currentShopIndex].id]
                  }
                  controlsDisabled={shopSession.pendingIntent !== null}
                  denial={shopSession.denial}
                />
              ) : (
                <div className="retro-ai-overlay">
                  {t("shop_waiting_opponent", {
                    name: shopPlayers[currentShopIndex]?.name ?? "",
                  })}
                </div>
              )
            ) : (
              <div className="retro-ai-overlay">
                <Trans
                  i18nKey="ai_shopping_status"
                  values={{
                    name: shopPlayers[currentShopIndex]?.name ?? "",
                  }}
                  components={{
                    strong: (
                      <strong
                        style={{
                          color: shopPlayers[currentShopIndex]?.tank.color ?? "#fff",
                        }}
                      />
                    ),
                  }}
                />
              </div>
            )}
          </>
        )}

        {fireRejection && gamePhase === "COMBAT" && !protocolMismatch && (
          <div className="fire-rejection-toast" role="alert">
            {t(FIRE_REJECTION_KEYS[fireRejection])}
          </div>
        )}

        {protocolMismatch && (
          <div className="protocol-mismatch-overlay" role="alert">
            <strong>{t("protocol_mismatch_title")}</strong>
            <p>{t("protocol_mismatch_body")}</p>
            <button
              type="button"
              onClick={() => {
                window.location.reload();
              }}
            >
              {t("protocol_mismatch_refresh")}
            </button>
          </div>
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
