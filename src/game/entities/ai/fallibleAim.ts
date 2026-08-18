/**
 * Shared fallible-aim helpers for v2–v4 AI.
 * Offsets the intended impact point so splash cannot turn a near-miss into a hit.
 * Personality gaffes stay in each strategy; this module only rolls chance + lock curve.
 * Lock bands are the manche-5 spec; aimMissScale stretches or shrinks them by round skill.
 */

import { secureRandom } from "../../../utils/random";
import { aimMissScale } from "./roundSkill";

export type FallibleProfile = "v2-heuristic" | "v3-sniper" | "v4-smart";

interface OffsetBand {
  min: number;
  max: number;
}

/** Per-attempt impact offset bands (px) at skill 1. Index 0 = first shot on the target. */
const LOCK_CURVE: Record<FallibleProfile, readonly OffsetBand[]> = {
  "v2-heuristic": [
    { min: 40, max: 65 },
    { min: 22, max: 40 },
    { min: 10, max: 22 },
    { min: 6, max: 6 },
  ],
  "v3-sniper": [
    { min: 40, max: 56 },
    { min: 14, max: 26 },
    { min: 5, max: 10 },
    { min: 0, max: 0 },
  ],
  "v4-smart": [
    { min: 16, max: 28 },
    { min: 6, max: 14 },
    { min: 0, max: 0 },
  ],
};

function bandFor(attempts: number, profile: FallibleProfile): OffsetBand {
  const bands = LOCK_CURVE[profile];
  const index = Math.min(Math.max(Math.floor(attempts), 1), bands.length) - 1;
  return bands[index];
}

/** Unsigned horizontal miss distance for this shot on the current target. */
export function impactOffsetMagnitude(
  attempts: number,
  profile: FallibleProfile,
  skill = 1,
): number {
  const band = bandFor(attempts, profile);
  const base = band.min + secureRandom() * (band.max - band.min);
  return base * aimMissScale(skill);
}

/**
 * Signed impact offset. Pass `sign` (+1/-1) to aim toward open space or to invert
 * after an overcorrection; omit it to pick a random side.
 */
export function signedImpactOffset(
  attempts: number,
  profile: FallibleProfile,
  sign?: number,
  skill = 1,
): number {
  const magnitude = impactOffsetMagnitude(attempts, profile, skill);
  const dir = sign === undefined ? (secureRandom() < 0.5 ? -1 : 1) : Math.sign(sign) || 1;
  return dir * magnitude;
}

export function maybeGaffe(chance: number): boolean {
  return secureRandom() < chance;
}

export function scaledGaffe(chance: number, skill: number): boolean {
  return maybeGaffe(chance * aimMissScale(skill));
}

/** Chance the sniper misreads wind / crater after it has already locked. */
export const SNIPER_MID_ROUND_SLIP_CHANCE = 0.14;
const SNIPER_SLIP_MIN = 14;
const SNIPER_SLIP_MAX = 28;

/**
 * Sniper impact miss. Follows the lock curve, then occasionally slips
 * on shot 4+ so a mid-round duel is not a perfect laser.
 */
export function sniperImpactMagnitude(attempts: number, skill = 1): number {
  if (attempts >= 4 && scaledGaffe(SNIPER_MID_ROUND_SLIP_CHANCE, skill)) {
    return (
      (SNIPER_SLIP_MIN + secureRandom() * (SNIPER_SLIP_MAX - SNIPER_SLIP_MIN)) *
      aimMissScale(skill)
    );
  }
  return impactOffsetMagnitude(attempts, "v3-sniper", skill);
}
