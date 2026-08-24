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
    expect(isStrictOnlineMessage({ type: "SHOT_EARNINGS", shotId: 1, authorityEpoch: 1, awards: [{ playerId: "p1", amount: 1.5 }], deadSlots: [false], directHitVictimIds: [], roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null } })).toBe(false);
    expect(isStrictOnlineMessage({ type: "SHOT", shotId: 1, roundNumber: 1, shotNumberInRound: 1, isFirstShotOfRound: true, slot: 0, ownerId: "p1", command: { angle: 0, power: 1, weaponId: "LASER" } })).toBe(false);
    expect(parseStrictOnlineMessage("{bad-json")).toBeNull();
  });

  it("accepts strict Zeus events and rejects Zeus as a FireCommand weapon", () => {
    expect(isStrictOnlineMessage({
      type: "ZEUS_APPOINTED",
      appointmentId: 1,
      zeusId: "p2",
      zeusSlot: 1,
      rotationSlots: [1, 2, 0],
    })).toBe(true);
    expect(isStrictOnlineMessage({
      type: "ZEUS_STRIKE",
      strikeId: 4,
      zeusId: "p2",
      targetId: "p1",
      resolveAt: 1000,
    })).toBe(true);
    expect(isStrictOnlineMessage({
      type: "ZEUS_STRIKE_APPLIED",
      strikeId: 4,
      zeusId: "p2",
      targetId: "p1",
      award: { playerId: "p2", amount: 75 },
      balances: [{ playerId: "p2", money: 325 }],
      deadSlots: [true, false],
      roundOutcome: { isRoundEnd: true, isDraw: false, roundWinnerId: "p2" },
      nextPlayerIndex: null,
    })).toBe(true);
    expect(isStrictOnlineMessage({
      type: "ZEUS_STATE",
      activeZeusId: "p2",
      currentPlayerIndex: 1,
      rotationSlots: [1, 0],
      deadSlots: [false, false],
      activeStrike: null,
      lastAppliedStrikeId: 0,
    })).toBe(true);
    expect(isStrictOnlineMessage({
      type: "SHOT",
      shotId: 1,
      roundNumber: 1,
      shotNumberInRound: 1,
      isFirstShotOfRound: true,
      slot: 0,
      ownerId: "p1",
      command: { angle: 45, power: 50, weaponId: "ZEUS_LIGHTNING" },
    })).toBe(false);
  });
});
