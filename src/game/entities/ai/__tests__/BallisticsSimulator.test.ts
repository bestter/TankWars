import { afterEach, describe, it, expect, vi } from "vitest";
import { TerrainManager } from "../../../engine/Terrain";
import {
  searchBallisticSolution,
  simulateShot,
  simulateSmartShot,
  type BallisticSearchConfig,
} from "../BallisticsSimulator";
import { flatTerrain, terrainWithMidObstacle } from "../../../__tests__/helpers";
import * as random from "../../../../utils/random";

function searchConfig(terrain: TerrainManager): BallisticSearchConfig {
  return {
    sx: 100, sy: 336, tx: 550, ty: 328.5, wind: 0, gravity: 260,
    terrain, isRight: true, aMin: 15, aMax: 85, coarseStep: 5,
    fineStep: 1.5, fineWindow: 4, powerLo: 20, powerHi: 95,
    powerIterations: 10, obstaclePenaltyHigh: 10000,
    obstaclePenaltyLow: 20, earlyExitError: 4,
  };
}

describe("BallisticsSimulator", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { sx: 100, tx: 550, isRight: true, aMin: 15, aMax: 85 },
    { sx: 550, tx: 100, isRight: false, aMin: 95, aMax: 165 },
  ])("retient une trajectoire complète de x=$sx vers x=$tx sans RNG", (direction) => {
    const terrain = flatTerrain(800, 480);
    const rng = vi.spyOn(random, "secureRandom");
    const result = searchBallisticSolution({ ...searchConfig(terrain), ...direction });
    const trajectory = simulateShot(direction.sx, 336, result.angle, result.power,
      0, 260, terrain);

    expect(result.complete).toBe(true);
    expect(trajectory.complete).toBe(true);
    expect(Math.abs(trajectory.landX - direction.tx)).toBeLessThan(10);
    expect(result.angle).toBeGreaterThanOrEqual(direction.aMin);
    expect(result.angle).toBeLessThanOrEqual(direction.aMax);
    expect(result.power).toBeGreaterThanOrEqual(20);
    expect(result.power).toBeLessThanOrEqual(95);
    expect(rng).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "privilégie la puissance complète même si le premier essai est complet=%s",
    (firstComplete) => {
      const terrain = flatTerrain(800, 480);
      // At zero gravity both free trajectories exhaust exactly 420 steps.
      const incomplete = simulateShot(100, 336, 15, firstComplete ? 52.5 : 55,
        0, 0, terrain);
      expect(incomplete.complete).toBe(false);
      let checks = 0;
      vi.spyOn(terrain, "checkCollision").mockImplementation(() =>
        firstComplete ? ++checks === 1 : ++checks > 420);

      const result = searchBallisticSolution({
        ...searchConfig(terrain), gravity: 0, tx: incomplete.landX,
        ty: incomplete.landY, aMin: 15, aMax: 15, fineStep: 0,
        powerLo: 50, powerHi: 60, powerIterations: 2,
      });

      expect(result.complete).toBe(true);
      expect(result.power).toBe(firstComplete ? 55 : 52.5);
      expect(result.err).toBeGreaterThan(0);
      expect(checks).toBe(421);
    },
  );

  it.each([false, true])(
    "privilégie l'angle complet même si le premier angle est complet=%s",
    (firstComplete) => {
      const terrain = flatTerrain(800, 480);
      const incomplete = simulateShot(100, 336, firstComplete ? 20 : 15, 55,
        0, 0, terrain);
      expect(incomplete.complete).toBe(false);
      let checks = 0;
      vi.spyOn(terrain, "checkCollision").mockImplementation(() =>
        firstComplete ? ++checks === 1 : ++checks > 420);

      const result = searchBallisticSolution({
        ...searchConfig(terrain), gravity: 0, tx: incomplete.landX,
        ty: incomplete.landY, aMin: 15, aMax: 20, fineStep: 0,
        powerLo: 50, powerHi: 60, powerIterations: 1,
        earlyExitError: firstComplete ? undefined : 0,
      });

      expect(result.complete).toBe(true);
      expect(result.angle).toBe(firstComplete ? 15 : 20);
      expect(result.err).toBeGreaterThan(0);
      expect(checks).toBe(421);
    },
  );

  it("conserve la meilleure approximation incomplète sans arrêt anticipé", () => {
    const terrain = flatTerrain(800, 480);
    const incomplete = simulateShot(100, 336, 15, 55, 0, 0, terrain);
    const collision = vi.spyOn(terrain, "checkCollision");
    const result = searchBallisticSolution({
      ...searchConfig(terrain), gravity: 0, tx: incomplete.landX,
      ty: incomplete.landY, aMin: 15, aMax: 20, fineStep: 0,
      powerLo: 50, powerHi: 60, powerIterations: 1, earlyExitError: 0,
    });

    expect(result).toEqual({ angle: 15, power: 55, err: 0, complete: false });
    expect(collision).toHaveBeenCalledTimes(840);
  });

  it("ne remplace pas le gagnant complet du balayage grossier par un essai fin incomplet", () => {
    const terrain = flatTerrain(800, 480);
    const incomplete = simulateShot(100, 336, 20, 55, 0, 0, terrain);
    let checks = 0;
    vi.spyOn(terrain, "checkCollision").mockImplementation(() => ++checks === 1);
    const result = searchBallisticSolution({
      ...searchConfig(terrain), gravity: 0, tx: incomplete.landX,
      ty: incomplete.landY, aMin: 15, aMax: 20, coarseStep: 10,
      fineStep: 5, fineWindow: 5, powerLo: 50, powerHi: 60,
      powerIterations: 1, earlyExitError: undefined,
    });

    expect(result.complete).toBe(true);
    expect(result.angle).toBe(15);
    expect(result.err).toBeGreaterThan(0);
    expect(checks).toBe(841);
  });

  it("marque la commande de secours incomplète si aucun essai n'est évalué", () => {
    const result = searchBallisticSolution({
      ...searchConfig(flatTerrain(800, 480)), powerIterations: 0, fineStep: 0,
    });
    expect(result).toEqual({ angle: 55, power: 60, err: 999999, complete: false });
  });

  it("simulateShot returns early when projectile leaves the map", () => {
    const terrain = new TerrainManager(800, 480);
    terrain.generate();

    const result = simulateShot(100, 300, 45, 10, 0, 260, terrain);
    expect(result.landX).toBeTypeOf("number");
    expect(result.landY).toBeTypeOf("number");

  });

  it("simulateShot handles angle=0 (horizontal right) correctly", () => {
    const terrain = new TerrainManager(800, 480);
    terrain.generate();

    const result = simulateShot(400, 200, 0, 50, 0, 260, terrain);

    expect(result.landX).toBeGreaterThan(400);
  });

  it("simulateShot handles angle=180 (horizontal left) correctly", () => {
    const terrain = new TerrainManager(800, 480);
    terrain.generate();

    const result = simulateShot(400, 200, 180, 50, 0, 260, terrain);

    expect(result.landX).toBeLessThan(400);
  });

  it("simulateShot handles angle=90 (straight up) correctly", () => {
    const terrain = new TerrainManager(800, 480);
    terrain.generate();

    const result = simulateShot(400, 200, 90, 50, 0, 260, terrain);

    expect(Math.abs(result.landX - 400)).toBeLessThan(1.0);
  });

  it("simulateShot handles power=0 (drop straight down) correctly", () => {
    const terrain = new TerrainManager(800, 480);
    terrain.generate();

    const result = simulateShot(400, 200, 45, 0, 0, 260, terrain);

    // With power 0, the projectile drops straight down from the barrel tip.
    // The barrel is short (length 20), so the landing X should be close to launch X.
    expect(Math.abs(result.landX - 400)).toBeLessThan(25.0);
  });


  it("searchBallisticSolution finds a low-error shot on flat terrain", () => {
    const terrain = flatTerrain(800, 480, 0.72);
    const groundY = 480 * 0.72;

    const result = searchBallisticSolution({
      sx: 150,
      sy: groundY - 15,
      tx: 550,
      ty: groundY - 15,
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
