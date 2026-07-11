import type { GamePhase } from "./types/game";
import type { Player } from "./types/player";
import type {
  OnlineCanvasSnapshot,
  PersistedOnlineSession,
} from "./utils/onlineSession";

export interface OnlineMeta {
  roomId: string;
  localPlayerId: string;
  initialHeights?: number[];
  initialWind?: number;
  initialCurrentPlayerIndex?: number;
  slot?: number;
  token?: string;
  ws?: WebSocket;
}

export interface AppState {
  phase: GamePhase;
  players: Player[] | null;
  onlineMeta: OnlineMeta | null;
  forceShowOnlineLobby: boolean;
  onlineMatchStarted: boolean;
  resumeCanvas: OnlineCanvasSnapshot | null;
}

export type AppAction =
  | { type: "START_LOCAL_GAME"; players: Player[] }
  | {
      type: "START_ONLINE_GAME";
      players: Player[];
      meta: OnlineMeta;
    }
  | { type: "RETURN_TO_MENU" }
  | { type: "SHOW_ONLINE_LOBBY" }
  | { type: "HIDE_ONLINE_LOBBY" };

export function createInitialAppState(
  savedSession: PersistedOnlineSession | null,
): AppState {
  return {
    phase: savedSession ? "COMBAT" : "MENU",
    players: savedSession?.players ?? null,
    onlineMeta: savedSession?.meta ?? null,
    forceShowOnlineLobby: false,
    onlineMatchStarted: !!savedSession,
    resumeCanvas: savedSession?.canvas ?? null,
  };
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "START_LOCAL_GAME":
      return {
        ...state,
        players: action.players,
        phase: "COMBAT",
      };
    case "START_ONLINE_GAME":
      return {
        ...state,
        players: action.players,
        onlineMeta: action.meta,
        resumeCanvas: null,
        onlineMatchStarted: true,
        forceShowOnlineLobby: false,
        phase: "COMBAT",
      };
    case "RETURN_TO_MENU":
      return {
        ...state,
        players: null,
        onlineMeta: null,
        resumeCanvas: null,
        onlineMatchStarted: false,
        forceShowOnlineLobby: false,
        phase: "MENU",
      };
    case "SHOW_ONLINE_LOBBY":
      return { ...state, forceShowOnlineLobby: true };
    case "HIDE_ONLINE_LOBBY":
      return { ...state, forceShowOnlineLobby: false };
    default:
      return state;
  }
}
