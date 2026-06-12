import { describe, it, expect } from "vitest";
import { TerrainManager } from "../../../engine/Terrain";
import {
  searchBallisticSolution,
  simulateShot,
  simulateSmartShot,
  BALLISTICS_MAX_STEPS,
} from "../BallisticsSimulator";
import { flatTerrain, terrainWithMidObstacle } from "../../../__tests__/helpers";

describe("BallisticsSimulator", () => {
  it("simulateShot returns early when projectile leaves the map", () => {
    const terrain = new TerrainManager(800, 480);
    terrain.generate();

    const result = simulateShot(100, 300, 45, 10, 0, 260, terrain);
    expect(result.landX).toBeTypeOf("number");
    expect(result.landY).toBeTypeOf("number");
    expect(BALLISTICS_MAX_STEPS).toBeGreaterThan(100);
  });

  it("searchBallisticSolution finds a low-error shot on flat terrain", () => {
    const terrain = new TerrainManager(800, 480);
    terrain.generate();

    const result = searchBallisticSolution({
      sx: 150,
      sy: 300,
      tx: 550,
      ty: 290,
      wind: 0,
      gravity: 260,
      terrain,
      isRight: true,
      aMin: 20,
      aMax: 80,
      coarseStep: 10,
      fineStep: 2,
      fineWindow: 6,
      powerLo: 30,
      powerHi: 90,
      powerIterations: 8,
      earlyExitError: 15,
    });

    expect(result.err).toBeLessThan(20);
    expect(result.angle).toBeGreaterThanOrEqual(20);
    expect(result.angle).toBeLessThanOrEqual(80);
    expect(result.power).toBeGreaterThanOrEqual(30);
    expect(result.power).toBeLessThanOrEqual(90);
  });

  it("searchBallisticSolution handles left-facing shots (isRight: false)", () => {
    const terrain = flatTerrain(800, 480, 0.72);
    const sy = 480 * 0.72 - 15;

    const result = searchBallisticSolution({
      sx: 620,
      sy,
      tx: 180,
      ty: sy - 6,
      wind: 0,
      gravity: 260,
      terrain,
      isRight: false,
      aMin: 98,
      aMax: 158,
      coarseStep: 5,
      fineStep: 1.5,
      fineWindow: 4,
      powerLo: 25,
      powerHi: 90,
      powerIterations: 8,
      earlyExitError: 12,
    });

    expect(result.err).toBeLessThan(20);
    expect(result.angle).toBeGreaterThanOrEqual(98);
    expect(result.angle).toBeLessThanOrEqual(158);
  });

  it("honors earlyExitError threshold on easy flat targets", () => {
    const terrain = flatTerrain(800, 480, 0.72);
    const sy = 480 * 0.72 - 15;

    const result = searchBallisticSolution({
      sx: 120,
      sy,
      tx: 520,
      ty: sy - 6,
      wind: 0,
      gravity: 260,
      terrain,
      isRight: true,
      aMin: 25,
      aMax: 75,
      coarseStep: 8,
      fineStep: 2,
      fineWindow: 6,
      powerLo: 35,
      powerHi: 85,
      powerIterations: 8,
      earlyExitError: 18,
    });

    expect(result.err).toBeLessThanOrEqual(18);
  });

  it("avoids intermediate terrain obstacles between shooter and target", () => {
    const terrain = terrainWithMidObstacle(800, 480, 360, 440, 120);
    const sy = 480 * 0.7 - 15;

    const result = searchBallisticSolution({
      sx: 120,
      sy,
      tx: 680,
      ty: sy - 6,
      wind: 0,
      gravity: 260,
      terrain,
      isRight: true,
      aMin: 20,
      aMax: 85,
      coarseStep: 5,
      fineStep: 1.5,
      fineWindow: 5,
      powerLo: 30,
      powerHi: 95,
      powerIterations: 9,
      obstaclePenaltyHigh: 10000,
      earlyExitError: 25,
    });

    const landing = simulateShot(
      120,
      sy,
      result.angle,
      result.power,
      0,
      260,
      terrain,
    );

    expect(result.err).toBeLessThan(30);
    const hitObstacleCorridor =
      landing.hitTerrainEarly &&
      landing.landX > 160 &&
      landing.landX < 640;
    expect(hitObstacleCorridor).toBe(false);
  });

  it("applies selfHarmPenalty to reject shots landing on the shooter", () => {
    const terrain = flatTerrain(800, 480, 0.72);
    const sx = 200;
    const sy = 480 * 0.72 - 15;

    const result = searchBallisticSolution({
      sx,
      sy,
      tx: 620,
      ty: sy - 6,
      wind: 0,
      gravity: 260,
      terrain,
      isRight: true,
      aMin: 20,
      aMax: 80,
      coarseStep: 5,
      fineStep: 1.5,
      fineWindow: 4,
      powerLo: 20,
      powerHi: 95,
      powerIterations: 9,
      selfHarmPenalty: (landX, landY) =>
        Math.hypot(landX - sx, landY - sy) < 60 ? 50000 : 0,
      earlyExitError: 20,
    });

    const landing = simulateShot(sx, sy, result.angle, result.power, 0, 260, terrain);
    expect(Math.hypot(landing.landX - sx, landing.landY - sy)).toBeGreaterThan(55);
  });

  it("simulateSmartShot simulates grenade bounces before settling", () => {
    const terrain = flatTerrain(800, 480, 0.72);
    const sy = 480 * 0.72 - 15;

    const result = simulateSmartShot(400, sy, 75, 45, 0, 260, terrain, "GRENADE");

    expect(result.landX).toBeGreaterThan(0);
    expect(result.landY).toBeGreaterThan(0);
    expect(result.hitTerrainEarly).toBe(false);
  });

  it("simulateSmartShot handles cluster weapon without throwing", () => {
    const terrain = flatTerrain(800, 480, 0.72);
    const sy = 480 * 0.72 - 15;

    const result = simulateSmartShot(150, sy, 55, 65, 0, 260, terrain, "CLUSTER");

    expect(result.landX).toBeTypeOf("number");
    expect(result.landY).toBeLessThan(terrain.height + 120);
  });
});