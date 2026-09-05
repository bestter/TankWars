import type { Player, TankHitReaction } from "../../../types/player";

export const FALL_DISTANCE_MAX_PX = 120;

interface ReactionProfile {
  directHit: number;
  fallMaximum: number;
}

const REACTION_PROFILES: Record<
  NonNullable<Player["aiProfile"]>,
  ReactionProfile
> = {
  "v1-random": { directHit: 0.28, fallMaximum: 0.6 },
  "v2-heuristic": { directHit: 0.22, fallMaximum: 0.4 },
  "v3-sniper": { directHit: 0.15, fallMaximum: 0.3 },
  "v4-smart": { directHit: 0.1, fallMaximum: 0.2 },
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Intensité de la corruption de la prochaine riposte seulement.
 */
export function getHitReactionIntensity(
  profile: Player["aiProfile"],
  hitReaction?: TankHitReaction,
): number {
  if (!hitReaction) return 0;

  const reactionProfile = REACTION_PROFILES[profile ?? "v1-random"];
  const fallDistance = Number.isFinite(hitReaction.fallDistance)
    ? Math.max(0, hitReaction.fallDistance)
    : 0;
  const fallRatio = clamp01(fallDistance / FALL_DISTANCE_MAX_PX);
  const direct = hitReaction.wasDirectHit ? reactionProfile.directHit : 0;
  return clamp01(direct + reactionProfile.fallMaximum * fallRatio);
}

/** Consomme entièrement la réaction après la riposte. */
export function consumeHitReaction(hitReaction?: TankHitReaction): void {
  if (!hitReaction) return;
  hitReaction.wasDirectHit = false;
  hitReaction.fallDistance = 0;
}
