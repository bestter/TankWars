import { describe, it, expect } from 'vitest';
import { nextLivingPlayerIndex } from '../turnOrder';

describe('nextLivingPlayerIndex', () => {
  it('advances to the next index when everyone is alive', () => {
    const isDead = () => false;
    expect(nextLivingPlayerIndex(0, 2, isDead)).toBe(1);
    expect(nextLivingPlayerIndex(1, 2, isDead)).toBe(0);
    expect(nextLivingPlayerIndex(0, 3, isDead)).toBe(1);
    expect(nextLivingPlayerIndex(2, 3, isDead)).toBe(0);
  });

  it('skips dead players', () => {
    const isDead = (i: number) => i === 1;
    expect(nextLivingPlayerIndex(0, 3, isDead)).toBe(2);
    expect(nextLivingPlayerIndex(2, 3, isDead)).toBe(0);
  });

  it('skips multiple consecutive dead players', () => {
    const isDead = (i: number) => i === 1 || i === 2;
    expect(nextLivingPlayerIndex(0, 4, isDead)).toBe(3);
    expect(nextLivingPlayerIndex(3, 4, isDead)).toBe(0);
  });

  it('falls back to +1 when every player is dead', () => {
    const isDead = () => true;
    expect(nextLivingPlayerIndex(0, 2, isDead)).toBe(1);
    expect(nextLivingPlayerIndex(1, 2, isDead)).toBe(0);
  });

  it('handles numPlayers <= 0 safely', () => {
    expect(nextLivingPlayerIndex(0, 0, () => false)).toBe(0);
    expect(nextLivingPlayerIndex(3, -1, () => false)).toBe(0);
  });
});
