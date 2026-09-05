import { secureRandom } from "../../../utils/random";

export interface AimCommand {
  angle: number;
  power: number;
}

export type AdvancedAimProfile =
  | "v2-heuristic"
  | "v3-sniper"
  | "v4-smart";

export interface AdvancedGaffeConfig {
  chance: number;
  angleAmplitude: number;
  powerAmplitude: number;
}

export const ADVANCED_GAFFES: Record<
  AdvancedAimProfile,
  AdvancedGaffeConfig
> = {
  "v2-heuristic": { chance: 0.1, angleAmplitude: 50, powerAmplitude: 25 },
  "v3-sniper": { chance: 0.05, angleAmplitude: 25, powerAmplitude: 15 },
  "v4-smart": { chance: 0.02, angleAmplitude: 10, powerAmplitude: 5 },
};

function randomSign(): number {
  return secureRandom() < 0.5 ? -1 : 1;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function randomIntegerInclusive(
  minimum: number,
  maximum: number,
): number {
  return minimum + Math.floor(secureRandom() * (maximum - minimum + 1));
}

/** Échantillonner la distribution de grosse gaffe SIMPLE. */
export function sampleSimpleGaffe(): AimCommand {
  return {
    angle: secureRandom() * 180,
    power:
      secureRandom() < 0.5
        ? randomIntegerInclusive(1, 9)
        : randomIntegerInclusive(80, 99),
  };
}

/**
 * Applique des corruptions direction et puissance avec des signes indépendants.
 * L'appelant omet cette fonction quand l'intensité vaut zéro.
 */
export function applySignedCorruption(
  command: AimCommand,
  angleAmplitude: number,
  powerAmplitude: number,
): AimCommand {
  return {
    angle: command.angle + randomSign() * angleAmplitude,
    power: command.power + randomSign() * powerAmplitude,
  };
}

export function interpolateAimCommands(
  from: AimCommand,
  to: AimCommand,
  intensity: number,
): AimCommand {
  return {
    angle: from.angle + (to.angle - from.angle) * intensity,
    power: from.power + (to.power - from.power) * intensity,
  };
}

/** Enveloppe finale v2-v4, fermée à 180 degrés. */
export function finalizeAdvancedAim(command: AimCommand): AimCommand {
  return {
    angle: Math.round(clamp(command.angle, 0, 180) * 10) / 10,
    power: Math.round(clamp(command.power, 1, 99)),
  };
}

/** Enveloppe finale SIMPLE, ouverte à 180 degrés même après l'arrondi. */
export function finalizeSimpleAim(command: AimCommand): AimCommand {
  const roundedAngle =
    Math.round(clamp(command.angle, 0, 179.999999) * 10) / 10;
  return {
    angle: Math.min(179.9, roundedAngle),
    power: Math.round(clamp(command.power, 1, 99)),
  };
}
