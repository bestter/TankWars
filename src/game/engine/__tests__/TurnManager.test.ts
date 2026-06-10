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
    it('should call clear methods and reset properties', () => {
      // Arrange: Setup dirty state on primitive properties directly
      (turnManager as any).currentPlayerIndex = 2;
      (turnManager as any).turnNumber = 5;
      (turnManager as any).isInputLocked = true;
      (turnManager as any).isProcessingAI = true;
      (turnManager as any).interRoundPaused = true;

      const initialAiTurnGen = (turnManager as any).aiTurnGeneration;

      // Arrange: Spy on the internal clear methods called by reset
      const clearPhysicsSpy = vi.spyOn(turnManager as any, 'clearPhysicsSettlementTimeout');
      const clearResSpy = vi.spyOn(turnManager as any, 'clearResolutionTimeout');
      const clearSettlementSpy = vi.spyOn(turnManager as any, 'clearSettlementSafetyTimeout');
      const clearTurnLockSpy = vi.spyOn(turnManager as any, 'clearTurnLockSafetyTimeout');
      const clearAwaitingSpy = vi.spyOn(turnManager as any, 'clearAwaitingStabilization');
      const removeInputListenersSpy = vi.spyOn(turnManager as any, 'removeInputListeners');

      // Act
      turnManager.reset();

      // Assert: Verify internal clears were called
      expect(clearPhysicsSpy).toHaveBeenCalled();
      expect(clearResSpy).toHaveBeenCalled();
      expect(clearSettlementSpy).toHaveBeenCalled();
      expect(clearTurnLockSpy).toHaveBeenCalled();
      expect(clearAwaitingSpy).toHaveBeenCalled();
      expect(removeInputListenersSpy).toHaveBeenCalled();

      // Assert: Verify property assignments
      expect((turnManager as any).currentPlayerIndex).toBe(0);
      expect((turnManager as any).turnNumber).toBe(1);
      expect((turnManager as any).isInputLocked).toBe(false);
      expect((turnManager as any).isProcessingAI).toBe(false);
      expect((turnManager as any).interRoundPaused).toBe(false);
      expect((turnManager as any).aiTurnGeneration).toBe(initialAiTurnGen + 1);

      vi.restoreAllMocks();
    });
  });
});
