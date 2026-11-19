import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VGA_PALETTE } from "../../../types/game";
import { TERRAIN_MATERIAL } from "../../../types/terrain";
import * as random from "../../../utils/random";
import { makePlayer, makeRoundMap, makeTank } from "../../__tests__/helpers";
import { CombatAudio } from "../audio/CombatAudio";
import { GameEngine } from "../GameEngine";
import { CelebrationFireworks } from "../vfx/celebrationFireworks";
import { ImpactExplosions } from "../vfx/impactExplosions";
import { TerrainImpactParticles } from "../vfx/terrainImpactParticles";
import { createRecordingCanvasContext } from "./recordingCanvasContext";

function setupFlatPlayers(engine: GameEngine) {
  const p1 = makePlayer({ id: "p1", name: "P1", tank: makeTank("t1", 120, 300) });
  const p2 = makePlayer({ id: "p2", name: "P2", tank: makeTank("t2", 680, 300) });
  engine.setPlayers([p1, p2]);
  engine.setWindForce(0);
  engine
    .getTerrain()
    .loadHeights(new Array<number>(800).fill(300), new Array(800).fill(TERRAIN_MATERIAL.SOFT));
  const live1 = engine.getTankManager().getPlayerById("p1")!;
  const live2 = engine.getTankManager().getPlayerById("p2")!;
  live1.tank.position = { x: 120, y: 300 };
  live2.tank.position = { x: 680, y: 300 };
  return { live1, live2 };
}

function triggerAllThreeVfx(engine: GameEngine, winnerId: string) {
  const step = Reflect.get(engine, "update") as (dt: number) => void;
  engine
    .getTerrain()
    .loadHeights(new Array<number>(800).fill(300), new Array(800).fill(TERRAIN_MATERIAL.SOFT));
  const shooter = engine.getTankManager().getPlayerById(winnerId)!;
  const p2 = engine.getTankManager().getPlayerById("p2");
  shooter.tank.position = { x: 120, y: 300 };
  if (p2) p2.tank.position = { x: 680, y: 300 };
  shooter.inventory.THERMONUCLEAR = 2;

  engine.fireProjectile(
    shooter.tank.position,
    { angle: 0, power: 50, weaponId: "MISSILE" },
    shooter.id,
    { shotId: 1, isFirstShotOfRound: true },
  );
  engine.getActiveProjectiles()[0].x = 400;
  engine.getActiveProjectiles()[0].y = 305;
  step.call(engine, 1 / 120);
  (Reflect.get(engine, "finalizeActiveShot") as () => void).call(engine);

  engine.fireProjectile(
    shooter.tank.position,
    { angle: 0, power: 50, weaponId: "THERMONUCLEAR" },
    shooter.id,
    { shotId: 2, isFirstShotOfRound: false },
  );
  engine.getActiveProjectiles()[0].x = 300;
  engine.getActiveProjectiles()[0].y = 305;
  step.call(engine, 1 / 120);
  (Reflect.get(engine, "finalizeActiveShot") as () => void).call(engine);

  engine.triggerRoundCelebration(shooter);
}

describe("GameEngine VFX integration", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.spyOn(Date, "now").mockReturnValue(0);
    vi.spyOn(CombatAudio.prototype, "playVictoryFanfare").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("enforces the exact clear matrix across all round and match transitions", () => {
    const rng = random.createSeededRNG(13);
    vi.spyOn(random, "secureRandom").mockImplementation(() => rng.next());

    const engine = new GameEngine(800, 480);
    const { live1 } = setupFlatPlayers(engine);

    const clearFireworks = vi.spyOn(CelebrationFireworks.prototype, "clear");
    const clearExplosions = vi.spyOn(ImpactExplosions.prototype, "clear");
    const clearTerrain = vi.spyOn(TerrainImpactParticles.prototype, "clear");

    // 1. enterInterRoundPhase clears ONLY terrainImpactParticles (keeps celebration fireworks + impactExplosions)
    triggerAllThreeVfx(engine, live1.id);
    clearFireworks.mockClear();
    clearExplosions.mockClear();
    clearTerrain.mockClear();
    engine.enterInterRoundPhase();
    expect(clearTerrain).toHaveBeenCalledOnce();
    expect(clearFireworks).not.toHaveBeenCalled();
    expect(clearExplosions).not.toHaveBeenCalled();
    expect(engine.getTerrainImpactParticles()).toHaveLength(0);
    expect(engine.getImpactExplosions()).toHaveLength(42);

    // 2. clearRoundCelebration clears all 3
    clearFireworks.mockClear();
    clearExplosions.mockClear();
    clearTerrain.mockClear();
    engine.clearRoundCelebration();
    expect(clearFireworks).toHaveBeenCalledOnce();
    expect(clearExplosions).toHaveBeenCalledOnce();
    expect(clearTerrain).toHaveBeenCalledOnce();
    expect(engine.getImpactExplosions()).toHaveLength(0);
    expect(engine.getTerrainImpactParticles()).toHaveLength(0);

    // 3. startNextRound clears all 3
    engine.getTurnManager().resumeForCombat();
    triggerAllThreeVfx(engine, live1.id);
    clearFireworks.mockClear();
    clearExplosions.mockClear();
    clearTerrain.mockClear();
    expect(engine.startNextRound()).toBe(true);
    expect(clearFireworks).toHaveBeenCalledOnce();
    expect(clearExplosions).toHaveBeenCalledOnce();
    expect(clearTerrain).toHaveBeenCalledOnce();
    expect(engine.getImpactExplosions()).toHaveLength(0);
    expect(engine.getTerrainImpactParticles()).toHaveLength(0);

    // 4. reconstructCombat clears all 3 (via clearRoundCelebration)
    triggerAllThreeVfx(engine, live1.id);
    clearFireworks.mockClear();
    clearExplosions.mockClear();
    clearTerrain.mockClear();
    engine.reconstructCombat(makeRoundMap(), [live1, engine.getTankManager().getPlayerById("p2")!]);
    expect(clearFireworks).toHaveBeenCalledOnce();
    expect(clearExplosions).toHaveBeenCalledOnce();
    expect(clearTerrain).toHaveBeenCalledOnce();
    expect(engine.getImpactExplosions()).toHaveLength(0);
    expect(engine.getTerrainImpactParticles()).toHaveLength(0);

    // 5. resetGame clears all 3
    triggerAllThreeVfx(engine, live1.id);
    clearFireworks.mockClear();
    clearExplosions.mockClear();
    clearTerrain.mockClear();
    engine.resetGame();
    expect(clearFireworks).toHaveBeenCalledOnce();
    expect(clearExplosions).toHaveBeenCalledOnce();
    expect(clearTerrain).toHaveBeenCalledOnce();
    expect(engine.getImpactExplosions()).toHaveLength(0);
    expect(engine.getTerrainImpactParticles()).toHaveLength(0);
  });

  it("draws VFX in strict render order (fireworks -> zeusFlash -> impactExplosions -> terrainImpactParticles) and skips when inactive", () => {
    const engine = new GameEngine(800, 480);
    const { live1 } = setupFlatPlayers(engine);

    vi.spyOn(engine.getTerrain(), "draw").mockImplementation(() => {});
    vi.spyOn(engine.getPhysicsEngine(), "draw").mockImplementation(() => {});
    vi.spyOn(engine.getTankManager(), "draw").mockImplementation(() => {});

    const order: string[] = [];
    const drawFireworks = vi
      .spyOn(CelebrationFireworks.prototype, "draw")
      .mockImplementation(() => {
        order.push("fireworks");
      });
    const drawExplosions = vi
      .spyOn(ImpactExplosions.prototype, "draw")
      .mockImplementation(() => {
        order.push("impactExplosions");
      });
    const drawTerrain = vi
      .spyOn(TerrainImpactParticles.prototype, "drawAndAdvance")
      .mockImplementation(() => {
        order.push("terrainImpactParticles");
      });

    // When all 3 are empty/inactive, none of their draw methods are invoked
    const recorder = createRecordingCanvasContext();
    engine.render(recorder.ctx);
    expect(drawFireworks).not.toHaveBeenCalled();
    expect(drawExplosions).not.toHaveBeenCalled();
    expect(drawTerrain).not.toHaveBeenCalled();

    // Activate all 3 VFX + Zeus flash via public API
    vi.spyOn(CombatAudio.prototype, "playZeusStrike").mockImplementation(() => {});
    triggerAllThreeVfx(engine, live1.id);
    expect(
      engine.applyRemoteZeusStrikeResult({
        strikeId: 1,
        zeusId: live1.id,
        targetId: "p2",
        award: { playerId: live1.id, amount: 0 },
        balances: [],
        roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
      }),
    ).toBe(true);

    const wrappedCtx = new Proxy(recorder.ctx, {
      get(target, prop, receiver) {
        if (prop === "fillRect") {
          return (x: number, y: number, w: number, h: number) => {
            if (target.fillStyle === VGA_PALETTE.WHITE && w === 800 && h === 480) {
              order.push("zeusFlash");
            }
            target.fillRect(x, y, w, h);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    order.length = 0;
    engine.render(wrappedCtx);
    expect(order).toEqual([
      "fireworks",
      "zeusFlash",
      "impactExplosions",
      "terrainImpactParticles",
    ]);
  });

  it("overrides winner cannon angle during tankManager.draw and restores it even if draw throws", () => {
    const engine = new GameEngine(800, 480);
    const { live1 } = setupFlatPlayers(engine);
    live1.tank.angle = 33;

    vi.spyOn(engine.getTerrain(), "draw").mockImplementation(() => {});
    vi.spyOn(engine.getPhysicsEngine(), "draw").mockImplementation(() => {});
    const drawSpy = vi.spyOn(engine.getTankManager(), "draw").mockImplementation(() => {
      expect(live1.tank.angle).toBe(78.5);
      throw new Error("draw failure");
    });

    engine.triggerRoundCelebration(live1);
    const recorder = createRecordingCanvasContext();
    expect(() => engine.render(recorder.ctx)).toThrow("draw failure");
    expect(drawSpy).toHaveBeenCalledOnce();
    expect(live1.tank.angle).toBe(33);
  });

  it("gates terrainImpactParticles on !headless, BULLDOZER, and THERMONUCLEAR while keeping THERMONUCLEAR RNG in headless", () => {
    const step = (eng: GameEngine) =>
      (Reflect.get(eng, "update") as (dt: number) => void).call(eng, 1 / 120);

    // headless: no terrain particles, but THERMONUCLEAR still populates impactExplosions
    const headless = new GameEngine(800, 480, { headless: true });
    const { live1: h1 } = setupFlatPlayers(headless);
    h1.inventory.THERMONUCLEAR = 1;
    headless.fireProjectile(
      h1.tank.position,
      { angle: 0, power: 50, weaponId: "MISSILE" },
      h1.id,
      { shotId: 1, isFirstShotOfRound: true },
    );
    headless.getActiveProjectiles()[0].x = 400;
    headless.getActiveProjectiles()[0].y = 300;
    step(headless);
    expect(headless.getTerrainImpactParticles()).toHaveLength(0);

    (Reflect.get(headless, "finalizeActiveShot") as () => void).call(headless);
    headless.fireProjectile(
      h1.tank.position,
      { angle: 0, power: 50, weaponId: "THERMONUCLEAR" },
      h1.id,
      { shotId: 2, isFirstShotOfRound: false },
    );
    headless.getActiveProjectiles()[0].x = 520;
    headless.getActiveProjectiles()[0].y = 305;
    step(headless);
    expect(headless.getImpactExplosions()).toHaveLength(42);
    expect(headless.getTerrainImpactParticles()).toHaveLength(0);

    // DRILLER spawns terrain particles when not headless; BULLDOZER does not
    const drillerEng = new GameEngine(800, 480);
    const { live1: d1 } = setupFlatPlayers(drillerEng);
    d1.inventory.DRILLER = 1;
    drillerEng.fireProjectile(
      d1.tank.position,
      { angle: 0, power: 50, weaponId: "DRILLER" },
      d1.id,
      { shotId: 1, isFirstShotOfRound: true },
    );
    drillerEng.getActiveProjectiles()[0].x = 400;
    drillerEng.getActiveProjectiles()[0].y = 300;
    step(drillerEng);
    expect(drillerEng.getTerrainImpactParticles().length).toBeGreaterThan(0);

    const bullEng = new GameEngine(800, 480);
    const { live1: b1 } = setupFlatPlayers(bullEng);
    b1.inventory.BULLDOZER = 1;
    bullEng.fireProjectile(
      b1.tank.position,
      { angle: 0, power: 50, weaponId: "BULLDOZER" },
      b1.id,
      { shotId: 1, isFirstShotOfRound: true },
    );
    bullEng.getActiveProjectiles()[0].x = 400;
    bullEng.getActiveProjectiles()[0].y = 300;
    step(bullEng);
    expect(bullEng.getTerrainImpactParticles()).toHaveLength(0);
  });

  it("triggers playVictoryFanfare and wires onBurst to audio.playFireworkPop(x) on round and match celebrations", () => {
    const fanfareSpy = vi.mocked(CombatAudio.prototype.playVictoryFanfare);
    const popSpy = vi.spyOn(CombatAudio.prototype, "playFireworkPop").mockImplementation(() => {});
    const burstDrawTarget = 0.5;
    let returnVal = burstDrawTarget;
    vi.spyOn(random, "secureRandom").mockImplementation(() => returnVal);

    const engine = new GameEngine(800, 480);
    const { live1 } = setupFlatPlayers(engine);
    const step = Reflect.get(engine, "update") as (dt: number) => void;

    fanfareSpy.mockClear();
    engine.triggerRoundCelebration(live1);
    expect(fanfareSpy).toHaveBeenCalledOnce();

    returnVal = 0.99;
    for (let i = 0; i < 110; i++) {
      step.call(engine, 1 / 120);
    }
    expect(popSpy).toHaveBeenCalled();

    // Match winner path also plays victory fanfare and emits firework pops
    engine.startNextRound();
    fanfareSpy.mockClear();
    popSpy.mockClear();
    returnVal = 0.5;
    engine.declareMatchWinner(live1);
    expect(fanfareSpy).toHaveBeenCalledOnce();

    returnVal = 0.99;
    for (let i = 0; i < 110; i++) {
      step.call(engine, 1 / 120);
    }
    expect(popSpy).toHaveBeenCalled();
  });
});
