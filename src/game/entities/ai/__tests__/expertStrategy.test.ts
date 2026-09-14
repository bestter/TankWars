import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AISmartStrategy } from "../AISmartStrategy";
import * as ballistics from "../BallisticsSimulator";
import * as fallibleAim from "../fallibleAim";
import * as random from "../../../../utils/random";
import { flatTerrain, makeGameState, makePlayer, makeTank, terrainWithMidObstacle } from "../../../__tests__/helpers";
import type { AimMemory } from "../aimMemory";
import type { Player } from "../../../../types/player";
import { TANK_HITBOX_WIDTH } from "../../../combatConstants";

function fixture(inventory: Player["inventory"] = { NUKE: 1, THERMONUCLEAR: 1 }) {
  const self = makePlayer({ id: "self", isHuman: false, aiProfile: "v4-smart", inventory,
    tank: makeTank("self", 50, 336, { currentWeapon: "THERMONUCLEAR" }) });
  const a = makePlayer({ id: "a", isHuman: false, tank: makeTank("a", 400, 336, { health: 10 }) });
  const b = makePlayer({ id: "b", isHuman: true, tank: makeTank("b", 440, 356, { health: 20 }) });
  const state = makeGameState(self, a, "v4-smart");
  state.players = [self, a, b];
  state.roundNumber = 1;
  const terrain = flatTerrain(1000, 480);
  const strategy = new AISmartStrategy();
  const memories = (strategy as unknown as { memories: Map<string, AimMemory> }).memories;
  const memory = { currentTargetId: "a", currentTargetAttempts: 1, lastRoundNumber: 1 };
  memories.set(self.id, memory);
  return { self, a, b, state, terrain, strategy, memory,
    run: () => strategy.executeTurn("self", state, terrain) };
}

beforeEach(() => {
  vi.spyOn(ballistics, "searchBallisticSolution").mockReturnValue({ angle: 45, power: 50, err: 0 });
  vi.spyOn(fallibleAim, "signedImpactOffset").mockReturnValue(7);
  vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
});
afterEach(() => vi.restoreAllMocks());

describe("EXPERT heavy orchestration", () => {
  it.each([
    [0, "THERMONUCLEAR"], [0.219999, "THERMONUCLEAR"], [0.22, "NUKE"],
    [0.499999, "NUKE"], [0.50, "MISSILE"], [0.99, "MISSILE"],
  ] as const)("uses one tactical roll at %s, returning %s", async (roll, weapon) => {
    const f = fixture();
    vi.mocked(random.secureRandom).mockReturnValueOnce(roll);
    expect((await f.run()).weaponId).toBe(weapon);
    expect(random.secureRandom).toHaveBeenCalledTimes(2); // tactique + gaffe, offset doublé par le test
    const heavy = weapon !== "MISSILE";
    expect(ballistics.searchBallisticSolution).toHaveBeenCalledWith(expect.objectContaining({
      tx: heavy ? 427 : 407, ty: heavy ? 346 : 330, weaponId: weapon,
    }));
    expect(f.memory.currentTargetAttempts).toBe(2);
    expect(f.self.tank.currentWeapon).toBe(weapon);
    expect(fallibleAim.signedImpactOffset).toHaveBeenCalledExactlyOnceWith(2, "v4-smart", 1);
  });

  it.each([
    [{ NUKE: 1 }, 0.1], [{ THERMONUCLEAR: 1 }, 0.22],
  ])("does not switch weapons or prepare after an empty interval", async (inventory, roll) => {
    const f = fixture(inventory as Player["inventory"]);
    vi.mocked(random.secureRandom).mockReturnValueOnce(roll as number);
    expect((await f.run()).weaponId).toBe("MISSILE");
    expect(ballistics.searchBallisticSolution).toHaveBeenCalledWith(expect.objectContaining({ tx: 407, ty: 330 }));
    expect(f.memory.currentTargetId).toBe("a");
    expect(random.secureRandom).toHaveBeenCalledTimes(2);
  });

  it("prepares a new primary on turn one and permits a heavy on turn two", async () => {
    const f = fixture();
    f.memory.currentTargetId = "b";
    expect((await f.run()).weaponId).toBe("MISSILE");
    expect(f.memory).toMatchObject({ currentTargetId: "a", currentTargetAttempts: 1 });
    expect(random.secureRandom).toHaveBeenCalledTimes(1);
    expect(ballistics.searchBallisticSolution).toHaveBeenLastCalledWith(expect.objectContaining({ tx: 407, ty: 330 }));
    vi.mocked(random.secureRandom).mockReturnValueOnce(0.1);
    expect((await f.run()).weaponId).toBe("THERMONUCLEAR");
    expect(f.memory.currentTargetAttempts).toBe(2);
    f.a.tank.position.x += 10;
    f.b.tank.position.x += 10;
    vi.mocked(random.secureRandom).mockReturnValueOnce(0.1);
    await f.run();
    expect(f.memory.currentTargetAttempts).toBe(3);
    expect(ballistics.searchBallisticSolution).toHaveBeenLastCalledWith(expect.objectContaining({ tx: 437, ty: 346 }));
  });

  it("resets the round before virtual attempts and never rolls on the first attempt", async () => {
    const f = fixture();
    f.state.roundNumber = 2;
    f.memory.currentTargetAttempts = 20;
    expect((await f.run()).weaponId).toBe("MISSILE");
    expect(f.memory).toEqual({ currentTargetId: "a", currentTargetAttempts: 1, lastRoundNumber: 2 });
    expect(random.secureRandom).toHaveBeenCalledTimes(1);
  });

  it("uses no tactical RNG with one target or no stock, ignoring an equipped heavy", async () => {
    for (const single of [true, false]) {
      const f = fixture(single ? { NUKE: 1, THERMONUCLEAR: 1 } : {});
      if (single) f.state.players.pop();
      vi.mocked(random.secureRandom).mockClear();
      expect((await f.run()).weaponId).toBe("MISSILE");
      expect(random.secureRandom).toHaveBeenCalledTimes(1);
    }
  });

  it("returns to the ordinary target instead of preparing a better unready group after a roll", async () => {
    const f = fixture();
    const c = makePlayer({ id: "c", tank: makeTank("c", 420, 340, { health: 1 }) });
    f.state.players.push(c);
    vi.mocked(random.secureRandom).mockReturnValueOnce(0.5);
    expect((await f.run()).weaponId).toBe("MISSILE");
    expect(f.memory).toMatchObject({ currentTargetId: "a", currentTargetAttempts: 2 });
    expect(ballistics.searchBallisticSolution).toHaveBeenLastCalledWith(expect.objectContaining({ tx: 407, ty: 330 }));
  });

  it("selects an eligible pair before preparing a better unready triplet", async () => {
    const f = fixture();
    f.state.players.push(makePlayer({ id: "c", tank: makeTank("c", 420, 340, { health: 1 }) }));
    vi.mocked(random.secureRandom).mockReturnValueOnce(0.1);
    expect((await f.run()).weaponId).toBe("THERMONUCLEAR");
    expect(f.memory.currentTargetId).toBe("a");
    expect(ballistics.searchBallisticSolution).toHaveBeenLastCalledWith(expect.objectContaining({ tx: 427, ty: 346 }));
  });

  it("retains a human target without finish-off and resets A to B to A", async () => {
    const f = fixture({});
    f.memory.currentTargetId = "b";
    await f.run();
    expect(f.memory).toMatchObject({ currentTargetId: "b", currentTargetAttempts: 2 });
    f.b.tank.isDead = true;
    await f.run();
    expect(f.memory).toMatchObject({ currentTargetId: "a", currentTargetAttempts: 1 });
    f.a.tank.isDead = true;
    f.b.tank.isDead = false;
    await f.run();
    expect(f.memory).toMatchObject({ currentTargetId: "b", currentTargetAttempts: 1 });
  });

  it("keeps geometry independent of ROCK occlusion and off-surface centroids", async () => {
    const f = fixture();
    const occlusion = vi.spyOn(f.terrain, "isBlastOccludedByRock").mockReturnValue(true);
    vi.spyOn(f.terrain, "getMaterialAt").mockReturnValue("ROCK");
    f.a.tank.position.y = 200;
    f.b.tank.position.y = 240;
    vi.mocked(random.secureRandom).mockReturnValueOnce(0.1);
    expect((await f.run()).weaponId).toBe("THERMONUCLEAR");
    expect(ballistics.searchBallisticSolution).toHaveBeenLastCalledWith(expect.objectContaining({ ty: 220 }));
    expect(occlusion).not.toHaveBeenCalled();
  });

  it("penalizes the shared safety boundary inclusively", async () => {
    const f = fixture();
    vi.mocked(random.secureRandom).mockReturnValueOnce(0.22);
    await f.run();
    const penalty = vi.mocked(ballistics.searchBallisticSolution).mock.calls[0][0].selfHarmPenalty!;
    const limit = 62 + TANK_HITBOX_WIDTH;
    expect(penalty(50 + limit - 0.001, 336)).toBe(50000);
    expect(penalty(50 + limit, 336)).toBe(50000);
    expect(penalty(50 + limit + 0.001, 336)).toBe(0);
  });

  it("keeps the real aim RNG contract with exactly one additional heavy roll", async () => {
    vi.mocked(fallibleAim.signedImpactOffset).mockRestore();
    const f = fixture();
    f.memory.currentTargetAttempts = 0;
    await f.run();
    expect(random.secureRandom).toHaveBeenCalledTimes(3); // magnitude, signe, gaffe
    vi.mocked(random.secureRandom).mockClear().mockReturnValueOnce(0.1);
    await f.run();
    expect(random.secureRandom).toHaveBeenCalledTimes(3); // lourde, signe, gaffe (lock)
    f.self.inventory = {};
    vi.mocked(random.secureRandom).mockClear();
    await f.run();
    expect(random.secureRandom).toHaveBeenCalledTimes(2); // signe, gaffe (lock)
  });

  it("preserves terrain, inventory, positions and health while consuming reaction", async () => {
    const f = fixture();
    const snapshot = structuredClone(f.state.players);
    const heights = Array.from({ length: f.terrain.width }, (_, x) => f.terrain.getHeightAt(x));
    const materials = [...f.terrain.getMaterials()];
    f.self.tank.hitReaction = { wasDirectHit: true, fallDistance: 120 };
    vi.mocked(random.secureRandom)
      .mockReturnValueOnce(0.1) // lourde
      .mockReturnValueOnce(0.99).mockReturnValueOnce(0.99) // réaction positive
      .mockReturnValueOnce(0) // gaffe 2 %
      .mockReturnValueOnce(0).mockReturnValueOnce(0); // gaffe négative
    expect(await f.run()).toEqual({ weaponId: "THERMONUCLEAR", angle: 38, power: 47 });
    expect(random.secureRandom).toHaveBeenCalledTimes(6);
    expect(f.memory.currentTargetAttempts).toBe(2);
    expect(f.self.tank.hitReaction).toEqual({ wasDirectHit: false, fallDistance: 0 });
    expect(Array.from({ length: f.terrain.width }, (_, x) => f.terrain.getHeightAt(x))).toEqual(heights);
    expect(f.terrain.getMaterials()).toEqual(materials);
    for (const [index, player] of f.state.players.entries()) {
      expect(player.inventory).toEqual(snapshot[index].inventory);
      expect(player.tank.position).toEqual(snapshot[index].tank.position);
      expect(player.tank.health).toBe(snapshot[index].tank.health);
      expect(player.tank.shield).toBe(snapshot[index].tank.shield);
    }
  });
});

describe("EXPERT ordinary tactics", () => {
  it("adjusts a preparatory weapon under its new primary and uses its individual point", async () => {
    const f = fixture({ THERMONUCLEAR: 1, DRILLER: 1 });
    f.b.tank.health = 5;
    const material = vi.spyOn(f.terrain, "getMaterialAt").mockImplementation((x) => x === 440 ? "SOFT" : "ROCK");
    expect((await f.run()).weaponId).toBe("DRILLER");
    expect(material).toHaveBeenCalledWith(440);
    expect(f.memory).toMatchObject({ currentTargetId: "b", currentTargetAttempts: 1 });
    expect(ballistics.searchBallisticSolution).toHaveBeenLastCalledWith(expect.objectContaining({ tx: 447, ty: 350 }));
    expect(random.secureRandom).toHaveBeenCalledTimes(1);
  });

  it("keeps CLUSTER horizontal and aims at the individual even on strong elevation", async () => {
    const f = fixture({ CLUSTER: 1 });
    f.b.tank.position.y = 1000;
    expect((await f.run()).weaponId).toBe("CLUSTER");
    expect(ballistics.searchBallisticSolution).toHaveBeenLastCalledWith(expect.objectContaining({ tx: 407, ty: 330 }));
  });

  it.each(["GRENADE", "DRILLER"] as const)("keeps %s for hidden targets", async (weapon) => {
    const f = fixture({ [weapon]: 1 });
    const terrain = terrainWithMidObstacle(1000, 480, 180, 300, 100);
    expect((await f.strategy.executeTurn("self", f.state, terrain)).weaponId).toBe(weapon);
  });

  it.each(["ROCK", "SOFT"] as const)("adjusts ordinary weapons for %s under the final target", async (material) => {
    const f = fixture({ DRILLER: 1 });
    const terrain = terrainWithMidObstacle(1000, 480, 180, 300, material === "ROCK" ? 100 : 336);
    const getMaterial = vi.spyOn(terrain, "getMaterialAt").mockReturnValue(material);
    expect((await f.strategy.executeTurn("self", f.state, terrain)).weaponId).toBe(material === "ROCK" ? "MISSILE" : "DRILLER");
    expect(getMaterial).toHaveBeenCalledWith(400);
  });
});
