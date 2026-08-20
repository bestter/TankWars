/**
 * TankWars - hitReaction.ts
 *
 * Implements Issue #174: Learning / inaccuracy curves after an AI player is hit or falls.
 *
 * Rules:
 * 1. Direct projectile hit: next shot is 50% less accurate (+0.50).
 * 2. Fall down: next shot is 1% to 25% less accurate depending on fall distance (0 to 120 px).
 * 3. Both are cumulative on the FIRST shot after the event.
 * 4. On the SECOND shot after a hit (if not hit again in between):
 *    - SNIPER (v3-sniper): reacts normally; very accurate (0% penalty).
 *    - EXPERT (v4-smart): 12% less accurate (0.12 penalty).
 *    - OK (v2-heuristic): 25% less accurate (0.25 penalty).
 *    - SIMPLE (v1-random): 25% less accurate (0.25 penalty).
 * 5. Third shot and onwards: returns to baseline (0% penalty).
 */

import type { Player, TankHitReaction } from "../../../types/player";

export const DIRECT_HIT_PENALTY = 0.5;
export const FALL_PENALTY_MIN = 0.01;
export const FALL_PENALTY_MAX = 0.25;
export const FALL_DISTANCE_MAX_PX = 120;

export const SECOND_SHOT_PENALTIES: Record<
  NonNullable<Player["aiProfile"]>,
  number
> = {
  "v3-sniper": 0.0,
  "v4-smart": 0.12,
  "v2-heuristic": 0.25,
  "v1-random": 0.25,
};

/**
 * Calculates fall inaccuracy penalty based on downward pixels fallen.
 * Scale: 0 px -> 0, 1 px -> 1%, 120 px+ -> 25%.
 */
export function computeFallPenalty(fallDistance: number): number {
  if (fallDistance <= 0 || !Number.isFinite(fallDistance)) return 0;
  const ratio = Math.min(1, fallDistance / FALL_DISTANCE_MAX_PX);
  return (
    FALL_PENALTY_MIN + ratio * (FALL_PENALTY_MAX - FALL_PENALTY_MIN)
  );
}

/**
 * Evaluates the inaccuracy penalty (e.g. 0.50 for +50% miss) for the upcoming shot.
 */
export function getHitReactionPenalty(
  profile: Player["aiProfile"],
  hitReaction?: TankHitReaction,
): number {
  if (!hitReaction) return 0;

  // If a new direct hit or fall happened since the last turn -> Shot #1
  if (hitReaction.wasDirectHit || hitReaction.fallDistance > 0) {
    const directPenalty = hitReaction.wasDirectHit ? DIRECT_HIT_PENALTY : 0;
    const fallPenalty = computeFallPenalty(hitReaction.fallDistance);
    return directPenalty + fallPenalty;
  }

  // If Shot #1 was completed and no new hit/fall occurred -> Shot #2
  if (hitReaction.shotStep === 1) {
    const prof = profile ?? "v1-random";
    return SECOND_SHOT_PENALTIES[prof] ?? 0.25;
  }

  // Shot #3+ / fully recovered
  return 0;
}

/**
 * Advances the recovery state machine after the AI fires its shot.
 */
export function advanceHitReaction(hitReaction?: TankHitReaction): void {
  if (!hitReaction) return;

  if (hitReaction.wasDirectHit || hitReaction.fallDistance > 0) {
    // Shot #1 completed
    hitReaction.wasDirectHit = false;
    hitReaction.fallDistance = 0;
    hitReaction.shotStep = 1;
  } else if (hitReaction.shotStep === 1) {
    // Shot #2 completed -> now recovered
    hitReaction.shotStep = 2;
  } else if (hitReaction.shotStep >= 2) {
    hitReaction.shotStep = 0;
  }
}
