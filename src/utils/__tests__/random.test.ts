import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { secureRandom, seedFromRoomRound, createSeededRNG } from '../random.js';

describe('secureRandom', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'getRandomValues').mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should call crypto.getRandomValues with a Uint32Array of length 1', () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      const uint32Array = array as Uint32Array;
      uint32Array[0] = 12345;
      return array;
    });

    secureRandom();

    expect(crypto.getRandomValues).toHaveBeenCalledTimes(1);
    const mockCallArg = vi.mocked(crypto.getRandomValues).mock.calls[0][0];
    expect(mockCallArg).toBeInstanceOf(Uint32Array);
    expect((mockCallArg as Uint32Array).length).toBe(1);
  });

  it('should return 0 when getRandomValues sets the array to 0', () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      const uint32Array = array as Uint32Array;
      uint32Array[0] = 0;
      return array;
    });

    const result = secureRandom();
    expect(result).toBe(0);
  });

  it('should return a value very close to but strictly less than 1 when getRandomValues sets the array to maximum Uint32 (0xffffffff)', () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      const uint32Array = array as Uint32Array;
      uint32Array[0] = 0xffffffff;
      return array;
    });

    const result = secureRandom();
    expect(result).toBe(0xffffffff / (0xffffffff + 1));
    expect(result).toBeLessThan(1);
    expect(result).toBeGreaterThan(0.99999999);
  });

  it('should return the correct scaled value for an arbitrary random number', () => {
    const arbitraryNumber = 2147483648; // 0x80000000
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      const uint32Array = array as Uint32Array;
      uint32Array[0] = arbitraryNumber;
      return array;
    });

    const result = secureRandom();
    expect(result).toBe(arbitraryNumber / (0xffffffff + 1));
  });
});

describe('seedFromRoomRound', () => {
  it('is deterministic for the same room and round', () => {
    expect(seedFromRoomRound('abc123', 2)).toBe(seedFromRoomRound('abc123', 2));
  });

  it('differs across round numbers for the same room', () => {
    expect(seedFromRoomRound('abc123', 1)).not.toBe(seedFromRoomRound('abc123', 2));
  });

  it('produces identical spawn draws on two fresh seeded RNG instances', () => {
    const seed = seedFromRoomRound('room-xyz', 2);
    const a = createSeededRNG(seed);
    const b = createSeededRNG(seed);
    const drawsA = [a.next(), a.next(), a.next(), a.next()];
    const drawsB = [b.next(), b.next(), b.next(), b.next()];
    expect(drawsA).toEqual(drawsB);
  });
});
