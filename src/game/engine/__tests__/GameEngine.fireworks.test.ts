import { describe, it, expect, beforeEach } from "vitest";
import { GameEngine } from "../GameEngine";

type FireworkParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  type: "rocket" | "particle" | "confetti";
};

type FireworksInternals = {
  updateFireworks: (dt: number) => void;
  queueFireworkSpawn: (p: FireworkParticle) => void;
  fireworks: FireworkParticle[];
  fireworksUpdateAccum: number;
  fireworkSpawnBuffer: FireworkParticle[];
};

const MAX_FIREWORKS = 250;
const PHYSICS_DT = 1 / 120;

function engineInternals(engine: GameEngine): FireworksInternals {
  return engine as unknown as FireworksInternals;
}

function makeParticle(life = 10): FireworkParticle {
  return {
    type: "particle",
    x: 100,
    y: 100,
    vx: 0,
    vy: 0,
    life,
    maxLife: life,
    color: "#FFFFFF",
    size: 2,
  };
}

describe("GameEngine fireworks optimization", () => {
  let engine: GameEngine;
  let internal: FireworksInternals;

  beforeEach(() => {
    engine = new GameEngine(200, 200);
    internal = engineInternals(engine);
    internal.fireworks.length = 0;
    internal.fireworkSpawnBuffer.length = 0;
    internal.fireworksUpdateAccum = 0;
  });

  it("decimates fireworks simulation to ~60 Hz (not every 120 Hz physics step)", () => {
    internal.fireworks.push(makeParticle(12));

    internal.updateFireworks(PHYSICS_DT);
    expect(internal.fireworks[0].life).toBe(12);

    internal.updateFireworks(PHYSICS_DT);
    expect(internal.fireworks[0].life).toBe(11);
  });

  it("does not throw when fireworks arrays are empty", () => {
    expect(() => {
      internal.updateFireworks(PHYSICS_DT);
      internal.updateFireworks(PHYSICS_DT);
    }).not.toThrow();
  });

  it("caps queued fireworks spawns at MAX_FIREWORKS", () => {
    internal.fireworks.length = MAX_FIREWORKS - 5;

    for (let i = 0; i < 40; i++) {
      internal.queueFireworkSpawn(makeParticle(8));
    }

    expect(
      internal.fireworks.length + internal.fireworkSpawnBuffer.length,
    ).toBeLessThanOrEqual(MAX_FIREWORKS);
  });

  it("compacts dead particles in place during tick", () => {
    internal.fireworks.push(makeParticle(1));
    internal.fireworks.push(makeParticle(20));

    internal.updateFireworks(PHYSICS_DT);
    internal.updateFireworks(PHYSICS_DT);

    expect(internal.fireworks.length).toBe(1);
    expect(internal.fireworks[0].life).toBe(19);
  });
});