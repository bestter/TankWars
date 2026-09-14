import { useTranslation } from "react-i18next";
import { VGA_PALETTE } from "../types/game";
import type { Player } from "../types/player";
import { GameHUD } from "./GameHUD";
import { WindBanner } from "./WindBanner";
import { RoundSummary } from "./RoundSummary";
import { GameControlsExplanation } from "./GameControlsExplanation";
import { GameOverOverlay } from "./GameOverOverlay";
import { useGameSession } from "./useGameSession";
import { MobileControls } from "./MobileControls";
import type { OnlineCanvasSnapshot } from "../utils/onlineSession";
import type { TerrainMaterial } from "../types/terrain";
import { ShotEarningsOverlay } from "./ShotEarningsOverlay";
import type { FireRejectedReason } from "../game/online/protocol";
import { GameShopOverlay } from "./GameShopOverlay";
import type { GameCanvasState } from "./gameCanvasReducer";
import type { WeaponId } from "../types/weapon";

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

function MenuButton({
  canvasWidth,
  onReturnToMenu,
}: {
  readonly canvasWidth: number;
  readonly onReturnToMenu?: () => void;
}) {
  const { t } = useTranslation();
  if (!onReturnToMenu) return null;
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", width: canvasWidth }}>
      <button
        type="button"
        onClick={onReturnToMenu}
        style={{ fontSize: 12, padding: "3px 9px" }}
        title={t("btn_menu_title")}
      >
        {t("btn_menu")}
      </button>
    </div>
  );
}

function CombatControls({
  gamePhase,
  wind,
  turnInfo,
  onWeaponSelect,
  onAdjustAngle,
  onAdjustPower,
  onCycleWeapon,
  onFire,
}: {
  readonly gamePhase: GameCanvasState["gamePhase"];
  readonly wind: number;
  readonly turnInfo: GameCanvasState["turnInfo"];
  readonly onWeaponSelect: (weaponId: WeaponId) => void;
  readonly onAdjustAngle: (delta: number) => void;
  readonly onAdjustPower: (delta: number) => void;
  readonly onCycleWeapon: (delta: 1 | -1) => void;
  readonly onFire: () => void;
}) {
  const active = gamePhase === "COMBAT" || gamePhase === "RESOLUTION";
  if (!active) return null;
  return (
    <>
      <WindBanner windForce={wind} />
      <GameHUD turnInfo={turnInfo} onWeaponSelect={onWeaponSelect} />
      <MobileControls
        turnInfo={turnInfo}
        onAdjustAngle={onAdjustAngle}
        onAdjustPower={onAdjustPower}
        onCycleWeapon={onCycleWeapon}
        onFire={onFire}
      />
    </>
  );
}

function TransientOverlays({
  earningsOverlay,
  zeusAnnouncement,
  fireRejection,
  protocolMismatch,
  gamePhase,
  onDismissEarnings,
}: {
  readonly earningsOverlay: GameCanvasState["earningsOverlay"];
  readonly zeusAnnouncement: GameCanvasState["zeusAnnouncement"];
  readonly fireRejection: GameCanvasState["fireRejection"];
  readonly protocolMismatch: GameCanvasState["protocolMismatch"];
  readonly gamePhase: GameCanvasState["gamePhase"];
  readonly onDismissEarnings: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {earningsOverlay && (
        <ShotEarningsOverlay overlay={earningsOverlay} onDismiss={onDismissEarnings} />
      )}
      {zeusAnnouncement && (
        <div className="zeus-announcement" role="status" aria-live="polite">
          {t("zeus_appointed_announcement", { name: zeusAnnouncement.playerName })}
        </div>
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
          <button type="button" onClick={() => window.location.reload()}>
            {t("protocol_mismatch_refresh")}
          </button>
        </div>
      )}
    </>
  );
}

function RoundPhaseOverlay({
  state,
  gameMode,
  isLocalShopTurn,
  shopDisplayPlayer,
  localShopDone,
  onNextRound,
  onNewGameFromSummary,
  onShopBuySell,
  onShopReady,
}: {
  readonly state: GameCanvasState;
  readonly gameMode: GameCanvasProps["gameMode"];
  readonly isLocalShopTurn: boolean;
  readonly shopDisplayPlayer: Player | null;
  readonly localShopDone: boolean;
  readonly onNextRound: () => void;
  readonly onNewGameFromSummary: () => void;
  readonly onShopBuySell: (weaponId: WeaponId, delta: 1 | -1) => void;
  readonly onShopReady: () => void;
}) {
  const { t } = useTranslation();
  switch (state.gamePhase) {
    case "SUMMARY":
      return (
        <>
          <RoundSummary
            round={state.currentManche}
            players={state.uiPlayers}
            result={state.roundResult}
            roundOutcome={state.lastRoundOutcome}
            onNextRound={onNextRound}
            onNewGame={onNewGameFromSummary}
          />
          <div className="retro-badge">PHASE: {state.gamePhase}</div>
        </>
      );
    case "SHOP":
      return state.shopPlayers.length > 0 ? (
        <GameShopOverlay
          gameMode={gameMode}
          shopPlayers={state.shopPlayers}
          currentShopIndex={state.currentShopIndex}
          shopDisplayPlayer={shopDisplayPlayer}
          isLocalShopTurn={isLocalShopTurn}
          localShopDone={localShopDone}
          shopSession={state.shopSession}
          onBuySell={onShopBuySell}
          onReady={onShopReady}
        />
      ) : null;
    case "CELEBRATION":
      return <div className="celebration-banner">{t("celebration_banner")}</div>;
    case "GAME_OVER":
      return <GameOverOverlay winner={state.winner} />;
    default:
      return null;
  }
}

function NewGameButton({
  visible,
  onNewGame,
}: {
  readonly visible: boolean;
  readonly onNewGame: () => void;
}) {
  const { t } = useTranslation();
  if (!visible) return null;
  return (
    <button type="button" onClick={onNewGame} className="retro-newgame-btn">
      {t("btn_new_game")}
    </button>
  );
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
    showNewGameButton,
    earningsOverlay,
    zeusAnnouncement,
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
      <MenuButton canvasWidth={CANVAS_WIDTH} onReturnToMenu={onReturnToMenu} />

      <div style={{ position: "relative" }}>
        <TransientOverlays
          earningsOverlay={earningsOverlay}
          zeusAnnouncement={zeusAnnouncement}
          fireRejection={fireRejection}
          protocolMismatch={protocolMismatch}
          gamePhase={gamePhase}
          onDismissEarnings={dismissEarningsOverlay}
        />

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
            cursor: state.winner ? "default" : "crosshair",
            background: "#000000",
          }}
        />

        <CombatControls
          gamePhase={gamePhase}
          wind={wind}
          turnInfo={turnInfo}
          onWeaponSelect={handleWeaponSelect}
          onAdjustAngle={handleAdjustAngle}
          onAdjustPower={handleAdjustPower}
          onCycleWeapon={handleCycleWeapon}
          onFire={handleFire}
        />

        <RoundPhaseOverlay
          state={state}
          gameMode={gameMode}
          isLocalShopTurn={isLocalShopTurn}
          shopDisplayPlayer={shopDisplayPlayer}
          localShopDone={localShopDone}
          onNextRound={handleNextRound}
          onNewGameFromSummary={handleNewGameFromSummary}
          onShopBuySell={handleShopBuySell}
          onShopReady={handleShopReady}
        />
      </div>

      <NewGameButton visible={showNewGameButton} onNewGame={handleNewGame} />

      <GameControlsExplanation />
    </div>
  );
}
