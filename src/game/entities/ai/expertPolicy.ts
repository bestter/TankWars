import type { ExpertConsequences } from "./expertConsequences";

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
  a: ExpertConsequences & { readonly profit: number; readonly shooterDestroyed: boolean },
  b: ExpertConsequences & { readonly profit: number; readonly shooterDestroyed: boolean },
  policy: AdvisorPolicy,
): number {
  return (policy.neutralize ? 0 : b.profit - a.profit ||
    Number(a.shooterDestroyed) - Number(b.shooterDestroyed)) || compareNeutralConsequences(a, b);
}
