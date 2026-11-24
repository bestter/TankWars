import type { ExpertConsequences } from "./expertConsequences";

export type AdvisorOutcome = ExpertConsequences & {
  readonly profit: number;
  readonly shooterDestroyed: boolean;
  /** Highest profile score among opponents actually harmed by the shot, including collateral damage. */
  readonly affectedProfileScore?: number;
};

export type AdvisorObjective = "SURVIE" | "OPTIMISER_PROFIT";
export interface AdvisorPolicy {
  readonly objective: AdvisorObjective;
  readonly neutralize?: boolean;
}

/** Filter every point/arc before an unsafe winner can hide a safe alternative. */
export function advisorAdmissible(policy: AdvisorPolicy, weapon: string, profit: number, destroyed: boolean): boolean {
  return !(policy.objective === "SURVIE" && destroyed) &&
    (policy.neutralize === true || weapon === "MISSILE" || profit >= 0);
}

export function compareNeutralConsequences(a: ExpertConsequences, b: ExpertConsequences): number {
  return (b.humanDestroyedCount + b.aiDestroyedCount) - (a.humanDestroyedCount + a.aiDestroyedCount) ||
    (b.humanDamageMilli + b.aiDamageMilli) - (a.humanDamageMilli + a.aiDamageMilli);
}

export function compareAdvisorOutcomes(
  a: AdvisorOutcome,
  b: AdvisorOutcome,
  policy: AdvisorPolicy,
): number {
  return (policy.neutralize ? 0 : b.profit - a.profit ||
    Number(a.shooterDestroyed) - Number(b.shooterDestroyed) ||
    (policy.objective === "OPTIMISER_PROFIT" ? (b.affectedProfileScore ?? 0) - (a.affectedProfileScore ?? 0) : 0)) ||
    compareNeutralConsequences(a, b);
}

export function advisorSelectionReason(a: AdvisorOutcome, b: AdvisorOutcome, policy: AdvisorPolicy): string | undefined {
  if (!policy.neutralize) {
    if (a.profit !== b.profit) return "profit net supérieur";
    if (a.shooterDestroyed !== b.shooterDestroyed) return "le tireur survit au tir";
    if (policy.objective === "OPTIMISER_PROFIT" && (a.affectedProfileScore ?? 0) !== (b.affectedProfileScore ?? 0)) {
      return "profil adverse affecté plus élevé";
    }
  }
  if (a.humanDestroyedCount + a.aiDestroyedCount !== b.humanDestroyedCount + b.aiDestroyedCount) {
    return "davantage d’adversaires détruits";
  }
  if (compareNeutralConsequences(a, b) !== 0) return "davantage de dégâts aux adversaires";
  return undefined;
}
