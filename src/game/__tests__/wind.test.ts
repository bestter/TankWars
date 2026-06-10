import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatWindDisplay, rollRoundWind, WIND_ACCEL_MIN, WIND_ACCEL_MAX } from '../wind';
import { secureRandom } from '../../utils/random';

vi.mock('../../utils/random', () => ({
  secureRandom: vi.fn(),
}));

describe('formatWindDisplay', () => {
  it('formats CALM wind correctly (force < 0.5)', () => {
    expect(formatWindDisplay(0)).toEqual({ direction: 'CALM', arrow: '—', strength: 0, label: 'CALM' });
    expect(formatWindDisplay(-0)).toEqual({ direction: 'CALM', arrow: '—', strength: 0, label: 'CALM' });
    expect(formatWindDisplay(0.49)).toEqual({ direction: 'CALM', arrow: '—', strength: 0, label: 'CALM' });
    expect(formatWindDisplay(-0.49)).toEqual({ direction: 'CALM', arrow: '—', strength: 0, label: 'CALM' });
  });

  it('formats EAST wind correctly (force >= 0.5)', () => {
    expect(formatWindDisplay(0.5)).toEqual({ direction: 'EAST', arrow: '→', strength: 1, label: 'EAST' });
    expect(formatWindDisplay(1)).toEqual({ direction: 'EAST', arrow: '→', strength: 1, label: 'EAST' });
    expect(formatWindDisplay(10.2)).toEqual({ direction: 'EAST', arrow: '→', strength: 10, label: 'EAST' });
    expect(formatWindDisplay(10.8)).toEqual({ direction: 'EAST', arrow: '→', strength: 11, label: 'EAST' });
    expect(formatWindDisplay(WIND_ACCEL_MAX)).toEqual({ direction: 'EAST', arrow: '→', strength: WIND_ACCEL_MAX, label: 'EAST' });
    expect(formatWindDisplay(Infinity)).toEqual({ direction: 'EAST', arrow: '→', strength: Infinity, label: 'EAST' });
  });

  it('formats WEST wind correctly (force <= -0.5)', () => {
    expect(formatWindDisplay(-0.5)).toEqual({ direction: 'WEST', arrow: '←', strength: 1, label: 'WEST' });
    expect(formatWindDisplay(-1)).toEqual({ direction: 'WEST', arrow: '←', strength: 1, label: 'WEST' });
    expect(formatWindDisplay(-10.2)).toEqual({ direction: 'WEST', arrow: '←', strength: 10, label: 'WEST' });
    expect(formatWindDisplay(-10.8)).toEqual({ direction: 'WEST', arrow: '←', strength: 11, label: 'WEST' });
    expect(formatWindDisplay(WIND_ACCEL_MIN)).toEqual({ direction: 'WEST', arrow: '←', strength: Math.abs(WIND_ACCEL_MIN), label: 'WEST' });
    expect(formatWindDisplay(-Infinity)).toEqual({ direction: 'WEST', arrow: '←', strength: Infinity, label: 'WEST' });
  });

  it('handles NaN gracefully', () => {
    expect(formatWindDisplay(NaN)).toEqual({ direction: 'WEST', arrow: '←', strength: NaN, label: 'WEST' });
  });
});

describe('rollRoundWind', () => {
  beforeEach(() => {
    vi.mocked(secureRandom).mockReset();
  });

  it('returns 0 when calm chance is met (random < 0.1)', () => {
    vi.mocked(secureRandom).mockReturnValueOnce(0.05); // < CALM_CHANCE
    expect(rollRoundWind()).toBe(0);

    vi.mocked(secureRandom).mockReset();
    vi.mocked(secureRandom).mockReturnValueOnce(0.099); // < CALM_CHANCE
    expect(rollRoundWind()).toBe(0);
  });

  it('handles exact boundary for calm chance (random === 0.1)', () => {
    // 0.1 is not strictly < 0.1, so it shouldn't be calm
    vi.mocked(secureRandom)
      .mockReturnValueOnce(0.1) // not calm
      .mockReturnValueOnce(0.6) // east
      .mockReturnValueOnce(0.5); // magnitude
    expect(rollRoundWind()).toBe(20.5);
  });

  it('handles exact boundary for sign (random === 0.5)', () => {
    // 0.5 is not < 0.5, so it should be positive (east)
    vi.mocked(secureRandom)
      .mockReturnValueOnce(0.2) // not calm
      .mockReturnValueOnce(0.5) // east
      .mockReturnValueOnce(0.5); // magnitude
    expect(rollRoundWind()).toBe(20.5);
  });

  it('tests the boundary t close to 1.0', () => {
    vi.mocked(secureRandom)
      .mockReturnValueOnce(0.2) // not calm
      .mockReturnValueOnce(0.6) // east
      .mockReturnValueOnce(0.9999); // near max
    expect(rollRoundWind()).toBe(52);
  });

  it('returns positive wind (EAST)', () => {
    // 1st call: 0.15 (not calm)
    // 2nd call: 0.6 (positive sign >= 0.5)
    // 3rd call: 0.5 (magnitude modifier)
    vi.mocked(secureRandom)
      .mockReturnValueOnce(0.15)
      .mockReturnValueOnce(0.6)
      .mockReturnValueOnce(0.5);

    // magnitude calculation: 10 + 0.5 * 0.5 * (52 - 10) = 10 + 0.25 * 42 = 10 + 10.5 = 20.5
    expect(rollRoundWind()).toBe(20.5);
  });

  it('returns negative wind (WEST)', () => {
    // 1st call: 0.15 (not calm)
    // 2nd call: 0.4 (negative sign < 0.5)
    // 3rd call: 0.5 (magnitude modifier)
    vi.mocked(secureRandom)
      .mockReturnValueOnce(0.15)
      .mockReturnValueOnce(0.4)
      .mockReturnValueOnce(0.5);

    // magnitude calculation: 10 + 0.5 * 0.5 * (52 - 10) = 10 + 0.25 * 42 = 10 + 10.5 = 20.5
    expect(rollRoundWind()).toBe(-20.5);
  });

  it('returns max positive wind', () => {
    // 1st call: 0.15 (not calm)
    // 2nd call: 0.6 (positive sign >= 0.5)
    // 3rd call: 1.0 (magnitude modifier)
    vi.mocked(secureRandom)
      .mockReturnValueOnce(0.15)
      .mockReturnValueOnce(0.6)
      .mockReturnValueOnce(1.0);

    // magnitude calculation: 10 + 1.0 * 1.0 * (52 - 10) = 52
    expect(rollRoundWind()).toBe(52);
  });

  it('returns max negative wind', () => {
    // 1st call: 0.15 (not calm)
    // 2nd call: 0.4 (negative sign < 0.5)
    // 3rd call: 1.0 (magnitude modifier)
    vi.mocked(secureRandom)
      .mockReturnValueOnce(0.15)
      .mockReturnValueOnce(0.4)
      .mockReturnValueOnce(1.0);

    // magnitude calculation: 10 + 1.0 * 1.0 * (52 - 10) = 52
    expect(rollRoundWind()).toBe(-52);
  });

  it('returns minimum non-zero magnitude', () => {
    // 1st call: 0.15 (not calm)
    // 2nd call: 0.6 (positive sign >= 0.5)
    // 3rd call: 0.0 (magnitude modifier)
    vi.mocked(secureRandom)
      .mockReturnValueOnce(0.15)
      .mockReturnValueOnce(0.6)
      .mockReturnValueOnce(0.0);

    // magnitude calculation: 10 + 0.0 * 0.0 * (52 - 10) = 10
    expect(rollRoundWind()).toBe(10);
  });
});

  describe('extreme edge cases for secureRandom', () => {
    it('handles NaN from secureRandom gracefully', () => {
      vi.mocked(secureRandom)
        .mockReturnValueOnce(NaN)
        .mockReturnValueOnce(NaN)
        .mockReturnValueOnce(NaN);
      expect(rollRoundWind()).toBeNaN();
    });

    it('handles Infinity from secureRandom gracefully', () => {
      vi.mocked(secureRandom)
        .mockReturnValueOnce(Infinity)
        .mockReturnValueOnce(Infinity)
        .mockReturnValueOnce(Infinity);
      expect(rollRoundWind()).toBe(Infinity);
    });

    it('handles -Infinity from secureRandom gracefully', () => {
      vi.mocked(secureRandom)
        .mockReturnValueOnce(-Infinity) // < 0.1, so it returns 0! Wait, -Infinity < 0.1 is true.
        .mockReturnValueOnce(-Infinity)
        .mockReturnValueOnce(-Infinity);
      expect(rollRoundWind()).toBe(0);
    });

    it('handles -0 from secureRandom gracefully', () => {
      vi.mocked(secureRandom)
        .mockReturnValueOnce(-0) // < 0.1, so returns 0
        .mockReturnValueOnce(-0)
        .mockReturnValueOnce(-0);
      expect(rollRoundWind()).toBe(0);
    });
  });
