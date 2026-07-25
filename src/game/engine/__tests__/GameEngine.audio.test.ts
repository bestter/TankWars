import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GameEngine } from '../GameEngine';

describe('GameEngine AudioContext', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(200, 200);
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

    const internalEngine = engine as unknown as { ensureAudioContext: () => AudioContext | null, audioContext: AudioContext | null };

    let result: AudioContext | null = null;

    expect(() => {
      result = internalEngine.ensureAudioContext();
    }).not.toThrow();

    expect(result).toBeNull();
    expect(internalEngine.audioContext).toBeNull();
    expect(MockAudioContext).toHaveBeenCalled();
  });
});
