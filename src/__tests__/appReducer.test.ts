import { describe, it, expect } from "vitest";
import { appReducer, createInitialAppState } from "../appReducer";
import type { AppState, AppAction, OnlineMeta } from "../appReducer";
import type { Player } from "../types/player";
import type { PersistedOnlineSession } from "../utils/onlineSession";

describe("appReducer", () => {
  describe("createInitialAppState", () => {
    it("should return MENU phase and nulls when passed null", () => {
      const state = createInitialAppState(null);
      expect(state).toEqual({
        phase: "MENU",
        players: null,
        onlineMeta: null,
        forceShowOnlineLobby: false,
        onlineMatchStarted: false,
        resumeCanvas: null,
      });
    });

    it("should return COMBAT phase and session data when passed a valid session", () => {
      const mockPlayer: Player = {
        id: "p1",
        name: "Test Player",
        color: "#ff0000",
        type: "LOCAL",
      };

      const mockMeta: OnlineMeta = {
        roomId: "room-123",
        localPlayerId: "p1",
      };

      const mockSession: PersistedOnlineSession = {
        roomId: "room-123",
        localPlayerId: "p1",
        meta: mockMeta,
        players: [mockPlayer],
        lastUpdate: Date.now(),
        canvas: null,
      };

      const state = createInitialAppState(mockSession);

      expect(state).toEqual({
        phase: "COMBAT",
        players: [mockPlayer],
        onlineMeta: mockMeta,
        forceShowOnlineLobby: false,
        onlineMatchStarted: true,
        resumeCanvas: null,
      });
    });
  });

  describe("appReducer", () => {
    const initialState: AppState = {
      phase: "MENU",
      players: null,
      onlineMeta: null,
      forceShowOnlineLobby: false,
      onlineMatchStarted: false,
      resumeCanvas: null,
    };

    const mockPlayer: Player = {
      id: "p1",
      name: "Test Player",
      color: "#ff0000",
      type: "LOCAL",
    };

    it("should handle START_LOCAL_GAME", () => {
      const action: AppAction = {
        type: "START_LOCAL_GAME",
        players: [mockPlayer],
      };
      const newState = appReducer(initialState, action);

      expect(newState.phase).toBe("COMBAT");
      expect(newState.players).toEqual([mockPlayer]);
      expect(newState.onlineMeta).toBeNull();
    });

    it("should handle START_ONLINE_GAME", () => {
      const mockMeta: OnlineMeta = {
        roomId: "room-123",
        localPlayerId: "p1",
      };
      const action: AppAction = {
        type: "START_ONLINE_GAME",
        players: [mockPlayer],
        meta: mockMeta,
      };

      const newState = appReducer(initialState, action);

      expect(newState.phase).toBe("COMBAT");
      expect(newState.players).toEqual([mockPlayer]);
      expect(newState.onlineMeta).toEqual(mockMeta);
      expect(newState.onlineMatchStarted).toBe(true);
      expect(newState.forceShowOnlineLobby).toBe(false);
      expect(newState.resumeCanvas).toBeNull();
    });

    it("should handle RETURN_TO_MENU", () => {
      const combatState: AppState = {
        phase: "COMBAT",
        players: [mockPlayer],
        onlineMeta: { roomId: "room-123", localPlayerId: "p1" },
        forceShowOnlineLobby: true,
        onlineMatchStarted: true,
        resumeCanvas: null, // we can test with this later or create a mock snapshot
      };

      const action: AppAction = { type: "RETURN_TO_MENU" };
      const newState = appReducer(combatState, action);

      expect(newState).toEqual({
        ...combatState,
        phase: "MENU",
        players: null,
        onlineMeta: null,
        resumeCanvas: null,
        onlineMatchStarted: false,
        forceShowOnlineLobby: false,
      });
    });

    it("should handle SHOW_ONLINE_LOBBY", () => {
      const action: AppAction = { type: "SHOW_ONLINE_LOBBY" };
      const newState = appReducer(initialState, action);

      expect(newState.forceShowOnlineLobby).toBe(true);
    });

    it("should handle HIDE_ONLINE_LOBBY", () => {
      const stateWithLobbyOpen = {
        ...initialState,
        forceShowOnlineLobby: true,
      };
      const action: AppAction = { type: "HIDE_ONLINE_LOBBY" };
      const newState = appReducer(stateWithLobbyOpen, action);

      expect(newState.forceShowOnlineLobby).toBe(false);
    });

    it("should return current state for unknown action", () => {
      const action = { type: "UNKNOWN_ACTION" } as unknown as AppAction;
      const newState = appReducer(initialState, action);

      expect(newState).toBe(initialState);
    });
  });
});
