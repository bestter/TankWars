import { describe, expect, it, vi } from "vitest";
import { makePlayer, makeTank } from "../../../__tests__/helpers";
import { compareHeavyCandidates, evaluateExpertTactics, type HeavyCandidate } from "../expertTactics";
import type { AimMemory } from "../aimMemory";
import * as random from "../../../../utils/random";

const enemy = (id: string, x: number, y = 300, health = 100, shield = 0) =>
  makePlayer({ id, isHuman: false, tank: makeTank(id, x, y, { health, shield }) });
const shooter = () => makePlayer({ id: "self", tank: makeTank("self", 0, 300),
  inventory: { NUKE: 1, THERMONUCLEAR: 1 } });
const memory: AimMemory = { currentTargetId: "a", currentTargetAttempts: 1 };

describe("expert group geometry", () => {
  it("enumerates only three pairs and one triplet per weapon without mutation or RNG", () => {
    const self = shooter();
    const players = [self, enemy("a", 300), enemy("b", 320), enemy("c", 340)];
    const before = structuredClone({ players, memory });
    const rng = vi.spyOn(random, "secureRandom");
    const result = evaluateExpertTactics(self, players, memory);
    expect(result.candidates).toHaveLength(8);
    expect(result.nuke?.memberIndices).toEqual([1, 2, 3]);
    expect({ players, memory }).toEqual(before);
    expect(rng).not.toHaveBeenCalled();
    rng.mockRestore();
    players[3].tank.isDead = true;
    expect(evaluateExpertTactics(self, players, memory).candidates).toHaveLength(2);
  });

  it.each([79.999, 80, 80.001])("requires horizontal distance < 80 (%s)", (distance) => {
    const self = shooter();
    const result = evaluateExpertTactics(self, [self, enemy("a", 300), enemy("b", 300 + distance)], memory);
    expect(Boolean(result.nuke)).toBe(distance < 80);
  });

  it.each([61.999, 62, 62.001, 159.999, 160, 160.001])("uses strict 2D radii at %s", (distance) => {
    const self = shooter();
    const result = evaluateExpertTactics(self,
      [self, enemy("a", 400, 300 - distance), enemy("b", 400, 300 + distance)], memory);
    expect(Boolean(result.nuke)).toBe(distance < 62);
    expect(Boolean(result.thermonuclear)).toBe(distance < 160);
  });

  it("requires at least one close pair even for a covered triplet", () => {
    const self = shooter();
    const players = [self, enemy("a", 300), enemy("b", 380), enemy("c", 460)];
    expect(evaluateExpertTactics(self, players, memory).candidates).toHaveLength(0);
    players[2].tank.position.x = 379;
    expect(evaluateExpertTactics(self, players, memory).candidates.some((c) => c.memberIndices.length === 3)).toBe(true);
  });

  it("does not let a covered outsider alter the pair or its primary", () => {
    const self = shooter();
    const result = evaluateExpertTactics(self, [self, enemy("a", 300, 280, 30, 10),
      enemy("b", 340, 320, 60), enemy("c", 325, 300, 1)], memory);
    const pair = result.candidates.find((c) => c.weaponId === "NUKE" && c.memberIndices.join() === "1,2");
    expect(pair).toMatchObject({ primaryTargetId: "a", healthTotal: 100,
      point: { x: 320, y: 300 }, memberIndices: [1, 2] });
    expect(result.nuke?.memberIndices).toEqual([1, 2]);
    expect(result.preparation?.memberIndices).toEqual([1, 2, 3]);
  });

  it("filters attempts before ranking, separately for each weapon", () => {
    const self = shooter();
    const players = [self, enemy("a", 300, 300, 20), enemy("b", 330, 300, 30), enemy("c", 350, 500, 10)];
    const result = evaluateExpertTactics(self, players, memory);
    expect(result.nuke?.memberIndices).toEqual([1, 2]);
    expect(result.thermonuclear?.memberIndices).toEqual([1, 2]);
    expect(result.preparation?.memberIndices).toEqual([1, 2, 3]);
    players[3].tank.health = 40;
    expect(evaluateExpertTactics(self, players, memory).thermonuclear?.memberIndices).toEqual([1, 2, 3]);
  });

  it("filters a stronger unsafe pair before ranking a safe pair using 2D self distance", () => {
    const self = shooter();
    const result = evaluateExpertTactics(self, [self, enemy("a", 80, 300, 10),
      enemy("b", 90, 300, 100), enemy("c", 80, 420, 20)], memory);
    expect(result.nuke?.memberIndices).toEqual([1, 3]);
    expect(result.nuke?.selfDistance).toBe(100);
  });

  it.each(["NUKE", "THERMONUCLEAR"] as const)("enforces strict self safety for %s", (weaponId) => {
    const radius = weaponId === "NUKE" ? 62 : 160;
    for (const delta of [-0.001, 0, 0.001]) {
      const self = shooter();
      self.inventory = { [weaponId]: 1 };
      const x = radius + 24 + delta;
      const result = evaluateExpertTactics(self, [self, enemy("a", x, 299), enemy("b", x, 301)], memory);
      expect(result.candidates.length).toBe(delta > 0 ? 1 : 0);
    }
  });

  it("rejects the THERMO kill zone and absent stock, including preparation", () => {
    const self = shooter();
    self.inventory = { THERMONUCLEAR: 1 };
    expect(evaluateExpertTactics(self, [self, enemy("a", 75), enemy("b", 75)], memory).preparation).toBeUndefined();
    self.inventory = {};
    expect(evaluateExpertTactics(self, [self, enemy("a", 400), enemy("b", 420)], memory).preparation).toBeUndefined();
  });

  it("chooses the primary by health plus shield and roster, without human preference", () => {
    const self = shooter();
    const a = enemy("a", 300, 300, 10, 30);
    a.isHuman = true;
    const b = enemy("b", 320, 300, 40);
    expect(evaluateExpertTactics(self, [self, a, b], memory).nuke?.primaryTargetId).toBe("a");
    b.tank.health = 39;
    expect(evaluateExpertTactics(self, [self, a, b], memory).preparation?.primaryTargetId).toBe("b");
  });

  it("keeps a living human target despite wounded AI, otherwise uses AI then health then roster", () => {
    const self = shooter();
    const human = enemy("human", 300, 300, 1);
    human.isHuman = true;
    const a = enemy("a", 400, 300, 20, 40);
    const b = enemy("b", 500, 300, 20);
    const players = [self, human, a, b];
    expect(evaluateExpertTactics(self, players, { currentTargetId: "human", currentTargetAttempts: 2 }).ordinaryTarget).toBe(human);
    expect(evaluateExpertTactics(self, players, { currentTargetAttempts: 0 }).ordinaryTarget).toBe(a);
    a.tank.isDead = true;
    expect(evaluateExpertTactics(self, players, memory).ordinaryTarget).toBe(b);
    b.tank.isDead = true;
    expect(evaluateExpertTactics(self, players, memory).ordinaryTarget).toBe(human);
  });
});

describe("expert candidate ranking", () => {
  const base: HeavyCandidate = { weaponId: "NUKE", primaryTargetId: "a", point: { x: 300, y: 300 },
    memberIndices: [1, 2], healthTotal: 100, selfDistance: 300, virtualAttempts: 2 };
  it.each([
    { memberIndices: [1, 2, 3], healthTotal: 1, selfDistance: 1 },
    { healthTotal: 101, selfDistance: 1 },
    { selfDistance: 301 },
    { memberIndices: [0, 2] },
    { memberIndices: [1, 1] },
  ])("applies each rank key in order: %o", (overrides) => {
    const better = { ...base, ...overrides };
    expect(compareHeavyCandidates(better, base)).toBeLessThan(0);
    expect(compareHeavyCandidates(base, better)).toBeGreaterThan(0);
  });
  it("ties identical subsets across weapons", () => {
    expect(compareHeavyCandidates(base, { ...base, weaponId: "THERMONUCLEAR" })).toBe(0);
  });
});
