import type { Player } from "../../../types/player";

/** Shared ranking; human tactical score is independent of Zeus eligibility. */
export function expertProfileScore(player: Player): number {
  if (player.isHuman) return 0.9;
  switch (player.aiProfile) {
    case "v4-smart": return 1;
    case "v3-sniper": return 0.8;
    case "v1-random": return 0.1;
    default: return 0.5;
  }
}
