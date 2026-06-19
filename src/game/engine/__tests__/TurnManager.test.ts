import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TurnManager } from '../TurnManager';
import type { TankManager } from '../../entities/TankManager';
import type { TerrainManager } from '../Terrain';
import type { AIEngine } from '../../entities/ai/AIEngine';
import { makePlayer } from '../../__tests__/helpers';

describe('TurnManager', () => {
  let turnManager: TurnManager;
  let mockTankManager: Partial<TankManager>;
  let mockTerrainManager: Partial<TerrainManager>;
  const mockFireCallback = vi.fn();
  let mockAiEngine: Partial<AIEngine>;

  beforeEach(() => {
    mockTankManager = {
      getPlayers: vi.fn().mockReturnValue([]),
      anyTankIsFalling: vi.fn().mockReturnValue(false),
    };
    mockTerrainManager = {};
    mockFireCallback.mockReset();
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

  describe('HUD update throttling', () => {
    function createHumanPlayer() {
      return makePlayer({
        id: 'human-1',
        tank: {
          ...makePlayer().tank,
          id: 'tank-human',
          angle: 45,
          power: 50,
          currentWeapon: 'MISSILE',
        },
        inventory: { MISSILE: 99, GRENADE: 2 },
      });
    }

    beforeEach(() => {
      vi.useFakeTimers();
      mockTankManager.getPlayers = vi.fn().mockReturnValue([createHumanPlayer()]);
      turnManager = new TurnManager(
        mockTankManager as TankManager,
        mockTerrainManager as TerrainManager,
        mockFireCallback,
        mockAiEngine as AIEngine,
      );
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('throttles rapid angle adjustments to one follow-up dispatch', () => {
      const hudUpdates = vi.fn();
      turnManager.onHudUpdate = hudUpdates;

      turnManager.adjustAngle(1);
      turnManager.adjustAngle(1);
      turnManager.adjustAngle(1);

      expect(hudUpdates).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(66);

      expect(hudUpdates).toHaveBeenCalledTimes(2);
      expect(hudUpdates.mock.calls[1][0].angle).toBe(48);
    });

    it('dispatches immediately on structural weapon change during throttle window', () => {
      const hudUpdates = vi.fn();
      turnManager.onHudUpdate = hudUpdates;

      turnManager.adjustAngle(2);
      hudUpdates.mockClear();

      turnManager.adjustAngle(1);
      turnManager.selectWeapon('GRENADE');

      expect(hudUpdates).toHaveBeenCalledTimes(1);
      expect(hudUpdates.mock.calls[0][0].currentWeapon).toBe('GRENADE');
    });

    it('clears pending HUD throttle timer on removeInputListeners', () => {
      const hudUpdates = vi.fn();
      turnManager.onHudUpdate = hudUpdates;

      turnManager.adjustAngle(1);
      hudUpdates.mockClear();

      turnManager.adjustAngle(1);
      turnManager.removeInputListeners();

      vi.advanceTimersByTime(100);

      expect(hudUpdates).not.toHaveBeenCalled();
    });
  });
});
