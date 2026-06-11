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
      Object.assign(turnManager, {
        currentPlayerIndex: 2,
        turnNumber: 5,
        isInputLocked: true,
        isProcessingAI: true,
        interRoundPaused: true,
      });

      const initialAiTurnGen = Reflect.get(turnManager, 'aiTurnGeneration') as number;

      // Arrange: Spy on the internal clear methods called by reset
      const clearPhysicsSpy = vi.spyOn(turnManager as unknown as { clearPhysicsSettlementTimeout: () => void }, 'clearPhysicsSettlementTimeout');
      const clearResSpy = vi.spyOn(turnManager as unknown as { clearResolutionTimeout: () => void }, 'clearResolutionTimeout');
      const clearSettlementSpy = vi.spyOn(turnManager as unknown as { clearSettlementSafetyTimeout: () => void }, 'clearSettlementSafetyTimeout');
      const clearTurnLockSpy = vi.spyOn(turnManager as unknown as { clearTurnLockSafetyTimeout: () => void }, 'clearTurnLockSafetyTimeout');
      const clearAwaitingSpy = vi.spyOn(turnManager as unknown as { clearAwaitingStabilization: () => void }, 'clearAwaitingStabilization');
      const removeInputListenersSpy = vi.spyOn(turnManager as unknown as { removeInputListeners: () => void }, 'removeInputListeners');

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
      expect(Reflect.get(turnManager, 'currentPlayerIndex')).toBe(0);
      expect(Reflect.get(turnManager, 'turnNumber')).toBe(1);
      expect(Reflect.get(turnManager, 'isInputLocked')).toBe(false);
      expect(Reflect.get(turnManager, 'isProcessingAI')).toBe(false);
      expect(Reflect.get(turnManager, 'interRoundPaused')).toBe(false);
      expect(Reflect.get(turnManager, 'aiTurnGeneration')).toBe(initialAiTurnGen + 1);

      vi.restoreAllMocks();
    });
  });
});
