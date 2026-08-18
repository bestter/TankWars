/**
 * Match-round skill ramp for all AI profiles.
 * Manche 1 starts at AI_WARMUP_START_SKILL and reaches full spec at AI_WARMUP_ROUNDS.
 */

export const AI_WARMUP_ROUNDS = 5;
export const AI_WARMUP_START_SKILL = 0.1;
export const AI_WARMUP_EXTRA_PX = 80;

export function clamp01(n: number): number {
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

/**
 * AI_WARMUP_START_SKILL (0.10) on manche 1 → 1.0 from AI_WARMUP_ROUNDS onward.
 * Linear. undefined / non-finite = full spec (existing tests).
 */
export function roundSkill(roundNumber: number | undefined): number {
  if (roundNumber === undefined || !Number.isFinite(roundNumber)) return 1;
  if (AI_WARMUP_ROUNDS <= 1) return 1;
  const t = clamp01((roundNumber - 1) / (AI_WARMUP_ROUNDS - 1));
  return AI_WARMUP_START_SKILL + (1 - AI_WARMUP_START_SKILL) * t;
}

export function warmupImpactExtraPx(skill: number): number {
  return (1 - clamp01(skill)) * AI_WARMUP_EXTRA_PX;
}
