import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { TurnManager } from '../TurnManager';
import type { TankManager } from '../../entities/TankManager';
import type { TerrainManager } from '../Terrain';
import type { AIEngine } from '../../entities/ai/AIEngine';

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
      // Setup dirty state
      (turnManager as any).currentPlayerIndex = 2;
      (turnManager as any).turnNumber = 5;
      (turnManager as any).isInputLocked = true;
      (turnManager as any).isProcessingAI = true;
      (turnManager as any).interRoundPaused = true;

      const initialAiTurnGen = (turnManager as any).aiTurnGeneration;

      // Also set some timeouts/flags that should be cleared
      (turnManager as any).physicsSettlementTimeoutId = 123;
      (turnManager as any).isResolutionSafetyArmed = true;
      (turnManager as any).isSettlementSafetyArmed = true;
      (turnManager as any).isTurnLockWatchdogArmed = true;
      (turnManager as any).awaitingTankStabilization = true;

      // Mock removeInputListeners since we don't have full DOM mock
      turnManager['removeInputListeners'] = vi.fn();

      turnManager.reset();

      // Verify reset state
      expect((turnManager as any).currentPlayerIndex).toBe(0);
      expect((turnManager as any).turnNumber).toBe(1);
      expect((turnManager as any).isInputLocked).toBe(false);
      expect((turnManager as any).isProcessingAI).toBe(false);
      expect((turnManager as any).interRoundPaused).toBe(false);
      expect((turnManager as any).aiTurnGeneration).toBe(initialAiTurnGen + 1);

      // Verify timeouts/flags cleared
      expect((turnManager as any).physicsSettlementTimeoutId).toBeNull();
      expect((turnManager as any).isResolutionSafetyArmed).toBe(false);
      expect((turnManager as any).isSettlementSafetyArmed).toBe(false);
      expect((turnManager as any).isTurnLockWatchdogArmed).toBe(false);
      expect((turnManager as any).awaitingTankStabilization).toBe(false);

      expect(turnManager['removeInputListeners']).toHaveBeenCalled();
    });
  });
});
