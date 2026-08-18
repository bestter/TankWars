/**
 * Shared fallible-aim helpers for v2–v4 AI.
 * Offsets the intended impact point so splash cannot turn a near-miss into a hit.
 * Personality gaffes stay in each strategy; this module interpolates miss → lock.
 */

import { secureRandom } from "../../../utils/random";
import { aimMissScale } from "./roundSkill";

export type FallibleProfile = "v2-heuristic" | "v3-sniper" | "v4-smart";

interface OffsetBand {
  min: number;
  max: number;
}

/** Attempts on the same target before the lock shot (inclusive). Editable. */
export const SHOTS_TO_HIT: Record<FallibleProfile, number> = {
  "v2-heuristic": 5,
  "v3-sniper": 4,
  "v4-smart": 3,
};

/** Below splash (tank 24 + blast ~28) a "miss" can still kill. */
export const FIRST_SHOT_FLOOR_PX = 36;

/** Residual miss on shot N when skill < 1 (manches 1–4). */
export const EARLY_LOCK_LEFTOVER_PX = 36;

const FIRST_BAND: Record<FallibleProfile, OffsetBand> = {
  "v2-heuristic": { min: 52, max: 78 },
  "v3-sniper": { min: 48, max: 68 },
  "v4-smart": { min: 42, max: 58 },
};

const PRE_LOCK_BAND: Record<FallibleProfile, OffsetBand> = {
  "v2-heuristic": { min: 12, max: 22 },
  "v3-sniper": { min: 8, max: 14 },
  "v4-smart": { min: 8, max: 14 },
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function missBand(attempts: number, profile: FallibleProfile): OffsetBand {
  const n = SHOTS_TO_HIT[profile];
  const first = FIRST_BAND[profile];
  const pre = PRE_LOCK_BAND[profile];
  const missShots = Math.max(n - 1, 1);
  const u = (Math.min(Math.max(attempts, 1), missShots) - 1) / Math.max(missShots - 1, 1);
  return {
    min: lerp(first.min, pre.min, u),
    max: lerp(first.max, pre.max, u),
  };
}

/** Unsigned horizontal miss distance for this shot on the current target. */
export function impactOffsetMagnitude(
  attempts: number,
  profile: FallibleProfile,
  skill = 1,
): number {
  const n = SHOTS_TO_HIT[profile];
  if (attempts >= n) {
    if (skill >= 1) return 0;
    return (1 - skill) * EARLY_LOCK_LEFTOVER_PX;
  }
  const band = missBand(attempts, profile);
  const base = band.min + secureRandom() * (band.max - band.min);
  let mag = base * aimMissScale(skill);
  if (attempts <= 1) {
    mag = Math.max(mag, FIRST_SHOT_FLOOR_PX);
  }
  return mag;
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
 * on the lock shot and after so a mid-round duel is not a perfect laser.
 */
export function sniperImpactMagnitude(attempts: number, skill = 1): number {
  if (
    attempts >= SHOTS_TO_HIT["v3-sniper"] &&
    scaledGaffe(SNIPER_MID_ROUND_SLIP_CHANCE, skill)
  ) {
    return (
      (SNIPER_SLIP_MIN + secureRandom() * (SNIPER_SLIP_MAX - SNIPER_SLIP_MIN)) *
      aimMissScale(skill)
    );
  }
  return impactOffsetMagnitude(attempts, "v3-sniper", skill);
}
