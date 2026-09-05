import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_SHOT_FLOOR_PX,
  SHOTS_TO_HIT,
  getAimParameters,
  impactOffsetMagnitude,
  maybeGaffe,
  signedImpactOffset,
} from "../fallibleAim";
import * as random from "../../../../utils/random";

const profiles = [
  "v1-random",
  "v2-heuristic",
  "v3-sniper",
  "v4-smart",
] as const;

const anchors = {
  "v1-random": [
    [1, 74, 84, 48],
    [5, 69, 74, 30],
    [12, 59, 69, 21],
  ],
  "v2-heuristic": [
    [1, 62, 72, 36],
    [5, 57, 62, 18],
    [12, 47, 57, 9],
  ],
  "v3-sniper": [
    [1, 57, 62, 18],
    [5, 47, 57, 10],
    [12, 39, 47, 4],
  ],
  "v4-smart": [
    [1, 45, 57, 12],
    [5, 38, 45, 6],
    [12, 36, 38, 0],
  ],
} as const;

describe("fallibleAim", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("expose les seuils de lock de #212", () => {
    expect(SHOTS_TO_HIT).toEqual({
      "v1-random": 7,
      "v2-heuristic": 5,
      "v3-sniper": 3,
      "v4-smart": 2,
    });
  });

  it.each(profiles)("retourne les trois ancrages de %s", (profile) => {
    for (const [round, min, max, residual] of anchors[profile]) {
      expect(getAimParameters(profile, round)).toEqual({
        firstBand: { min, max },
        residual,
      });
    }
  });

  it("interpole séparément les bornes et le résidu à M3 et M8", () => {
    expect(getAimParameters("v2-heuristic", 3)).toEqual({
      firstBand: { min: 59.5, max: 67 },
      residual: 27,
    });
    expect(getAimParameters("v3-sniper", 8)).toEqual({
      firstBand: {
        min: 43.57142857142857,
        max: 52.714285714285715,
      },
      residual: 7.428571428571429,
    });
  });

  it("plafonne M12+ et normalise les manches invalides vers M1", () => {
    expect(getAimParameters("v4-smart", 12)).toEqual(
      getAimParameters("v4-smart", 13),
    );
    expect(getAimParameters("v4-smart", 99)).toEqual(
      getAimParameters("v4-smart", 12),
    );
    for (const round of [undefined, Number.NaN, 0, -2]) {
      expect(getAimParameters("v2-heuristic", round)).toEqual(
        getAimParameters("v2-heuristic", 1),
      );
    }
  });

  it("utilise exactement la bande au premier tir et le résidu au seuil", () => {
    const randomSpy = vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(impactOffsetMagnitude(1, "v2-heuristic", 1)).toBe(62);
    expect(impactOffsetMagnitude(1, "v4-smart", 12)).toBe(
      FIRST_SHOT_FLOOR_PX,
    );

    randomSpy.mockClear();
    expect(impactOffsetMagnitude(5, "v2-heuristic", 1)).toBe(36);
    expect(randomSpy).not.toHaveBeenCalled();
    expect(impactOffsetMagnitude(8, "v2-heuristic", 12)).toBe(9);
    expect(randomSpy).not.toHaveBeenCalled();
  });

  it("interpole les tentatives pré-lock et la fraction EXPERT", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(impactOffsetMagnitude(1.5, "v4-smart", 1)).toBe(28.5);
    expect(impactOffsetMagnitude(2, "v3-sniper", 1)).toBe(37.5);
    expect(impactOffsetMagnitude(3, "v2-heuristic", 1)).toBe(49);
    expect(impactOffsetMagnitude(4, "v1-random", 1)).toBe(61);
  });

  it("conserve la hiérarchie d'offset à quantile identique", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    for (const round of [1, 3, 5, 8, 12, 13]) {
      const firstShots = [
        impactOffsetMagnitude(1, "v4-smart", round),
        impactOffsetMagnitude(1, "v3-sniper", round),
        impactOffsetMagnitude(1, "v2-heuristic", round),
        impactOffsetMagnitude(1, "v1-random", round),
      ];
      expect(firstShots[0]).toBeLessThan(firstShots[1]);
      expect(firstShots[1]).toBeLessThan(firstShots[2]);
      expect(firstShots[2]).toBeLessThan(firstShots[3]);

      const locks = [
        impactOffsetMagnitude(SHOTS_TO_HIT["v4-smart"], "v4-smart", round),
        impactOffsetMagnitude(SHOTS_TO_HIT["v3-sniper"], "v3-sniper", round),
        impactOffsetMagnitude(
          SHOTS_TO_HIT["v2-heuristic"],
          "v2-heuristic",
          round,
        ),
        impactOffsetMagnitude(SHOTS_TO_HIT["v1-random"], "v1-random", round),
      ];
      expect(locks[0]).toBeLessThan(locks[1]);
      expect(locks[1]).toBeLessThan(locks[2]);
      expect(locks[2]).toBeLessThan(locks[3]);
    }
  });

  it("ne tire pas le côté quand un signe explicite est fourni", () => {
    const randomSpy = vi.spyOn(random, "secureRandom").mockReturnValue(0);
    expect(signedImpactOffset(1, "v3-sniper", 1, -1)).toBe(-57);
    expect(randomSpy).toHaveBeenCalledTimes(1);

    randomSpy.mockClear();
    randomSpy.mockReturnValueOnce(0).mockReturnValueOnce(0.5);
    expect(signedImpactOffset(1, "v3-sniper", 1)).toBe(57);
    expect(randomSpy).toHaveBeenCalledTimes(2);
  });

  it("garde le jet de grosse gaffe strictement sous son seuil", () => {
    const randomSpy = vi.spyOn(random, "secureRandom");
    randomSpy.mockReturnValueOnce(0.09);
    expect(maybeGaffe(0.1)).toBe(true);
    randomSpy.mockReturnValueOnce(0.1);
    expect(maybeGaffe(0.1)).toBe(false);
  });
});
