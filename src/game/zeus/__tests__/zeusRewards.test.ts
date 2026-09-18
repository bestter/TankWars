import { describe, it, expect } from "vitest";
import { calculateZeusStrikeReward } from "../zeusRewards";
import { calculateBaseRewardMilli, MAX_REWARD_PLAYERS } from "../../economy/fixedPoint";

describe("calculateZeusStrikeReward", () => {
  it("throws an error if survivor IDs are not unique", () => {
    expect(() => {
      calculateZeusStrikeReward("zeus1", 4, ["player1", "player1"]);
    }).toThrow(RangeError);
    expect(() => {
      calculateZeusStrikeReward("zeus1", 4, ["player1", "player1"]);
    }).toThrow("Les survivants Zeus doivent être uniques.");
  });

  it("calculates reward and draw outcome when 0 survivors", () => {
    const result = calculateZeusStrikeReward("zeus1", 4, []);

    // ceilToSafeInteger of (25 * baseRewardMilli / 1000)
    const expectedAmount = Math.ceil((25 * calculateBaseRewardMilli(4)) / 1000);

    expect(result).toEqual({
      award: { playerId: "zeus1", amount: expectedAmount },
      roundOutcome: {
        isRoundEnd: true,
        isDraw: true,
        roundWinnerId: null,
      },
    });
  });

  it("calculates reward and winner outcome when 1 survivor", () => {
    const result = calculateZeusStrikeReward("zeus1", 4, ["player1"]);

    const expectedAmount = Math.ceil((25 * calculateBaseRewardMilli(4)) / 1000);

    expect(result).toEqual({
      award: { playerId: "zeus1", amount: expectedAmount },
      roundOutcome: {
        isRoundEnd: true,
        isDraw: false,
        roundWinnerId: "player1",
      },
    });
  });

  it("calculates reward and continue outcome when > 1 survivors", () => {
    const result = calculateZeusStrikeReward("zeus1", 4, ["player1", "player2"]);

    const expectedAmount = Math.ceil((25 * calculateBaseRewardMilli(4)) / 1000);

    expect(result).toEqual({
      award: { playerId: "zeus1", amount: expectedAmount },
      roundOutcome: {
        isRoundEnd: false,
        isDraw: false,
        roundWinnerId: null,
      },
    });
  });

  it("handles different playerCountAtMatchStart values properly", () => {
    // Should work for player count 2
    const result2 = calculateZeusStrikeReward("zeus1", 2, ["player1", "player2"]);
    const expectedAmount2 = Math.ceil((25 * calculateBaseRewardMilli(2)) / 1000);
    expect(result2.award.amount).toBe(expectedAmount2);

    // Should work for player count 3
    const result3 = calculateZeusStrikeReward("zeus1", 3, ["player1", "player2"]);
    const expectedAmount3 = Math.ceil((25 * calculateBaseRewardMilli(3)) / 1000);
    expect(result3.award.amount).toBe(expectedAmount3);
  });

  it("throws error for invalid playerCountAtMatchStart", () => {
    // calculateBaseRewardMilli throws for < 2 or > MAX_REWARD_PLAYERS
    expect(() => {
      calculateZeusStrikeReward("zeus1", 1, ["player1"]);
    }).toThrow(RangeError);

    expect(() => {
      calculateZeusStrikeReward("zeus1", MAX_REWARD_PLAYERS + 1, ["player1"]);
    }).toThrow(RangeError);
  });
});
