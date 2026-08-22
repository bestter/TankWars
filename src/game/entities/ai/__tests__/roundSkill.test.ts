import { describe, it, expect } from "vitest";
import {
  AI_WARMUP_ROUNDS,
  AI_WARMUP_START_SKILL,
  AI_LATE_SKILL_CAP,
  roundSkill,
  aimMissScale,
  clamp01,
} from "../roundSkill";

describe("roundSkill", () => {
  it("defaults to manche-5 spec when round is omitted", () => {
    expect(roundSkill(undefined)).toBe(1);
    expect(aimMissScale(1)).toBe(1);
  });

  it("ease-out from 15% on manche 1 to 1 on manche 5", () => {
    expect(AI_WARMUP_ROUNDS).toBe(5);
    expect(AI_WARMUP_START_SKILL).toBe(0.15);
    expect(roundSkill(1)).toBeCloseTo(0.15);
    expect(roundSkill(2)).toBeCloseTo(0.521875);
    expect(roundSkill(3)).toBeCloseTo(0.7875);
    expect(roundSkill(4)).toBeCloseTo(0.946875);
    expect(roundSkill(5)).toBe(1);
  });

  it("keeps tightening after manche 5 up to the cap", () => {
    expect(roundSkill(6)).toBeCloseTo(1.07);
    expect(roundSkill(7)).toBeCloseTo(1.14);
    expect(roundSkill(10)).toBeCloseTo(1.35);
    expect(roundSkill(20)).toBe(AI_LATE_SKILL_CAP);
  });

  it("miss scale is wide early and shrinks past spec", () => {
    expect(aimMissScale(0.15)).toBeCloseTo(1.75);
    expect(aimMissScale(1)).toBe(1);
    expect(aimMissScale(1.35)).toBeCloseTo(0.55);
  });
});


describe("clamp01", () => {
  it("clamps values correctly", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1)).toBe(1);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(1);
  });
});
