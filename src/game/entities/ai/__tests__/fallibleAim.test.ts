import { describe, it, expect, vi, afterEach } from "vitest";
import {
  impactOffsetMagnitude,
  signedImpactOffset,
  maybeGaffe,
  scaledGaffe,
  sniperImpactMagnitude,
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
    expect(scaledGaffe(0.25, 0.15)).toBe(true); // 0.25 * 1.75 = 0.4375
    spy.mockReturnValueOnce(0.3);
    expect(scaledGaffe(0.25, 1)).toBe(false); // 0.25 * 1 = 0.25
  });

  it("heuristic first-shot magnitude stays in the wide miss band", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(impactOffsetMagnitude(1, "v2-heuristic")).toBe(40);
    vi.spyOn(random, "secureRandom").mockReturnValue(0.999);
    expect(impactOffsetMagnitude(1, "v2-heuristic")).toBeCloseTo(65, 0);
  });

  it("sniper first-shot magnitude is a safe miss, later shots tighten", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(impactOffsetMagnitude(1, "v3-sniper")).toBe(40);
    expect(impactOffsetMagnitude(2, "v3-sniper")).toBe(14);
    expect(impactOffsetMagnitude(3, "v3-sniper")).toBe(5);
    expect(impactOffsetMagnitude(4, "v3-sniper")).toBe(0);
    expect(impactOffsetMagnitude(9, "v3-sniper")).toBe(0);
  });

  it("expert first shot is fallible and locks from shot 3", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(impactOffsetMagnitude(1, "v4-smart")).toBe(16);
    expect(impactOffsetMagnitude(2, "v4-smart")).toBe(6);
    expect(impactOffsetMagnitude(3, "v4-smart")).toBe(0);
    expect(impactOffsetMagnitude(6, "v4-smart")).toBe(0);
  });

  it("heuristic never reaches a zero-offset lock", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(impactOffsetMagnitude(8, "v2-heuristic")).toBe(6);
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
    spy.mockReturnValueOnce(0.05); // slip triggers (0.05 < 0.14)
    spy.mockReturnValueOnce(0); // min slip
    expect(sniperImpactMagnitude(5)).toBe(14);
    spy.mockReturnValueOnce(0.05);
    spy.mockReturnValueOnce(0.999);
    expect(sniperImpactMagnitude(6)).toBeCloseTo(28, 0);
  });

  it("sniper early shots do not roll a mid-round slip", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(sniperImpactMagnitude(1)).toBe(40);
    expect(sniperImpactMagnitude(3)).toBe(5);
  });

  it("signedImpactOffset uses the provided sign without consuming RNG for direction", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(signedImpactOffset(1, "v3-sniper", -1)).toBe(-40);
    expect(signedImpactOffset(1, "v3-sniper", 1)).toBe(40);
  });

  it("applies no extra scale when skill is omitted or 1", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(impactOffsetMagnitude(1, "v2-heuristic")).toBe(40);
    expect(impactOffsetMagnitude(1, "v2-heuristic", 1)).toBe(40);
  });

  it("widens miss at early skill and shrinks past spec", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(impactOffsetMagnitude(1, "v2-heuristic", 0.15)).toBeCloseTo(70);
    expect(signedImpactOffset(1, "v3-sniper", -1, 0.15)).toBeCloseTo(-70);
    expect(impactOffsetMagnitude(1, "v4-smart", 1.35)).toBeCloseTo(8.8);
  });

  it("sniper slip also receives the miss scale", () => {
    const spy = vi.spyOn(random, "secureRandom");
    spy.mockReturnValueOnce(0.05); // slip
    spy.mockReturnValueOnce(0); // min slip 14
    expect(sniperImpactMagnitude(5, 0.15)).toBeCloseTo(14 * 1.75);
  });

  it("signedImpactOffset picks a random sign when none is given", () => {
    const spy = vi.spyOn(random, "secureRandom");
    spy.mockReturnValueOnce(0); // magnitude → min
    spy.mockReturnValueOnce(0.1); // sign → -1
    expect(signedImpactOffset(1, "v4-smart")).toBe(-16);
    spy.mockReturnValueOnce(0);
    spy.mockReturnValueOnce(0.5); // sign → +1
    expect(signedImpactOffset(1, "v4-smart")).toBe(16);
  });
});
