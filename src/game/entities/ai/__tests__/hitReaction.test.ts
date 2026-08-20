import { describe, it, expect } from "vitest";
import {
  computeFallPenalty,
  getHitReactionPenalty,
  advanceHitReaction,
  DIRECT_HIT_PENALTY,
  FALL_PENALTY_MIN,
  FALL_PENALTY_MAX,
} from "../hitReaction";
import type { TankHitReaction } from "../../../../types/player";

describe("hitReaction", () => {
  describe("computeFallPenalty", () => {
    it("returns 0 for no fall or negative distance", () => {
      expect(computeFallPenalty(0)).toBe(0);
      expect(computeFallPenalty(-10)).toBe(0);
    });

    it("returns ~1% for minimal fall (1px)", () => {
      const penalty = computeFallPenalty(1);
      expect(penalty).toBeCloseTo(FALL_PENALTY_MIN, 2);
      expect(penalty).toBeGreaterThanOrEqual(FALL_PENALTY_MIN);
    });

    it("interpolates linearly up to 120px", () => {
      const halfPenalty = computeFallPenalty(60);
      // 0.01 + 0.5 * 0.24 = 0.13 (13%)
      expect(halfPenalty).toBeCloseTo(0.13, 2);
    });

    it("caps at 25% for falls of 120px or more", () => {
      expect(computeFallPenalty(120)).toBeCloseTo(FALL_PENALTY_MAX, 2);
      expect(computeFallPenalty(200)).toBeCloseTo(FALL_PENALTY_MAX, 2);
    });
  });

  describe("getHitReactionPenalty and advanceHitReaction state machine", () => {
    it("returns 0 when hitReaction is undefined", () => {
      expect(getHitReactionPenalty("v3-sniper", undefined)).toBe(0);
    });

    it("handles direct hit only (50% penalty on shot 1)", () => {
      const reaction: TankHitReaction = {
        wasDirectHit: true,
        fallDistance: 0,
        shotStep: 0,
      };

      // Shot 1
      expect(getHitReactionPenalty("v3-sniper", reaction)).toBe(DIRECT_HIT_PENALTY);
      advanceHitReaction(reaction);

      // Shot 2 (Sniper reacts normally -> 0%)
      expect(getHitReactionPenalty("v3-sniper", reaction)).toBe(0);
      advanceHitReaction(reaction);

      // Shot 3 (Fully recovered -> 0%)
      expect(getHitReactionPenalty("v3-sniper", reaction)).toBe(0);
    });

    it("handles cumulative direct hit + fall on shot 1", () => {
      const reaction: TankHitReaction = {
        wasDirectHit: true,
        fallDistance: 120, // 25%
        shotStep: 0,
      };

      // Shot 1: 50% + 25% = 75% (0.75)
      expect(getHitReactionPenalty("v4-smart", reaction)).toBeCloseTo(0.75, 2);
      advanceHitReaction(reaction);

      // Shot 2: Expert is 12% less accurate on shot 2
      expect(getHitReactionPenalty("v4-smart", reaction)).toBeCloseTo(0.12, 2);
      advanceHitReaction(reaction);

      // Shot 3: Fully recovered (0%)
      expect(getHitReactionPenalty("v4-smart", reaction)).toBe(0);
    });

    it("applies second-shot penalties correctly across all profiles", () => {
      const createShot2Reaction = (): TankHitReaction => ({
        wasDirectHit: false,
        fallDistance: 0,
        shotStep: 1,
      });

      expect(getHitReactionPenalty("v3-sniper", createShot2Reaction())).toBe(0.0);
      expect(getHitReactionPenalty("v4-smart", createShot2Reaction())).toBe(0.12);
      expect(getHitReactionPenalty("v2-heuristic", createShot2Reaction())).toBe(0.25);
      expect(getHitReactionPenalty("v1-random", createShot2Reaction())).toBe(0.25);
      expect(getHitReactionPenalty(undefined, createShot2Reaction())).toBe(0.25);
    });

    it("resets to Shot 1 if hit again before Shot 2", () => {
      const reaction: TankHitReaction = {
        wasDirectHit: true,
        fallDistance: 0,
        shotStep: 0,
      };

      // Fired Shot 1
      advanceHitReaction(reaction);
      expect(reaction.shotStep).toBe(1);

      // Hit again before Shot 2!
      reaction.wasDirectHit = true;
      reaction.shotStep = 0;

      // Should be Shot 1 again with 50% penalty
      expect(getHitReactionPenalty("v4-smart", reaction)).toBe(0.5);
    });
  });
});
