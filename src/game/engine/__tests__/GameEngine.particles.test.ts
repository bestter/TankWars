import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameEngine } from '../GameEngine';
import * as random from '../../../utils/random';
import { makePlayer, makeTank } from '../../__tests__/helpers';
import { TERRAIN_MATERIAL } from '../../../types/terrain';
import { VGA_PALETTE, type GameState } from '../../../types/game';
import { resolvePhysicalShot } from '../../entities/ai/physicalShotForecast';
import { calculateShotAdvice } from '../../entities/ai/shotAdvisor';

function makeCanvasCtx(): CanvasRenderingContext2D {
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    drawImage: vi.fn(),
    setLineDash: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
  } as unknown as CanvasRenderingContext2D;
}

describe('GameEngine terrain impact particles & #184 multi-Hz / forecast parity', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function setupTwoPlayers(engine: GameEngine, material: 'DIRT' | 'SOFT' | 'ROCK') {
    const p1 = makePlayer({ id: 'p1', name: 'P1', tank: makeTank('t1', 40, 120) });
    const p2 = makePlayer({ id: 'p2', name: 'P2', tank: makeTank('t2', 160, 120) });
    engine.setPlayers([p1, p2]);
    const terrain = engine.getTerrain();
    terrain.loadHeights(new Array(200).fill(120), new Array(200).fill(material));
    const live1 = engine.getTankManager().getPlayerById('p1')!;
    const live2 = engine.getTankManager().getPlayerById('p2')!;
    live1.tank.position = { x: 40, y: 120 };
    live2.tank.position = { x: 160, y: 120 };
    return { live1, live2, terrain };
  }

  it('spawns exact material-specific VGA particles without calling secureRandom or Math.random', () => {
    // 1. DIRT -> 8 dust, maxLife 16, BROWN or GREEN
    const dirtEngine = new GameEngine(200, 200);
    const { live1: d1 } = setupTwoPlayers(dirtEngine, TERRAIN_MATERIAL.DIRT);
    const rngSpy = vi.spyOn(random, 'secureRandom');
    const mathSpy = vi.spyOn(Math, 'random');

    dirtEngine.fireProjectile(d1.tank.position, { angle: 0, power: 50, weaponId: 'MISSILE' }, d1.id, {
      shotId: 1,
      isFirstShotOfRound: true,
    });
    rngSpy.mockClear();
    mathSpy.mockClear();

    const dirtProj = dirtEngine.getActiveProjectiles()[0];
    dirtProj.x = 100;
    dirtProj.y = 120;
    const step = Reflect.get(dirtEngine, 'update') as (dt: number) => void;
    step.call(dirtEngine, 1 / 120);

    expect(rngSpy).not.toHaveBeenCalled();
    expect(mathSpy).not.toHaveBeenCalled();
    const dirtParticles = dirtEngine.getTerrainImpactParticles();
    expect(dirtParticles).toHaveLength(8);
    for (const pt of dirtParticles) {
      expect(pt.kind).toBe('dust');
      expect(pt.life).toBe(16);
      expect(pt.maxLife).toBe(16);
      expect([1, 2]).toContain(pt.size);
      expect([VGA_PALETTE.BROWN, VGA_PALETTE.GREEN]).toContain(pt.color);
    }

    // 2. SOFT -> 12 dust + 6 grains = 18, maxLife 24, YELLOW or BROWN
    const softEngine = new GameEngine(200, 200);
    const { live1: s1 } = setupTwoPlayers(softEngine, TERRAIN_MATERIAL.SOFT);
    softEngine.fireProjectile(s1.tank.position, { angle: 0, power: 50, weaponId: 'MISSILE' }, s1.id, {
      shotId: 1,
      isFirstShotOfRound: true,
    });
    const softProj = softEngine.getActiveProjectiles()[0];
    softProj.x = 100;
    softProj.y = 120;
    const softStep = Reflect.get(softEngine, 'update') as (dt: number) => void;
    softStep.call(softEngine, 1 / 120);

    const softParticles = softEngine.getTerrainImpactParticles();
    expect(softParticles).toHaveLength(18);
    expect(softParticles.filter((pt) => pt.kind === 'dust')).toHaveLength(12);
    expect(softParticles.filter((pt) => pt.kind === 'grain')).toHaveLength(6);
    for (const pt of softParticles) {
      expect(pt.life).toBe(24);
      expect(pt.maxLife).toBe(24);
      expect([1, 2]).toContain(pt.size);
      expect([VGA_PALETTE.YELLOW, VGA_PALETTE.BROWN]).toContain(pt.color);
    }

    // 3. ROCK -> 6 shards, maxLife 12, DARK_GRAY or GRAY
    const rockEngine = new GameEngine(200, 200);
    const { live1: r1 } = setupTwoPlayers(rockEngine, TERRAIN_MATERIAL.ROCK);
    rockEngine.fireProjectile(r1.tank.position, { angle: 0, power: 50, weaponId: 'MISSILE' }, r1.id, {
      shotId: 1,
      isFirstShotOfRound: true,
    });
    const rockProj = rockEngine.getActiveProjectiles()[0];
    rockProj.x = 100;
    rockProj.y = 120;
    const rockStep = Reflect.get(rockEngine, 'update') as (dt: number) => void;
    rockStep.call(rockEngine, 1 / 120);

    const rockParticles = rockEngine.getTerrainImpactParticles();
    expect(rockParticles).toHaveLength(6);
    for (const pt of rockParticles) {
      expect(pt.kind).toBe('shard');
      expect(pt.life).toBe(12);
      expect(pt.maxLife).toBe(12);
      expect([1, 2]).toContain(pt.size);
      expect([VGA_PALETTE.DARK_GRAY, VGA_PALETTE.GRAY]).toContain(pt.color);
    }
  });

  it('excludes BULLDOZER, THERMONUCLEAR, and headless mode from terrainImpactParticles', () => {
    // 1. BULLDOZER -> 0 terrainImpactParticles
    const bullEngine = new GameEngine(200, 200);
    const { live1: b1 } = setupTwoPlayers(bullEngine, TERRAIN_MATERIAL.DIRT);
    b1.inventory.BULLDOZER = 1;
    bullEngine.fireProjectile(b1.tank.position, { angle: 0, power: 50, weaponId: 'BULLDOZER' }, b1.id, {
      shotId: 1,
      isFirstShotOfRound: true,
    });
    const bullProj = bullEngine.getActiveProjectiles()[0];
    bullProj.x = 100;
    bullProj.y = 120;
    (Reflect.get(bullEngine, 'update') as (dt: number) => void).call(bullEngine, 1 / 120);
    expect(bullEngine.getTerrainImpactParticles()).toHaveLength(0);

    // 2. THERMONUCLEAR -> 42 impactExplosions + flash, 0 terrainImpactParticles
    const thermoEngine = new GameEngine(200, 200);
    const { live1: t1 } = setupTwoPlayers(thermoEngine, TERRAIN_MATERIAL.SOFT);
    t1.inventory.THERMONUCLEAR = 1;
    thermoEngine.fireProjectile(t1.tank.position, { angle: 0, power: 50, weaponId: 'THERMONUCLEAR' }, t1.id, {
      shotId: 1,
      isFirstShotOfRound: true,
    });
    const thermoProj = thermoEngine.getActiveProjectiles()[0];
    thermoProj.x = 100;
    thermoProj.y = 120;
    (Reflect.get(thermoEngine, 'update') as (dt: number) => void).call(thermoEngine, 1 / 120);
    expect(thermoEngine.getImpactExplosions()).toHaveLength(42);
    expect(thermoEngine.getTerrainImpactParticles()).toHaveLength(0);

    // 3. Headless -> 0 terrainImpactParticles
    const headlessEngine = new GameEngine(200, 200, { headless: true });
    const { live1: h1 } = setupTwoPlayers(headlessEngine, TERRAIN_MATERIAL.SOFT);
    headlessEngine.fireProjectile(h1.tank.position, { angle: 0, power: 50, weaponId: 'MISSILE' }, h1.id, {
      shotId: 1,
      isFirstShotOfRound: true,
    });
    const headProj = headlessEngine.getActiveProjectiles()[0];
    headProj.x = 100;
    headProj.y = 120;
    (Reflect.get(headlessEngine, 'update') as (dt: number) => void).call(headlessEngine, 1 / 120);
    expect(headlessEngine.getTerrainImpactParticles()).toHaveLength(0);
  });

  it.each([1, 13, 42])('advances particles in render(ctx) and clears them across all round lifecycle transitions (seed %i)', (seed) => {
    // Seed 13 reproduced a missed impact after setPlayers regenerated the map.
    const rng = random.createSeededRNG(seed);
    vi.spyOn(random, 'secureRandom').mockImplementation(() => rng.next());
    const engine = new GameEngine(800, 480);
    const p1 = makePlayer({ id: 'p1', name: 'P1', tank: makeTank('t1', 150, 300) });
    const p2 = makePlayer({ id: 'p2', name: 'P2', tank: makeTank('t2', 650, 300) });
    engine.setPlayers([p1, p2]);

    const ctx = makeCanvasCtx();
    const step = Reflect.get(engine, 'update') as (dt: number) => void;
    const render = Reflect.get(engine, 'render') as (ctx: CanvasRenderingContext2D) => void;

    let shotCounter = 0;
    const triggerHit = () => {
      // Round setup randomizes terrain and spawns. Restore a safe contact before
      // every hit so lifecycle assertions cannot depend on lava or nearby tanks.
      engine.getTerrain().loadHeights(new Array(800).fill(300), new Array(800).fill(TERRAIN_MATERIAL.SOFT));
      engine.getTankManager().getPlayerById('p1')!.tank.position = { x: 150, y: 300 };
      engine.getTankManager().getPlayerById('p2')!.tank.position = { x: 650, y: 300 };
      const shooter = engine.getTankManager().getPlayerById('p1')!;
      engine.fireProjectile(shooter.tank.position, { angle: 0, power: 50, weaponId: 'MISSILE' }, shooter.id, {
        shotId: ++shotCounter,
        isFirstShotOfRound: true,
      });
      const proj = engine.getActiveProjectiles()[0];
      proj.x = 400;
      proj.y = engine.getTerrain().getHeightAt(400) + 5;
      step.call(engine, 1 / 120);
      const finalize = Reflect.get(engine, 'finalizeActiveShot') as () => void;
      finalize.call(engine);
    };

    triggerHit();
    expect(engine.getTerrainImpactParticles()).toHaveLength(18);
    const grainBeforeVy = engine.getTerrainImpactParticles().find((pt) => pt.kind === 'grain')!.vy;
    render.call(engine, ctx);
    const grainAfter = engine.getTerrainImpactParticles().find((pt) => pt.kind === 'grain')!;
    expect(grainAfter.life).toBe(23);
    expect(grainAfter.vy).toBeCloseTo(grainBeforeVy + 0.24, 9);

    // Clear on clearRoundCelebration
    engine.clearRoundCelebration();
    expect(engine.getTerrainImpactParticles()).toHaveLength(0);

    // Clear on enterInterRoundPhase
    triggerHit();
    expect(engine.getTerrainImpactParticles().length).toBeGreaterThan(0);
    engine.enterInterRoundPhase();
    expect(engine.getTerrainImpactParticles()).toHaveLength(0);

    // Clear on startNextRound
    engine.setPlayers([p1, p2]);
    engine.getTurnManager().resumeForCombat();
    triggerHit();
    expect(engine.getTerrainImpactParticles().length).toBeGreaterThan(0);
    engine.startNextRound(undefined, [p1, p2]);
    expect(engine.getTerrainImpactParticles()).toHaveLength(0);

    // Clear on resetGame
    triggerHit();
    expect(engine.getTerrainImpactParticles().length).toBeGreaterThan(0);
    engine.resetGame([p1, p2]);
    expect(engine.getTerrainImpactParticles()).toHaveLength(0);
  });

  it('maintains strict multi-Hz simulation invariance (0 render vs 60 Hz vs 120 Hz) and forecast/advisor parity', () => {
    const initialHeights = Array.from({ length: 400 }, (_, x) => 220 + Math.round(10 * Math.sin(x / 25)));
    const initialMaterials = Array.from({ length: 400 }, (_, x) =>
      x < 140 ? TERRAIN_MATERIAL.DIRT : x < 280 ? TERRAIN_MATERIAL.SOFT : TERRAIN_MATERIAL.ROCK,
    );

    const runEngineAtCadence = (renderEverySteps: number) => {
      const eng = new GameEngine(400, 300);
      eng.setLocalMatch(true);
      const p1 = makePlayer({ id: 'p1', isHuman: true, tank: makeTank('t1', 80, initialHeights[80]) });
      const p2 = makePlayer({ id: 'p2', isHuman: false, tank: makeTank('t2', 220, initialHeights[220]) });
      eng.setPlayers([p1, p2]);
      eng.getTerrain().loadHeights([...initialHeights], [...initialMaterials]);
      const l1 = eng.getTankManager().getPlayerById('p1')!;
      const l2 = eng.getTankManager().getPlayerById('p2')!;
      l1.tank.position = { x: 80, y: initialHeights[80] };
      l2.tank.position = { x: 220, y: initialHeights[220] };
      Reflect.set(eng, 'windForce', 15);
      eng.getTurnManager().setEnvironment(15, 260);

      eng.fireProjectile(l1.tank.position, { angle: 48, power: 62, weaponId: 'MISSILE' }, l1.id, {
        shotId: 1,
        isFirstShotOfRound: true,
      });

      const step = Reflect.get(eng, 'update') as (dt: number) => void;
      const render = Reflect.get(eng, 'render') as (ctx: CanvasRenderingContext2D) => void;
      const ctx = makeCanvasCtx();

      for (let i = 1; i <= 360; i++) {
        step.call(eng, 1 / 120);
        if (renderEverySteps > 0 && i % renderEverySteps === 0) {
          render.call(eng, ctx);
        }
        if (eng.getActiveProjectiles().length === 0 && !eng.getTankManager().anyTankIsFalling()) {
          break;
        }
      }

      return {
        heights: [...eng.getTerrain().getHeightmap()],
        materials: [...eng.getTerrain().getMaterials()],
        supportAfter: [eng.getTerrain().getHeightAt(80), eng.getTerrain().getHeightAt(220)],
        tanks: eng.getTankManager().getPlayers().map((pl) => ({
          id: pl.id,
          x: pl.tank.position.x,
          y: pl.tank.position.y,
          health: pl.tank.health,
          shield: pl.tank.shield,
        })),
        earnings: eng.getRoundEarningsByPlayer(),
      };
    };

    const run0Hz = runEngineAtCadence(0);
    const run60Hz = runEngineAtCadence(2);
    const run120Hz = runEngineAtCadence(1);

    expect(run60Hz).toEqual(run0Hz);
    expect(run120Hz).toEqual(run0Hz);

    // Verify resolvePhysicalShot & calculateShotAdvice parity on the same terrain
    const forecastTerrain = new GameEngine(400, 300).getTerrain();
    forecastTerrain.loadHeights([...initialHeights], [...initialMaterials]);
    const fp1 = makePlayer({ id: 'p1', isHuman: true, tank: makeTank('t1', 80, initialHeights[80]) });
    const fp2 = makePlayer({ id: 'p2', isHuman: false, tank: makeTank('t2', 220, initialHeights[220]) });
    const state: GameState = {
      phase: 'COMBAT',
      players: [fp1, fp2],
      currentPlayerIndex: 0,
      turn: 1,
      roundNumber: 1,
      windForce: 15,
      gravity: 260,
      localShotContext: { playerCountAtMatchStart: 2, isFirstShotOfRound: true },
    };
    const resolved = resolvePhysicalShot(
      state,
      forecastTerrain,
      fp1,
      'MISSILE',
      { angle: 48, power: 62 },
      { localMatch: true },
    );
    expect(resolved.complete).toBe(true);
    expect(resolved.support.map((s) => s.after)).toEqual(run0Hz.supportAfter);

    const advice = calculateShotAdvice(
      {
        state,
        width: 400,
        height: 300,
        heights: [...initialHeights],
        materials: [...initialMaterials],
      },
      'OPTIMISER_PROFIT',
    );
    expect(advice).not.toBeNull();
  });
});
