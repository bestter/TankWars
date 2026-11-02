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
import { copyLivingPlayerStatus } from "../playerStatus";

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

  it("stores a protocol mismatch overlay payload", () => {
    const nextState = gameCanvasReducer(INITIAL_STATE, {
      type: "SET_PROTOCOL_MISMATCH",
      mismatch: { requiredVersion: 1, receivedVersion: null },
    });
    expect(nextState.protocolMismatch).toEqual({
      requiredVersion: 1,
      receivedVersion: null,
    });
  });

  it("conserve puis efface une intention FIRE corrélable", () => {
    const intent = {
      actionId: "fire-pending-1",
      command: { angle: 45, power: 50, weaponId: "GRENADE" as const },
    };
    const pendingState = gameCanvasReducer(INITIAL_STATE, {
      type: "SET_FIRE_PENDING",
      intent,
    });
    expect(pendingState.pendingFireIntent).toEqual(intent);

    const clearedState = gameCanvasReducer(pendingState, {
      type: "SET_FIRE_PENDING",
      intent: null,
    });
    expect(clearedState.pendingFireIntent).toBeNull();
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
      earningsByPlayer: { p1: 150 },
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
      earningsByPlayer: {},
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

  it("starts a local visit with a fresh epoch and fresh counters", () => {
    const roster = [createMockPlayer("p1", "Alice"), createMockPlayer("p2", "Bob")];
    const stateBefore: GameCanvasState = {
      ...INITIAL_STATE,
      lastAppliedShopEpoch: 4,
      shopSession: {
        ...INITIAL_STATE.shopSession,
        counters: { p1: { NUKE: 1 } },
      },
    };

    const nextState = gameCanvasReducer(stateBefore, {
      type: "START_SHOP",
      roster,
      mode: "local",
      completedRoundNumber: 2,
    });

    expect(nextState.shopSession).toMatchObject({
      epoch: 5,
      roundNumber: 2,
      counters: {},
      authoritativeReceived: true,
    });
  });

  it("waits for the first authoritative SHOP_STATE online", () => {
    const roster = [createMockPlayer("p1", "Alice"), createMockPlayer("p2", "Bob")];
    const started = gameCanvasReducer(INITIAL_STATE, {
      type: "START_SHOP",
      roster,
      mode: "online",
      completedRoundNumber: 3,
    });
    expect(started.shopSession).toMatchObject({
      epoch: null,
      roundNumber: 3,
      authoritativeReceived: false,
      counters: {},
    });

    const pendingIntent = {
      kind: "READY" as const,
      actionId: "ready-1",
      shopEpoch: 7,
    };
    const withPending = gameCanvasReducer(started, {
      type: "SET_SHOP_PENDING",
      intent: pendingIntent,
    });
    const authoritative = gameCanvasReducer(withPending, {
      type: "APPLY_SHOP_STATE",
      shopEpoch: 7,
      roundNumber: 3,
      readySlots: [1],
      players: roster,
      counters: { p1: { NUKE: 1 }, p2: { GRENADE: 2 } },
      aiShopApplied: true,
    });
    expect(authoritative.shopSession).toEqual({
      epoch: 7,
      roundNumber: 3,
      readySlots: [1],
      counters: { p1: { NUKE: 1 }, p2: { GRENADE: 2 } },
      aiShopApplied: true,
      authoritativeReceived: true,
      pendingIntent,
      denial: null,
    });
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
      roundResult: { damageDealt: {}, earningsByPlayer: {}, terrainDestroyed: 5, survivors: [] },
    };

    const action: GameCanvasAction = {
      type: "FINISH_SHOP",
      uiPlayers: roster,
      shopEpoch: 6,
    };
    const nextState = gameCanvasReducer(stateBefore, action);

    expect(nextState.gamePhase).toBe("COMBAT");
    expect(nextState.lastRoundOutcome).toBeNull();
    expect(nextState.roundResult).toBeNull();
    expect(nextState.shopPlayers).toEqual([]);
    expect(nextState.currentShopIndex).toBe(0);
    expect(nextState.uiPlayers).toEqual(roster);
    expect(nextState.lastAppliedShopEpoch).toBe(6);
    expect(nextState.shopSession).toEqual(INITIAL_STATE.shopSession);
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
      ...INITIAL_STATE,
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
      roundResult: { damageDealt: {}, earningsByPlayer: {}, terrainDestroyed: 100, survivors: [] },
      currentManche: 4,
      lastRoundOutcome: { isDraw: false, winner: newPlayers[0] },
      shopPlayers: [newPlayers[0]],
      currentShopIndex: 1,
      uiPlayers: [newPlayers[0]],
      earningsOverlay: null,
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
    expect(nextState.playerStatus).toBeNull();
  });

  it("keeps the same state when the displayed tank status is unchanged", () => {
    const player = createMockPlayer("p1", "Alice");
    const first = gameCanvasReducer(INITIAL_STATE, {
      type: "SET_PLAYER_STATUS",
      players: copyLivingPlayerStatus([player]),
    });
    player.tank.angle = 120;
    player.tank.power = 10;
    const same = gameCanvasReducer(first, {
      type: "SET_PLAYER_STATUS",
      players: copyLivingPlayerStatus([player]),
    });
    expect(same).toBe(first);
    expect(gameCanvasReducer(INITIAL_STATE, { type: "SET_PLAYER_STATUS", players: null })).toBe(INITIAL_STATE);

    player.tank.health = 40;
    const changed = gameCanvasReducer(same, {
      type: "SET_PLAYER_STATUS",
      players: copyLivingPlayerStatus([player]),
    });
    expect(changed.playerStatus?.[0]?.health).toBe(40);
  });

  it("clears tank status when combat stops being aimable", () => {
    const player = createMockPlayer("p1", "Alice");
    const armed = gameCanvasReducer(INITIAL_STATE, {
      type: "SET_PLAYER_STATUS",
      players: copyLivingPlayerStatus([player]),
    });
    const roundResult: RoundResult = {
      damageDealt: {},
      earningsByPlayer: {},
      terrainDestroyed: 0,
      survivors: ["p1"],
    };
    const cleared = [
      gameCanvasReducer(armed, { type: "GO_TO_SUMMARY" }),
      gameCanvasReducer(armed, {
        type: "START_CELEBRATION",
        payload: { roundWinner: player, roundResult, uiPlayers: [player] },
      }),
      gameCanvasReducer(armed, { type: "START_SHOP", roster: [player] }),
      gameCanvasReducer(armed, {
        type: "APPLY_SHOP_STATE",
        shopEpoch: 1,
        roundNumber: 1,
        readySlots: [],
        players: [player],
        counters: {},
        aiShopApplied: false,
      }),
      gameCanvasReducer(armed, { type: "END_MATCH_FROM_SHOP", winner: player }),
      gameCanvasReducer(armed, { type: "RESET_COMBAT_PROGRESS", roundNumber: 2 }),
      gameCanvasReducer(armed, { type: "RESET_GAME", newPlayers: [player] }),
      gameCanvasReducer(armed, {
        type: "RESUME_CANVAS",
        snapshot: {
          gamePhase: "COMBAT",
          currentManche: 2,
          uiPlayers: [player],
          shopPlayers: [],
          currentShopIndex: 0,
          roundResult: null,
          lastRoundOutcome: null,
          wind: 1,
          earningsOverlay: null,
        },
      }),
    ];
    for (const next of cleared) {
      expect(next.playerStatus).toBeNull();
    }
  });

  it("keeps the aiming list when an error does not close the combat gate", () => {
    const player = createMockPlayer("p1", "Alice");
    const armed = gameCanvasReducer(INITIAL_STATE, {
      type: "SET_PLAYER_STATUS",
      players: copyLivingPlayerStatus([player]),
    });
    const preparation = gameCanvasReducer(armed, {
      type: "SET_ROUND_PREPARATION_ERROR",
      reason: "EXHAUSTED",
    });
    const mismatch = gameCanvasReducer(armed, {
      type: "SET_PROTOCOL_MISMATCH",
      mismatch: { requiredVersion: 4, receivedVersion: 3 },
    });
    expect(preparation.playerStatus).toBe(armed.playerStatus);
    expect(preparation.roundPreparationError).toBe("EXHAUSTED");
    expect(mismatch.playerStatus).toBe(armed.playerStatus);
    expect(mismatch.protocolMismatch).toEqual({ requiredVersion: 4, receivedVersion: 3 });
  });
});
