import { afterEach, describe, expect, it, vi } from "vitest";
import * as ballistics from "../BallisticsSimulator";
import { computeHeuristicShot } from "../heuristicShot";
import { flatTerrain, makePlayer, makeTank } from "../../../__tests__/helpers";

describe("computeHeuristicShot", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([100, 700])("oriente le vrai solveur vers x=%s sur terrain plat", (targetX) => {
    const self = makePlayer({ tank: makeTank("self", 400, 336) });
    const shot = computeHeuristicShot(self, targetX, 330, 0, 260, flatTerrain(800, 480));
    if (targetX < 400) expect(shot.angle).toBeGreaterThan(90);
    else expect(shot.angle).toBeLessThan(90);
    expect(shot.angle).toBeGreaterThanOrEqual(8);
    expect(shot.angle).toBeLessThanOrEqual(172);
    expect(shot.power).toBeGreaterThanOrEqual(30);
    expect(shot.power).toBeLessThanOrEqual(90);
  });

  it.each([
    { angle: -5, power: -1, expected: { angle: 8, power: 30 } },
    { angle: 190, power: 110, expected: { angle: 172, power: 90 } },
    { angle: 8, power: 30, expected: { angle: 8, power: 30 } },
    { angle: 172, power: 90, expected: { angle: 172, power: 90 } },
    { angle: 45.125, power: 55.375, expected: { angle: 45.125, power: 55.375 } },
  ])("borne sans arrondir angle=$angle power=$power", ({ angle, power, expected }) => {
    vi.spyOn(ballistics, "searchBallisticSolution").mockReturnValue({ angle, power, err: 0 });
    const self = makePlayer({ tank: makeTank("self", 400, 336) });
    expect(computeHeuristicShot(self, 700, 330, 0, 260, flatTerrain(800, 480)))
      .toEqual(expected);
  });
});
