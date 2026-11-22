import { ShotAdvisorPanel, type ShotAdvisorPanelProps } from "./advisor/ShotAdvisorPanel";
import { lazy, Suspense } from "react";
const DiagnosticPanel = import.meta.env.DEV || import.meta.env.MODE === "endurance" ? lazy(() => import("./diagnostics/DiagnosticPanel")) : null;
import { PlayerStatusList } from "./PlayerStatusList";
import { isAimingInspectionVisible } from "./playerStatus";
import type { EnduranceSession } from "../game/endurance/session";
import { type RoundMap } from "../game/round/prepareRound";
import { useTranslation } from "react-i18next";
import type { Player } from "../types/player";
import { GameHUD } from "./GameHUD";
import { WindBanner } from "./WindBanner";
import { RoundSummary } from "./RoundSummary";
import { GameControlsExplanation } from "./GameControlsExplanation";
import { GameOverOverlay } from "./GameOverOverlay";
import { useGameSession } from "./useGameSession";
import { MobileControls } from "./MobileControls";
import type { OnlineCanvasSnapshot } from "../utils/onlineSession";
import { ShotEarningsOverlay } from "./ShotEarningsOverlay";
import type { FireRejectedReason } from "../game/online/protocol";
import { GameShopOverlay } from "./GameShopOverlay";
import type { GameCanvasState } from "./gameCanvasReducer";
import type { WeaponId } from "../types/weapon";
import { CombatStatusAnnouncer } from "./CombatStatusAnnouncer";
import { getTerrainCursor, isAdvisorOpenForTurn } from "./combatWaitStatus";
import { ProtocolMismatchDialog, SessionErrorDialog } from "./RecoveryDialogs";

const FIRE_REJECTION_KEYS = {
  ZEUS_TURN: "fire_rejected_zeus_turn",
  MALFORMED: "fire_rejected_malformed",
  NOT_YOUR_TURN: "fire_rejected_not_your_turn",
  SHOT_IN_FLIGHT: "fire_rejected_shot_in_flight",
  ROUND_ENDED: "fire_rejected_round_ended",
  NO_AMMO: "fire_rejected_no_ammo",
  ILLEGAL_INVENTORY: "fire_rejected_illegal_inventory",
} as const satisfies Record<FireRejectedReason, string>;

export interface GameCanvasProps {
  endurance?: EnduranceSession;
  /** Joueurs pré-configurés depuis le MainMenu (phase initiale 'MENU'). Si absent → démo 2 joueurs. */
  initialPlayers?: Player[];
  /** Permet de retourner à l'écran titre (démontage engine + ressources). */
  onReturnToMenu?: () => void;
  /** Online multiplayer info (passed from lobby start) */
  gameMode?: "local" | "online";
  localPlayerId?: string;
  roomId?: string;
  initialMap?: RoundMap;
  initialCurrentPlayerIndex?: number;
  resumeCanvas?: OnlineCanvasSnapshot;
  slot?: number;
  token?: string;
  ws?: WebSocket;
  freeWeapons?: boolean;
}

function MenuButton({
  onReturnToMenu,
}: {
  readonly onReturnToMenu?: () => void;
}) {
  const { t } = useTranslation();
  if (!onReturnToMenu) return null;
  return (
    <div className="combat-topbar">
      <button
        type="button"
        className="combat-menu-btn"
        onClick={onReturnToMenu}
        title={t("btn_menu_title")}
      >
        {t("btn_menu")}
      </button>
    </div>
  );
}

function AimingPlayerStatus({
  players,
  gamePhase,
  turnInfo,
  gameMode,
  lockedTargetId,
  onToggleLock,
}: {
  readonly players: GameCanvasState["playerStatus"];
  readonly gamePhase: GameCanvasState["gamePhase"];
  readonly turnInfo: GameCanvasState["turnInfo"];
  readonly gameMode: GameCanvasProps["gameMode"];
  readonly lockedTargetId?: string;
  readonly onToggleLock?: (playerId: string) => void;
}) {
  if (!players || !turnInfo || !isAimingInspectionVisible({ gamePhase, turnInfo })) return null;
  return (
    <PlayerStatusList
      players={players}
      currentPlayerId={turnInfo.playerId}
      gameMode={gameMode === "online" ? "online" : "local"}
      lockedTargetId={lockedTargetId}
      onToggleLock={onToggleLock}
    />
  );
}

function CombatAdvisor({
  gameMode,
  gamePhase,
  turnInfo,
  advisor,
}: {
  readonly gameMode: GameCanvasProps["gameMode"];
  readonly gamePhase: GameCanvasState["gamePhase"];
  readonly turnInfo: GameCanvasState["turnInfo"];
  readonly advisor: ShotAdvisorPanelProps;
}) {
  const open = isAdvisorOpenForTurn({
    gameMode,
    gamePhase,
    turnInfo,
    advisorPlayerId: advisor.view.playerId,
  });
  if (!open) return null;
  const view =
    advisor.view.status === "calculating" && !advisor.view.playerId && turnInfo?.playerId
      ? { ...advisor.view, playerId: turnInfo.playerId }
      : advisor.view;
  return <ShotAdvisorPanel {...advisor} view={view} />;
}

function CombatHudOverlay({
  gameMode,
  round,
  gamePhase,
  wind,
  turnInfo,
  onWeaponSelect,
}: {
  readonly gameMode: GameCanvasProps["gameMode"];
  readonly round: number;
  readonly gamePhase: GameCanvasState["gamePhase"];
  readonly wind: number;
  readonly turnInfo: GameCanvasState["turnInfo"];
  readonly onWeaponSelect: (weaponId: WeaponId) => void;
}) {
  const active = gamePhase === "COMBAT" || gamePhase === "RESOLUTION";
  if (!active) return null;
  return (
    <>
      <CombatStatusAnnouncer round={round} turnInfo={turnInfo} wind={wind} />
      <div className="combat-hud-stack">
        <WindBanner windForce={wind} />
        <GameHUD turnInfo={turnInfo} gameMode={gameMode} onWeaponSelect={onWeaponSelect} />
      </div>
    </>
  );
}

function TransientOverlays({
  earningsOverlay,
  zeusAnnouncement,
  fireRejection,
  protocolMismatch,
  gamePhase,
  canvasWidth,
  canvasHeight,
  onDismissEarnings,
}: {
  readonly earningsOverlay: GameCanvasState["earningsOverlay"];
  readonly zeusAnnouncement: GameCanvasState["zeusAnnouncement"];
  readonly fireRejection: GameCanvasState["fireRejection"];
  readonly protocolMismatch: GameCanvasState["protocolMismatch"];
  readonly gamePhase: GameCanvasState["gamePhase"];
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly onDismissEarnings: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {earningsOverlay && (
        <ShotEarningsOverlay
          overlay={earningsOverlay}
          canvasWidth={canvasWidth}
          canvasHeight={canvasHeight}
          onDismiss={onDismissEarnings}
        />
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
      {protocolMismatch && <ProtocolMismatchDialog />}
    </>
  );
}

function RoundPhaseOverlay({
  state,
  gameMode,
  isLocalShopTurn,
  shopDisplayPlayer,
  localShopDone,
  freeWeapons,
  onNextRound,
  onNewGameFromSummary,
  onShopBuySell,
  onShopReady,
  onRetry,
  onReturnToMenu,
}: {
  readonly state: GameCanvasState;
  readonly gameMode: GameCanvasProps["gameMode"];
  readonly isLocalShopTurn: boolean;
  readonly shopDisplayPlayer: Player | null;
  readonly localShopDone: boolean;
  readonly freeWeapons?: boolean;
  readonly onNextRound: () => void;
  readonly onNewGameFromSummary: () => void;
  readonly onShopBuySell: (weaponId: WeaponId, delta: 1 | -1) => void;
  readonly onShopReady: () => void;
  readonly onRetry: () => void;
  readonly onReturnToMenu?: () => void;
}) {
  const { t } = useTranslation();
  if (state.protocolMismatch) return null;
  if (
    (state.gamePhase === "SHOP" || state.gamePhase === "SUMMARY") &&
    (state.roundPreparationError || state.networkError)
  ) {
    return (
      <SessionErrorDialog
        roundPreparationError={state.roundPreparationError}
        networkError={state.networkError}
        onRetry={onRetry}
        onReturnToMenu={onReturnToMenu}
      />
    );
  }
  switch (state.gamePhase) {
    case "SUMMARY":
      return (
        <RoundSummary
          round={state.currentManche}
          players={state.uiPlayers}
          result={state.roundResult}
          roundOutcome={state.lastRoundOutcome}
          onNextRound={onNextRound}
          onNewGame={onNewGameFromSummary}
          freeWeapons={freeWeapons}
        />
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

function InlineSessionErrors({
  suppressed,
  networkError,
  roundPreparationError,
  onRetry,
}: {
  readonly suppressed: boolean;
  readonly networkError: GameCanvasState["networkError"];
  readonly roundPreparationError: GameCanvasState["roundPreparationError"];
  readonly onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (suppressed) return null;
  return (
    <>
      {networkError && (
        <div role="alert">
          {t(networkError, { defaultValue: networkError })}{" "}
          <button type="button" className="combat-menu-btn" onClick={onRetry}>
            {t("btn_retry")}
          </button>
        </div>
      )}
      {roundPreparationError && (
        <div role="alert">
          {t(
            roundPreparationError === "NEW_GAME_REQUIRED"
              ? "round_new_game_required"
              : "round_preparation_failed",
          )}
          {roundPreparationError === "EXHAUSTED" && (
            <button type="button" className="combat-menu-btn" onClick={onRetry}>
              {t("btn_retry")}
            </button>
          )}
        </div>
      )}
    </>
  );
}

function isBlockingModalErrorActive(state: GameCanvasState): boolean {
  if (state.protocolMismatch) return true;
  return (
    (state.gamePhase === "SHOP" || state.gamePhase === "SUMMARY") &&
    Boolean(state.roundPreparationError || state.networkError)
  );
}

export function GameCanvas({
  endurance,
  initialPlayers,
  onReturnToMenu,
  gameMode,
  localPlayerId,
  roomId,
  initialMap,
  initialCurrentPlayerIndex,
  resumeCanvas,
  slot,
  token,
  ws,
  freeWeapons,
}: GameCanvasProps = {}) {
  const { t } = useTranslation();

  const {
    diagnostics,
    advisor,
    canvasRef,
    state,
    CANVAS_WIDTH,
    CANVAS_HEIGHT,
    handleCanvasClick,
    handleWeaponSelect,
    handleShopBuySell,
    handleShopReady,
    handleNextRound,
    retryRoundPreparation,
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
  } = useGameSession({ endurance, initialPlayers, onReturnToMenu, gameMode, localPlayerId, roomId, initialMap, initialCurrentPlayerIndex, resumeCanvas, slot, token, ws, freeWeapons });

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

  const hasBlockingModalError = isBlockingModalErrorActive(state);
  const isCombatActive = gamePhase === "COMBAT" || gamePhase === "RESOLUTION";
  const terrainCursor = getTerrainCursor({
    gameMode,
    gamePhase,
    turnInfo,
    advisorView: advisor.view,
    winner: state.winner,
    hasBlockingError: hasBlockingModalError,
  });

  return (
    <div className="combat-shell">
      {!endurance && gameMode === "local" && diagnostics && DiagnosticPanel && <Suspense fallback={null}><DiagnosticPanel source={diagnostics} /></Suspense>}
      <InlineSessionErrors
        suppressed={hasBlockingModalError}
        networkError={state.networkError}
        roundPreparationError={state.roundPreparationError}
        onRetry={retryRoundPreparation}
      />
      <MenuButton onReturnToMenu={endurance ? undefined : onReturnToMenu} />

      <div className="combat-battlefield">
        <CombatHudOverlay
          gameMode={gameMode}
          round={state.currentManche}
          gamePhase={gamePhase}
          wind={wind}
          turnInfo={turnInfo}
          onWeaponSelect={handleWeaponSelect}
        />

        <div className="combat-canvas-stage">
          <TransientOverlays
            earningsOverlay={earningsOverlay}
            zeusAnnouncement={zeusAnnouncement}
            fireRejection={fireRejection}
            protocolMismatch={protocolMismatch}
            gamePhase={gamePhase}
            canvasWidth={CANVAS_WIDTH}
            canvasHeight={CANVAS_HEIGHT}
            onDismissEarnings={dismissEarningsOverlay}
          />

          <canvas
            ref={canvasRef}
            className="game-canvas"
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
            style={{ cursor: terrainCursor }}
          />

          <RoundPhaseOverlay
            state={state}
            gameMode={gameMode}
            isLocalShopTurn={isLocalShopTurn}
            shopDisplayPlayer={shopDisplayPlayer}
            localShopDone={localShopDone}
            freeWeapons={freeWeapons}
            onNextRound={endurance ? () => {} : handleNextRound}
            onNewGameFromSummary={endurance ? () => {} : handleNewGameFromSummary}
            onShopBuySell={handleShopBuySell}
            onShopReady={handleShopReady}
            onRetry={retryRoundPreparation}
            onReturnToMenu={endurance ? undefined : onReturnToMenu}
          />
        </div>
      </div>

      {isCombatActive && (
        <MobileControls
          turnInfo={turnInfo}
          onAdjustAngle={handleAdjustAngle}
          onAdjustPower={handleAdjustPower}
          onCycleWeapon={handleCycleWeapon}
          onFire={handleFire}
        />
      )}

      <AimingPlayerStatus
        players={state.playerStatus}
        gamePhase={gamePhase}
        turnInfo={turnInfo}
        gameMode={gameMode}
        lockedTargetId={advisor.lockFor ? advisor.lockFor(turnInfo?.playerId) : (advisor.view.playerId === turnInfo?.playerId ? advisor.view.lockedTargetId : undefined)}
        onToggleLock={advisor.toggleLock}
      />

      <CombatAdvisor
        gameMode={gameMode}
        gamePhase={gamePhase}
        turnInfo={turnInfo}
        advisor={advisor}
      />

      {!hasBlockingModalError && gamePhase === "SUMMARY" && (
        <div className="retro-badge">PHASE: {gamePhase}</div>
      )}

      <NewGameButton visible={showNewGameButton} onNewGame={handleNewGame} />

      <GameControlsExplanation />
    </div>
  );
}
