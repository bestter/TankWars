/**
 * Match-round skill ramp for all AI profiles.
 * Ease-out from AI_WARMUP_START_SKILL on manche 1 to 1.0 at AI_WARMUP_ROUNDS,
 * then keeps tightening until AI_LATE_SKILL_CAP.
 */

export const AI_WARMUP_ROUNDS = 5;
export const AI_WARMUP_START_SKILL = 0.15;
export const AI_WARMUP_EASE_POWER = 2;
export const AI_WARMUP_MISS_SCALE = 1.75;
export const AI_LATE_TIGHTEN_PER_ROUND = 0.07;
export const AI_LATE_SKILL_CAP = 1.35;
export const AI_LATE_MISS_FLOOR = 0.55;

export function clamp01(n: number): number {
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function easeOutUnit(t: number, power: number): number {
  const x = clamp01(t);
  return 1 - (1 - x) ** power;
}

/**
 * undefined / non-finite = manche-5 spec (1.0).
 * After AI_WARMUP_ROUNDS, climbs toward AI_LATE_SKILL_CAP.
 */
export function roundSkill(roundNumber: number | undefined): number {
  if (roundNumber === undefined || !Number.isFinite(roundNumber)) return 1;
  if (AI_WARMUP_ROUNDS <= 1) return 1;
  if (roundNumber > AI_WARMUP_ROUNDS) {
    return Math.min(
      AI_LATE_SKILL_CAP,
      1 + AI_LATE_TIGHTEN_PER_ROUND * (roundNumber - AI_WARMUP_ROUNDS),
    );
  }
  const t = (roundNumber - 1) / (AI_WARMUP_ROUNDS - 1);
  return (
    AI_WARMUP_START_SKILL +
    (1 - AI_WARMUP_START_SKILL) * easeOutUnit(t, AI_WARMUP_EASE_POWER)
  );
}

/** Multiplier on lock-curve miss distance. 1.75 early → 1.0 at spec → 0.55 at cap. */
export function aimMissScale(skill: number): number {
  if (skill <= 1) {
    const span = 1 - AI_WARMUP_START_SKILL;
    const u = span <= 0 ? 1 : clamp01((skill - AI_WARMUP_START_SKILL) / span);
    return AI_WARMUP_MISS_SCALE + (1 - AI_WARMUP_MISS_SCALE) * u;
  }
  const span = AI_LATE_SKILL_CAP - 1;
  const u = span <= 0 ? 1 : clamp01((skill - 1) / span);
  return 1 + (AI_LATE_MISS_FLOOR - 1) * u;
}
