import type { CurrentTurnInfo } from "../game/engine/TurnManager";
import type { GamePhase } from "../types/game";
import type { Player } from "../types/player";
import type { AdvisorView } from "./advisor/AdvisorController";

export type HudWaitCauseKey =
  | "status_tanks_falling"
  | "status_resolving"
  | "status_ai_turn"
  | "status_ai_waiting";

export type CombatWaitCauseKey = HudWaitCauseKey | "advisor_calculating";

export type TerrainCursor = "crosshair" | "default" | "wait" | "progress";

/**
 * Returns the active HUD wait cause key for the current turn, or `null` when
 * no combat wait state is active. Falling takes priority over shot resolution,
 * and an active shot replaces AI preparation.
 */
export function getHudWaitCauseKey(
  turnInfo: CurrentTurnInfo | null,
  gameMode: "local" | "online" = "local",
): HudWaitCauseKey | null {
  if (!turnInfo || turnInfo.isCatchUp) return null;
  if (turnInfo.tanksAreFalling) return "status_tanks_falling";
  if (turnInfo.isResolving) return "status_resolving";
  if (!turnInfo.isHuman && !turnInfo.isSpecialTurn && !turnInfo.isAwaitingServerTurn) {
    return gameMode === "online" ? "status_ai_waiting" : "status_ai_turn";
  }
  return null;
}

/**
 * Checks whether the local shot advisor panel is open for the active human turn.
 */
export function isAdvisorOpenForTurn(input: {
  readonly gameMode?: "local" | "online";
  readonly gamePhase: GamePhase;
  readonly turnInfo: CurrentTurnInfo | null;
  readonly advisorPlayerId?: string;
}): boolean {
  const { gameMode, gamePhase, turnInfo, advisorPlayerId } = input;
  if (gameMode === "online" || gamePhase !== "COMBAT") return false;
  if (
    turnInfo &&
    (!turnInfo.isHuman ||
      turnInfo.isInputLocked ||
      turnInfo.isResolving ||
      turnInfo.tanksAreFalling ||
      turnInfo.isCatchUp)
  ) {
    return false;
  }
  return !turnInfo || !advisorPlayerId || advisorPlayerId === turnInfo.playerId;
}

/**
 * Checks whether the shot advisor is actively calculating for the active human turn.
 */
export function isAdvisorCalculatingForTurn(input: {
  readonly gameMode?: "local" | "online";
  readonly gamePhase: GamePhase;
  readonly turnInfo: CurrentTurnInfo | null;
  readonly advisorView: Pick<AdvisorView, "status" | "playerId">;
}): boolean {
  const { advisorView, turnInfo } = input;
  if (advisorView.status !== "calculating") return false;
  if (
    !isAdvisorOpenForTurn({
      gameMode: input.gameMode,
      gamePhase: input.gamePhase,
      turnInfo,
      advisorPlayerId: advisorView.playerId,
    })
  ) {
    return false;
  }
  return Boolean(advisorView.playerId || turnInfo?.playerId);
}

/**
 * Resolves the single current combat wait cause across HUD and shot advisor.
 */
export function getCombatWaitCauseKey(input: {
  readonly gameMode?: "local" | "online";
  readonly gamePhase: GamePhase;
  readonly turnInfo: CurrentTurnInfo | null;
  readonly advisorView: Pick<AdvisorView, "status" | "playerId">;
  readonly winner: Player | null;
  readonly hasBlockingError?: boolean;
}): CombatWaitCauseKey | null {
  if (
    input.winner ||
    input.hasBlockingError ||
    (input.gamePhase !== "COMBAT" && input.gamePhase !== "RESOLUTION")
  ) {
    return null;
  }
  const hudCause = getHudWaitCauseKey(input.turnInfo, input.gameMode);
  if (hudCause) return hudCause;
  if (isAdvisorCalculatingForTurn(input)) return "advisor_calculating";
  return null;
}

/**
 * Maps the current combat wait state to the appropriate canvas cursor.
 */
export function getTerrainCursor(input: {
  readonly gameMode?: "local" | "online";
  readonly gamePhase: GamePhase;
  readonly turnInfo: CurrentTurnInfo | null;
  readonly advisorView: Pick<AdvisorView, "status" | "playerId">;
  readonly winner: Player | null;
  readonly hasBlockingError?: boolean;
}): TerrainCursor {
  if (input.winner) return "default";
  const cause = getCombatWaitCauseKey(input);
  if (cause === "advisor_calculating") return "progress";
  if (cause !== null) return "wait";
  return "crosshair";
}
