/**
 * Shared fallible-aim helpers for v2–v4 AI.
 * Offsets the intended impact point so splash cannot turn a near-miss into a hit.
 * Personality gaffes stay in each strategy; this module only rolls chance + lock curve.
 */

import { secureRandom } from "../../../utils/random";

export type FallibleProfile = "v2-heuristic" | "v3-sniper" | "v4-smart";

interface OffsetBand {
  min: number;
  max: number;
}

/** Per-attempt impact offset bands (px). Index 0 = first shot on the target. */
const LOCK_CURVE: Record<FallibleProfile, readonly OffsetBand[]> = {
  "v2-heuristic": [
    { min: 55, max: 90 },
    { min: 35, max: 60 },
    { min: 15, max: 35 },
    { min: 10, max: 10 },
  ],
  "v3-sniper": [
    { min: 55, max: 70 },
    { min: 20, max: 40 },
    { min: 8, max: 15 },
    { min: 0, max: 0 },
  ],
  "v4-smart": [
    { min: 24, max: 42 },
    { min: 10, max: 20 },
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
): number {
  const band = bandFor(attempts, profile);
  return band.min + secureRandom() * (band.max - band.min);
}

/**
 * Signed impact offset. Pass `sign` (+1/-1) to aim toward open space or to invert
 * after an overcorrection; omit it to pick a random side.
 */
export function signedImpactOffset(
  attempts: number,
  profile: FallibleProfile,
  sign?: number,
): number {
  const magnitude = impactOffsetMagnitude(attempts, profile);
  const dir = sign === undefined ? (secureRandom() < 0.5 ? -1 : 1) : Math.sign(sign) || 1;
  return dir * magnitude;
}

export function maybeGaffe(chance: number): boolean {
  return secureRandom() < chance;
}

/** Chance the sniper misreads wind / crater after it has already locked. */
export const SNIPER_MID_ROUND_SLIP_CHANCE = 0.18;
const SNIPER_SLIP_MIN = 20;
const SNIPER_SLIP_MAX = 42;

/**
 * Sniper impact miss. Follows the lock curve, then occasionally slips
 * on shot 4+ so a mid-round duel is not a perfect laser.
 */
export function sniperImpactMagnitude(attempts: number): number {
  if (attempts >= 4 && maybeGaffe(SNIPER_MID_ROUND_SLIP_CHANCE)) {
    return SNIPER_SLIP_MIN + secureRandom() * (SNIPER_SLIP_MAX - SNIPER_SLIP_MIN);
  }
  return impactOffsetMagnitude(attempts, "v3-sniper");
}
