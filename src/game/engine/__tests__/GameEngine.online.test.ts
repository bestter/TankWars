import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GameEngine } from '../GameEngine';
import * as random from '../../../utils/random';
import { makePlayer, makeTank } from '../../__tests__/helpers';

describe('GameEngine online multiplayer', () => {
  let engine: GameEngine;

  beforeEach(() => {
    vi.spyOn(random, 'secureRandom').mockReturnValue(0.5);
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    engine = new GameEngine(200, 200);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function twoPlayerSetup(): { host: ReturnType<typeof makePlayer>; guest: ReturnType<typeof makePlayer> } {
    const host = makePlayer({
      id: 'player-1',
      name: 'Host',
      tank: makeTank('tank-1', 40, 120),
    });
    const guest = makePlayer({
      id: 'player-2',
      name: 'Guest',
      tank: makeTank('tank-2', 140, 120),
    });
    engine.setPlayers([host, guest]);
    return { host, guest };
  }

  it('isRoundCombatActive is true after setPlayers and false after enterInterRoundPhase', () => {
    twoPlayerSetup();
    expect(engine.isRoundCombatActive()).toBe(true);

    engine.enterInterRoundPhase();
    expect(engine.isRoundCombatActive()).toBe(false);
  });

  it('syncRoundEndFromRemote ends combat and emits onRoundEnded with winner', () => {
    const { host, guest } = twoPlayerSetup();
    const deadGuest = {
      ...guest,
      tank: { ...guest.tank, health: 0, isDead: true },
    };

    const onRoundEnded = vi.fn();
    engine.onRoundEnded = onRoundEnded;

    engine.syncRoundEndFromRemote([host, deadGuest], 'player-1', false);

    expect(engine.isRoundCombatActive()).toBe(false);
    expect(onRoundEnded).toHaveBeenCalledTimes(1);
    expect(onRoundEnded.mock.calls[0][0]).toMatchObject({
      isDraw: false,
      roundWinner: expect.objectContaining({ id: 'player-1' }),
      survivors: expect.arrayContaining([expect.objectContaining({ id: 'player-1' })]),
    });
  });

  it('syncRoundEndFromRemote supports draw payload', () => {
    twoPlayerSetup();
    const onRoundEnded = vi.fn();
    engine.onRoundEnded = onRoundEnded;

    engine.syncRoundEndFromRemote([], null, true);

    expect(engine.isRoundCombatActive()).toBe(false);
    expect(onRoundEnded.mock.calls[0][0]).toMatchObject({
      isDraw: true,
      roundWinner: null,
      survivors: [],
    });
  });

  it('syncRoundEndFromRemote is a no-op when combat round already ended', () => {
    twoPlayerSetup();
    const onRoundEnded = vi.fn();
    engine.onRoundEnded = onRoundEnded;

    engine.enterInterRoundPhase();
    onRoundEnded.mockClear();

    engine.syncRoundEndFromRemote([], 'player-1', false);

    expect(onRoundEnded).not.toHaveBeenCalled();
    expect(engine.isRoundCombatActive()).toBe(false);
  });
});