import { describe, expect, it, vi } from "vitest";
import { hasSafeRockBase, type SpawnTerrain } from "../spawnPlacement";
import { TERRAIN_MATERIAL } from "../../../types/terrain";
import { TANK_HITBOX_WIDTH } from "../../combatConstants";
import { spawnTerrain } from "../prepareRound";
import { makeRoundMap } from "../../__tests__/helpers";
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
