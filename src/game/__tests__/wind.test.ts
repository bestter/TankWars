import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatWindDisplay, rollRoundWind, WIND_ACCEL_MIN, WIND_ACCEL_MAX } from '../wind';
import { secureRandom } from '../../utils/random';

vi.mock('../../utils/random', () => ({
  secureRandom: vi.fn(),
}));

describe('formatWindDisplay', () => {
  it('formats CALM wind correctly (force < 0.5)', () => {
    expect(formatWindDisplay(0)).toEqual({ direction: 'CALM', arrow: '—', strength: 0, label: 'CALM' });
    expect(formatWindDisplay(0.49)).toEqual({ direction: 'CALM', arrow: '—', strength: 0, label: 'CALM' });
    expect(formatWindDisplay(-0.49)).toEqual({ direction: 'CALM', arrow: '—', strength: 0, label: 'CALM' });
  });

  it('formats EAST wind correctly (force >= 0.5)', () => {
    expect(formatWindDisplay(0.5)).toEqual({ direction: 'EAST', arrow: '→', strength: 1, label: 'EAST' });
    expect(formatWindDisplay(10.8)).toEqual({ direction: 'EAST', arrow: '→', strength: 11, label: 'EAST' });
    expect(formatWindDisplay(WIND_ACCEL_MAX)).toEqual({ direction: 'EAST', arrow: '→', strength: WIND_ACCEL_MAX, label: 'EAST' });
  });

  it('formats WEST wind correctly (force <= -0.5)', () => {
    expect(formatWindDisplay(-0.5)).toEqual({ direction: 'WEST', arrow: '←', strength: 1, label: 'WEST' });
    expect(formatWindDisplay(-10.8)).toEqual({ direction: 'WEST', arrow: '←', strength: 11, label: 'WEST' });
    expect(formatWindDisplay(WIND_ACCEL_MIN)).toEqual({ direction: 'WEST', arrow: '←', strength: Math.abs(WIND_ACCEL_MIN), label: 'WEST' });
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
    vi.mocked(secureRandom).mockReturnValueOnce(0.05);
    expect(rollRoundWind()).toBe(0);
  });

  it('handles exact boundary for calm chance (random === 0.1)', () => {
    vi.mocked(secureRandom)
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.6)
      .mockReturnValueOnce(0.5);
    expect(rollRoundWind()).toBe(20.5);
  });

  it('handles exact boundary for sign (random === 0.5)', () => {
    vi.mocked(secureRandom)
      .mockReturnValueOnce(0.2)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.5);
    expect(rollRoundWind()).toBe(20.5);
  });

  it('returns positive wind (EAST)', () => {
    vi.mocked(secureRandom)
      .mockReturnValueOnce(0.15)
      .mockReturnValueOnce(0.6)
      .mockReturnValueOnce(0.5);
    expect(rollRoundWind()).toBe(20.5);
  });

  it('returns negative wind (WEST)', () => {
    vi.mocked(secureRandom)
      .mockReturnValueOnce(0.15)
      .mockReturnValueOnce(0.4)
      .mockReturnValueOnce(0.5);
    expect(rollRoundWind()).toBe(-20.5);
  });

  it('returns max positive wind', () => {
    vi.mocked(secureRandom)
      .mockReturnValueOnce(0.15)
      .mockReturnValueOnce(0.6)
      .mockReturnValueOnce(1.0);
    expect(rollRoundWind()).toBe(52);
  });

  it('returns minimum non-zero magnitude', () => {
    vi.mocked(secureRandom)
      .mockReturnValueOnce(0.15)
      .mockReturnValueOnce(0.6)
      .mockReturnValueOnce(0.0);
    expect(rollRoundWind()).toBe(10);
  });

  it('uses secureRandom exactly 3 times when not calm', () => {
    const mathRandomSpy = vi.spyOn(Math, 'random');
    vi.mocked(secureRandom)
      .mockReturnValueOnce(0.15)
      .mockReturnValueOnce(0.6)
      .mockReturnValueOnce(0.5);

    rollRoundWind();

    expect(vi.mocked(secureRandom)).toHaveBeenCalledTimes(3);
    expect(mathRandomSpy).not.toHaveBeenCalled();
    mathRandomSpy.mockRestore();
  });

  it('uses secureRandom exactly 1 time when calm', () => {
    const mathRandomSpy = vi.spyOn(Math, 'random');
    vi.mocked(secureRandom).mockReturnValueOnce(0.05);

    rollRoundWind();

    expect(vi.mocked(secureRandom)).toHaveBeenCalledTimes(1);
    expect(mathRandomSpy).not.toHaveBeenCalled();
    mathRandomSpy.mockRestore();
  });
});
