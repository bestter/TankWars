import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { TurnManager } from '../TurnManager';
import type { TankManager } from '../../entities/TankManager';
import type { TerrainManager } from '../Terrain';
import type { AIEngine } from '../../entities/ai/AIEngine';

interface PrivateTurnManager {
  currentPlayerIndex: number;
  turnNumber: number;
  isInputLocked: boolean;
  isProcessingAI: boolean;
  interRoundPaused: boolean;
  aiTurnGeneration: number;
  physicsSettlementTimeoutId: ReturnType<typeof setTimeout> | number | null;
  isResolutionSafetyArmed: boolean;
  resolutionAccumulatedTime: number;
  resolutionPlayer: unknown;
  isSettlementSafetyArmed: boolean;
  settlementAccumulatedTime: number;
  settlementPlayerId: string | null;
  isTurnLockWatchdogArmed: boolean;
  turnLockAccumulatedTime: number;
  awaitingTankStabilization: boolean;
  wasFallingForHud: boolean;
}

describe('TurnManager', () => {
  let turnManager: TurnManager;
  let mockTankManager: Partial<TankManager>;
  let mockTerrainManager: Partial<TerrainManager>;
  let mockFireCallback: Mock;
  let mockAiEngine: Partial<AIEngine>;

  beforeEach(() => {
    mockTankManager = {
      getPlayers: vi.fn().mockReturnValue([]),
      anyTankIsFalling: vi.fn().mockReturnValue(false),
    };
    mockTerrainManager = {};
    mockFireCallback = vi.fn();
    mockAiEngine = {};

    turnManager = new TurnManager(
      mockTankManager as TankManager,
      mockTerrainManager as TerrainManager,
      mockFireCallback,
      mockAiEngine as AIEngine
    );
  });

  describe('reset', () => {
    it('should reset turn state variables to initial values', () => {
      const priv = turnManager as unknown as PrivateTurnManager;

      // Setup dirty state
      priv.currentPlayerIndex = 2;
      priv.turnNumber = 5;
      priv.isInputLocked = true;
      priv.isProcessingAI = true;
      priv.interRoundPaused = true;

      const initialAiTurnGen = priv.aiTurnGeneration;

      // Also set some timeouts/flags that should be cleared
      vi.spyOn(globalThis, 'clearTimeout');
      priv.physicsSettlementTimeoutId = 123 as unknown as ReturnType<typeof setTimeout>;

      priv.isResolutionSafetyArmed = true;
      priv.resolutionAccumulatedTime = 5;
      priv.resolutionPlayer = {} as unknown;

      priv.isSettlementSafetyArmed = true;
      priv.settlementAccumulatedTime = 2.5;
      priv.settlementPlayerId = "player1";

      priv.isTurnLockWatchdogArmed = true;
      priv.turnLockAccumulatedTime = 10;

      priv.awaitingTankStabilization = true;
      priv.wasFallingForHud = true;

      // Mock removeInputListeners since we don't have full DOM mock
      turnManager['removeInputListeners'] = vi.fn();

      turnManager.reset();

      // Verify reset state
      expect(priv.currentPlayerIndex).toBe(0);
      expect(priv.turnNumber).toBe(1);
      expect(priv.isInputLocked).toBe(false);
      expect(priv.isProcessingAI).toBe(false);
      expect(priv.interRoundPaused).toBe(false);
      expect(priv.aiTurnGeneration).toBe(initialAiTurnGen + 1);

      // Verify timeouts/flags cleared
      expect(globalThis.clearTimeout).toHaveBeenCalledWith(123);
      expect(priv.physicsSettlementTimeoutId).toBeNull();

      expect(priv.isResolutionSafetyArmed).toBe(false);
      expect(priv.resolutionAccumulatedTime).toBe(0);
      expect(priv.resolutionPlayer).toBeNull();

      expect(priv.isSettlementSafetyArmed).toBe(false);
      expect(priv.settlementAccumulatedTime).toBe(0);
      expect(priv.settlementPlayerId).toBeNull();

      expect(priv.isTurnLockWatchdogArmed).toBe(false);
      expect(priv.turnLockAccumulatedTime).toBe(0);

      expect(priv.awaitingTankStabilization).toBe(false);
      expect(priv.wasFallingForHud).toBe(false);

      expect(turnManager['removeInputListeners']).toHaveBeenCalled();

      vi.restoreAllMocks();
    });
  });
});
