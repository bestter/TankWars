/**
 * Courbes de visée faillible partagées par les quatre profils IA.
 *
 * Les bandes et résidus sont des offsets horizontaux de la cible visée, avant
 * le solveur balistique. Ils ne garantissent pas le point d'impact physique.
 */

import type { AiProfile } from "../../../types/player";
import { secureRandom } from "../../../utils/random";

export type FallibleProfile = AiProfile;

interface OffsetBand {
  min: number;
  max: number;
}

interface AimAnchors {
  firstBand: OffsetBand;
  residual: number;
}

export interface AimParameters {
  firstBand: Readonly<OffsetBand>;
  residual: number;
}

type AimAnchorTable = {
  m1: AimAnchors;
  m5: AimAnchors;
  m12: AimAnchors;
};

/** Tentative inclusive à laquelle le profil atteint son résidu. */
export const SHOTS_TO_HIT: Record<FallibleProfile, number> = {
  "v1-random": 7,
  "v2-heuristic": 5,
  "v3-sniper": 3,
  "v4-smart": 2,
};

/** Empêche une visée directe intentionnelle au premier tir, pas un splash. */
export const FIRST_SHOT_FLOOR_PX = 36;

const AIM_ANCHORS: Record<FallibleProfile, AimAnchorTable> = {
  "v1-random": {
    m1: { firstBand: { min: 74, max: 84 }, residual: 48 },
    m5: { firstBand: { min: 69, max: 74 }, residual: 30 },
    m12: { firstBand: { min: 59, max: 69 }, residual: 21 },
  },
  "v2-heuristic": {
    m1: { firstBand: { min: 62, max: 72 }, residual: 36 },
    m5: { firstBand: { min: 57, max: 62 }, residual: 18 },
    m12: { firstBand: { min: 47, max: 57 }, residual: 9 },
  },
  "v3-sniper": {
    m1: { firstBand: { min: 57, max: 62 }, residual: 18 },
    m5: { firstBand: { min: 47, max: 57 }, residual: 10 },
    m12: { firstBand: { min: 39, max: 47 }, residual: 4 },
  },
  "v4-smart": {
    m1: { firstBand: { min: 45, max: 57 }, residual: 12 },
    m5: { firstBand: { min: 38, max: 45 }, residual: 6 },
    m12: { firstBand: { min: 36, max: 38 }, residual: 0 },
  },
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function lerp(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function interpolateAnchors(
  start: AimAnchors,
  end: AimAnchors,
  progress: number,
): AimParameters {
  return {
    firstBand: {
      min: lerp(start.firstBand.min, end.firstBand.min, progress),
      max: lerp(start.firstBand.max, end.firstBand.max, progress),
    },
    residual: lerp(start.residual, end.residual, progress),
  };
}

/** undefined, NaN et les manches <= 1 utilisent l'ancrage M1. */
export function normalizeAimRound(roundNumber: number | undefined): number {
  if (
    roundNumber === undefined ||
    !Number.isFinite(roundNumber) ||
    roundNumber <= 1
  ) {
    return 1;
  }
  return roundNumber;
}

/** Bandes et résidu interpolés pour une manche donnée. */
export function getAimParameters(
  profile: FallibleProfile,
  roundNumber: number | undefined,
): AimParameters {
  const round = normalizeAimRound(roundNumber);
  const anchors = AIM_ANCHORS[profile];

  if (round < 5) {
    return interpolateAnchors(anchors.m1, anchors.m5, (round - 1) / 4);
  }
  if (round < 12) {
    return interpolateAnchors(anchors.m5, anchors.m12, (round - 5) / 7);
  }
  return {
    firstBand: { ...anchors.m12.firstBand },
    residual: anchors.m12.residual,
  };
}

/**
 * Offset horizontal absolu du tir courant. La magnitude ne consomme aucun RNG
 * dès que la tentative a atteint le seuil du profil.
 */
export function impactOffsetMagnitude(
  attempts: number,
  profile: FallibleProfile,
  roundNumber: number | undefined,
): number {
  const threshold = SHOTS_TO_HIT[profile];
  const parameters = getAimParameters(profile, roundNumber);

  if (attempts >= threshold) {
    return parameters.residual;
  }

  const normalizedAttempt = Math.max(1, attempts);
  const progression = clamp01(
    (normalizedAttempt - 1) / Math.max(threshold - 1, 1),
  );
  const firstOffset = lerp(
    parameters.firstBand.min,
    parameters.firstBand.max,
    secureRandom(),
  );
  const magnitude = lerp(firstOffset, parameters.residual, progression);

  return normalizedAttempt <= 1
    ? Math.max(magnitude, FIRST_SHOT_FLOOR_PX)
    : magnitude;
}

/**
 * Offset horizontal signé. Sans signe explicite, le côté est tiré séparément
 * de la magnitude.
 */
export function signedImpactOffset(
  attempts: number,
  profile: FallibleProfile,
  roundNumber: number | undefined,
  sign?: number,
): number {
  const magnitude = impactOffsetMagnitude(attempts, profile, roundNumber);
  const direction =
    sign === undefined
      ? secureRandom() < 0.5
        ? -1
        : 1
      : Math.sign(sign) || 1;
  return direction * magnitude;
}

export function maybeGaffe(chance: number): boolean {
  return secureRandom() < chance;
}
