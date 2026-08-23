import { describe, expect, it } from "vitest";
import { isStrictOnlineMessage, parseStrictOnlineMessage } from "../protocol";

describe("strict online protocol", () => {
  it("accepts a complete SHOT identity", () => {
    expect(isStrictOnlineMessage({
      type: "SHOT",
      shotId: 4,
      roundNumber: 2,
      shotNumberInRound: 1,
      isFirstShotOfRound: true,
      slot: 0,
      ownerId: "p1",
      command: { angle: 45, power: 60, weaponId: "MISSILE" },
    })).toBe(true);
  });

  it("rejects malformed, decimal, and unknown-weapon payloads", () => {
    expect(isStrictOnlineMessage({ type: "SHOT_EARNINGS", shotId: 1, authorityEpoch: 1, awards: [{ playerId: "p1", amount: 1.5 }], deadSlots: [false], roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null } })).toBe(false);
    expect(isStrictOnlineMessage({ type: "SHOT", shotId: 1, roundNumber: 1, shotNumberInRound: 1, isFirstShotOfRound: true, slot: 0, ownerId: "p1", command: { angle: 0, power: 1, weaponId: "LASER" } })).toBe(false);
    expect(parseStrictOnlineMessage("{bad-json")).toBeNull();
  });
});
