import type { GamePhase, RoundResult } from "../types/game";
import type { Player } from "../types/player";
import type { CurrentTurnInfo } from "../game/engine/TurnManager";

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
}

export type GameCanvasAction =
  | { type: "SET_WIND"; wind: number }
  | { type: "SET_TURN_INFO"; info: CurrentTurnInfo | null }
  | { type: "SET_UI_PLAYERS"; players: Player[] }
  | { type: "START_CELEBRATION"; payload: { roundWinner: Player | null; roundResult: RoundResult; uiPlayers: Player[] } }
  | { type: "GO_TO_SUMMARY" }
  | { type: "START_SHOP"; roster: Player[] }
  | { type: "ADVANCE_SHOPPER"; nextIndex: number }
  | { type: "MUTATE_SHOP_PLAYERS"; players: Player[] }
  | { type: "FINISH_SHOP"; uiPlayers: Player[] }
  | { type: "END_MATCH_FROM_SHOP"; winner: Player | null }
  | { type: "SHOW_NEW_GAME_BUTTON"; show: boolean }
  | { type: "RESET_GAME"; newPlayers: Player[] }
  | { type: "RESUME_CANVAS"; snapshot: Pick<GameCanvasState, "gamePhase" | "currentManche" | "uiPlayers" | "shopPlayers" | "currentShopIndex" | "roundResult" | "lastRoundOutcome" | "wind"> };

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
      };
    case "END_MATCH_FROM_SHOP":
      return {
        ...state,
        gamePhase: "GAME_OVER",
        shopPlayers: [],
        winner: action.winner,
        showNewGameButton: false,
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
      };
    default:
      return state;
  }
}
