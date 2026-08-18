import { describe, it, expect } from "vitest";
import {
  AI_WARMUP_ROUNDS,
  AI_WARMUP_START_SKILL,
  AI_WARMUP_EXTRA_PX,
  roundSkill,
  warmupImpactExtraPx,
} from "../roundSkill";

describe("roundSkill", () => {
  it("defaults to full spec when round is omitted", () => {
    expect(roundSkill(undefined)).toBe(1);
  });

  it("starts at 10% on manche 1 and reaches 1 from warmup round onward", () => {
    expect(AI_WARMUP_ROUNDS).toBe(5);
    expect(AI_WARMUP_START_SKILL).toBe(0.1);
    expect(roundSkill(1)).toBeCloseTo(0.1);
    expect(roundSkill(2)).toBeCloseTo(0.325);
    expect(roundSkill(3)).toBeCloseTo(0.55);
    expect(roundSkill(4)).toBeCloseTo(0.775);
    expect(roundSkill(5)).toBe(1);
    expect(roundSkill(9)).toBe(1);
  });

  it("extra miss shrinks linearly to zero at spec", () => {
    expect(warmupImpactExtraPx(0)).toBe(AI_WARMUP_EXTRA_PX);
    expect(warmupImpactExtraPx(0.1)).toBeCloseTo(AI_WARMUP_EXTRA_PX * 0.9);
    expect(warmupImpactExtraPx(1)).toBe(0);
  });
});
