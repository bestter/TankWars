import { describe, expect, it, vi } from "vitest";
import { hasSafeRockBase, resetPlayersForSpawn, type SpawnTerrain } from "../spawnPlacement";
import { TERRAIN_MATERIAL } from "../../../types/terrain";
import { TANK_HITBOX_WIDTH } from "../../combatConstants";
import { spawnTerrain } from "../prepareRound";
import { makePlayer, makeRoundMap, makeTank } from "../../__tests__/helpers";
import { setRNG, resetRNG } from "../../../utils/random";

describe("ROCK base geometry", () => {
  it("a 24 px base at 212.5 touches 25 columns, including both half columns", () => {
    const map = makeRoundMap();
    const terrain = spawnTerrain(800, map);
    const material = vi.spyOn(terrain, 'getMaterialAt');
    expect(hasSafeRockBase(212.5, terrain)).toBe(true); // [200.5, 224.5)
    expect(material.mock.calls.map(([column]) => column)).toEqual(
      Array.from({ length: 25 }, (_, i) => 200 + i),
    );
    for (const edge of [200, 224]) {
      map.materials.fill('DIRT');
      map.materials[edge] = 'ROCK';
      expect(hasSafeRockBase(212.5, terrain)).toBe(false);
      map.materials.fill('ROCK');
      map.materials[edge] = 'DIRT';
      expect(hasSafeRockBase(212.5, terrain)).toBe(false);
    }
    map.materials.fill('DIRT');
    map.materials[199] = 'ROCK';
    map.materials[224] = 'ROCK';
    expect(hasSafeRockBase(212, terrain)).toBe(true); // [200, 224): no overlap with either ROCK column
  });

  it("counts positive overlap only, including fractions, both edges and an interior island", () => {
    const map = makeRoundMap();
    map.materials.fill("ROCK", 200, 240);
    const terrain = spawnTerrain(800, map);
    expect(hasSafeRockBase(188, terrain)).toBe(true); // exactly touches ROCK
    expect(hasSafeRockBase(188.01, terrain)).toBe(false);
    expect(hasSafeRockBase(212, terrain)).toBe(true);
    expect(hasSafeRockBase(211.99, terrain)).toBe(false);
    expect(hasSafeRockBase(228, terrain)).toBe(true);
    expect(hasSafeRockBase(228.01, terrain)).toBe(false);
    expect(hasSafeRockBase(252, terrain)).toBe(true);
    expect(hasSafeRockBase(251.99, terrain)).toBe(false);
    map.materials.fill("DIRT");
    map.materials[215] = "ROCK";
    expect(hasSafeRockBase(212.5, terrain)).toBe(false);
    expect(hasSafeRockBase(12, terrain)).toBe(true);
    expect(hasSafeRockBase(788, terrain)).toBe(true);
    expect(hasSafeRockBase(11.99, terrain)).toBe(false);
    expect(hasSafeRockBase(788.01, terrain)).toBe(false);
  });

  it("accepts DIRT/SOFT transitions and never draws RNG or mutates terrain", () => {
    const map = makeRoundMap();
    map.materials.fill("SOFT", 200, 400);
    const before = structuredClone(map);
    setRNG({ next: () => { throw new Error("Unexpected RNG"); } });
    try { expect(hasSafeRockBase(200.5, spawnTerrain(800, map))).toBe(true); }
    finally { resetRNG(); }
    expect(map).toEqual(before);
  });
});

describe("hasSafeRockBase isolated checks", () => {
  const makeTerrain = (width: number, rockPositions: Set<number>): SpawnTerrain => ({
    width,
    getHeightAt: () => 0,
    getMaterialAt: (x: number) => rockPositions.has(x) ? TERRAIN_MATERIAL.ROCK : TERRAIN_MATERIAL.DIRT
  });

  it("returns true for a base entirely on DIRT", () => {
    const terrain = makeTerrain(100, new Set());
    expect(hasSafeRockBase(50, terrain)).toBe(true);
  });

  it("returns true for a base entirely on ROCK", () => {
    const rockPositions = new Set<number>();
    for (let i = 0; i < 100; i++) rockPositions.add(i);
    const terrain = makeTerrain(100, rockPositions);
    expect(hasSafeRockBase(50, terrain)).toBe(true);
  });

  it("returns false for a mixed base", () => {
    const rockPositions = new Set<number>();
    for (let i = 45; i < 55; i++) rockPositions.add(i);
    const terrain = makeTerrain(100, rockPositions);
    expect(hasSafeRockBase(50, terrain)).toBe(false);
  });

  it("returns false if x is out of bounds", () => {
    const terrain = makeTerrain(100, new Set());
    expect(hasSafeRockBase(-50, terrain)).toBe(false);
    expect(hasSafeRockBase(150, terrain)).toBe(false);
  });

  it("returns false if x is near the edge and hitbox goes out of bounds", () => {
    const terrain = makeTerrain(100, new Set());
    // Left edge
    expect(hasSafeRockBase(TANK_HITBOX_WIDTH / 2 - 1, terrain)).toBe(false);
    // Right edge
    expect(hasSafeRockBase(100 - TANK_HITBOX_WIDTH / 2 + 1, terrain)).toBe(false);
  });

  it("returns false if x is not finite", () => {
    const terrain = makeTerrain(100, new Set());
    expect(hasSafeRockBase(NaN, terrain)).toBe(false);
    expect(hasSafeRockBase(Infinity, terrain)).toBe(false);
  });
});

describe("resetPlayersForSpawn", () => {
  it("preserves identities, money, and inventory", () => {
    const p1 = makePlayer({ id: "p1", name: "Player 1", money: 500, inventory: { MISSILE: 10 } });
    const p2 = makePlayer({ id: "p2", name: "Player 2", money: 100, inventory: { GRENADE: 5 } });

    const terrain: SpawnTerrain = { width: 800, getHeightAt: () => 100, getMaterialAt: () => TERRAIN_MATERIAL.DIRT };

    const result = resetPlayersForSpawn([p1, p2], [100, 700], terrain);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("p1");
    expect(result[0].name).toBe("Player 1");
    expect(result[0].isHuman).toBe(p1.isHuman);
    expect(result[0].tank.id).toBe(p1.tank.id);
    expect(result[0].tank.color).toBe(p1.tank.color);
    expect(result[0].money).toBe(500);
    expect(result[0].inventory).toEqual({ MISSILE: 10 });
    expect(result[0].inventory).not.toBe(p1.inventory); // Check deep copy

    expect(result[1].id).toBe("p2");
    expect(result[1].name).toBe("Player 2");
    expect(result[1].money).toBe(100);
    expect(result[1].inventory).toEqual({ GRENADE: 5 });
    expect(result[1].inventory).not.toBe(p2.inventory); // Check deep copy
  });

  it("updates position and orientation correctly based on terrain width", () => {
    const p1 = makePlayer();
    const p2 = makePlayer();

    const terrain: SpawnTerrain = {
      width: 800,
      getHeightAt: (x: number) => x === 100 ? 150 : 250,
      getMaterialAt: () => TERRAIN_MATERIAL.DIRT
    };

    const result = resetPlayersForSpawn([p1, p2], [100, 700], terrain);

    expect(result[0].tank.position).toEqual({ x: 100, y: 150 });
    // Left of the midpoint (x < 400), the cannon points inward to the right at 45 degrees.
    expect(result[0].tank.angle).toBe(45);

    expect(result[1].tank.position).toEqual({ x: 700, y: 250 });
    // Right of the midpoint (x >= 400), the cannon points inward to the left at 135 degrees.
    expect(result[1].tank.angle).toBe(135);
  });

  it("restores health, shield, and isDead status", () => {
    const p1 = makePlayer({
      tank: makeTank("t1", 0, 0, { health: 10, maxHealth: 100, isDead: true, shield: 0, maxShield: 50 })
    });

    const terrain: SpawnTerrain = { width: 800, getHeightAt: () => 100, getMaterialAt: () => TERRAIN_MATERIAL.DIRT };
    const result = resetPlayersForSpawn([p1], [100], terrain);

    expect(result[0].tank.isDead).toBe(false);
    expect(result[0].tank.health).toBe(100);
    expect(result[0].tank.shield).toBe(50);
  });

  it("calculates default maxShield if not provided", () => {
    const p1 = makePlayer({
      tank: makeTank("t1", 0, 0, { health: 50, maxHealth: 200, maxShield: undefined })
    });

    const terrain: SpawnTerrain = { width: 800, getHeightAt: () => 100, getMaterialAt: () => TERRAIN_MATERIAL.DIRT };
    const result = resetPlayersForSpawn([p1], [100], terrain);

    // An undefined maxShield uses floor(maxHealth * 0.4): floor(200 * 0.4) = 80.
    // The current shield is then fully restored to that computed maximum.
    expect(result[0].tank.maxShield).toBe(80);
    expect(result[0].tank.shield).toBe(80);
  });

  it("preserves an explicit zero maxShield and resets shield to zero", () => {
    const p1 = makePlayer({
      tank: makeTank("t1", 0, 0, { maxHealth: 200, shield: 25, maxShield: 0 })
    });

    const terrain: SpawnTerrain = { width: 800, getHeightAt: () => 100, getMaterialAt: () => TERRAIN_MATERIAL.DIRT };
    const result = resetPlayersForSpawn([p1], [100], terrain);

    // Zero is an explicit maximum: ?? must preserve it instead of using the 80-point default.
    expect(result[0].tank.maxShield).toBe(0);
    expect(result[0].tank.shield).toBe(0);
  });

  it("clears temporary combat state", () => {
    const p1 = makePlayer({
      tank: makeTank("t1", 0, 0, {
        lastHitBy: "p2",
        lastDirectAttackerId: "p2",
        hitReaction: { wasDirectHit: true, fallDistance: 50 },
        power: 100,
        currentWeapon: "NUKE"
      })
    });

    const terrain: SpawnTerrain = { width: 800, getHeightAt: () => 100, getMaterialAt: () => TERRAIN_MATERIAL.DIRT };
    const result = resetPlayersForSpawn([p1], [100], terrain);

    expect(result[0].tank.lastHitBy).toBeUndefined();
    expect(result[0].tank.lastDirectAttackerId).toBeUndefined();
    expect(result[0].tank.hitReaction).toBeUndefined();
    expect(result[0].tank.power).toBe(50);
    expect(result[0].tank.currentWeapon).toBe("MISSILE");
  });
});
