import { describe, it, expect } from 'vitest';
import {
  TERRAIN_MATERIAL,
  grenadeBounceParams,
  GRENADE_ROCK_BOUNCE_SCALE,
  GRENADE_MAX_RESTITUTION,
  GRENADE_DIRT_RESTITUTION_MIN,
  GRENADE_DIRT_RESTITUTION_SPAN,
  GRENADE_DIRT_FRICTION,
  GRENADE_ROCK_FRICTION
} from '../terrain';

describe('grenadeBounceParams', () => {
  it('returns 0 restitution and friction, and explodes on contact for SOFT material', () => {
    const params = grenadeBounceParams(TERRAIN_MATERIAL.SOFT, () => 0.5);
    expect(params).toEqual({
      explodeOnContact: true,
      restitution: 0,
      friction: 0
    });
  });

  it('calculates restitution and friction correctly for DIRT material', () => {
    let callCount = 0;
    const mockRng = () => {
      callCount++;
      return 0.5;
    };
    const params = grenadeBounceParams(TERRAIN_MATERIAL.DIRT, mockRng);

    const expectedRestitution = GRENADE_DIRT_RESTITUTION_MIN + 0.5 * GRENADE_DIRT_RESTITUTION_SPAN;
    expect(params).toEqual({
      explodeOnContact: false,
      restitution: expectedRestitution,
      friction: GRENADE_DIRT_FRICTION
    });
    expect(callCount).toBe(1);
  });

  it('calculates restitution and friction correctly for ROCK material', () => {
    let callCount = 0;
    const mockRng = () => {
      callCount++;
      return 0.5;
    };
    const params = grenadeBounceParams(TERRAIN_MATERIAL.ROCK, mockRng);

    const expectedBaseRestitution = GRENADE_DIRT_RESTITUTION_MIN + 0.5 * GRENADE_DIRT_RESTITUTION_SPAN;
    const expectedRestitution = Math.min(
      GRENADE_MAX_RESTITUTION,
      expectedBaseRestitution * GRENADE_ROCK_BOUNCE_SCALE
    );

    expect(params).toEqual({
      explodeOnContact: false,
      restitution: expectedRestitution,
      friction: GRENADE_ROCK_FRICTION
    });
    expect(callCount).toBe(1);
  });

  it('caps restitution at GRENADE_MAX_RESTITUTION for ROCK material when base restitution is high', () => {
    const mockRng = () => 1; // Max rng
    const params = grenadeBounceParams(TERRAIN_MATERIAL.ROCK, mockRng);

    // Calculate base and multiplied manually to verify cap
    const baseRestitution = GRENADE_DIRT_RESTITUTION_MIN + 1 * GRENADE_DIRT_RESTITUTION_SPAN; // 0.58 + 0.12 = 0.7
    const multiplied = baseRestitution * GRENADE_ROCK_BOUNCE_SCALE; // 0.7 * Math.SQRT2 = ~0.9899

    expect(multiplied).toBeGreaterThan(GRENADE_MAX_RESTITUTION); // Ensure we're testing the cap
    expect(params.restitution).toBe(GRENADE_MAX_RESTITUTION);
    expect(params.explodeOnContact).toBe(false);
    expect(params.friction).toBe(GRENADE_ROCK_FRICTION);
  });
});
