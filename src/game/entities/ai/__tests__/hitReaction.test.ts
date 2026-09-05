import { describe, expect, it } from "vitest";
import {
  consumeHitReaction,
  getHitReactionIntensity,
} from "../hitReaction";
import { FALL_DISTANCE_MAX_PX } from "../../../../types/player";

describe("hitReaction", () => {
  it("applique les réactions de coup direct propres à chaque profil", () => {
    const reaction = { wasDirectHit: true, fallDistance: 0 };
    expect(getHitReactionIntensity("v4-smart", reaction)).toBe(0.1);
    expect(getHitReactionIntensity("v3-sniper", reaction)).toBe(0.15);
    expect(getHitReactionIntensity("v2-heuristic", reaction)).toBe(0.22);
    expect(getHitReactionIntensity("v1-random", reaction)).toBe(0.28);
  });

  it("interpole les chutes à 0, 60, 120 et au-delà", () => {
    const profiles = [
      ["v4-smart", 0.2],
      ["v3-sniper", 0.3],
      ["v2-heuristic", 0.4],
      ["v1-random", 0.6],
    ] as const;

    for (const [profile, maximum] of profiles) {
      expect(
        getHitReactionIntensity(profile, {
          wasDirectHit: false,
          fallDistance: 0,
        }),
      ).toBe(0);
      expect(
        getHitReactionIntensity(profile, {
          wasDirectHit: false,
          fallDistance: FALL_DISTANCE_MAX_PX / 2,
        }),
      ).toBeCloseTo(maximum / 2);
      expect(
        getHitReactionIntensity(profile, {
          wasDirectHit: false,
          fallDistance: FALL_DISTANCE_MAX_PX,
        }),
      ).toBe(maximum);
      expect(
        getHitReactionIntensity(profile, {
          wasDirectHit: false,
          fallDistance: FALL_DISTANCE_MAX_PX * 2,
        }),
      ).toBe(maximum);
    }
  });

  it("cumule un coup direct et une chute, puis consomme la réaction", () => {
    const reaction = { wasDirectHit: true, fallDistance: 120 };
    expect(getHitReactionIntensity("v4-smart", reaction)).toBeCloseTo(0.3);

    consumeHitReaction(reaction);
    expect(reaction).toEqual({ wasDirectHit: false, fallDistance: 0 });
    expect(getHitReactionIntensity("v4-smart", reaction)).toBe(0);
  });

  it("ignore une distance invalide plutôt que de produire une intensité invalide", () => {
    expect(
      getHitReactionIntensity("v1-random", {
        wasDirectHit: false,
        fallDistance: Number.NaN,
      }),
    ).toBe(0);
  });
});
