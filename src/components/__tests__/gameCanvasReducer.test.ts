import { describe, it, expect } from "vitest";
import {
  gameCanvasReducer,
  INITIAL_STATE,
  type GameCanvasState,
  type GameCanvasAction,
} from "../gameCanvasReducer";
import { VGA_PALETTE } from "../../types/game";
import type { Player } from "../../types/player";
import type { CurrentTurnInfo } from "../../game/engine/TurnManager";
import type { RoundResult } from "../../types/game";

// Helper function to create a minimal valid Player object for testing
function createMockPlayer(id: string, name: string): Player {
  return {
    id,
    name,
    isHuman: true,
    money: 1000,
    inventory: {
      GRENADE: 2,
    },
    tank: {
      id: `tank-${id}`,
      position: { x: 100, y: 200 },
      angle: 45,
      power: 50,
      health: 100,
      maxHealth: 100,
      shield: 0,
      maxShield: 50,
      isDead: false,
      color: VGA_PALETTE.GREEN,
      currentWeapon: "MISSILE",
    },
  };
}

describe("gameCanvasReducer", () => {
  it("should return initial state by default for unknown action", () => {
    // @ts-expect-error - testing invalid action type
    const state = gameCanvasReducer(INITIAL_STATE, { type: "UNKNOWN_ACTION" });
    expect(state).toEqual(INITIAL_STATE);
  });

  it("should handle SET_WIND action", () => {
    const action: GameCanvasAction = { type: "SET_WIND", wind: 15 };
    const nextState = gameCanvasReducer(INITIAL_STATE, action);
    expect(nextState.wind).toBe(15);
  });

  it("should handle SET_TURN_INFO action", () => {
    const mockTurnInfo: CurrentTurnInfo = {
      playerId: "p1",
      playerName: "Alice",
      isHuman: true,
      playerColor: VGA_PALETTE.GREEN,
      angle: 45,
      power: 50,
      currentWeapon: "MISSILE",
      inventory: { GRENADE: 2 },
      turn: 1,
      isInputLocked: false,
      tanksAreFalling: false,
    };
    const action: GameCanvasAction = { type: "SET_TURN_INFO", info: mockTurnInfo };
    const nextState = gameCanvasReducer(INITIAL_STATE, action);
    expect(nextState.turnInfo).toEqual(mockTurnInfo);
  });

  it("should handle SET_UI_PLAYERS action", () => {
    const players = [createMockPlayer("p1", "Alice"), createMockPlayer("p2", "Bob")];
    const action: GameCanvasAction = { type: "SET_UI_PLAYERS", players };
    const nextState = gameCanvasReducer(INITIAL_STATE, action);
    expect(nextState.uiPlayers).toEqual(players);
  });

  it("should handle START_CELEBRATION action", () => {
    const players = [createMockPlayer("p1", "Alice"), createMockPlayer("p2", "Bob")];
    const roundResult: RoundResult = {
      damageDealt: { p1: 50 },
      terrainDestroyed: 120,
      survivors: ["p1"],
    };
    const action: GameCanvasAction = {
      type: "START_CELEBRATION",
      payload: {
        roundWinner: players[0],
        roundResult,
        uiPlayers: players,
      },
    };

    const stateBefore: GameCanvasState = {
      ...INITIAL_STATE,
      currentManche: 1,
    };

    const nextState = gameCanvasReducer(stateBefore, action);

    expect(nextState.gamePhase).toBe("CELEBRATION");
    expect(nextState.currentManche).toBe(2);
    expect(nextState.winner).toBeNull();
    expect(nextState.showNewGameButton).toBe(false);
    expect(nextState.roundResult).toEqual(roundResult);
    expect(nextState.lastRoundOutcome).toEqual({
      isDraw: false,
      winner: players[0],
    });
    expect(nextState.uiPlayers).toEqual(players);
  });

  it("should handle START_CELEBRATION action for a draw", () => {
    const players = [createMockPlayer("p1", "Alice"), createMockPlayer("p2", "Bob")];
    const roundResult: RoundResult = {
      damageDealt: {},
      terrainDestroyed: 0,
      survivors: [],
    };
    const action: GameCanvasAction = {
      type: "START_CELEBRATION",
      payload: {
        roundWinner: null,
        roundResult,
        uiPlayers: players,
      },
    };

    const nextState = gameCanvasReducer(INITIAL_STATE, action);

    expect(nextState.lastRoundOutcome).toEqual({
      isDraw: true,
      winner: null,
    });
  });

  it("should handle GO_TO_SUMMARY action", () => {
    const action: GameCanvasAction = { type: "GO_TO_SUMMARY" };
    const nextState = gameCanvasReducer(INITIAL_STATE, action);
    expect(nextState.gamePhase).toBe("SUMMARY");
  });

  it("should handle START_SHOP action", () => {
    const roster = [createMockPlayer("p1", "Alice"), createMockPlayer("p2", "Bob")];
    const action: GameCanvasAction = { type: "START_SHOP", roster };
    const stateBefore: GameCanvasState = {
      ...INITIAL_STATE,
      currentShopIndex: 3, // some dirty state
    };
    const nextState = gameCanvasReducer(stateBefore, action);

    expect(nextState.gamePhase).toBe("SHOP");
    expect(nextState.shopPlayers).toEqual(roster);
    expect(nextState.uiPlayers).toEqual(roster);
    expect(nextState.currentShopIndex).toBe(0);
  });

  it("should handle ADVANCE_SHOPPER action", () => {
    const action: GameCanvasAction = { type: "ADVANCE_SHOPPER", nextIndex: 1 };
    const nextState = gameCanvasReducer(INITIAL_STATE, action);
    expect(nextState.currentShopIndex).toBe(1);
  });

  it("should handle MUTATE_SHOP_PLAYERS action and correctly update both shopPlayers and uiPlayers", () => {
    const p1 = createMockPlayer("p1", "Alice");
    const p2 = createMockPlayer("p2", "Bob");

    // Starting state has the original players
    const stateBefore: GameCanvasState = {
      ...INITIAL_STATE,
      gamePhase: "SHOP",
      shopPlayers: [p1, p2],
      uiPlayers: [p1, p2],
      currentShopIndex: 0,
    };

    // Mutated players: Bob has purchased a grenade (money decreases, grenade increases)
    const p2Mutated: Player = {
      ...p2,
      money: 925, // bought 1 grenade ($75)
      inventory: {
        GRENADE: 3,
      },
    };
    const mutatedPlayers = [p1, p2Mutated];

    const action: GameCanvasAction = {
      type: "MUTATE_SHOP_PLAYERS",
      players: mutatedPlayers,
    };

    const nextState = gameCanvasReducer(stateBefore, action);

    // Assert that the state objects are correctly updated
    expect(nextState.shopPlayers).toEqual(mutatedPlayers);
    expect(nextState.uiPlayers).toEqual(mutatedPlayers);

    // Verify referential change to trigger React re-renders
    expect(nextState.shopPlayers).not.toBe(stateBefore.shopPlayers);
    expect(nextState.shopPlayers[1].money).toBe(925);
    expect(nextState.shopPlayers[1].inventory.GRENADE).toBe(3);
  });

  it("should handle FINISH_SHOP action", () => {
    const roster = [createMockPlayer("p1", "Alice"), createMockPlayer("p2", "Bob")];
    const stateBefore: GameCanvasState = {
      ...INITIAL_STATE,
      gamePhase: "SHOP",
      shopPlayers: roster,
      uiPlayers: roster,
      currentShopIndex: 1,
      lastRoundOutcome: { isDraw: false, winner: roster[0] },
      roundResult: { damageDealt: {}, terrainDestroyed: 5, survivors: [] },
    };

    const action: GameCanvasAction = { type: "FINISH_SHOP", uiPlayers: roster };
    const nextState = gameCanvasReducer(stateBefore, action);

    expect(nextState.gamePhase).toBe("COMBAT");
    expect(nextState.lastRoundOutcome).toBeNull();
    expect(nextState.roundResult).toBeNull();
    expect(nextState.shopPlayers).toEqual([]);
    expect(nextState.currentShopIndex).toBe(0);
    expect(nextState.uiPlayers).toEqual(roster);
  });

  it("should handle END_MATCH_FROM_SHOP action", () => {
    const roster = [createMockPlayer("p1", "Alice"), createMockPlayer("p2", "Bob")];
    const stateBefore: GameCanvasState = {
      ...INITIAL_STATE,
      gamePhase: "SHOP",
      shopPlayers: roster,
    };

    const action: GameCanvasAction = {
      type: "END_MATCH_FROM_SHOP",
      winner: roster[0],
    };
    const nextState = gameCanvasReducer(stateBefore, action);

    expect(nextState.gamePhase).toBe("GAME_OVER");
    expect(nextState.shopPlayers).toEqual([]);
    expect(nextState.winner).toEqual(roster[0]);
    expect(nextState.showNewGameButton).toBe(false);
  });

  it("should handle SHOW_NEW_GAME_BUTTON action", () => {
    const action: GameCanvasAction = { type: "SHOW_NEW_GAME_BUTTON", show: true };
    const nextState = gameCanvasReducer(INITIAL_STATE, action);
    expect(nextState.showNewGameButton).toBe(true);
  });

  it("should handle RESET_GAME action", () => {
    const newPlayers = [createMockPlayer("p1", "Alice"), createMockPlayer("p2", "Bob")];
    const dirtyState: GameCanvasState = {
      gamePhase: "GAME_OVER",
      wind: 20,
      turnInfo: {
        playerId: "p1",
        playerName: "Alice",
        isHuman: true,
        playerColor: VGA_PALETTE.GREEN,
        angle: 45,
        power: 50,
        currentWeapon: "MISSILE",
        inventory: { GRENADE: 2 },
        turn: 1,
        isInputLocked: false,
        tanksAreFalling: false,
      },
      winner: newPlayers[0],
      showNewGameButton: true,
      roundResult: { damageDealt: {}, terrainDestroyed: 100, survivors: [] },
      currentManche: 4,
      lastRoundOutcome: { isDraw: false, winner: newPlayers[0] },
      shopPlayers: [newPlayers[0]],
      currentShopIndex: 1,
      uiPlayers: [newPlayers[0]],
    };

    const action: GameCanvasAction = { type: "RESET_GAME", newPlayers };
    const nextState = gameCanvasReducer(dirtyState, action);

    expect(nextState.gamePhase).toBe("COMBAT");
    expect(nextState.winner).toBeNull();
    expect(nextState.showNewGameButton).toBe(false);
    expect(nextState.turnInfo).toBeNull();
    expect(nextState.roundResult).toBeNull();
    expect(nextState.currentManche).toBe(1);
    expect(nextState.uiPlayers).toEqual(newPlayers);
    expect(nextState.shopPlayers).toEqual([]);
    expect(nextState.currentShopIndex).toBe(0);
    // Note: wind is not reset by RESET_GAME in the reducer, it retains its value (or gets set separately)
    expect(nextState.wind).toBe(20);
  });
});
