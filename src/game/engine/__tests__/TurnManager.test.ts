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

  describe('AI GameState snapshot', () => {
    it('passes currentRoundNumber to the AI GameState snapshot', async () => {
      const onlyAi = makePlayer({
        id: 'ai-1',
        isHuman: false,
        aiProfile: 'v1-random',
      });
      mockTankManager.getPlayers = vi.fn().mockReturnValue([onlyAi]);
      const executeTurn = vi.fn().mockResolvedValue({ angle: 50, power: 60 });
      turnManager.setAIEngine({ executeTurn });
      turnManager.setRoundNumber(3);
      turnManager.startFirstTurn();
      await Promise.resolve();
      expect(executeTurn).toHaveBeenCalled();
      const state = executeTurn.mock.calls[0][1] as { roundNumber?: number };
      expect(state.roundNumber).toBe(3);
    });
  });

  describe('reset', () => {
    it('restores turn 1 and lets a local human fire again', () => {
      const human = makePlayer({
        id: 'human-1',
        isHuman: true,
        inventory: { GRENADE: 2 },
        tank: makePlayer().tank,
      });
      human.tank.currentWeapon = 'GRENADE';
      mockTankManager.getPlayers = vi.fn().mockReturnValue([human]);

      turnManager.startFirstTurn();
      Object.assign(turnManager, {
        turnNumber: 5,
        isInputLocked: true,
        interRoundPaused: true,
      });

      turnManager.reset();

      expect(turnManager.getCurrentTurnNumber()).toBe(1);
      expect(turnManager.isAwaitingServerTurnAfterLocalShot()).toBe(false);
      expect(turnManager.getCurrentTurnInfo()?.turn).toBe(1);
      expect(turnManager.getCurrentTurnInfo()?.isInputLocked).toBe(false);
      expect(turnManager.tryFire()).toBe(true);
      expect(mockFireCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe('earnings resolution', () => {
    function prepareResolvedLocalShot(gate: { hasEarnings: boolean; isRoundEnd: boolean }) {
      const players = [
        makePlayer({ id: 'p1', isHuman: true }),
        makePlayer({ id: 'p2', isHuman: true }),
      ];
      mockTankManager.getPlayers = vi.fn().mockReturnValue(players);
      turnManager.startFirstTurn();
      turnManager.onShotResolutionReady = vi.fn().mockReturnValue(gate);
      Object.assign(turnManager, { hasUnresolvedShot: true, settlingShotWasLocal: true });
      const finish = Reflect.get(turnManager, 'finishShotResolution') as () => void;
      finish.call(turnManager);
    }

    it('advances immediately when a rewarded shot is resolved', () => {
      prepareResolvedLocalShot({ hasEarnings: true, isRoundEnd: false });
      expect(turnManager.getCurrentTurnNumber()).toBe(2);
      expect(turnManager.isWaitingForEarningsRelease()).toBe(false);
      turnManager.releaseResolvedShot();
      expect(turnManager.getCurrentTurnNumber()).toBe(2);
    });

    it('releases a zero-gain resolution immediately', () => {
      prepareResolvedLocalShot({ hasEarnings: false, isRoundEnd: false });
      expect(turnManager.getCurrentTurnNumber()).toBe(2);
      expect(turnManager.isWaitingForEarningsRelease()).toBe(false);
    });

    it('announces a round end immediately instead of advancing the turn', () => {
      const roundEnd = vi.fn();
      turnManager.onResolvedRoundEnd = roundEnd;
      prepareResolvedLocalShot({ hasEarnings: true, isRoundEnd: true });
      expect(roundEnd).toHaveBeenCalledTimes(1);
      expect(turnManager.getCurrentTurnNumber()).toBe(1);
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

    it('stays locked when syncTurn repeats the same index after a local shot', () => {
      turnManager.setLocalPlayerId('player-1');
      turnManager.startFirstTurn();
      expect(turnManager.tryFire()).toBe(true);

      Reflect.set(turnManager, 'awaitingTankStabilization', true);
      turnManager.update(0.016);

      // Stale GAME_START / reconnect with same index must not re-unlock the firer.
      turnManager.syncTurn(0);

      expect(turnManager.getCurrentTurnInfo()?.isInputLocked).toBe(true);
      expect(turnManager.tryFire()).toBe(false);
    });

    it('unlocks only after server advances away then back to the local player', () => {
      turnManager.setLocalPlayerId('player-1');
      turnManager.startFirstTurn();
      expect(turnManager.tryFire()).toBe(true);

      Reflect.set(turnManager, 'awaitingTankStabilization', true);
      turnManager.update(0.016);
      expect(turnManager.getCurrentTurnInfo()?.isInputLocked).toBe(true);

      // Server gives the turn to player 2
      turnManager.syncTurn(1);
      expect(turnManager.getCurrentTurnInfo()?.isInputLocked).toBe(true);
      expect(turnManager.tryFire()).toBe(false);

      // Full cycle later: server returns the turn to player 1
      turnManager.syncTurn(0);
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

  describe('AI grenade settlement vs safety net', () => {
    let human: ReturnType<typeof makePlayer>;
    let ai: ReturnType<typeof makePlayer>;

    function createPlayers() {
      human = makePlayer({
        id: 'player-1',
        name: 'Joueur-1',
        isHuman: true,
        tank: { ...makePlayer().tank, id: 'tank-1' },
      });
      ai = makePlayer({
        id: 'player-2',
        name: 'CPU-1',
        isHuman: false,
        tank: {
          ...makePlayer().tank,
          id: 'tank-2',
          currentWeapon: 'GRENADE',
        },
        inventory: { GRENADE: 5, MISSILE: 99 },
      });
    }

    async function playHumanThenLetAiFire() {
      turnManager.startFirstTurn();
      expect(turnManager.getCurrentPlayer()?.id).toBe('player-1');
      expect(turnManager.tryFire()).toBe(true);

      Reflect.set(turnManager, 'awaitingTankStabilization', true);
      turnManager.update(0.016);
      expect(turnManager.getCurrentPlayer()?.id).toBe('player-2');

      await vi.advanceTimersByTimeAsync(1600);
      expect(mockFireCallback).toHaveBeenCalledTimes(2);
    }

    beforeEach(() => {
      vi.useFakeTimers();
      createPlayers();
      mockTankManager.getPlayers = vi.fn().mockReturnValue([human, ai]);
      mockTankManager.anyTankIsFalling = vi.fn().mockReturnValue(false);
      mockFireCallback.mockReset();
      mockAiEngine = {
        executeTurn: vi.fn().mockResolvedValue({
          angle: 74.6,
          power: 89,
          weaponId: 'GRENADE',
        }),
      };
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

    it('does not skip the human when a late grenade settlement arrives after the AI safety net', async () => {
      await playHumanThenLetAiFire();

      // Grenade still bouncing: 4.5s safety net currently force-advances to human.
      turnManager.update(5);
      expect(turnManager.getCurrentPlayer()?.id).toBe('player-1');

      // Real explosion + settlement arrives after the premature advance.
      Reflect.set(turnManager, 'awaitingTankStabilization', true);
      turnManager.update(0.016);

      expect(turnManager.getCurrentPlayer()?.id).toBe('player-1');
      expect(turnManager.getCurrentTurnInfo()?.isHuman).toBe(true);
    });

    it('does not force-advance an AI turn while a grenade is still in flight', async () => {
      const physics = {
        hasActiveProjectiles: vi.fn().mockReturnValue(true),
      };
      turnManager.connectToPhysics(physics as never);

      await playHumanThenLetAiFire();

      turnManager.update(5);

      expect(turnManager.getCurrentPlayer()?.id).toBe('player-2');
      expect(turnManager.getCurrentTurnInfo()?.isInputLocked).toBe(true);
    });
  });
});
