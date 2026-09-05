import { describe, expect, it } from "vitest";
import {
  recordAimAttempt,
  resetAimMemoryForRound,
  type AimMemory,
} from "../aimMemory";

describe("aimMemory", () => {
  it("repart à la tentative 1 après A -> B -> A", () => {
    const memory: AimMemory = { currentTargetAttempts: 0 };
    resetAimMemoryForRound(memory, 1);

    expect(recordAimAttempt(memory, "A")).toBe(1);
    expect(recordAimAttempt(memory, "A")).toBe(2);
    expect(recordAimAttempt(memory, "B")).toBe(1);
    expect(recordAimAttempt(memory, "A")).toBe(1);
  });

  it("réinitialise la cible au changement de manche même sans changement de PV", () => {
    const memory: AimMemory = {
      currentTargetId: "A",
      currentTargetAttempts: 4,
      lastRoundNumber: 1,
    };

    expect(resetAimMemoryForRound(memory, 2)).toBe(true);
    expect(memory).toEqual({
      currentTargetAttempts: 0,
      lastRoundNumber: 2,
    });
    expect(recordAimAttempt(memory, "A")).toBe(1);
  });

  it("traite undefined, NaN et les valeurs <= 1 comme M1", () => {
    const memory: AimMemory = { currentTargetAttempts: 0 };
    expect(resetAimMemoryForRound(memory, undefined)).toBe(true);
    expect(resetAimMemoryForRound(memory, Number.NaN)).toBe(false);
    expect(resetAimMemoryForRound(memory, 0)).toBe(false);
    expect(memory.lastRoundNumber).toBe(1);
  });
});
