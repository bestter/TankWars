import type { FireCommand, GamePhase, RoundResult } from "../types/game";
import type { Player } from "../types/player";
import type { CurrentTurnInfo } from "../game/engine/TurnManager";
import type { WeaponId } from "../types/weapon";
import type {
  ShopDenial,
  ShopVisitCounters,
} from "../game/shop/shopTransaction";
import type { FireRejectedReason } from "../game/online/protocol";

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

export interface PendingFireIntent {
  readonly actionId: string;
  readonly command: FireCommand;
}

export type PendingShopIntent =
  | {
      readonly kind: "BUY_SELL";
      readonly actionId: string;
      readonly shopEpoch: number;
      readonly weaponId: WeaponId;
      readonly delta: 1 | -1;
    }
  | {
      readonly kind: "READY";
      readonly actionId: string;
      readonly shopEpoch: number;
    };

export interface ShopClientSessionState {
  readonly epoch: number | null;
  readonly roundNumber: number | null;
  readonly counters: ShopVisitCounters;
  readonly readySlots: number[];
  readonly aiShopApplied: boolean;
  readonly authoritativeReceived: boolean;
  readonly pendingIntent: PendingShopIntent | null;
  readonly denial: ShopDenial | null;
}

export function createEmptyShopSession(): ShopClientSessionState {
  return {
    epoch: null,
    roundNumber: null,
    counters: {},
    readySlots: [],
    aiShopApplied: false,
    authoritativeReceived: false,
    pendingIntent: null,
    denial: null,
  };
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
  shopSession: ShopClientSessionState;
  lastAppliedShopEpoch: number;
  lastCompletedRoundNumber: number;
  lastSeenShotId: number;
  pendingFireIntent: PendingFireIntent | null;
  fireRejection: FireRejectedReason | null;
  protocolMismatch: {
    requiredVersion: number;
    receivedVersion: number | null;
  } | null;
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
  | {
      type: "START_SHOP";
      roster: Player[];
      mode?: "local" | "online";
      completedRoundNumber?: number;
    }
  | {
      type: "APPLY_SHOP_STATE";
      shopEpoch: number;
      roundNumber: number;
      readySlots: number[];
      players: Player[];
      counters: ShopVisitCounters;
      aiShopApplied: boolean;
    }
  | { type: "SET_SHOP_PENDING"; intent: PendingShopIntent | null }
  | { type: "SET_SHOP_DENIAL"; denial: ShopDenial | null }
  | {
      type: "APPLY_LOCAL_SHOP_TRANSACTION";
      players: Player[];
      counters: ShopVisitCounters;
      denial: ShopDenial | null;
    }
  | { type: "ADVANCE_SHOPPER"; nextIndex: number }
  | { type: "MUTATE_SHOP_PLAYERS"; players: Player[] }
  | {
      type: "FINISH_SHOP";
      uiPlayers: Player[];
      shopEpoch?: number;
      nextRoundNumber?: number;
    }
  | { type: "SET_LAST_COMPLETED_ROUND"; roundNumber: number }
  | { type: "SET_LAST_SEEN_SHOT"; shotId: number }
  | { type: "SET_FIRE_PENDING"; intent: PendingFireIntent | null }
  | { type: "SET_FIRE_REJECTION"; reason: FireRejectedReason | null }
  | {
      type: "SET_PROTOCOL_MISMATCH";
      mismatch: {
        requiredVersion: number;
        receivedVersion: number | null;
      } | null;
    }
  | { type: "END_MATCH_FROM_SHOP"; winner: Player | null }
  | { type: "SHOW_NEW_GAME_BUTTON"; show: boolean }
  | { type: "RESET_GAME"; newPlayers: Player[] }
  | {
      type: "RESUME_CANVAS";
      snapshot: Pick<
        GameCanvasState,
        | "gamePhase"
        | "currentManche"
        | "uiPlayers"
        | "shopPlayers"
        | "currentShopIndex"
        | "roundResult"
        | "lastRoundOutcome"
        | "wind"
        | "earningsOverlay"
      > &
        Partial<
          Pick<
            GameCanvasState,
            | "shopSession"
            | "lastAppliedShopEpoch"
            | "lastCompletedRoundNumber"
            | "lastSeenShotId"
            | "pendingFireIntent"
            | "fireRejection"
          >
        >;
    };

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
  shopSession: createEmptyShopSession(),
  lastAppliedShopEpoch: 0,
  lastCompletedRoundNumber: 0,
  lastSeenShotId: 0,
  pendingFireIntent: null,
  fireRejection: null,
  protocolMismatch: null,
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
      {
        const online = action.mode === "online";
        const nextEpoch = online ? null : state.lastAppliedShopEpoch + 1;
        return {
          ...state,
          gamePhase: "SHOP",
          shopPlayers: action.roster,
          uiPlayers: action.roster,
          currentShopIndex: 0,
          zeusAnnouncement: null,
          lastCompletedRoundNumber:
            action.completedRoundNumber ?? state.lastCompletedRoundNumber,
          shopSession: {
            ...createEmptyShopSession(),
            epoch: nextEpoch,
            roundNumber:
              action.completedRoundNumber ?? state.lastCompletedRoundNumber,
            authoritativeReceived: !online,
          },
        };
      }
    case "APPLY_SHOP_STATE":
      return {
        ...state,
        gamePhase: "SHOP",
        shopPlayers: action.players,
        uiPlayers: action.players,
        currentManche: Math.max(
          state.currentManche,
          action.roundNumber + 1,
        ),
        lastCompletedRoundNumber: Math.max(
          state.lastCompletedRoundNumber,
          action.roundNumber,
        ),
        shopSession: {
          epoch: action.shopEpoch,
          roundNumber: action.roundNumber,
          counters: action.counters,
          readySlots: action.readySlots,
          aiShopApplied: action.aiShopApplied,
          authoritativeReceived: true,
          pendingIntent: state.shopSession.pendingIntent,
          denial: null,
        },
      };
    case "SET_SHOP_PENDING":
      return {
        ...state,
        shopSession: {
          ...state.shopSession,
          pendingIntent: action.intent,
          denial: action.intent ? null : state.shopSession.denial,
        },
      };
    case "SET_SHOP_DENIAL":
      return {
        ...state,
        shopSession: {
          ...state.shopSession,
          pendingIntent: null,
          denial: action.denial,
        },
      };
    case "APPLY_LOCAL_SHOP_TRANSACTION":
      return {
        ...state,
        shopPlayers: action.players,
        uiPlayers: action.players,
        shopSession: {
          ...state.shopSession,
          counters: action.counters,
          denial: action.denial,
        },
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
        shopSession: createEmptyShopSession(),
        currentManche:
          action.nextRoundNumber === undefined
            ? state.currentManche
            : Math.max(state.currentManche, action.nextRoundNumber),
        lastAppliedShopEpoch:
          action.shopEpoch === undefined
            ? state.lastAppliedShopEpoch
            : Math.max(state.lastAppliedShopEpoch, action.shopEpoch),
      };
    case "SET_LAST_COMPLETED_ROUND":
      return {
        ...state,
        lastCompletedRoundNumber: Math.max(
          state.lastCompletedRoundNumber,
          action.roundNumber,
        ),
      };
    case "SET_LAST_SEEN_SHOT":
      return {
        ...state,
        lastSeenShotId: Math.max(state.lastSeenShotId, action.shotId),
      };
    case "SET_FIRE_PENDING":
      return { ...state, pendingFireIntent: action.intent };
    case "SET_FIRE_REJECTION":
      return { ...state, fireRejection: action.reason };
    case "SET_PROTOCOL_MISMATCH":
      return { ...state, protocolMismatch: action.mismatch };
    case "END_MATCH_FROM_SHOP":
      return {
        ...state,
        gamePhase: "GAME_OVER",
        shopPlayers: [],
        winner: action.winner,
        showNewGameButton: false,
        zeusAnnouncement: null,
        shopSession: createEmptyShopSession(),
        lastAppliedShopEpoch: 0,
        lastCompletedRoundNumber: 0,
        lastSeenShotId: 0,
        pendingFireIntent: null,
        fireRejection: null,
        protocolMismatch: null,
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
        shopSession: createEmptyShopSession(),
        lastAppliedShopEpoch: 0,
        lastCompletedRoundNumber: 0,
        lastSeenShotId: 0,
        pendingFireIntent: null,
        fireRejection: null,
        protocolMismatch: null,
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
        shopSession:
          action.snapshot.shopSession ?? createEmptyShopSession(),
        lastAppliedShopEpoch: action.snapshot.lastAppliedShopEpoch ?? 0,
        lastCompletedRoundNumber:
          action.snapshot.lastCompletedRoundNumber ?? 0,
        lastSeenShotId: action.snapshot.lastSeenShotId ?? 0,
        pendingFireIntent: action.snapshot.pendingFireIntent ?? null,
        fireRejection: action.snapshot.fireRejection ?? null,
      };
    default:
      return state;
  }
}
