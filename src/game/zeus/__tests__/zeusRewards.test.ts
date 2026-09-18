import { describe, it, expect } from "vitest";
import { calculateZeusStrikeReward } from "../zeusRewards";
import { MAX_REWARD_PLAYERS } from "../../economy/fixedPoint";

describe("calculateZeusStrikeReward", () => {
  it("throws an error if survivor IDs are not unique", () => {
    expect(() => {
      calculateZeusStrikeReward("zeus1", 4, ["player1", "player1"]);
    }).toThrowError(new RangeError("Les survivants Zeus doivent être uniques."));
  });

  it("calculates reward and draw outcome when 0 survivors", () => {
    const result = calculateZeusStrikeReward("zeus1", 4, []);

    expect(result).toEqual({
      award: { playerId: "zeus1", amount: 100 },
      roundOutcome: {
        isRoundEnd: true,
        isDraw: true,
        roundWinnerId: null,
      },
    });
  });

  it("calculates reward and winner outcome when 1 survivor", () => {
    const result = calculateZeusStrikeReward("zeus1", 4, ["player1"]);

    expect(result).toEqual({
      award: { playerId: "zeus1", amount: 100 },
      roundOutcome: {
        isRoundEnd: true,
        isDraw: false,
        roundWinnerId: "player1",
      },
    });
  });

  it("calculates reward and continue outcome when > 1 survivors", () => {
    const result = calculateZeusStrikeReward("zeus1", 4, ["player1", "player2"]);

    expect(result).toEqual({
      award: { playerId: "zeus1", amount: 100 },
      roundOutcome: {
        isRoundEnd: false,
        isDraw: false,
        roundWinnerId: null,
      },
    });
  });

  it.each([
    [2, 75],
    [3, 88],
    [MAX_REWARD_PLAYERS, 100],
  ])(
    "calculates the expected reward for %i players",
    (playerCountAtMatchStart, expectedAmount) => {
      const result = calculateZeusStrikeReward("zeus1", playerCountAtMatchStart, [
        "player1",
        "player2",
      ]);

      expect(result.award.amount).toBe(expectedAmount);
    },
  );

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
