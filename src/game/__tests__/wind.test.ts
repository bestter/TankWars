import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatWindDisplay, rollRoundWind } from '../wind';
import * as randomUtils from '../../utils/random';

describe('formatWindDisplay', () => {
  it('returns CALM when absolute force is less than 0.5', () => {
    const expected = { direction: 'CALM', arrow: '—', strength: 0, label: 'CALM' };
    expect(formatWindDisplay(0)).toEqual(expected);
    expect(formatWindDisplay(0.49)).toEqual(expected);
    expect(formatWindDisplay(-0.49)).toEqual(expected);
    expect(formatWindDisplay(-0)).toEqual(expected);
  });

  it('returns EAST when force is positive and >= 0.5', () => {
    expect(formatWindDisplay(0.5)).toEqual({ direction: 'EAST', arrow: '→', strength: 1, label: 'EAST' });
    expect(formatWindDisplay(1.2)).toEqual({ direction: 'EAST', arrow: '→', strength: 1, label: 'EAST' });
    expect(formatWindDisplay(1.5)).toEqual({ direction: 'EAST', arrow: '→', strength: 2, label: 'EAST' });
    expect(formatWindDisplay(10)).toEqual({ direction: 'EAST', arrow: '→', strength: 10, label: 'EAST' });
    expect(formatWindDisplay(Infinity)).toEqual({ direction: 'EAST', arrow: '→', strength: Infinity, label: 'EAST' });
  });

  it('returns WEST when force is negative and <= -0.5', () => {
    expect(formatWindDisplay(-0.5)).toEqual({ direction: 'WEST', arrow: '←', strength: 1, label: 'WEST' });
    expect(formatWindDisplay(-1.2)).toEqual({ direction: 'WEST', arrow: '←', strength: 1, label: 'WEST' });
    expect(formatWindDisplay(-1.5)).toEqual({ direction: 'WEST', arrow: '←', strength: 2, label: 'WEST' });
    expect(formatWindDisplay(-10)).toEqual({ direction: 'WEST', arrow: '←', strength: 10, label: 'WEST' });
    expect(formatWindDisplay(-Infinity)).toEqual({ direction: 'WEST', arrow: '←', strength: Infinity, label: 'WEST' });
  });

  it('handles NaN gracefully by defaulting to WEST', () => {
    // NaN fails absolute check and > 0 check, so it goes to the default case
    expect(formatWindDisplay(NaN)).toEqual({ direction: 'WEST', arrow: '←', strength: NaN, label: 'WEST' });
  });
});

describe('rollRoundWind', () => {
  let secureRandomSpy: any;

  beforeEach(() => {
    secureRandomSpy = vi.spyOn(randomUtils, 'secureRandom');
  });

  it('returns 0 when calm chance hits (< 0.1)', () => {
    secureRandomSpy.mockReturnValue(0.05); // < 0.1
    expect(rollRoundWind()).toBe(0);
  });

  it('generates negative wind when sign check < 0.5', () => {
    // 1st call: < CALM_CHANCE ? No (e.g. 0.2)
    // 2nd call: sign < 0.5 ? Yes -> -1 (e.g. 0.1)
    // 3rd call: t (e.g. 0.5)
    secureRandomSpy
      .mockReturnValueOnce(0.2)
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.5);

    // magnitude = 10 + (0.5 * 0.5 * (52 - 10)) = 10 + 0.25 * 42 = 10 + 10.5 = 20.5
    // value = -1 * 20.5 = -20.5
    expect(rollRoundWind()).toBe(-20.5);
  });

  it('generates positive wind when sign check >= 0.5', () => {
    // 1st call: < CALM_CHANCE ? No (e.g. 0.2)
    // 2nd call: sign < 0.5 ? No -> 1 (e.g. 0.6)
    // 3rd call: t (e.g. 1.0)
    secureRandomSpy
      .mockReturnValueOnce(0.2)
      .mockReturnValueOnce(0.6)
      .mockReturnValueOnce(1.0);

    // magnitude = 10 + (1.0 * 1.0 * 42) = 52
    expect(rollRoundWind()).toBe(52);
  });
});
