import { secureRandom } from "../../../utils/random";
import type { AimMemory } from "./aimMemory";
import { FIRST_SHOT_FLOOR_PX, SHOTS_TO_HIT, getAimParameters, normalizeAimRound } from "./fallibleAim";

export interface ExpertTargetAim {
  readonly primaryTargetId: string;
  readonly attempts: number;
  readonly offset: number;
}

export interface ExpertDecisionAim {
  /** Reserve amplitude, then side, after the optional SURVIE roll. */
  reserve(): void;
  forTarget(targetId: string): ExpertTargetAim;
}

/** Virtual attempts and one shared primitive pair; never advances live memory. */
export function createExpertDecisionAim(
  memory: Readonly<AimMemory> = { currentTargetAttempts: 0 },
  roundNumber?: number,
): ExpertDecisionAim {
  const round = normalizeAimRound(roundNumber);
  const previousTarget = memory.lastRoundNumber === round ? memory.currentTargetId : undefined;
  const previousAttempts = memory.lastRoundNumber === round ? memory.currentTargetAttempts : 0;
  const parameters = getAimParameters("v4-smart", round);
  let draws: { amplitude: number; side: number } | undefined;
  const reserve = () => draws ??= { amplitude: secureRandom(), side: secureRandom() };
  return {
    reserve,
    forTarget(targetId) {
      const values = reserve();
      const attempts = previousTarget === targetId ? previousAttempts + 1 : 1;
      const magnitude = attempts >= SHOTS_TO_HIT["v4-smart"] ? parameters.residual : Math.max(FIRST_SHOT_FLOOR_PX,
        parameters.firstBand.min + (parameters.firstBand.max - parameters.firstBand.min) * values.amplitude);
      return { primaryTargetId: targetId, attempts, offset: (values.side < 0.5 ? -1 : 1) * magnitude };
    },
  };
}
