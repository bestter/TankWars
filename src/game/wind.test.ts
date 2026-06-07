import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatWindDisplay, rollRoundWind, WIND_ACCEL_MIN, WIND_ACCEL_MAX } from './wind';

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
    vi.spyOn(Math, 'random');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 0 when calm chance is met', () => {
    vi.mocked(Math.random).mockReturnValueOnce(0.05);
    expect(rollRoundWind()).toBe(0);
  });

  it('calculates west wind correctly (sign < 0.5)', () => {
    vi.mocked(Math.random)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.4)
      .mockReturnValueOnce(0.5);

    expect(rollRoundWind()).toBe(-20.5);
  });

  it('calculates east wind correctly (sign >= 0.5)', () => {
    vi.mocked(Math.random)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.6)
      .mockReturnValueOnce(1);

    expect(rollRoundWind()).toBe(52);
  });
});
