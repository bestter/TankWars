import { afterEach, describe, expect, it, vi } from "vitest";
import * as random from "../../../../utils/random";
import { makePlayer, makeTank } from "../../../__tests__/helpers";
import { createRecordingCanvasContext } from "../../__tests__/recordingCanvasContext";
import {
  CelebrationFireworks,
  FIREWORKS_TICK_DT,
  MAX_FIREWORKS,
} from "../celebrationFireworks";

const PHYSICS_DT = 1 / 120;

describe("CelebrationFireworks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("decimates simulation to 60 Hz (not every 120 Hz physics step)", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0.5);
    const fireworks = new CelebrationFireworks({
      width: 800,
      height: 480,
      getGroundHeight: () => 400,
      onBurst: () => {},
    });

    fireworks.start(400, 300, "#55FFFF", null);
    const initialLife = fireworks.getParticles()[0].life;

    fireworks.update(PHYSICS_DT);
    expect(fireworks.getParticles()[0].life).toBe(initialLife);

    fireworks.update(PHYSICS_DT);
    expect(fireworks.getParticles()[0].life).toBe(initialLife - 1);
  });

  it("does not throw when fireworks arrays are empty", () => {
    const recorder = createRecordingCanvasContext();
    const fireworks = new CelebrationFireworks({
      width: 800,
      height: 480,
      getGroundHeight: () => 400,
      onBurst: () => {},
    });

    expect(() => {
      fireworks.update(PHYSICS_DT);
      fireworks.update(PHYSICS_DT);
      fireworks.draw(recorder.ctx);
    }).not.toThrow();
    expect(recorder.getLines()).toHaveLength(0);
  });

  it("caps active and queued fireworks spawns at MAX_FIREWORKS", () => {
    // 0.01 triggers cannon shots, sparks, and high particle/confetti counts
    vi.spyOn(random, "secureRandom").mockReturnValue(0.01);
    const winner = makePlayer({ id: "w", tank: makeTank("tw", 400, 360) });
    const fireworks = new CelebrationFireworks({
      width: 800,
      height: 480,
      getGroundHeight: () => 460,
      onBurst: () => {},
    });

    fireworks.start(400, 300, "#55FFFF", winner);
    for (let i = 0; i < 60; i++) {
      fireworks.update(FIREWORKS_TICK_DT);
      expect(fireworks.getParticles().length).toBeLessThanOrEqual(MAX_FIREWORKS);
    }
    expect(fireworks.getParticles().length).toBeGreaterThan(100);
  });

  it("compacts expired particles in place while keeping the same array reference", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0.5);
    const fireworks = new CelebrationFireworks({
      width: 800,
      height: 480,
      getGroundHeight: () => 460,
      onBurst: () => {},
    });

    fireworks.start(400, 300, "#55FFFF", null);
    const initialRef = fireworks.getParticles();

    // Advance 55 ticks until the initial 9 rockets (life=55 with 0.5) burst and get compacted out
    for (let i = 0; i < 55; i++) {
      fireworks.update(FIREWORKS_TICK_DT);
      expect(fireworks.getParticles()).toBe(initialRef);
    }
    expect(fireworks.getParticles().some((p) => p.type === "rocket")).toBe(false);
  });

  it("maintains bounded FIFO ring trails (7 for rockets with -0.12 alpha decay, 3 for particles at 1.0 alpha)", () => {
    const rng = random.createSeededRNG(7);
    vi.spyOn(random, "secureRandom").mockImplementation(() => rng.next());

    const fireworks = new CelebrationFireworks({
      width: 800,
      height: 480,
      getGroundHeight: () => 470,
      onBurst: () => {},
    });
    fireworks.start(400, 300, "#55FFFF", null);

    // Advance 9 ticks: initial rockets wrap their 7-slot circular trail
    for (let i = 0; i < 9; i++) {
      fireworks.update(FIREWORKS_TICK_DT);
    }

    const rocket = fireworks.getParticles().find((p) => p.type === "rocket");
    expect(rocket).toBeDefined();
    if (!rocket || rocket.type !== "rocket") throw new Error("expected rocket");
    expect(rocket.trail.capacity).toBe(7);
    expect(rocket.trail.count).toBe(7);
    expect(rocket.trail.data).toHaveLength(7 * 3);

    // Check FIFO order and -0.12 per-tick alpha decay (oldest slot decayed 7 times -> 0.16, newest decayed 1 time -> 0.88)
    const rocketAlphas: number[] = [];
    for (let i = 0; i < rocket.trail.count; i++) {
      const slot = (rocket.trail.head + i) % rocket.trail.capacity;
      rocketAlphas.push(rocket.trail.data[slot * 3 + 2]);
    }
    expect(rocketAlphas[0]).toBeCloseTo(1 - 7 * 0.12, 6);
    expect(rocketAlphas[6]).toBeCloseTo(1 - 0.12, 6);

    // Verify draw(ctx) draws rocket trail slots in FIFO order with matching alphas
    const recorder = createRecordingCanvasContext();
    fireworks.draw(recorder.ctx);
    expect(recorder.getGlobalAlpha()).toBe(1);
    const firstRocketAlpha = Math.max(0.1, rocket.life / rocket.maxLife);
    const lines = recorder.getLines();
    const firstSlotX = rocket.trail.data[rocket.trail.head * 3];
    const expectedOldestX = (firstSlotX - rocket.size / 3).toFixed(6);
    expect(lines[0]).toContain(`x=${expectedOldestX}`);
    expect(lines[0]).toContain(
      `alpha=${(rocketAlphas[0] * firstRocketAlpha * 0.38).toFixed(6)}`,
    );

    // Advance until burst particles have existed for >= 5 ticks -> bounded 3-slot FIFO ring
    for (let i = 9; i < 80; i++) {
      fireworks.update(FIREWORKS_TICK_DT);
    }
    const burst = fireworks.getParticles().find((p) => p.type === "particle");
    expect(burst).toBeDefined();
    if (!burst || burst.type !== "particle") throw new Error("expected burst particle");
    expect(burst.trail.capacity).toBe(3);
    expect(burst.trail.count).toBe(3);
    expect(burst.trail.data).toHaveLength(3 * 2);

    const recorderAfter = createRecordingCanvasContext();
    fireworks.draw(recorderAfter.ctx);
    expect(recorderAfter.getGlobalAlpha()).toBe(1);
    const burstAlpha = Math.max(0.1, burst.life / burst.maxLife);
    const expectedTrailAlpha = (burstAlpha * 0.38).toFixed(6);
    expect(
      recorderAfter.getLines().some((l) => l.includes(`alpha=${expectedTrailAlpha}`)),
    ).toBe(true);
  });

  it("calls onBurst(x) once per bursting rocket with exact x before explosionPattern RNG draw", () => {
    let draws = 0;
    let burstDrawTarget = 0.5;
    vi.spyOn(random, "secureRandom").mockImplementation(() => {
      draws += 1;
      return burstDrawTarget;
    });

    const bursts: Array<{ x: number; drawsAtBurst: number }> = [];
    const fireworks = new CelebrationFireworks({
      width: 800,
      height: 480,
      getGroundHeight: () => 470,
      onBurst: (x) => {
        bursts.push({ x, drawsAtBurst: draws });
      },
    });

    fireworks.start(400, 300, "#55FFFF", null);
    // Avoid extra spark/ambient spawns during flight so only the 9 initial rockets burst on tick 55
    burstDrawTarget = 0.99;
    const expectedBurstXs = fireworks
      .getParticles()
      .filter((p) => p.type === "rocket")
      .map((r) => r.x + r.vx * 55);

    for (let i = 0; i < 54; i++) {
      fireworks.update(FIREWORKS_TICK_DT);
    }
    expect(bursts).toHaveLength(0);

    // On tick 55, set draws = 0; each of the 9 rockets draws once for spark check (< 0.22)
    // and only AFTER onBurst(p.x) draws for explosionPattern, burst particles, and confetti.
    draws = 0;
    fireworks.update(FIREWORKS_TICK_DT);

    expect(bursts).toHaveLength(9);
    for (let i = 0; i < 9; i++) {
      expect(bursts[i].x).toBeCloseTo(expectedBurstXs[i], 9);
    }
    // First rocket drew only once (spark check) before onBurst was invoked; pattern + confetti draws happened after
    expect(bursts[0].drawsAtBurst).toBe(1);
    expect(draws).toBeGreaterThan(bursts[8].drawsAtBurst);
  });

  it("sweeps winner cannon between 78.5 and 112.5 degrees and returns null without winner", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const fireworks = new CelebrationFireworks({
      width: 800,
      height: 480,
      getGroundHeight: () => 470,
      onBurst: () => {},
    });

    fireworks.start(400, 300, "#55FFFF", null);
    expect(fireworks.cannonWinner).toBeNull();
    expect(fireworks.cannonAngle).toBe(90);

    const winner = makePlayer({ id: "w", tank: makeTank("tw", 400, 360) });
    fireworks.start(400, 300, winner.tank.color, winner);
    expect(fireworks.cannonWinner).toBe(winner);
    expect(fireworks.cannonAngle).toBe(78.5);

    // 34 ticks -> reaches 112.5 (still heading up)
    for (let i = 0; i < 34; i++) {
      fireworks.update(FIREWORKS_TICK_DT);
    }
    expect(fireworks.cannonAngle).toBe(112.5);

    // Next tick clamps at 112.5 and reverses direction to -1; following tick moves to 111.5
    fireworks.update(FIREWORKS_TICK_DT);
    expect(fireworks.cannonAngle).toBe(112.5);
    expect(fireworks.getCelebrationState().angleDir).toBe(-1);
    fireworks.update(FIREWORKS_TICK_DT);
    expect(fireworks.cannonAngle).toBe(111.5);

    // Sweep back down to 78.5 (33 more ticks), clamp + reverse to +1, then move to 79.5
    for (let i = 0; i < 33; i++) {
      fireworks.update(FIREWORKS_TICK_DT);
    }
    expect(fireworks.cannonAngle).toBe(78.5);
    fireworks.update(FIREWORKS_TICK_DT);
    expect(fireworks.cannonAngle).toBe(78.5);
    expect(fireworks.getCelebrationState().angleDir).toBe(1);
    fireworks.update(FIREWORKS_TICK_DT);
    expect(fireworks.cannonAngle).toBe(79.5);
  });

  it("resets winner, angle, and direction when starting without a winner after a winner celebration", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const winner = makePlayer({ id: "w", tank: makeTank("tw", 400, 360) });
    const fireworks = new CelebrationFireworks({
      width: 800,
      height: 480,
      getGroundHeight: () => 470,
      onBurst: () => {},
    });

    fireworks.start(400, 300, winner.tank.color, winner);
    for (let i = 0; i < 35; i++) {
      fireworks.update(FIREWORKS_TICK_DT);
    }
    expect(fireworks.cannonAngle).toBe(112.5);
    expect(fireworks.getCelebrationState().angleDir).toBe(-1);

    fireworks.start(400, 300, "#FFFFFF", null);
    expect(fireworks.cannonWinner).toBeNull();
    expect(fireworks.cannonAngle).toBe(90);
    expect(fireworks.getCelebrationState().angleDir).toBe(1);
  });

  it("clips confetti at injected ground height", () => {
    // 0.5 spawns confetti at y = 0.5 * 300 = 150; lowering ground to y = 10 clips it
    vi.spyOn(random, "secureRandom").mockReturnValue(0.5);
    let groundHeight = 400;
    const fireworks = new CelebrationFireworks({
      width: 800,
      height: 480,
      getGroundHeight: () => groundHeight,
      onBurst: () => {},
    });

    fireworks.start(400, 300, "#55FFFF", null);
    expect(fireworks.getParticles().some((p) => p.type === "confetti")).toBe(true);

    // Lower the ground above all confetti -> next tick removes all confetti
    groundHeight = 10;
    fireworks.update(FIREWORKS_TICK_DT);
    expect(fireworks.getParticles().some((p) => p.type === "confetti")).toBe(false);
  });

  it("clears celebration state in place and preserves the remaining half-tick", () => {
    const draws = vi.spyOn(random, "secureRandom").mockReturnValue(0.5);
    const winner = makePlayer({ id: "w", tank: makeTank("tw", 400, 360) });
    const fireworks = new CelebrationFireworks({
      width: 800,
      height: 480,
      getGroundHeight: () => 400,
      onBurst: () => {},
    });

    const initialRef = fireworks.getParticles();
    fireworks.start(400, 300, "#FF5555", winner);
    fireworks.update(PHYSICS_DT); // leaves 1/120 in updateAccum
    expect(fireworks.getCelebrationState().updateAccum).toBeCloseTo(PHYSICS_DT, 9);

    fireworks.clear();
    expect(fireworks.getParticles()).toBe(initialRef);
    expect(fireworks.getParticles()).toHaveLength(0);
    expect(fireworks.hasParticles).toBe(false);
    expect(fireworks.cannonWinner).toBeNull();
    expect(fireworks.cannonAngle).toBe(90);
    expect(fireworks.getCelebrationState()).toEqual({
      centerX: 0,
      color: "#FFFFFF",
      winner: null,
      angle: 90,
      angleDir: 1,
      updateAccum: PHYSICS_DT,
    });

    fireworks.start(200, 200, "#55FF55", winner);
    const lifeAfterRestart = fireworks.getParticles()[0].life;
    draws.mockClear();
    fireworks.update(PHYSICS_DT);
    expect(fireworks.getParticles()[0].life).toBe(lifeAfterRestart - 1);
    expect(fireworks.cannonAngle).toBe(79.5);
    expect(draws).toHaveBeenCalledTimes(11);
  });
});
