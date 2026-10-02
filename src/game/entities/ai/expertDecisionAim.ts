import { secureRandom } from "../../../utils/random";
import type { AimMemory } from "./aimMemory";
import { calculateImpactOffsetMagnitude, normalizeAimRound } from "./fallibleAim";

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
  memory: Readonly<AimMemory>,
  roundNumber?: number,
): ExpertDecisionAim {
  const round = normalizeAimRound(roundNumber);
  const previousTarget = memory.lastRoundNumber === round ? memory.currentTargetId : undefined;
  const previousAttempts = memory.lastRoundNumber === round ? memory.currentTargetAttempts : 0;
  let draws: { amplitude: number; side: number } | undefined;
  const reserve = () => draws ??= { amplitude: secureRandom(), side: secureRandom() };
  return {
    reserve,
    forTarget(targetId) {
      const values = reserve();
      const attempts = previousTarget === targetId ? previousAttempts + 1 : 1;
      const magnitude = calculateImpactOffsetMagnitude(attempts, "v4-smart", round, values.amplitude);
      return { primaryTargetId: targetId, attempts, offset: (values.side < 0.5 ? -1 : 1) * magnitude };
    },
  };
}
