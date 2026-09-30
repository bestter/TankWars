import type { Player } from "../../../types/player";
import type { CombatDamageEvent, CombatDestructionEvent } from "../../economy/shotRewards";

export interface ExpertConsequences {
  readonly humanDestroyedCount: number;
  readonly humanDamageMilli: number;
  readonly aiDestroyedCount: number;
  readonly aiDamageMilli: number;
}

/** Negative means the left forecast better preserves humans at equal safety/profit. */
export function compareExpertConsequences(a: ExpertConsequences, b: ExpertConsequences): number {
  return a.humanDestroyedCount - b.humanDestroyedCount ||
    a.humanDamageMilli - b.humanDamageMilli ||
    b.aiDestroyedCount - a.aiDestroyedCount ||
    b.aiDamageMilli - a.aiDamageMilli;
}

/** Uses only applied events; deaths never manufacture health or shield losses. */
export function aggregateExpertConsequences(
  roster: readonly Player[],
  shotId: number,
  shooterId: string,
  damage: readonly CombatDamageEvent[],
  destruction: readonly CombatDestructionEvent[],
): ExpertConsequences {
  const victims = new Map(roster.map((player) => [player.id, player]));
  let humanDamageMilli = 0;
  let aiDamageMilli = 0;
  const humanDestroyed = new Set<string>();
  const aiDestroyed = new Set<string>();
  const victimFor = (event: CombatDamageEvent | CombatDestructionEvent): Player | undefined => {
    if (event.shotId !== shotId || event.shooterId !== shooterId || event.victimId === shooterId) {
      return undefined;
    }
    const victim = victims.get(event.victimId);
    if (!victim) throw new RangeError("Victime absente du roster de la prévision EXPERT.");
    return victim;
  };
  for (const event of damage) {
    const victim = victimFor(event);
    if (!victim) continue;
    for (const value of [event.shieldLostMilli, event.healthDamageMilli]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError("Perte physique EXPERT absente ou invalide.");
      }
    }
    const loss = event.shieldLostMilli + event.healthDamageMilli;
    if (victim.isHuman) humanDamageMilli += loss;
    else aiDamageMilli += loss;
    if (!Number.isSafeInteger(loss) || !Number.isSafeInteger(humanDamageMilli) ||
        !Number.isSafeInteger(aiDamageMilli)) {
      throw new RangeError("Le cumul des pertes physiques EXPERT dépasse les entiers sûrs.");
    }
  }
  for (const event of destruction) {
    const victim = victimFor(event);
    if (victim) (victim.isHuman ? humanDestroyed : aiDestroyed).add(victim.id);
  }
  return {
    humanDestroyedCount: humanDestroyed.size,
    humanDamageMilli,
    aiDestroyedCount: aiDestroyed.size,
    aiDamageMilli,
  };
}
