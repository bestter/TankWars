import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GameEngine } from '../GameEngine';

type GameEngineInternals = {
  victoryOscillators: { stop: () => void }[];
  ensureAudioContext: () => AudioContext | null;
  audioContext: AudioContext | null;
};

function engineInternals(engine: GameEngine): GameEngineInternals {
  return engine as unknown as GameEngineInternals;
}

describe('GameEngine audio', () => {
  let engine: GameEngine;
  let internal: GameEngineInternals;

  beforeEach(() => {
    engine = new GameEngine(200, 200);
    internal = engineInternals(engine);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('handles AudioContext initialization failure gracefully', () => {
    const MockAudioContext = vi.fn(function() {
      throw new Error('AudioContext not supported');
    });

    vi.stubGlobal('window', {
      AudioContext: MockAudioContext
    });

    let result: AudioContext | null = null;

    expect(() => {
      result = internal.ensureAudioContext();
    }).not.toThrow();

    expect(result).toBeNull();
    expect(internal.audioContext).toBeNull();
    expect(MockAudioContext).toHaveBeenCalled();
  });

  describe('stopVictoryMusic', () => {
    it('silently catches errors when oscillator stop() throws and clears the array', () => {
      const mockOscillator1 = {
        stop: vi.fn().mockImplementation(() => {
          throw new Error('Invalid state');
        }),
      };

      const mockOscillator2 = {
        stop: vi.fn(),
      };

      internal.victoryOscillators = [mockOscillator1, mockOscillator2];

      // `resetGame` calls `stopVictoryMusic`
      expect(() => {
        engine.resetGame();
      }).not.toThrow();

      expect(mockOscillator1.stop).toHaveBeenCalled();
      expect(mockOscillator2.stop).toHaveBeenCalled();

      // The array should be cleared
      expect(internal.victoryOscillators).toHaveLength(0);
    });
  });
});
