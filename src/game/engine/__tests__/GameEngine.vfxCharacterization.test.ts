import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TERRAIN_MATERIAL, type TerrainMaterial } from "../../../types/terrain";
import { VGA_PALETTE } from "../../../types/game";
import * as random from "../../../utils/random";
import { makePlayer, makeTank } from "../../__tests__/helpers";
import { CombatAudio } from "../audio/CombatAudio";
import { GameEngine } from "../GameEngine";
import { createRecordingCanvasContext } from "./recordingCanvasContext";

const SEEDS = [1, 13, 42] as const;
const DT = 1 / 120;

function getUpdateFn(engine: GameEngine): (dt: number) => void {
  return Reflect.get(engine, "update") as (dt: number) => void;
}

function setupFlatMatch(
  engine: GameEngine,
  width: number,
  groundY: number,
  material: TerrainMaterial,
  p1x: number,
  p2x: number,
) {
  const p1 = makePlayer({ id: "p1", name: "P1", tank: makeTank("t1", p1x, groundY) });
  const p2 = makePlayer({ id: "p2", name: "P2", tank: makeTank("t2", p2x, groundY) });
  engine.setPlayers([p1, p2]);
  engine.setWindForce(0);
  engine
    .getTerrain()
    .loadHeights(new Array<number>(width).fill(groundY), new Array<TerrainMaterial>(width).fill(material));
  const live1 = engine.getTankManager().getPlayerById("p1")!;
  const live2 = engine.getTankManager().getPlayerById("p2")!;
  live1.tank.position = { x: p1x, y: groundY };
  live2.tank.position = { x: p2x, y: groundY };
  return { live1, live2 };
}

describe("GameEngine VFX characterization", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.spyOn(Date, "now").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(SEEDS)(
    "captures celebration fireworks, cannon override, and secureRandom sequence (seed %i)",
    async (seed) => {
      const rng = random.createSeededRNG(seed);
      let randomDraws = 0;
      vi.spyOn(random, "secureRandom").mockImplementation(() => {
        randomDraws += 1;
        return rng.next();
      });

      const engine = new GameEngine(800, 480);
      const { live1 } = setupFlatMatch(engine, 800, 360, TERRAIN_MATERIAL.DIRT, 400, 650);
      live1.tank.angle = 45;
      engine.enterInterRoundPhase();

      vi.spyOn(engine.getTerrain(), "draw").mockImplementation(() => {});
      vi.spyOn(engine.getPhysicsEngine(), "draw").mockImplementation(() => {});
      let angleDuringDraw = Number.NaN;
      vi.spyOn(engine.getTankManager(), "draw").mockImplementation(() => {
        angleDuringDraw = live1.tank.angle;
      });
      vi.spyOn(CombatAudio.prototype, "playVictoryFanfare").mockImplementation(() => {});

      let currentStep = 0;
      const pops: Array<{ step: number; x: number; randomDraws: number }> = [];
      vi.spyOn(CombatAudio.prototype, "playFireworkPop").mockImplementation((x: number) => {
        pops.push({ step: currentStep, x, randomDraws });
      });

      const recorder = createRecordingCanvasContext();
      const stepUpdate = getUpdateFn(engine);
      const sampledSteps = new Set([0, 16, 70, 110, 160]);
      const frameOutputs: string[] = [];

      randomDraws = 0;
      engine.triggerRoundCelebration(live1);

      const recordFrame = (step: number) => {
        recorder.clearLines();
        angleDuringDraw = Number.NaN;
        engine.render(recorder.ctx);
        expect(live1.tank.angle).toBe(45);
        expect(recorder.getGlobalAlpha()).toBe(1);
        frameOutputs.push(
          [
            `=== frame step=${step} cannonAngleDuringDraw=${angleDuringDraw} ===`,
            ...recorder.getLines(),
          ].join("\n"),
        );
      };

      recordFrame(0);
      for (let step = 1; step <= 160; step++) {
        currentStep = step;
        stepUpdate.call(engine, DT);
        if (sampledSteps.has(step)) {
          recordFrame(step);
        }
      }

      expect(pops.length).toBeGreaterThan(0);

      const snapshot = [
        `totalRandomDraws=${randomDraws}`,
        "=== pops ===",
        ...pops.map((p) => `step=${p.step} x=${p.x.toFixed(6)} randomDraws=${p.randomDraws}`),
        ...frameOutputs,
      ].join("\n") + "\n";

      await expect(snapshot).toMatchFileSnapshot(`./__snapshots__/vfx-celebration-seed-${seed}.txt`);
    },
  );

  it.each(SEEDS)(
    "captures THERMONUCLEAR flash, explosion rects, and secureRandom draws (seed %i)",
    async (seed) => {
      const rng = random.createSeededRNG(seed);
      let randomDraws = 0;
      vi.spyOn(random, "secureRandom").mockImplementation(() => {
        randomDraws += 1;
        return rng.next();
      });

      const engine = new GameEngine(200, 200);
      const { live1 } = setupFlatMatch(engine, 200, 120, TERRAIN_MATERIAL.SOFT, 40, 160);
      live1.inventory.THERMONUCLEAR = 1;

      vi.spyOn(engine.getTerrain(), "draw").mockImplementation(() => {});
      vi.spyOn(engine.getPhysicsEngine(), "draw").mockImplementation(() => {});
      vi.spyOn(engine.getTankManager(), "draw").mockImplementation(() => {});

      engine.fireProjectile(
        live1.tank.position,
        { angle: 0, power: 50, weaponId: "THERMONUCLEAR" },
        live1.id,
        { shotId: 1, isFirstShotOfRound: true },
      );
      const proj = engine.getActiveProjectiles()[0];
      proj.x = 100;
      proj.y = 120;

      const stepUpdate = getUpdateFn(engine);
      randomDraws = 0;
      stepUpdate.call(engine, DT);
      expect(randomDraws).toBe(210);

      const recorder = createRecordingCanvasContext();
      const capturedFrames = new Set([0, 12, 13]);
      const frameOutputs: string[] = [];
      let flashCount = 0;
      const expectedFlashLine = `fillRect x=0.000000 y=0.000000 w=200.000000 h=200.000000 fill=${VGA_PALETTE.RED} alpha=0.240000`;

      for (let frame = 0; frame <= 13; frame++) {
        recorder.clearLines();
        engine.render(recorder.ctx);
        expect(recorder.getGlobalAlpha()).toBe(1);
        const lines = recorder.getLines();
        if (lines.includes(expectedFlashLine)) {
          flashCount += 1;
        }
        if (capturedFrames.has(frame)) {
          frameOutputs.push([`=== frame ${frame} ===`, ...lines].join("\n"));
        }
        stepUpdate.call(engine, DT);
      }

      for (let frame = 14; frame < 45; frame++) {
        stepUpdate.call(engine, DT);
      }

      recorder.clearLines();
      engine.render(recorder.ctx);
      expect(recorder.getGlobalAlpha()).toBe(1);
      frameOutputs.push([`=== frame 45 ===`, ...recorder.getLines()].join("\n"));

      expect(flashCount).toBe(13);
      expect(randomDraws).toBe(210);

      const snapshot = [
        `totalRandomDraws=${randomDraws}`,
        `flashCount=${flashCount}`,
        ...frameOutputs,
      ].join("\n") + "\n";

      await expect(snapshot).toMatchFileSnapshot(`./__snapshots__/vfx-thermo-seed-${seed}.txt`);
    },
  );

  describe.each([
    TERRAIN_MATERIAL.DIRT,
    TERRAIN_MATERIAL.SOFT,
    TERRAIN_MATERIAL.ROCK,
  ])("terrain impact particles for %s", (material) => {
    it("captures deterministic fillRect sequence without secureRandom or Math.random", async () => {
      const rng = random.createSeededRNG(1);
      let randomDraws = 0;
      const secureRandomSpy = vi.spyOn(random, "secureRandom").mockImplementation(() => {
        randomDraws += 1;
        return rng.next();
      });
      const mathRandomSpy = vi.spyOn(Math, "random");

      const engine = new GameEngine(200, 200);
      const { live1 } = setupFlatMatch(engine, 200, 120, material, 40, 160);

      vi.spyOn(engine.getTerrain(), "draw").mockImplementation(() => {});
      vi.spyOn(engine.getPhysicsEngine(), "draw").mockImplementation(() => {});
      vi.spyOn(engine.getTankManager(), "draw").mockImplementation(() => {});

      engine.fireProjectile(
        live1.tank.position,
        { angle: 0, power: 50, weaponId: "MISSILE" },
        live1.id,
        { shotId: 1, isFirstShotOfRound: true },
      );
      const proj = engine.getActiveProjectiles()[0];
      proj.x = 100;
      proj.y = 120;

      randomDraws = 0;
      secureRandomSpy.mockClear();
      mathRandomSpy.mockClear();

      const stepUpdate = getUpdateFn(engine);
      stepUpdate.call(engine, DT);

      const recorder = createRecordingCanvasContext();
      const capturedFrames = new Set([0, 1, 11, 12, 15, 16, 23, 24]);
      const frameOutputs: string[] = [];

      for (let frame = 0; frame < 25; frame++) {
        recorder.clearLines();
        engine.render(recorder.ctx);
        expect(recorder.getGlobalAlpha()).toBe(1);
        if (capturedFrames.has(frame)) {
          frameOutputs.push([`=== frame ${frame} ===`, ...recorder.getLines()].join("\n"));
        }
      }

      expect(randomDraws).toBe(0);
      expect(secureRandomSpy).not.toHaveBeenCalled();
      expect(mathRandomSpy).not.toHaveBeenCalled();

      const snapshot = `${frameOutputs.join("\n")}\n`;
      await expect(snapshot).toMatchFileSnapshot(`./__snapshots__/vfx-terrain-${material}.txt`);
    });
  });
});
