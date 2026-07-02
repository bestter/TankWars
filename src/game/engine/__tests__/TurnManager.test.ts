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

  describe('online multiplayer input gating', () => {
    const player1 = makePlayer({
      id: 'player-1',
      name: 'Host',
      isHuman: true,
      tank: { ...makePlayer().tank, id: 'tank-1' },
    });
    const player2 = makePlayer({
      id: 'player-2',
      name: 'Guest',
      isHuman: true,
      tank: { ...makePlayer().tank, id: 'tank-2' },
    });

    beforeEach(() => {
      mockTankManager.getPlayers = vi.fn().mockReturnValue([player1, player2]);
      turnManager = new TurnManager(
        mockTankManager as TankManager,
        mockTerrainManager as TerrainManager,
        mockFireCallback,
        mockAiEngine as AIEngine,
      );
    });

    it('locks guest input on host turn after setLocalPlayerId + startFirstTurn', () => {
      turnManager.setLocalPlayerId('player-2');
      turnManager.startFirstTurn();

      const info = turnManager.getCurrentTurnInfo();
      expect(info?.playerId).toBe('player-1');
      expect(info?.isInputLocked).toBe(true);
      expect(turnManager.tryFire()).toBe(false);
    });

    it('unlocks guest input when server syncs to their turn', () => {
      turnManager.setLocalPlayerId('player-2');
      turnManager.startFirstTurn();

      turnManager.syncTurn(1);

      const info = turnManager.getCurrentTurnInfo();
      expect(info?.playerId).toBe('player-2');
      expect(info?.isInputLocked).toBe(false);
      expect(turnManager.tryFire()).toBe(true);
      expect(mockFireCallback).toHaveBeenCalledTimes(1);
    });

    it('refreshes input lock when setLocalPlayerId is called after startFirstTurn', () => {
      turnManager.startFirstTurn();
      expect(turnManager.getCurrentTurnInfo()?.isInputLocked).toBe(false);

      turnManager.setLocalPlayerId('player-2');

      expect(turnManager.getCurrentTurnInfo()?.isInputLocked).toBe(true);
    });

    it('does not advance turn index locally after a local shot resolves in online mode', () => {
      turnManager.setLocalPlayerId('player-1');
      turnManager.startFirstTurn();
      expect(turnManager.tryFire()).toBe(true);

      Reflect.set(turnManager, 'awaitingTankStabilization', true);
      turnManager.update(0.016);

      expect(Reflect.get(turnManager, 'currentPlayerIndex')).toBe(0);
      expect(turnManager.getCurrentTurnInfo()?.isInputLocked).toBe(true);
    });

    it('replays remote fire from the correct slot even when turn index is desynced', () => {
      turnManager.startFirstTurn();
      expect(Reflect.get(turnManager, 'currentPlayerIndex')).toBe(0);

      mockTankManager.anyTankIsFalling = vi.fn().mockReturnValue(true);

      turnManager.executeRemoteFire(
        { angle: 45, power: 60, weaponId: 'MISSILE' },
        { fromSlot: 1 },
      );

      expect(Reflect.get(turnManager, 'currentPlayerIndex')).toBe(1);
      expect(mockFireCallback).toHaveBeenCalledTimes(1);
      expect(mockFireCallback.mock.calls[0][2]).toBe('player-2');
    });

    it('replays remote fire while tanks are falling (bypasses local falling guard)', () => {
      turnManager.syncTurn(1);
      mockTankManager.anyTankIsFalling = vi.fn().mockReturnValue(true);

      turnManager.executeRemoteFire(
        { angle: 90, power: 70, weaponId: 'MISSILE' },
        { fromSlot: 1 },
      );

      expect(mockFireCallback).toHaveBeenCalledTimes(1);
    });

    it('replays remote fire by ownerId when fromSlot is omitted', () => {
      turnManager.startFirstTurn();

      turnManager.executeRemoteFire(
        { angle: 12, power: 55, weaponId: 'GRENADE' },
        { ownerId: 'player-2' },
      );

      expect(Reflect.get(turnManager, 'currentPlayerIndex')).toBe(1);
      expect(mockFireCallback).toHaveBeenCalledTimes(1);
      expect(mockFireCallback.mock.calls[0][2]).toBe('player-2');
    });

    it('ignores remote fire when ownerId does not match any player', () => {
      turnManager.startFirstTurn();

      turnManager.executeRemoteFire(
        { angle: 12, power: 55, weaponId: 'MISSILE' },
        { ownerId: 'unknown-player' },
      );

      expect(mockFireCallback).not.toHaveBeenCalled();
    });

    it('does not emit onShotSettled when a remote replay settles after syncTurn advanced', () => {
      const onShotSettled = vi.fn();
      turnManager.setLocalPlayerId('player-2');
      turnManager.startFirstTurn();
      turnManager.onShotSettled = onShotSettled;

      turnManager.executeRemoteFire(
        { angle: 45, power: 60, weaponId: 'MISSILE' },
        { fromSlot: 0 },
      );

      // Server STATE_UPDATE arrives before the remote replay finishes on this client.
      turnManager.syncTurn(1);

      Reflect.set(turnManager, 'awaitingTankStabilization', true);
      turnManager.update(0.016);

      expect(onShotSettled).not.toHaveBeenCalled();
      expect(turnManager.getCurrentTurnInfo()?.playerId).toBe('player-2');
      expect(turnManager.getCurrentTurnInfo()?.isInputLocked).toBe(false);
      expect(turnManager.tryFire()).toBe(true);
    });

    it('emits onShotSettled only for locally fired shots in online mode', () => {
      const onShotSettled = vi.fn();
      turnManager.setLocalPlayerId('player-1');
      turnManager.startFirstTurn();
      turnManager.onShotSettled = onShotSettled;

      expect(turnManager.tryFire()).toBe(true);

      Reflect.set(turnManager, 'awaitingTankStabilization', true);
      turnManager.update(0.016);

      expect(onShotSettled).toHaveBeenCalledTimes(1);
      expect(turnManager.getCurrentTurnInfo()?.isInputLocked).toBe(true);
    });
  });
});
