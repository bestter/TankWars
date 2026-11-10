/** Search policy is explicit: an opponent's profile never selects our policy. */
export type AimVariant = "full" | "low" | "high";
export interface AimSearchPolicy {
  readonly variant: AimVariant;
  readonly penalizeProximity: boolean;
  /** Local EXPERT own shots: keep integrating a trajectory still in flight past 420 steps. */
  readonly extendOpenFlight?: boolean;
}
export const ORDINARY_AIM_POLICY: AimSearchPolicy = { variant: "full", penalizeProximity: true };

/** Fixed field order. An omitted open-flight flag matches false, the 420-step search. */
export function aimSearchPolicyCacheToken(policy: AimSearchPolicy): {
  readonly variant: AimVariant;
  readonly penalizeProximity: boolean;
  readonly extendOpenFlight: boolean;
} {
  return {
    variant: policy.variant,
    penalizeProximity: policy.penalizeProximity,
    extendOpenFlight: policy.extendOpenFlight === true,
  } satisfies Record<keyof AimSearchPolicy, AimVariant | boolean>;
}
export const MATERIAL_AIM_VARIANTS: readonly AimVariant[] = ["full", "low", "high"];

export function aimCone(isRight: boolean, minimum: number, maximum: number, variant: AimVariant): {
  aMin: number; aMax: number;
} {
  const middle = (minimum + maximum) / 2;
  if (variant === "full") return { aMin: minimum, aMax: maximum };
  const upper = (variant === "high") === isRight;
  return upper ? { aMin: middle, aMax: maximum } : { aMin: minimum, aMax: middle };
}
