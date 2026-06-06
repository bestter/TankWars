import { describe, it, expect } from 'vitest';
import { formatWindDisplay, WIND_ACCEL_MIN, WIND_ACCEL_MAX } from './wind';

describe('formatWindDisplay', () => {
  it('formats CALM wind correctly (force < 0.5)', () => {
    expect(formatWindDisplay(0)).toEqual({ direction: 'CALM', arrow: '—', strength: 0, label: 'CALM' });
    expect(formatWindDisplay(0.4)).toEqual({ direction: 'CALM', arrow: '—', strength: 0, label: 'CALM' });
    expect(formatWindDisplay(-0.4)).toEqual({ direction: 'CALM', arrow: '—', strength: 0, label: 'CALM' });
  });

  it('formats EAST wind correctly (force > 0)', () => {
    expect(formatWindDisplay(0.5)).toEqual({ direction: 'EAST', arrow: '→', strength: 1, label: 'EAST' });
    expect(formatWindDisplay(1)).toEqual({ direction: 'EAST', arrow: '→', strength: 1, label: 'EAST' });
    expect(formatWindDisplay(10.2)).toEqual({ direction: 'EAST', arrow: '→', strength: 10, label: 'EAST' });
    expect(formatWindDisplay(10.8)).toEqual({ direction: 'EAST', arrow: '→', strength: 11, label: 'EAST' });
    expect(formatWindDisplay(WIND_ACCEL_MAX)).toEqual({ direction: 'EAST', arrow: '→', strength: WIND_ACCEL_MAX, label: 'EAST' });
  });

  it('formats WEST wind correctly (force < 0)', () => {
    expect(formatWindDisplay(-0.5)).toEqual({ direction: 'WEST', arrow: '←', strength: 1, label: 'WEST' });
    expect(formatWindDisplay(-1)).toEqual({ direction: 'WEST', arrow: '←', strength: 1, label: 'WEST' });
    expect(formatWindDisplay(-10.2)).toEqual({ direction: 'WEST', arrow: '←', strength: 10, label: 'WEST' });
    expect(formatWindDisplay(-10.8)).toEqual({ direction: 'WEST', arrow: '←', strength: 11, label: 'WEST' });
    expect(formatWindDisplay(WIND_ACCEL_MIN)).toEqual({ direction: 'WEST', arrow: '←', strength: Math.abs(WIND_ACCEL_MIN), label: 'WEST' });
  });
});
