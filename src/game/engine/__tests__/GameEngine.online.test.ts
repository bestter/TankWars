import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GameEngine, type ResolvedShotPreview } from '../GameEngine';
import * as random from '../../../utils/random';
import { makePlayer, makeTank } from '../../__tests__/helpers';
import { TERRAIN_MATERIAL, type TerrainMaterial } from '../../../types/terrain';
import type { WeaponId } from '../../../types/weapon';

describe('GameEngine online multiplayer', () => {
  let engine: GameEngine;

  beforeEach(() => {
    vi.spyOn(random, 'secureRandom').mockReturnValue(0.5);
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    engine = new GameEngine(200, 200);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function twoPlayerSetup(): { host: ReturnType<typeof makePlayer>; guest: ReturnType<typeof makePlayer> } {
    const host = makePlayer({
      id: 'player-1',
      name: 'Host',
      tank: makeTank('tank-1', 40, 120),
    });
    const guest = makePlayer({
      id: 'player-2',
      name: 'Guest',
      tank: makeTank('tank-2', 140, 120),
    });
    engine.setPlayers([host, guest]);
    return { host, guest };
  }

  it('isRoundCombatActive is true after setPlayers and false after enterInterRoundPhase', () => {
    twoPlayerSetup();
    expect(engine.isRoundCombatActive()).toBe(true);

    engine.enterInterRoundPhase();
    expect(engine.isRoundCombatActive()).toBe(false);
  });

  it('syncRoundEndFromRemote ends combat and emits onRoundEnded with winner', () => {
    const { host, guest } = twoPlayerSetup();
    const deadGuest = {
      ...guest,
      tank: { ...guest.tank, health: 0, isDead: true },
    };

    const onRoundEnded = vi.fn();
    engine.onRoundEnded = onRoundEnded;

    engine.syncRoundEndFromRemote([host, deadGuest], 'player-1', false);

    expect(engine.isRoundCombatActive()).toBe(false);
    expect(onRoundEnded).toHaveBeenCalledTimes(1);
    expect(onRoundEnded.mock.calls[0][0]).toMatchObject({
      isDraw: false,
      roundWinner: expect.objectContaining({ id: 'player-1' }),
      survivors: expect.arrayContaining([expect.objectContaining({ id: 'player-1' })]),
    });
  });

  it('syncRoundEndFromRemote supports draw payload', () => {
    twoPlayerSetup();
    const onRoundEnded = vi.fn();
    engine.onRoundEnded = onRoundEnded;

    engine.syncRoundEndFromRemote([], null, true);

    expect(engine.isRoundCombatActive()).toBe(false);
    expect(onRoundEnded.mock.calls[0][0]).toMatchObject({
      isDraw: true,
      roundWinner: null,
      survivors: [],
    });
  });

  it('syncRoundEndFromRemote is a no-op when combat round already ended', () => {
    twoPlayerSetup();
    const onRoundEnded = vi.fn();
    engine.onRoundEnded = onRoundEnded;

    engine.enterInterRoundPhase();
    onRoundEnded.mockClear();

    engine.syncRoundEndFromRemote([], 'player-1', false);

    expect(onRoundEnded).not.toHaveBeenCalled();
    expect(engine.isRoundCombatActive()).toBe(false);
  });

  it('applies an authoritative Zeus result once without collateral or terrain changes', () => {
    const zeus = makePlayer({
      id: 'zeus',
      money: 250,
      tank: makeTank('tank-zeus', 30, 120),
    });
    const target = makePlayer({
      id: 'target',
      money: 250,
      tank: makeTank('tank-target', 100, 120, { health: 100, shield: 40, maxShield: 40 }),
    });
    const bystander = makePlayer({
      id: 'bystander',
      money: 250,
      tank: makeTank('tank-bystander', 110, 120, { health: 100, shield: 40, maxShield: 40 }),
    });
    engine.getTankManager().setPlayers([zeus, target, bystander]);
    const terrainBefore = [25, 100, 175].map((x) => engine.getTerrain().getHeightAt(x));
    const applied = vi.fn();
    engine.onZeusStrikeApplied = applied;
    const result = {
      strikeId: 1,
      zeusId: zeus.id,
      targetId: target.id,
      award: { playerId: zeus.id, amount: 88 },
      balances: [
        { playerId: zeus.id, money: 338 },
        { playerId: target.id, money: 250 },
        { playerId: bystander.id, money: 250 },
      ],
      roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
    };

    expect(engine.applyRemoteZeusStrikeResult(result)).toBe(true);
    expect(engine.applyRemoteZeusStrikeResult(result)).toBe(false);
    expect(target.tank).toMatchObject({ health: 0, shield: 0, isDead: true });
    expect(bystander.tank).toMatchObject({ health: 100, shield: 40, isDead: false });
    expect(zeus.money).toBe(338);
    expect(engine.getRoundEarningsByPlayer()[zeus.id]).toBe(88);
    expect([25, 100, 175].map((x) => engine.getTerrain().getHeightAt(x))).toEqual(terrainBefore);
    expect(applied).toHaveBeenCalledOnce();
  });

  function fireAtPointAndSettle(
    targetEngine: GameEngine,
    shooterId: string,
    weaponId: WeaponId,
    impactX: number,
    impactY: number,
    shotId = 1,
    maxSteps = 120 * 20,
  ): void {
    const shooter = targetEngine.getTankManager().getPlayerById(shooterId)!;
    shooter.inventory[weaponId] = Math.max(1, shooter.inventory[weaponId] ?? 0);
    targetEngine.setLocalPlayerId(shooterId);
    const tm = targetEngine.getTurnManager();
    let settled = false;
    tm.onAuthoritativeShotSettled = () => {
      settled = true;
    };
    tm.executeRemoteFire(
      { angle: 45, power: 50, weaponId },
      {
        ownerId: shooterId,
        mode: 'LIVE_LOCAL',
        identity: { shotId, isFirstShotOfRound: shotId === 1, physicsSeed: 1 },
      },
    );
    expect(targetEngine.getActiveProjectiles()).toHaveLength(1);
    const projectile = targetEngine.getActiveProjectiles()[0];
    projectile.x = impactX;
    projectile.y = impactY;
    projectile.vx = 0;
    projectile.vy = weaponId === 'DRILLER' ? 12 : 4;

    const stepSimulation = Reflect.get(targetEngine, 'update') as (dt: number) => void;
    for (let step = 0; step < maxSteps && !settled; step++) {
      stepSimulation.call(targetEngine, 1 / 120);
    }
    expect(settled).toBe(true);
  }

  it.each(['NUKE', 'THERMONUCLEAR'] as const)(
    'carves ROCK in online matches with strict local parity for %s',
    (weaponId) => {
      const runScenario = (isLocal: boolean) => {
        const sim = new GameEngine(800, 480);
        sim.setLocalMatch(isLocal);
        const p1 = makePlayer({ id: 'p1', money: 500, tank: makeTank('t1', 120, 240, { shield: 40, maxShield: 40 }) });
        const p2 = makePlayer({ id: 'p2', money: 500, tank: makeTank('t2', 400, 240, { shield: 40, maxShield: 40 }) });
        const p3 = makePlayer({ id: 'p3', money: 500, tank: makeTank('t3', 450, 240, { shield: 40, maxShield: 40 }) });
        sim.setPlayers([p1, p2, p3]);
        sim.getTerrain().loadHeights(new Array<number>(800).fill(240), new Array<TerrainMaterial>(800).fill(TERRAIN_MATERIAL.ROCK));
        for (const p of sim.getTankManager().getPlayers()) {
          p.tank.position.y = 240;
        }
        const resolvedPreviews: ResolvedShotPreview[] = [];
        sim.onShotResolved = (preview) => {
          resolvedPreviews.push(preview);
        };
        fireAtPointAndSettle(sim, 'p1', weaponId, 400, 239.5, 1);
        return {
          heights: [...sim.getTerrain().getHeightmap()],
          materials: [...sim.getTerrain().getMaterials()],
          players: sim.getTankManager().getPlayers().map((p) => ({
            id: p.id,
            x: p.tank.position.x,
            y: p.tank.position.y,
            health: p.tank.health,
            shield: p.tank.shield,
            isDead: p.tank.isDead,
          })),
          resolved: resolvedPreviews.at(-1) ?? null,
        };
      };

      const online = runScenario(false);
      const local = runScenario(true);
      const radius = weaponId === 'NUKE' ? 62 : 160;

      expect(online).toEqual(local);
      expect(online.heights[400]).toBeGreaterThan(240);
      expect(online.heights[400 - radius - 1]).toBe(240);
      expect(online.heights[400 + radius + 1]).toBe(240);
      expect(online.materials.every((m) => m === TERRAIN_MATERIAL.ROCK)).toBe(true);
      expect(online.resolved).not.toBeNull();
    },
  );

  it.each(['NUKE', 'THERMONUCLEAR'] as const)(
    'lets %s blast cross a breached narrow ROCK wall while remaining ROCK protects shielded targets in online mode',
    (weaponId) => {
      const sim = new GameEngine(800, 480);
      sim.setLocalMatch(false);
      const heights = new Array<number>(800).fill(260);
      const materials = new Array<TerrainMaterial>(800).fill(TERRAIN_MATERIAL.DIRT);

      // Narrow tall ROCK wall inside crater radius: breached by impact at (400, 260)
      for (let x = 418; x <= 422; x++) {
        heights[x] = 220;
        materials[x] = TERRAIN_MATERIAL.ROCK;
      }

      // Exposed target behind the narrow wall (inside 62 px NUKE and 75 px THERMO kill zone)
      const exposedX = 450;
      const exposedY = 260;

      // Shielded target in a pit on the left, protected by a ROCK column whose carved surface stays above line-of-sight
      const shieldCol = weaponId === 'NUKE' ? 355 : 300;
      const shieldedX = weaponId === 'NUKE' ? 350 : 290;
      const shieldedY = weaponId === 'NUKE' ? 295 : 370;
      heights[shieldCol] = 260;
      materials[shieldCol] = TERRAIN_MATERIAL.ROCK;
      for (let x = shieldedX - 15; x <= shieldedX + 15; x++) {
        if (x < shieldCol) {
          heights[x] = shieldedY;
          materials[x] = TERRAIN_MATERIAL.ROCK;
        }
      }

      const shooter = makePlayer({ id: 'p1', tank: makeTank('t1', 120, 260, { shield: 40, maxShield: 40 }) });
      const exposed = makePlayer({ id: 'p2', tank: makeTank('t2', exposedX, exposedY, { shield: 40, maxShield: 40 }) });
      const shielded = makePlayer({ id: 'p3', tank: makeTank('t3', shieldedX, shieldedY, { shield: 40, maxShield: 40 }) });
      sim.setPlayers([shooter, exposed, shielded]);
      sim.getTerrain().loadHeights(heights, materials);
      sim.getTankManager().getPlayerById('p1')!.tank.position = { x: 120, y: 260 };
      sim.getTankManager().getPlayerById('p2')!.tank.position = { x: exposedX, y: exposedY };
      sim.getTankManager().getPlayerById('p3')!.tank.position = { x: shieldedX, y: shieldedY };

      fireAtPointAndSettle(sim, 'p1', weaponId, 400, 260, 1);

      const liveExposed = sim.getTankManager().getPlayerById('p2')!;
      const liveShielded = sim.getTankManager().getPlayerById('p3')!;

      expect(sim.getTerrain().getHeightAt(420)).toBeGreaterThan(260);
      expect(sim.getTerrain().getMaterialAt(420)).toBe(TERRAIN_MATERIAL.ROCK);
      if (weaponId === 'THERMONUCLEAR') {
        expect(liveExposed.tank.isDead).toBe(true);
      } else {
        expect(liveExposed.tank.shield).toBeLessThan(40);
      }
      expect(liveShielded.tank.health).toBe(100);
      expect(liveShielded.tank.shield).toBe(40);
      expect(liveShielded.tank.isDead).toBe(false);
    },
  );

  it('preserves mixed DIRT/SOFT/ROCK transitions, outer-ROCK halo occlusion, and repeated nuclear shots online', () => {
    const sim = new GameEngine(800, 480);
    sim.setLocalMatch(false);
    const heights = new Array<number>(800).fill(260);
    const materials = new Array<TerrainMaterial>(800).fill(TERRAIN_MATERIAL.DIRT);
    for (let x = 390; x <= 415; x++) materials[x] = TERRAIN_MATERIAL.ROCK;
    for (let x = 416; x <= 560; x++) materials[x] = TERRAIN_MATERIAL.SOFT;
    // Outer ROCK pillar strictly outside NUKE radius (dx = 68 > 62) blocks SOFT halo beyond it
    materials[468] = TERRAIN_MATERIAL.ROCK;

    const p1 = makePlayer({ id: 'p1', tank: makeTank('t1', 120, 260) });
    const p2 = makePlayer({ id: 'p2', tank: makeTank('t2', 680, 260) });
    sim.setPlayers([p1, p2]);
    sim.getTerrain().loadHeights(heights, materials);
    sim.getTankManager().getPlayerById('p1')!.tank.position = { x: 120, y: 260 };
    sim.getTankManager().getPlayerById('p2')!.tank.position = { x: 680, y: 260 };

    fireAtPointAndSettle(sim, 'p1', 'NUKE', 400, 260, 1);

    const depthAfterFirst = sim.getTerrain().getHeightAt(400);
    expect(depthAfterFirst).toBeGreaterThan(260);
    expect(sim.getTerrain().getMaterialAt(400)).toBe(TERRAIN_MATERIAL.ROCK);
    expect(sim.getTerrain().getHeightAt(467)).toBeGreaterThan(260);
    expect(sim.getTerrain().getHeightAt(468)).toBe(260);
    expect(sim.getTerrain().getHeightAt(469)).toBe(260);

    fireAtPointAndSettle(sim, 'p1', 'NUKE', 400, depthAfterFirst, 2);

    expect(sim.getTerrain().getHeightAt(400)).toBeGreaterThan(depthAfterFirst);
    expect(sim.getTerrain().getMaterialAt(400)).toBe(TERRAIN_MATERIAL.ROCK);
  });

  it('handles crater falls, multi-kills, and no self-damage reward in online mode', () => {
    const sim = new GameEngine(800, 480);
    sim.setLocalMatch(false);
    const heights = new Array<number>(800).fill(400);
    const materials = new Array<TerrainMaterial>(800).fill(TERRAIN_MATERIAL.ROCK);

    // Shooter close enough to take splash + minor fall without hitting lava; victimA dies in kill zone, victimB falls into lava
    const shooter = makePlayer({ id: 'p1', money: 0, tank: makeTank('t1', 540, 400, { shield: 40, maxShield: 40 }) });
    const victimA = makePlayer({ id: 'p2', money: 0, tank: makeTank('t2', 360, 400, { shield: 40, maxShield: 40 }) });
    const victimB = makePlayer({ id: 'p3', money: 0, tank: makeTank('t3', 490, 400, { shield: 40, maxShield: 40 }) });
    sim.setPlayers([shooter, victimA, victimB]);
    sim.getTerrain().loadHeights(heights, materials);
    sim.getTankManager().getPlayerById('p1')!.tank.position = { x: 540, y: 400 };
    sim.getTankManager().getPlayerById('p2')!.tank.position = { x: 360, y: 400 };
    sim.getTankManager().getPlayerById('p3')!.tank.position = { x: 490, y: 400 };

    const resolvedPreviews: ResolvedShotPreview[] = [];
    sim.onShotResolved = (preview) => {
      resolvedPreviews.push(preview);
    };

    fireAtPointAndSettle(sim, 'p1', 'THERMONUCLEAR', 400, 400, 1);

    const liveShooter = sim.getTankManager().getPlayerById('p1')!;
    const liveVictimA = sim.getTankManager().getPlayerById('p2')!;
    const liveVictimB = sim.getTankManager().getPlayerById('p3')!;

    expect(liveShooter.tank.isDead).toBe(false);
    expect(liveShooter.tank.shield).toBeLessThan(40);
    expect(liveVictimA.tank.isDead).toBe(true);
    expect(liveVictimB.tank.isDead).toBe(true);
    expect(resolvedPreviews).toHaveLength(1);
    expect(resolvedPreviews[0]?.roundOutcome).toEqual({
      isRoundEnd: true,
      isDraw: false,
      roundWinnerId: 'p1',
    });

    // Self-damage case: shooter harms only itself -> zero reward
    const selfSim = new GameEngine(800, 480);
    selfSim.setLocalMatch(false);
    const selfP1 = makePlayer({ id: 'p1', tank: makeTank('t1', 400, 400, { shield: 40, maxShield: 40 }) });
    const selfP2 = makePlayer({ id: 'p2', tank: makeTank('t2', 700, 400, { shield: 40, maxShield: 40 }) });
    selfSim.setPlayers([selfP1, selfP2]);
    selfSim.getTerrain().loadHeights([...heights], [...materials]);
    selfSim.getTankManager().getPlayerById('p1')!.tank.position = { x: 400, y: 400 };
    selfSim.getTankManager().getPlayerById('p2')!.tank.position = { x: 700, y: 400 };
    const selfResolvedPreviews: ResolvedShotPreview[] = [];
    selfSim.onShotResolved = (preview) => {
      selfResolvedPreviews.push(preview);
    };
    fireAtPointAndSettle(selfSim, 'p1', 'NUKE', 430, 400, 1);
    expect(selfSim.getTankManager().getPlayerById('p1')!.tank.shield).toBeLessThan(40);
    expect(selfResolvedPreviews).toHaveLength(1);
    expect(selfResolvedPreviews[0]?.awards).toEqual([]);
  });

  it.each(['MISSILE', 'GRENADE', 'CLUSTER', 'BULLET', 'DRILLER', 'BULLDOZER'] as const)(
    'keeps ROCK indestructible for conventional %s in online mode',
    (weaponId) => {
      engine.setLocalMatch(false);
      const { host } = twoPlayerSetup();
      const liveHost = engine.getTankManager().getPlayerById('player-1')!;
      liveHost.inventory[weaponId] = 2;
      const terrain = engine.getTerrain();
      terrain.loadHeights(new Array<number>(200).fill(120), new Array<TerrainMaterial>(200).fill(TERRAIN_MATERIAL.ROCK));
      liveHost.tank.position = { x: 40, y: 120 };
      engine.getTankManager().getPlayerById('player-2')!.tank.position = { x: 160, y: 120 };

      fireAtPointAndSettle(engine, host.id, weaponId, 110, 120, 1, 120 * 10);

      for (let x = 0; x < 200; x++) {
        expect(terrain.getHeightAt(x)).toBe(120);
        expect(terrain.getMaterialAt(x)).toBe(TERRAIN_MATERIAL.ROCK);
      }
    },
  );
});
