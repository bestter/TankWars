import { describe, it, expect, vi, afterEach } from "vitest";
import {
  impactOffsetMagnitude,
  signedImpactOffset,
  maybeGaffe,
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

  it("heuristic first-shot magnitude stays in the wide miss band", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(impactOffsetMagnitude(1, "v2-heuristic")).toBe(55);
    vi.spyOn(random, "secureRandom").mockReturnValue(0.999);
    expect(impactOffsetMagnitude(1, "v2-heuristic")).toBeCloseTo(90, 0);
  });

  it("sniper first-shot magnitude is a safe miss (55–70), later shots tighten", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(impactOffsetMagnitude(1, "v3-sniper")).toBe(55);
    expect(impactOffsetMagnitude(2, "v3-sniper")).toBe(20);
    expect(impactOffsetMagnitude(3, "v3-sniper")).toBe(8);
    expect(impactOffsetMagnitude(4, "v3-sniper")).toBe(0);
    expect(impactOffsetMagnitude(9, "v3-sniper")).toBe(0);
  });

  it("expert first shot is fallible and locks from shot 3", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(impactOffsetMagnitude(1, "v4-smart")).toBe(24);
    expect(impactOffsetMagnitude(2, "v4-smart")).toBe(10);
    expect(impactOffsetMagnitude(3, "v4-smart")).toBe(0);
    expect(impactOffsetMagnitude(6, "v4-smart")).toBe(0);
  });

  it("heuristic never reaches a zero-offset lock", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(impactOffsetMagnitude(8, "v2-heuristic")).toBe(10);
  });

  it("sniper locked shots stay precise unless a mid-round slip fires", () => {
    const spy = vi.spyOn(random, "secureRandom");
    spy.mockReturnValueOnce(0.99);
    expect(sniperImpactMagnitude(4)).toBe(0);
    spy.mockReturnValueOnce(0.99);
    expect(sniperImpactMagnitude(8)).toBe(0);
  });

  it("sniper mid-round slip on a locked shot misses by 20–42px", () => {
    const spy = vi.spyOn(random, "secureRandom");
    spy.mockReturnValueOnce(0.05); // slip triggers (0.05 < 0.18)
    spy.mockReturnValueOnce(0); // min slip
    expect(sniperImpactMagnitude(5)).toBe(20);
    spy.mockReturnValueOnce(0.05);
    spy.mockReturnValueOnce(0.999);
    expect(sniperImpactMagnitude(6)).toBeCloseTo(42, 0);
  });

  it("sniper early shots do not roll a mid-round slip", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(sniperImpactMagnitude(1)).toBe(55);
    expect(sniperImpactMagnitude(3)).toBe(8);
  });

  it("signedImpactOffset uses the provided sign without consuming RNG for direction", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(signedImpactOffset(1, "v3-sniper", -1)).toBe(-55);
    expect(signedImpactOffset(1, "v3-sniper", 1)).toBe(55);
  });

  it("signedImpactOffset picks a random sign when none is given", () => {
    const spy = vi.spyOn(random, "secureRandom");
    spy.mockReturnValueOnce(0); // magnitude → min
    spy.mockReturnValueOnce(0.1); // sign → -1
    expect(signedImpactOffset(1, "v4-smart")).toBe(-24);
    spy.mockReturnValueOnce(0);
    spy.mockReturnValueOnce(0.5); // sign → +1
    expect(signedImpactOffset(1, "v4-smart")).toBe(24);
  });
});
