import { afterEach, describe, expect, it, vi } from "vitest";
import { flatTerrain, makePlayer, makeTank } from "../../../__tests__/helpers";
import { PhysicsEngine, type ProjectileHitEvent } from "../../../engine/PhysicsEngine";
import { TankManager } from "../../TankManager";
import * as random from "../../../../utils/random";
import { TERRAIN_MATERIAL } from "../../../../types/terrain";
import { insideTankHitbox } from "../../../combatConstants";
import {
  BALLISTICS_MAX_STEPS, BULLDOZER_DIRECT_SEARCH_MAX_SIMULATIONS,
  BULLDOZER_DIRECT_COARSE_ANGLE_STEP, BULLDOZER_DIRECT_COARSE_POWER_STEP,
  BULLDOZER_DIRECT_FINE_ANGLE_STEP, BULLDOZER_DIRECT_FINE_POWER_STEP,
  BULLDOZER_DIRECT_FINE_WINDOW, BULLDOZER_DIRECT_NEAR_DISTANCE,
  searchDirectBulldozerSolutions, simulateDirectBulldozerTrajectory, type DirectBulldozerConfig,
} from "../BallisticsSimulator";

afterEach(() => vi.restoreAllMocks());

function config(sx = 100, tx = 400): DirectBulldozerConfig {
  const shooter = makePlayer({ id: "shooter", tank: makeTank("shooter", sx, 300) });
  const target = makePlayer({ id: "target", tank: makeTank("target", tx, 300) });
  return { shooter, target, players: [shooter, target], terrain: flatTerrain(800, 480, 300 / 480), wind: 0, gravity: 260 };
}

describe("pure direct BULLDOZER trajectory", () => {
  it.each([0, 180])("uses inclusive hitbox edges at angle %s, before terrain and in roster order", (angle) => {
    const f = config();
    const x = angle === 0 ? 120 : 80;
    f.target.tank.position = { x: x + (angle === 0 ? 12 : -12), y: 300 };
    const overlap = makePlayer({ id: "overlap", tank: makeTank("overlap", f.target.tank.position.x, 300) });
    const trajectory = simulateDirectBulldozerTrajectory({ ...f, gravity: 0 }, { angle, power: 0 });
    expect(trajectory).toMatchObject({ terminal: "tank", targetId: "target", x, y: 287, steps: 1, vx: 0 });
    expect(simulateDirectBulldozerTrajectory({ ...f, gravity: 0, players: [overlap, f.target, f.shooter] }, { angle, power: 0 }))
      .toMatchObject({ terminal: "tank", targetId: "overlap" });
    expect(insideTankHitbox(x, 285, f.target.tank.position)).toBe(true);
    expect(insideTankHitbox(x, 300, f.target.tank.position)).toBe(true);
    expect(insideTankHitbox(x, 284.999, f.target.tank.position)).toBe(false);
    expect(insideTankHitbox(x, 300.001, f.target.tank.position)).toBe(false);
    const heights = [...f.terrain.getHeightmap()]; heights.fill(287);
    f.terrain.loadHeights(heights);
    expect(simulateDirectBulldozerTrajectory({ ...f, gravity: 0 }, { angle, power: 0 }).terminal).toBe("tank");
  });

  it.each(["left", "right", "bottom"])("checks the strict %s screen margin before tanks or terrain", (side) => {
    const f = config();
    const x = side === "left" ? -60 : side === "right" ? 860 : 150;
    const y = side === "bottom" ? 630 : 100;
    f.shooter.tank.position = { x: x - 20, y: y + 13 };
    f.target.tank.position = { x, y };
    expect(simulateDirectBulldozerTrajectory({ ...f, gravity: 0 }, { angle: 0, power: 0 }))
      .toMatchObject({ terminal: "tank", targetId: "target", steps: 1 });
    const delta = side === "left" ? -0.001 : 0.001;
    if (side === "bottom") { f.shooter.tank.position.y += delta; f.target.tank.position.y += delta; }
    else { f.shooter.tank.position.x += delta; f.target.tank.position.x += delta; }
    expect(simulateDirectBulldozerTrajectory({ ...f, gravity: 0 }, { angle: 0, power: 0 }))
      .toMatchObject({ terminal: "out-of-bounds", steps: 1 });
  });

  it("ignores only the owner while inside its box", () => {
    const f = config();
    f.target.tank.position = { x: 100, y: 300 };
    const command = { angle: 90, power: 0 };
    // Barrel starts at y=267; the first step reenters both boxes at y=290.
    expect(simulateDirectBulldozerTrajectory({ ...f, gravity: 23 * 120 * 120 }, command))
      .toMatchObject({ terminal: "tank", targetId: "target", steps: 1 });
  });

  it("allows an owner collision after exit and return", () => {
    const f = config();
    // Strong wind reverses the trajectory after it has cleared the shooter's box.
    const command = { angle: 0, power: 25 };
    const trajectory = simulateDirectBulldozerTrajectory({ ...f, wind: -1200, gravity: 0 }, command);
    expect(trajectory).toMatchObject({ terminal: "tank", targetId: "shooter" });
    expect(trajectory.steps).toBeGreaterThan(1);
  });

  it("rejects intervening ROCK and other live tanks, but ignores dead tanks", () => {
    const f = config();
    const command = { angle: 15, power: 50 };
    const baseline = simulateDirectBulldozerTrajectory(f, command);
    const obstacle = makePlayer({ id: "block", tank: makeTank("block", 130, 282) });
    expect(simulateDirectBulldozerTrajectory({ ...f, players: [f.shooter, obstacle, f.target] }, command))
      .toMatchObject({ terminal: "tank", targetId: "block" });
    obstacle.tank.isDead = true;
    expect(simulateDirectBulldozerTrajectory({ ...f, players: [f.shooter, obstacle, f.target] }, command)).toEqual(baseline);
    const heights = [...f.terrain.getHeightmap()]; heights.fill(150, 125, 150);
    f.terrain.loadHeights(heights, Array.from({ length: 800 }, () => TERRAIN_MATERIAL.ROCK));
    expect(simulateDirectBulldozerTrajectory(f, command)).toMatchObject({ terminal: "terrain" });
  });

  it("rejects trajectories still flying after 420 steps", () => {
    const f = config();
    expect(simulateDirectBulldozerTrajectory({ ...f, gravity: 0 }, { angle: 90, power: 25 }))
      .toMatchObject({ terminal: "incomplete", steps: 420 });
    expect(BALLISTICS_MAX_STEPS).toBe(420);
  });

  it.each([{ wind: 0, gravity: 260 }, { wind: -90, gravity: 160 }, { wind: 140, gravity: 400 }])(
    "matches actual combat terminal hits with wind=$wind gravity=$gravity", ({ wind, gravity }) => {
      const f = config();
      const before = structuredClone(f.players);
      for (const command of [{ angle: 15, power: 50 }, { angle: 45, power: 50 }, { angle: 85, power: 95 }]) {
        const predicted = simulateDirectBulldozerTrajectory({ ...f, wind, gravity }, command);
        const tanks = new TankManager(); tanks.setPlayers(structuredClone([...f.players]));
        const engine = new PhysicsEngine(() => { throw new Error("unexpected RNG"); }, false);
        const radians = command.angle * Math.PI / 180;
        engine.launchProjectile(100 + Math.cos(radians) * 20, 287 - Math.sin(radians) * 20,
          command.angle, command.power, "BULLDOZER", "shooter");
        let terminalHit: ProjectileHitEvent | undefined;
        engine.onProjectileHit = (event) => { terminalHit = event; };
        let steps = 0;
        while (engine.hasActiveProjectiles() && steps < 420) { steps++; engine.updateProjectiles(1 / 120, gravity, wind, f.terrain, tanks); }
        expect(predicted.steps).toBe(steps);
        if (terminalHit) {
          expect(predicted).toMatchObject({ x: terminalHit.x, y: terminalHit.y,
            terminal: terminalHit.directTargetId ? "tank" : "terrain" });
          expect(predicted.targetId).toBe(terminalHit.directTargetId);
        } else expect(predicted.terminal).toBe(engine.hasActiveProjectiles() ? "incomplete" : "out-of-bounds");
      }
      expect(f.players).toEqual(before);
    });
});

describe("bounded normalized traversal", () => {
  it.each([[100, 400, 15, 85], [400, 100, 95, 165], [100, 100, 95, 165]])(
    "normalizes the coarse grid and preserves direction/order (%s -> %s)", (sx, tx, minimum, maximum) => {
      const f = config(sx, tx);
      const before = structuredClone(f.players);
      const rng = vi.spyOn(random, "secureRandom");
      const launch = vi.spyOn(PhysicsEngine.prototype, "launchProjectile");
      const candidates = [...searchDirectBulldozerSolutions(f)];
      const coarse = candidates.slice(0, 90).map(({ command }) => command);
      const expected = [];
      for (let angle = minimum; angle <= maximum; angle += 5) {
        for (const power of [25, 35, 50, 65, 80, 95]) expected.push({ angle, power });
      }
      expect(coarse).toEqual(expected);
      expect(candidates.length).toBeLessThanOrEqual(512);
      expect(new Set(candidates.map(({ command }) => `${command.angle}:${command.power}`)).size).toBe(candidates.length);
      for (const { command, trajectory } of candidates) {
        expect(command.angle).toBeGreaterThanOrEqual(minimum); expect(command.angle).toBeLessThanOrEqual(maximum);
        expect(command.power).toBeGreaterThanOrEqual(25); expect(command.power).toBeLessThanOrEqual(95);
        expect(Number.isInteger(command.power)).toBe(true); expect(trajectory.steps).toBeLessThanOrEqual(420);
      }
      expect(rng).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled(); expect(f.players).toEqual(before);
    });

  it("uses the calibrated hard ceiling and does not truncate the coarse grid", () => {
    const f = config(100, 125); f.target.tank.position.y = 280;
    const candidates = [...searchDirectBulldozerSolutions(f)];
    expect(BULLDOZER_DIRECT_SEARCH_MAX_SIMULATIONS).toBe(512);
    expect(candidates).toHaveLength(512);
    expect(candidates[89].command).toEqual({ angle: 85, power: 95 });
    expect(BULLDOZER_DIRECT_COARSE_ANGLE_STEP).toBe(5); expect(BULLDOZER_DIRECT_COARSE_POWER_STEP).toBe(15);
    expect(BULLDOZER_DIRECT_FINE_ANGLE_STEP).toBe(1.5); expect(BULLDOZER_DIRECT_FINE_POWER_STEP).toBe(5);
    expect(BULLDOZER_DIRECT_FINE_WINDOW).toBe(4.5); expect(BULLDOZER_DIRECT_NEAR_DISTANCE).toBe(8);
  });

  it("does not refine a coarse campaign that never approaches the target AABB", () => {
    const f = config(); f.target.tank.position.x = 100000;
    expect([...searchDirectBulldozerSolutions(f)]).toHaveLength(90);
  });
});
