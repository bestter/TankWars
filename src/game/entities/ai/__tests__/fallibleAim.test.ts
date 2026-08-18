import { describe, it, expect, vi, afterEach } from "vitest";
import {
  impactOffsetMagnitude,
  signedImpactOffset,
  maybeGaffe,
  scaledGaffe,
  sniperImpactMagnitude,
  FIRST_SHOT_FLOOR_PX,
  EARLY_LOCK_LEFTOVER_PX,
} from "../fallibleAim";
import * as random from "../../../../utils/random";

describe("fallibleAim", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maybeGaffe is true only when RNG is below the chance", () => {
    const spy = vi.spyOn(random, "secureRandom");
    spy.mockReturnValueOnce(0.09);
    expect(maybeGaffe(0.1)).toBe(true);
    spy.mockReturnValueOnce(0.1);
    expect(maybeGaffe(0.1)).toBe(false);
  });

  it("scaledGaffe multiplies chance by miss scale", () => {
    const spy = vi.spyOn(random, "secureRandom");
    spy.mockReturnValueOnce(0.3);
    expect(scaledGaffe(0.25, 0.15)).toBe(true);
    spy.mockReturnValueOnce(0.3);
    expect(scaledGaffe(0.25, 1)).toBe(false);
  });

  it("first shot never drops below the splash-safe floor", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(impactOffsetMagnitude(1, "v4-smart", 1.35)).toBeGreaterThanOrEqual(
      FIRST_SHOT_FLOOR_PX,
    );
    expect(impactOffsetMagnitude(1, "v2-heuristic", 1)).toBeGreaterThanOrEqual(
      FIRST_SHOT_FLOOR_PX,
    );
  });

  it("OK locks on shot 5 at spec and can miss that shot while warming up", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(impactOffsetMagnitude(5, "v2-heuristic", 1)).toBe(0);
    expect(impactOffsetMagnitude(5, "v2-heuristic", 0.15)).toBeCloseTo(
      0.85 * EARLY_LOCK_LEFTOVER_PX,
    );
  });

  it("Sniper locks on shot 4 and Expert on shot 3 at spec", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(impactOffsetMagnitude(4, "v3-sniper", 1)).toBe(0);
    expect(impactOffsetMagnitude(3, "v4-smart", 1)).toBe(0);
    expect(impactOffsetMagnitude(2, "v4-smart", 1)).toBeGreaterThan(0);
    expect(impactOffsetMagnitude(4, "v2-heuristic", 1)).toBeGreaterThan(0);
  });

  it("each miss shot is tighter than the previous at spec", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    const a = impactOffsetMagnitude(1, "v2-heuristic", 1);
    const b = impactOffsetMagnitude(2, "v2-heuristic", 1);
    const c = impactOffsetMagnitude(3, "v2-heuristic", 1);
    const d = impactOffsetMagnitude(4, "v2-heuristic", 1);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    expect(c).toBeGreaterThan(d);
  });

  it("heuristic first-shot magnitude stays in the wide miss band", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(impactOffsetMagnitude(1, "v2-heuristic")).toBe(52);
    vi.spyOn(random, "secureRandom").mockReturnValue(0.999);
    expect(impactOffsetMagnitude(1, "v2-heuristic")).toBeCloseTo(78, 0);
  });

  it("sniper first-shot magnitude is a safe miss, later shots tighten", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(impactOffsetMagnitude(1, "v3-sniper")).toBe(48);
    expect(impactOffsetMagnitude(2, "v3-sniper")).toBeGreaterThan(
      impactOffsetMagnitude(3, "v3-sniper"),
    );
    expect(impactOffsetMagnitude(4, "v3-sniper")).toBe(0);
    expect(impactOffsetMagnitude(9, "v3-sniper")).toBe(0);
  });

  it("expert first shot is fallible and locks from shot 3", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(impactOffsetMagnitude(1, "v4-smart")).toBe(42);
    expect(impactOffsetMagnitude(2, "v4-smart")).toBe(8);
    expect(impactOffsetMagnitude(3, "v4-smart")).toBe(0);
    expect(impactOffsetMagnitude(6, "v4-smart")).toBe(0);
  });

  it("sniper locked shots stay precise unless a mid-round slip fires", () => {
    const spy = vi.spyOn(random, "secureRandom");
    spy.mockReturnValueOnce(0.99);
    expect(sniperImpactMagnitude(4)).toBe(0);
    spy.mockReturnValueOnce(0.99);
    expect(sniperImpactMagnitude(8)).toBe(0);
  });

  it("sniper mid-round slip on a locked shot misses by 14–28px at spec", () => {
    const spy = vi.spyOn(random, "secureRandom");
    spy.mockReturnValueOnce(0.05);
    spy.mockReturnValueOnce(0);
    expect(sniperImpactMagnitude(5)).toBe(14);
    spy.mockReturnValueOnce(0.05);
    spy.mockReturnValueOnce(0.999);
    expect(sniperImpactMagnitude(6)).toBeCloseTo(28, 0);
  });

  it("sniper early shots do not roll a mid-round slip", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(sniperImpactMagnitude(1)).toBe(48);
    expect(sniperImpactMagnitude(3)).toBeGreaterThan(0);
  });

  it("signedImpactOffset uses the provided sign without consuming RNG for direction", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(signedImpactOffset(1, "v3-sniper", -1)).toBe(-48);
    expect(signedImpactOffset(1, "v3-sniper", 1)).toBe(48);
  });

  it("signedImpactOffset picks a random sign when none is given", () => {
    const spy = vi.spyOn(random, "secureRandom");
    spy.mockReturnValueOnce(0);
    spy.mockReturnValueOnce(0.1);
    expect(signedImpactOffset(1, "v4-smart")).toBe(-42);
    spy.mockReturnValueOnce(0);
    spy.mockReturnValueOnce(0.5);
    expect(signedImpactOffset(1, "v4-smart")).toBe(42);
  });
});
