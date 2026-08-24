import type { WeaponId } from "../../types/weapon";
import {
  DAMAGE_PRECISION,
  ExactAccumulator,
  calculateBaseRewardMilli,
  type RationalSnapshot,
} from "./fixedPoint";

export type DamageSource = "projectile" | "fall";
export type HitClassification = "direct" | "indirect";
export type DestructionCause = "health-zero" | "lava" | "out-of-bounds" | "buried";

export interface CombatDamageEvent {
  shotId: number;
  munitionId: number;
  shooterId: string;
  victimId: string;
  weaponId: WeaponId;
  source: DamageSource;
  classification: HitClassification;
  shieldAbsorbedMilli: number;
  healthDamageMilli: number;
}

export interface CombatDestructionEvent {
  shotId: number;
  shooterId: string;
  victimId: string;
  weaponId: WeaponId;
  cause: DestructionCause;
}

export interface ShotRewardInput {
  shotId: number;
  shooterId: string;
  weaponId: WeaponId;
  playerCountAtMatchStart: number;
  isFirstShotOfRound: boolean;
  aliveBeforeShot: string[];
  survivorsAfterShot: string[];
  damageEvents: CombatDamageEvent[];
  destructionEvents: CombatDestructionEvent[];
}

export type RewardComponentKind =
  | "projectile-damage"
  | "fall-damage"
  | "destruction"
  | "last-survivor"
  | "draw-share"
  | "draw-shooter";

export interface RewardComponent {
  kind: RewardComponentKind;
  value: RationalSnapshot;
}

export interface PlayerShotReward {
  playerId: string;
  amount: number;
  components: RewardComponent[];
}

export interface ShotRewardResult {
  shotId: number;
  awards: PlayerShotReward[];
  damageDealtMilliByPlayer: Record<string, number>;
  hasEarnings: boolean;
  roundOutcome: {
    isRoundEnd: boolean;
    isDraw: boolean;
    roundWinnerId: string | null;
  };
}

const MASS_DESTRUCTION_WEAPONS = new Set<WeaponId>(["NUKE", "THERMONUCLEAR"]);
const MONEY_AND_DAMAGE_SCALE = BigInt(DAMAGE_PRECISION * DAMAGE_PRECISION);
const MONEY_SCALE = BigInt(DAMAGE_PRECISION);

interface PlayerAccumulator {
  total: ExactAccumulator;
  components: RewardComponent[];
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} doit être un entier sûr positif ou nul.`);
  }
}

function addComponent(
  accumulators: Map<string, PlayerAccumulator>,
  playerId: string,
  kind: RewardComponentKind,
  numerator: bigint,
  denominator: bigint,
): void {
  if (numerator === 0n) return;
  const component = new ExactAccumulator();
  component.add(numerator, denominator);
  const accumulator = accumulators.get(playerId) ?? {
    total: new ExactAccumulator(),
    components: [],
  };
  accumulator.total.addAccumulator(component);
  accumulator.components.push({ kind, value: component.toSnapshot() });
  accumulators.set(playerId, accumulator);
}

function uniquePlayerIds(ids: readonly string[], label: string): Set<string> {
  const unique = new Set(ids);
  if (unique.size !== ids.length || ids.some((id) => id.length === 0)) {
    throw new RangeError(`${label} doit contenir des identifiants uniques non vides.`);
  }
  return unique;
}

export function calculateShotRewards(input: ShotRewardInput): ShotRewardResult {
  assertSafeNonNegativeInteger(input.shotId, "shotId");
  const xMilli = calculateBaseRewardMilli(input.playerCountAtMatchStart);
  const aliveBefore = uniquePlayerIds(input.aliveBeforeShot, "aliveBeforeShot");
  const survivors = uniquePlayerIds(input.survivorsAfterShot, "survivorsAfterShot");
  for (const survivor of survivors) {
    if (!aliveBefore.has(survivor)) {
      throw new RangeError("Un survivant doit avoir été vivant avant le tir.");
    }
  }

  const accumulators = new Map<string, PlayerAccumulator>();
  const damageDealtMilliByPlayer: Record<string, number> = {};

  for (const event of input.damageEvents) {
    if (event.shotId !== input.shotId) {
      throw new RangeError("Un événement de dommage appartient à un autre tir.");
    }
    assertSafeNonNegativeInteger(event.munitionId, "munitionId");
    assertSafeNonNegativeInteger(event.shieldAbsorbedMilli, "shieldAbsorbedMilli");
    assertSafeNonNegativeInteger(event.healthDamageMilli, "healthDamageMilli");
    if (event.shooterId === event.victimId) continue;

    const damageMilli = event.shieldAbsorbedMilli + event.healthDamageMilli;
    if (!Number.isSafeInteger(damageMilli)) {
      throw new RangeError("Le cumul des dommages dépasse la plage des entiers sûrs.");
    }
    damageDealtMilliByPlayer[event.shooterId] =
      (damageDealtMilliByPlayer[event.shooterId] ?? 0) + damageMilli;

    let divisor = event.classification === "direct" ? 1 : 2;
    if (event.source === "fall") {
      divisor = event.classification === "direct" ? 4 : 8;
    } else if (MASS_DESTRUCTION_WEAPONS.has(event.weaponId)) {
      divisor *= 2;
    }
    addComponent(
      accumulators,
      event.shooterId,
      event.source === "fall" ? "fall-damage" : "projectile-damage",
      BigInt(xMilli) * BigInt(damageMilli),
      MONEY_AND_DAMAGE_SCALE * BigInt(divisor),
    );
  }

  const destroyedVictims = new Set<string>();
  for (const event of input.destructionEvents) {
    if (event.shotId !== input.shotId) {
      throw new RangeError("Un événement de destruction appartient à un autre tir.");
    }
    if (event.shooterId === event.victimId || destroyedVictims.has(event.victimId)) continue;
    destroyedVictims.add(event.victimId);
    const multiplier = MASS_DESTRUCTION_WEAPONS.has(event.weaponId)
      ? 2
      : input.isFirstShotOfRound
        ? 50
        : 25;
    addComponent(
      accumulators,
      event.shooterId,
      "destruction",
      BigInt(multiplier * xMilli),
      MONEY_SCALE,
    );
  }

  const isRoundEnd = survivors.size <= 1;
  const isDraw = isRoundEnd && survivors.size === 0;
  const roundWinnerId = survivors.size === 1 ? [...survivors][0] : null;

  if (roundWinnerId !== null) {
    addComponent(
      accumulators,
      roundWinnerId,
      "last-survivor",
      BigInt(50 * xMilli),
      MONEY_SCALE,
    );
  } else if (isDraw) {
    const isMassDestruction = MASS_DESTRUCTION_WEAPONS.has(input.weaponId);
    const shareRecipients = isMassDestruction
      ? [...aliveBefore].filter((playerId) => playerId !== input.shooterId)
      : [...aliveBefore];
    if (shareRecipients.length > 0) {
      for (const playerId of shareRecipients) {
        addComponent(
          accumulators,
          playerId,
          "draw-share",
          BigInt(50 * xMilli),
          MONEY_SCALE * BigInt(shareRecipients.length),
        );
      }
    }
    addComponent(
      accumulators,
      input.shooterId,
      "draw-shooter",
      BigInt(xMilli),
      MONEY_SCALE,
    );
  }

  const awards = [...accumulators.entries()].map(([playerId, accumulator]) => ({
    playerId,
    amount: accumulator.total.ceilToSafeInteger(),
    components: accumulator.components,
  }));

  return {
    shotId: input.shotId,
    awards,
    damageDealtMilliByPlayer,
    hasEarnings: awards.some((award) => award.amount > 0),
    roundOutcome: { isRoundEnd, isDraw, roundWinnerId },
  };
}
