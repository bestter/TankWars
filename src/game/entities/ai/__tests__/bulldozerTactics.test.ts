import { describe, it, expect } from "vitest";
import { shouldPickBulldozer } from "../bulldozerTactics";
import { makePlayer, makeTank } from "../../../__tests__/helpers";
import { TERRAIN_MATERIAL } from "../../../../types/terrain";
import type { TerrainManager } from "../../../engine/Terrain";

function mockTerrain(
  heightMap: (x: number) => number,
  width = 800,
): TerrainManager {
  return {
    width,
    height: 480,
    getHeightAt: (x: number) => heightMap(x),
    getMaterialAt: () => TERRAIN_MATERIAL.DIRT,
  } as unknown as TerrainManager;
}

function shooterAt(x: number, inventory: { BULLDOZER?: number } = { BULLDOZER: 1 }) {
  return makePlayer({
    id: "ai",
    isHuman: false,
    tank: makeTank("s", x, 300),
    inventory,
  });
}

function targetAt(x: number) {
  return makePlayer({
    id: "enemy",
    tank: makeTank("t", x, 300),
  });
}

describe("shouldPickBulldozer", () => {
  it("returns false without BULLDOZER stock", () => {
    const terrain = mockTerrain(() => 300);
    expect(shouldPickBulldozer(shooterAt(100, {}), targetAt(700), terrain)).toBe(
      false,
    );
  });

  it("returns false when the target is closer than 80 px", () => {
    const terrain = mockTerrain(() => 300);
    expect(shouldPickBulldozer(shooterAt(200), targetAt(250), terrain)).toBe(
      false,
    );
  });

  it("returns false on flat interior ground", () => {
    const terrain = mockTerrain(() => 300);
    expect(shouldPickBulldozer(shooterAt(100), targetAt(400), terrain)).toBe(
      false,
    );
  });

  it("returns true when the probe goes off the map edge", () => {
    const terrain = mockTerrain(() => 300, 800);
    expect(shouldPickBulldozer(shooterAt(100), targetAt(780), terrain)).toBe(
      true,
    );
  });

  it("returns true when the probe sits over a crater", () => {
    const terrain = mockTerrain((x) => (x > 450 ? 380 : 300));
    expect(shouldPickBulldozer(shooterAt(100), targetAt(400), terrain)).toBe(
      true,
    );
  });
});
