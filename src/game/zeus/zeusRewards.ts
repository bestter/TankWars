import type { PlayerId } from "../../types/player";
import { calculateBaseRewardMilli, DAMAGE_PRECISION, ExactAccumulator } from "../economy/fixedPoint";

export interface ZeusRewardResult {
  award: { playerId: PlayerId; amount: number };
  roundOutcome: {
    isRoundEnd: boolean;
    isDraw: boolean;
    roundWinnerId: PlayerId | null;
  };
}

export function calculateZeusStrikeReward(
  zeusId: PlayerId,
  playerCountAtMatchStart: number,
  survivorIds: readonly PlayerId[],
): ZeusRewardResult {
  const accumulator = new ExactAccumulator();
  accumulator.add(
    BigInt(25 * calculateBaseRewardMilli(playerCountAtMatchStart)),
    BigInt(DAMAGE_PRECISION),
  );
  const uniqueSurvivors = [...new Set(survivorIds)];
  if (uniqueSurvivors.length !== survivorIds.length) {
    throw new RangeError("Les survivants Zeus doivent être uniques.");
  }
  const isRoundEnd = uniqueSurvivors.length <= 1;
  return {
    award: { playerId: zeusId, amount: accumulator.ceilToSafeInteger() },
    roundOutcome: {
      isRoundEnd,
      isDraw: isRoundEnd && uniqueSurvivors.length === 0,
      roundWinnerId: uniqueSurvivors.length === 1 ? uniqueSurvivors[0] : null,
    },
  };
}
