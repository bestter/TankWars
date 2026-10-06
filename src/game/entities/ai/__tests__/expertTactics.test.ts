import { playerProfileScore } from "../profileScore";
import { describe, expect, it } from "vitest";
import { flatTerrain, makePlayer, makeTank } from "../../../__tests__/helpers";
import { expertTacticalPoints } from "../expertShotEvaluator";
import { ordinaryExpertTarget, possibleExpertThreatWeapons } from "../expertPlanner";

const terrain = flatTerrain(800, 480);
const self = makePlayer({ id: "self", isHuman: false, aiProfile: "v4-smart",
  tank: makeTank("self", 100, 336) });
const a = makePlayer({ id: "a", tank: makeTank("a", 300, 336) });
const b = makePlayer({ id: "b", tank: makeTank("b", 340, 316) });

describe("EXPERT tactical points", () => {
  it("uses tank-box centres and one shooter-side 19 px DRILLER point", () => {
    expect(expertTacticalPoints(self, [a], "DRILLER", terrain, [self, a])).toEqual([
      { x: 300, y: 328.5, kind: "tank" },
      { x: 293, y: 336, kind: "terrain" },
      { x: 307, y: 336, kind: "terrain" },
      { x: 281, y: 336, kind: "terrain" },
    ]);
    expect(expertTacticalPoints(self, [a, b], "DRILLER", terrain, [self, a, b])).toEqual([
      { x: 320, y: 318.5, kind: "pair" },
      { x: 281, y: 336, kind: "terrain" },
    ]);
  });

  it("breaks nearest-member ties by roster and chooses left on equal X", () => {
    const left = makePlayer({ id: "left", tank: makeTank("left", 80, 336) });
    const right = makePlayer({ id: "right", tank: makeTank("right", 120, 336) });
    const points = expertTacticalPoints(self, [right, left], "DRILLER", terrain,
      [self, left, right]);
    expect(points[1]).toEqual({ x: 99, y: 336, kind: "terrain" });
    const same = makePlayer({ id: "same", tank: makeTank("same", 100, 336) });
    expect(expertTacticalPoints(self, [same], "DRILLER", terrain, [self, same])[3])
      .toEqual({ x: 81, y: 336, kind: "terrain" });
  });

  it("drops out-of-map ground points without clamping", () => {
    const edge = makePlayer({ id: "edge", tank: makeTank("edge", 5, 336) });
    expect(expertTacticalPoints(self, [edge], "NUKE", terrain, [self, edge]))
      .toEqual([{ x: 5, y: 328.5, kind: "tank" },
        { x: 36, y: 336, kind: "terrain" }]);
  });
});

describe("EXPERT threat profile contracts", () => {
  it.each([
    ["v1-random", 0.1], ["v2-heuristic", 0.5], ["v3-sniper", 0.8], ["v4-smart", 1], [undefined, 0.5],
  ] as const)("preserves shared profile score for %s and human tactical score", (aiProfile, score) => {
    expect(playerProfileScore(makePlayer({ isHuman: false, aiProfile }))).toBe(score);
    expect(playerProfileScore(makePlayer({ isHuman: true, aiProfile }))).toBe(0.9);
  });

  it("limits SIMPLE to its equipped weapon and uses OK score for an unknown profile", () => {
    const simple = makePlayer({ ...a, isHuman: false, aiProfile: "v1-random",
      inventory: { NUKE: 1, BULLET: 1 },
      tank: makeTank("a", 300, 336, { currentWeapon: "BULLET" }) });
    expect(possibleExpertThreatWeapons(simple)).toEqual(["BULLET"]);
    const unknown = { ...simple, aiProfile: "unknown" as typeof simple.aiProfile };
    expect(possibleExpertThreatWeapons(unknown)).toEqual(["BULLET"]);
    expect(playerProfileScore(unknown)).toBe(0.5);
    simple.tank.currentWeapon = "BULLDOZER";
    expect(possibleExpertThreatWeapons(simple)).toEqual([]);
  });

  it("uses each local profile's selectable weapons and stock", () => {
    const inventory = { BULLET: 1, DRILLER: 1, GRENADE: 1,
      CLUSTER: 1, NUKE: 1, THERMONUCLEAR: 1, BULLDOZER: 1 };
    const player = makePlayer({ ...a, isHuman: false, inventory });
    player.aiProfile = "v3-sniper";
    expect(possibleExpertThreatWeapons(player)).toEqual(["MISSILE", "BULLET", "DRILLER"]);
    player.aiProfile = "v2-heuristic";
    expect(possibleExpertThreatWeapons(player)).toEqual(["MISSILE", "GRENADE", "CLUSTER", "NUKE", "DRILLER"]);
    player.aiProfile = "v4-smart";
    expect(possibleExpertThreatWeapons(player)).not.toContain("BULLDOZER");
    expect(possibleExpertThreatWeapons(player)).toContain("THERMONUCLEAR");
  });

  it("preserves the ordinary fallback target and AI/health/roster priority", () => {
    const human = makePlayer({ ...a, isHuman: true, tank: makeTank("a", 300, 336, { health: 1 }) });
    const ai = makePlayer({ ...b, isHuman: false, tank: makeTank("b", 340, 336, { health: 70 }) });
    expect(ordinaryExpertTarget(self, [self, human, ai],
      { currentTargetId: human.id, currentTargetAttempts: 2 })).toBe(human);
    expect(ordinaryExpertTarget(self, [self, human, ai],
      { currentTargetAttempts: 0 })).toBe(ai);
  });
});
