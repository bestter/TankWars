import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applySignedCorruption,
  finalizeAdvancedAim,
  finalizeSimpleAim,
  interpolateAimCommands,
  sampleSimpleGaffe,
} from "../aimCorruption";
import * as random from "../../../../utils/random";

describe("aimCorruption", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tire les signes direction et puissance indépendamment", () => {
    vi.spyOn(random, "secureRandom")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.99);
    expect(applySignedCorruption({ angle: 40, power: 50 }, 10, 5)).toEqual({
      angle: 30,
      power: 55,
    });
  });

  it("reproduit l'exemple EXPERT 30 % avant une éventuelle grosse gaffe", () => {
    vi.spyOn(random, "secureRandom")
      .mockReturnValueOnce(0.99)
      .mockReturnValueOnce(0);
    expect(applySignedCorruption({ angle: 40, power: 50 }, 3, 1.5)).toEqual({
      angle: 43,
      power: 48.5,
    });
  });

  it("borne et arrondit une seule fois selon le profil", () => {
    expect(finalizeAdvancedAim({ angle: 181.6, power: 99.8 })).toEqual({
      angle: 180,
      power: 99,
    });
    expect(finalizeAdvancedAim({ angle: -1, power: 0.2 })).toEqual({
      angle: 0,
      power: 1,
    });
    expect(finalizeSimpleAim({ angle: 180, power: 99.8 })).toEqual({
      angle: 179.9,
      power: 99,
    });
  });

  it("échantillonne la grosse gaffe SIMPLE dans ses deux bandes", () => {
    const randomSpy = vi.spyOn(random, "secureRandom");
    randomSpy
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0);
    expect(sampleSimpleGaffe()).toEqual({ angle: 90, power: 1 });

    randomSpy
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.99)
      .mockReturnValueOnce(0.99);
    expect(sampleSimpleGaffe()).toEqual({ angle: 90, power: 99 });
  });

  it("interpole le commandement SIMPLE vers une référence de gaffe", () => {
    expect(
      interpolateAimCommands(
        { angle: 40, power: 50 },
        { angle: 100, power: 90 },
        0.25,
      ),
    ).toEqual({ angle: 55, power: 60 });
  });
});
