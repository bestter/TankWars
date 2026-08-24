import type { GamePhase, RoundResult } from "../types/game";
import type { Player } from "../types/player";
import type { CurrentTurnInfo } from "../game/engine/TurnManager";

export const ZEUS_ANNOUNCEMENT_DURATION_MS = 3_000;

export interface EarningsOverlayState {
  shotId: number;
  awards: Array<{
    playerId: string;
    playerName: string;
    color: string;
    amount: number;
    x: number;
    y: number;
  }>;
  displayedAt: number;
}

export interface ZeusAnnouncementState {
  appointmentId: number;
  playerName: string;
  displayedAt: number;
}

export interface GameCanvasState {
  gamePhase: GamePhase;
  wind: number;
  turnInfo: CurrentTurnInfo | null;
  winner: Player | null;
  showNewGameButton: boolean;
  roundResult: RoundResult | null;
  currentManche: number;
  lastRoundOutcome: { isDraw: boolean; winner: Player | null } | null;
  shopPlayers: Player[];
  currentShopIndex: number;
  uiPlayers: Player[];
  earningsOverlay: EarningsOverlayState | null;
  zeusAnnouncement?: ZeusAnnouncementState | null;
}

export type GameCanvasAction =
  | { type: "SET_WIND"; wind: number }
  | { type: "SET_TURN_INFO"; info: CurrentTurnInfo | null }
  | { type: "SET_UI_PLAYERS"; players: Player[] }
  | { type: "SHOW_EARNINGS"; overlay: EarningsOverlayState }
  | { type: "HIDE_EARNINGS" }
  | { type: "SHOW_ZEUS_ANNOUNCEMENT"; announcement: ZeusAnnouncementState }
  | { type: "HIDE_ZEUS_ANNOUNCEMENT" }
  | { type: "START_CELEBRATION"; payload: { roundWinner: Player | null; roundResult: RoundResult; uiPlayers: Player[] } }
  | { type: "GO_TO_SUMMARY" }
  | { type: "START_SHOP"; roster: Player[] }
  | { type: "ADVANCE_SHOPPER"; nextIndex: number }
  | { type: "MUTATE_SHOP_PLAYERS"; players: Player[] }
  | { type: "FINISH_SHOP"; uiPlayers: Player[] }
  | { type: "END_MATCH_FROM_SHOP"; winner: Player | null }
  | { type: "SHOW_NEW_GAME_BUTTON"; show: boolean }
  | { type: "RESET_GAME"; newPlayers: Player[] }
  | { type: "RESUME_CANVAS"; snapshot: Pick<GameCanvasState, "gamePhase" | "currentManche" | "uiPlayers" | "shopPlayers" | "currentShopIndex" | "roundResult" | "lastRoundOutcome" | "wind" | "earningsOverlay"> };

export const INITIAL_STATE: GameCanvasState = {
  gamePhase: "COMBAT",
  wind: 0,
  turnInfo: null,
  winner: null,
  showNewGameButton: false,
  roundResult: null,
  currentManche: 1,
  lastRoundOutcome: null,
  shopPlayers: [],
  currentShopIndex: 0,
  uiPlayers: [],
  earningsOverlay: null,
  zeusAnnouncement: null,
};

export function gameCanvasReducer(
  state: GameCanvasState,
  action: GameCanvasAction
): GameCanvasState {
  switch (action.type) {
    case "SET_WIND":
      return { ...state, wind: action.wind };
    case "SET_TURN_INFO":
      return { ...state, turnInfo: action.info };
    case "SET_UI_PLAYERS":
      return { ...state, uiPlayers: action.players };
    case "SHOW_EARNINGS":
      return { ...state, earningsOverlay: action.overlay };
    case "HIDE_EARNINGS":
      return { ...state, earningsOverlay: null };
    case "SHOW_ZEUS_ANNOUNCEMENT":
      return { ...state, zeusAnnouncement: action.announcement };
    case "HIDE_ZEUS_ANNOUNCEMENT":
      return { ...state, zeusAnnouncement: null };
    case "START_CELEBRATION":
      return {
        ...state,
        gamePhase: "CELEBRATION",
        currentManche: state.currentManche + 1,
        winner: null,
        showNewGameButton: false,
        roundResult: action.payload.roundResult,
        lastRoundOutcome: {
          isDraw: action.payload.roundWinner === null,
          winner: action.payload.roundWinner,
        },
        uiPlayers: action.payload.uiPlayers,
        earningsOverlay: null,
        zeusAnnouncement: null,
      };
    case "GO_TO_SUMMARY":
      return {
        ...state,
        gamePhase: "SUMMARY",
      };
    case "START_SHOP":
      return {
        ...state,
        gamePhase: "SHOP",
        shopPlayers: action.roster,
        uiPlayers: action.roster,
        currentShopIndex: 0,
        zeusAnnouncement: null,
      };
    case "ADVANCE_SHOPPER":
      return {
        ...state,
        currentShopIndex: action.nextIndex,
      };
    case "MUTATE_SHOP_PLAYERS":
      return {
        ...state,
        shopPlayers: action.players,
        uiPlayers: action.players,
      };
    case "FINISH_SHOP":
      return {
        ...state,
        gamePhase: "COMBAT",
        lastRoundOutcome: null,
        roundResult: null,
        shopPlayers: [],
        currentShopIndex: 0,
        uiPlayers: action.uiPlayers,
        earningsOverlay: null,
        zeusAnnouncement: null,
      };
    case "END_MATCH_FROM_SHOP":
      return {
        ...state,
        gamePhase: "GAME_OVER",
        shopPlayers: [],
        winner: action.winner,
        showNewGameButton: false,
        zeusAnnouncement: null,
      };
    case "SHOW_NEW_GAME_BUTTON":
      return {
        ...state,
        showNewGameButton: action.show,
      };
    case "RESET_GAME":
      return {
        ...state,
        gamePhase: "COMBAT",
        winner: null,
        showNewGameButton: false,
        turnInfo: null,
        roundResult: null,
        currentManche: 1,
        uiPlayers: action.newPlayers,
        shopPlayers: [],
        currentShopIndex: 0,
        earningsOverlay: null,
        zeusAnnouncement: null,
      };
    case "RESUME_CANVAS":
      return {
        ...state,
        gamePhase: action.snapshot.gamePhase,
        currentManche: action.snapshot.currentManche,
        uiPlayers: action.snapshot.uiPlayers,
        shopPlayers: action.snapshot.shopPlayers,
        currentShopIndex: action.snapshot.currentShopIndex,
        roundResult: action.snapshot.roundResult,
        lastRoundOutcome: action.snapshot.lastRoundOutcome,
        wind: action.snapshot.wind,
        earningsOverlay: action.snapshot.earningsOverlay,
      };
    default:
      return state;
  }
}
