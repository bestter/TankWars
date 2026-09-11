import type { AiProfile } from "../types/player";

export const DEFAULT_AI_PROFILE: AiProfile = "v1-random";
export type PlayerController = "human" | AiProfile;

export const AI_PROFILE_UI = {
  "v1-random": {
    optionKey: "controller_ai_simple",
    nameKey: "ai_name_simple",
    badge: "CPU",
  },
  "v2-heuristic": {
    optionKey: "controller_ai_ok",
    nameKey: "ai_name_ok",
    badge: "OK",
  },
  "v3-sniper": {
    optionKey: "controller_ai_sniper",
    nameKey: "ai_name_sniper",
    badge: "SNIP",
  },
  "v4-smart": {
    optionKey: "controller_ai_expert",
    nameKey: "ai_name_expert",
    badge: "EXPT",
  },
} as const satisfies Record<
  AiProfile,
  { readonly optionKey: string; readonly nameKey: string; readonly badge: string }
>;

export function isAiProfile(value: string): value is AiProfile {
  return Object.hasOwn(AI_PROFILE_UI, value);
}

export const AI_PROFILE_IDS: readonly AiProfile[] = Object.keys(AI_PROFILE_UI).filter(isAiProfile);

export function controllerBadge(isHuman: boolean, profile?: AiProfile): string {
  if (isHuman) return "P";
  return AI_PROFILE_UI[profile ?? DEFAULT_AI_PROFILE].badge;
}
