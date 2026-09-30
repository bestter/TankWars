/** Search policy is explicit: an opponent's profile never selects our policy. */
export type AimVariant = "full" | "low" | "high";
export interface AimSearchPolicy {
  readonly variant: AimVariant;
  readonly penalizeProximity: boolean;
}
export const ORDINARY_AIM_POLICY: AimSearchPolicy = { variant: "full", penalizeProximity: true };
export const MATERIAL_AIM_VARIANTS: readonly AimVariant[] = ["full", "low", "high"];

export function aimCone(isRight: boolean, minimum: number, maximum: number, variant: AimVariant): {
  aMin: number; aMax: number;
} {
  const middle = (minimum + maximum) / 2;
  if (variant === "full") return { aMin: minimum, aMax: maximum };
  const upper = (variant === "high") === isRight;
  return upper ? { aMin: middle, aMax: maximum } : { aMin: minimum, aMax: middle };
}
