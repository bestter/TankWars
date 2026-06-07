import { secureRandom } from "../utils/random";
/**
 * Round wind: horizontal acceleration on projectiles (px/s²).
 * Positive = pushes projectiles toward the right (east on screen).
 */

export const WIND_ACCEL_MIN = -52;
export const WIND_ACCEL_MAX = 52;

/** ~10% chance of calm air each round. */
const CALM_CHANCE = 0.1;

export interface WindDisplay {
  readonly direction: "CALM" | "WEST" | "EAST";
  readonly arrow: "—" | "←" | "→";
  readonly strength: number;
  readonly label: string;
}

/** Rolls a new wind value for the start of a combat round. */
export function rollRoundWind(): number {
  if (secureRandom() < CALM_CHANCE) {
    return 0;
  }

  const sign = secureRandom() < 0.5 ? -1 : 1;
  const t = secureRandom();
  const magnitude = 10 + t * t * (WIND_ACCEL_MAX - 10);
  return Math.round(sign * magnitude * 10) / 10;
}

export function formatWindDisplay(force: number): WindDisplay {
  const abs = Math.abs(force);
  if (abs < 0.5) {
    return { direction: "CALM", arrow: "—", strength: 0, label: "CALM" };
  }
  if (force > 0) {
    return {
      direction: "EAST",
      arrow: "→",
      strength: Math.round(abs),
      label: "EAST",
    };
  }
  return {
    direction: "WEST",
    arrow: "←",
    strength: Math.round(abs),
    label: "WEST",
  };
}
