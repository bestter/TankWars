import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TurnManager } from '../TurnManager';
import type { TankManager } from '../../entities/TankManager';
import type { TerrainManager } from '../Terrain';
import type { AIEngine } from '../../entities/ai/AIEngine';
import { makePlayer, makeTank } from '../../__tests__/helpers';
import { VGA_PALETTE } from '../../../types/game';

describe('TurnManager (Hotseat multi-player)', () => {
  let turnManager: TurnManager;
  let mockTankManager: Partial<TankManager>;
  let mockTerrainManager: Partial<TerrainManager>;
  const mockFireCallback = vi.fn();
  let mockAiEngine: Partial<AIEngine>;

  const player1 = makePlayer({
    id: 'p-1',
    name: 'Alice',
    isHuman: true,
    tank: makeTank('tank-1', 100, 200, { color: VGA_PALETTE.BLUE, isDead: false }),
  });

  const player2 = makePlayer({
    id: 'p-2',
    name: 'Bob',
    isHuman: true,
    tank: makeTank('tank-2', 300, 200, { color: VGA_PALETTE.RED, isDead: false }),
  });

  const player3 = makePlayer({
    id: 'p-3',
    name: 'Charlie',
    isHuman: true,
    tank: makeTank('tank-3', 500, 200, { color: VGA_PALETTE.GREEN, isDead: false }),
  });

  beforeEach(() => {
    mockTankManager = {
      getPlayers: vi.fn().mockReturnValue([player1, player2, player3]),
      anyTankIsFalling: vi.fn().mockReturnValue(false),
    };
    mockTerrainManager = {};
    mockFireCallback.mockReset();
    mockAiEngine = {};

    turnManager = new TurnManager(
      mockTankManager as TankManager,
      mockTerrainManager as TerrainManager,
      mockFireCallback,
      mockAiEngine as AIEngine,
    );
  });

  it('cycles turns in hotseat mode sequentially through all 3 alive human players', () => {
    const onTurnChange = vi.fn();
    turnManager.onTurnChange = onTurnChange;

    expect(turnManager.getCurrentPlayer()?.id).toBe('p-1');

    // Turn 1 -> Turn 2 (Bob)
    turnManager.nextTurn();
    expect(turnManager.getCurrentPlayer()?.id).toBe('p-2');
    expect(onTurnChange).toHaveBeenLastCalledWith(player2, 2);

    // Turn 2 -> Turn 3 (Charlie)
    turnManager.nextTurn();
    expect(turnManager.getCurrentPlayer()?.id).toBe('p-3');
    expect(onTurnChange).toHaveBeenLastCalledWith(player3, 3);

    // Turn 3 -> Turn 4 (Alice loops back)
    turnManager.nextTurn();
    expect(turnManager.getCurrentPlayer()?.id).toBe('p-1');
    expect(onTurnChange).toHaveBeenLastCalledWith(player1, 4);
  });

  it('skips eliminated dead player automatically when advancing turns', () => {
    // Bob dies
    const deadBob = {
      ...player2,
      tank: { ...player2.tank, health: 0, isDead: true },
    };
    mockTankManager.getPlayers = vi.fn().mockReturnValue([player1, deadBob, player3]);

    expect(turnManager.getCurrentPlayer()?.id).toBe('p-1');

    // Next turn from Alice should skip dead Bob directly to Charlie
    turnManager.nextTurn();
    expect(turnManager.getCurrentPlayer()?.id).toBe('p-3');

    // Next turn from Charlie should loop back to Alice
    turnManager.nextTurn();
    expect(turnManager.getCurrentPlayer()?.id).toBe('p-1');
  });

  it('leaves input unlocked for each human player on their turn in hotseat mode', () => {
    const hudUpdates = vi.fn();
    turnManager.onHudUpdate = hudUpdates;

    // Alice turn: human and input unlocked
    expect(turnManager.getCurrentPlayer()?.isHuman).toBe(true);

    // Next to Bob
    turnManager.nextTurn();
    expect(turnManager.getCurrentPlayer()?.isHuman).toBe(true);
    expect(hudUpdates).toHaveBeenCalled();
    const lastUpdate = hudUpdates.mock.calls[hudUpdates.mock.calls.length - 1][0];
    expect(lastUpdate.playerId).toBe('p-2');
    expect(lastUpdate.isInputLocked).toBe(false);
  });
});
