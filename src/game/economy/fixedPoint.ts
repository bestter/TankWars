export const BASE_REWARD_AMOUNT = 2.0;
export const MAX_REWARD_PLAYERS = 4;
export const DAMAGE_PRECISION = 1_000;

export interface RationalSnapshot {
  numerator: string;
  denominator: string;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

/** Accumulateur rationnel exact. Les bigint ne quittent jamais le domaine économique. */
export class ExactAccumulator {
  private numerator = 0n;
  private denominator = 1n;

  public add(numerator: bigint, denominator: bigint): void {
    if (denominator <= 0n) {
      throw new RangeError("Le dénominateur doit être positif.");
    }
    if (numerator === 0n) return;

    const nextNumerator = this.numerator * denominator + numerator * this.denominator;
    const nextDenominator = this.denominator * denominator;
    const divisor = greatestCommonDivisor(nextNumerator, nextDenominator);
    this.numerator = nextNumerator / divisor;
    this.denominator = nextDenominator / divisor;
  }

  public addAccumulator(other: ExactAccumulator): void {
    const value = other.toBigIntPair();
    this.add(value.numerator, value.denominator);
  }

  public ceilToSafeInteger(): number {
    if (this.numerator < 0n) {
      throw new RangeError("Un gain ne peut pas être négatif.");
    }
    const rounded = (this.numerator + this.denominator - 1n) / this.denominator;
    if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError("Le gain dépasse la plage des entiers sûrs.");
    }
    return Number(rounded);
  }

  public toSnapshot(): RationalSnapshot {
    return {
      numerator: this.numerator.toString(),
      denominator: this.denominator.toString(),
    };
  }

  private toBigIntPair(): { numerator: bigint; denominator: bigint } {
    return { numerator: this.numerator, denominator: this.denominator };
  }
}

export function normalizeDamageToMilli(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("Les dommages doivent être un nombre fini positif ou nul.");
  }
  const normalized = Math.round(value * DAMAGE_PRECISION);
  if (!Number.isSafeInteger(normalized)) {
    throw new RangeError("Les dommages normalisés dépassent la plage des entiers sûrs.");
  }
  return normalized;
}

export function calculateBaseRewardMilli(playerCount: number): number {
  if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > MAX_REWARD_PLAYERS) {
    throw new RangeError("Le calcul des gains exige de 2 à 4 joueurs.");
  }
  const playerRatio = Math.round((playerCount / MAX_REWARD_PLAYERS) * 100) / 100;
  return Math.round(BASE_REWARD_AMOUNT * (1 + playerRatio) * DAMAGE_PRECISION);
}
