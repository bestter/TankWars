import { describe, it, expect } from 'vitest';
import {
  ExactAccumulator,
  normalizeDamageToMilli,
  calculateBaseRewardMilli,
  BASE_REWARD_AMOUNT,
  DAMAGE_PRECISION,
  MAX_REWARD_PLAYERS
} from '../fixedPoint';

describe('ExactAccumulator', () => {
  it('should initialize with 0/1', () => {
    const acc = new ExactAccumulator();
    expect(acc.toSnapshot()).toEqual({ numerator: '0', denominator: '1' });
    expect(acc.ceilToSafeInteger()).toBe(0);
  });

  describe('add', () => {
    it('should add fractions and simplify', () => {
      const acc = new ExactAccumulator();
      acc.add(1n, 2n);
      expect(acc.toSnapshot()).toEqual({ numerator: '1', denominator: '2' });

      acc.add(1n, 3n);
      // 1/2 + 1/3 = 5/6
      expect(acc.toSnapshot()).toEqual({ numerator: '5', denominator: '6' });

      acc.add(1n, 6n);
      // 5/6 + 1/6 = 6/6 = 1/1
      expect(acc.toSnapshot()).toEqual({ numerator: '1', denominator: '1' });
    });

    it('should handle zero numerator correctly', () => {
      const acc = new ExactAccumulator();
      acc.add(0n, 10n);
      expect(acc.toSnapshot()).toEqual({ numerator: '0', denominator: '1' });
    });

    it('should handle negative numerators', () => {
      const acc = new ExactAccumulator();
      acc.add(1n, 2n);
      acc.add(-1n, 4n);
      // 1/2 - 1/4 = 1/4
      expect(acc.toSnapshot()).toEqual({ numerator: '1', denominator: '4' });
    });

    it('should throw if denominator is less than or equal to zero', () => {
      const acc = new ExactAccumulator();
      expect(() => acc.add(1n, 0n)).toThrowError(RangeError);
      expect(() => acc.add(1n, -5n)).toThrowError(RangeError);
      expect(() => acc.add(1n, 0n)).toThrow('Le dénominateur doit être positif.');
    });
  });

  describe('addAccumulator', () => {
    it('should add another accumulator', () => {
      const acc1 = new ExactAccumulator();
      acc1.add(1n, 3n);

      const acc2 = new ExactAccumulator();
      acc2.add(1n, 6n);

      acc1.addAccumulator(acc2);
      // 1/3 + 1/6 = 3/6 = 1/2
      expect(acc1.toSnapshot()).toEqual({ numerator: '1', denominator: '2' });
    });
  });

  describe('ceilToSafeInteger', () => {
    it('should ceil positive values correctly', () => {
      const acc = new ExactAccumulator();
      expect(acc.ceilToSafeInteger()).toBe(0);

      acc.add(1n, 2n);
      expect(acc.ceilToSafeInteger()).toBe(1); // 0.5 -> 1

      acc.add(1n, 2n);
      expect(acc.ceilToSafeInteger()).toBe(1); // 1.0 -> 1

      acc.add(1n, 10n);
      expect(acc.ceilToSafeInteger()).toBe(2); // 1.1 -> 2
    });

    it('should throw on negative values', () => {
      const acc = new ExactAccumulator();
      acc.add(-1n, 2n);
      expect(() => acc.ceilToSafeInteger()).toThrowError(RangeError);
      expect(() => acc.ceilToSafeInteger()).toThrow('Un gain ne peut pas être négatif.');
    });

    it('should throw if value exceeds MAX_SAFE_INTEGER', () => {
      const acc = new ExactAccumulator();
      const maxSafeInt = BigInt(Number.MAX_SAFE_INTEGER);
      acc.add(maxSafeInt + 1n, 1n);
      expect(() => acc.ceilToSafeInteger()).toThrowError(RangeError);
      expect(() => acc.ceilToSafeInteger()).toThrow('Le gain dépasse la plage des entiers sûrs.');
    });
  });
});

describe('normalizeDamageToMilli', () => {
  it('should normalize valid positive values', () => {
    expect(normalizeDamageToMilli(1.5)).toBe(1500);
    expect(normalizeDamageToMilli(0)).toBe(0);
    expect(normalizeDamageToMilli(0.123)).toBe(123);
  });

  it('should throw on negative values', () => {
    expect(() => normalizeDamageToMilli(-1)).toThrowError(RangeError);
    expect(() => normalizeDamageToMilli(-0.001)).toThrowError(RangeError);
  });

  it('should throw on non-finite values', () => {
    expect(() => normalizeDamageToMilli(Infinity)).toThrowError(RangeError);
    expect(() => normalizeDamageToMilli(NaN)).toThrowError(RangeError);
  });

  it('should throw if value exceeds safe integer range after multiplication', () => {
    const tooLarge = Number.MAX_SAFE_INTEGER / DAMAGE_PRECISION + 1;
    expect(() => normalizeDamageToMilli(tooLarge)).toThrowError(RangeError);
  });
});

describe('calculateBaseRewardMilli', () => {
  it('should calculate base reward for valid player counts', () => {
    // 2 players: playerRatio = 2/4 = 0.5
    // reward = 2.0 * (1 + 0.5) * 1000 = 3000
    expect(calculateBaseRewardMilli(2)).toBe(3000);

    // 3 players: playerRatio = Math.round(3/4 * 100) / 100 = 0.75
    // reward = 2.0 * (1 + 0.75) * 1000 = 3500
    expect(calculateBaseRewardMilli(3)).toBe(3500);

    // 4 players: playerRatio = 4/4 = 1
    // reward = 2.0 * (1 + 1) * 1000 = 4000
    expect(calculateBaseRewardMilli(4)).toBe(4000);
  });

  it('should throw on invalid player counts', () => {
    expect(() => calculateBaseRewardMilli(1)).toThrowError(RangeError);
    expect(() => calculateBaseRewardMilli(5)).toThrowError(RangeError);
    expect(() => calculateBaseRewardMilli(2.5)).toThrowError(RangeError);
    expect(() => calculateBaseRewardMilli(-2)).toThrowError(RangeError);
  });
});
