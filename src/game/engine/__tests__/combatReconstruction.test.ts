import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine } from "../GameEngine";
import { makePlayer, makeRoundMap, makeTank } from "../../__tests__/helpers";
import { seedFromRoomShot } from "../../../utils/random";
import type { WeaponId } from "../../../types/weapon";
import { PhysicsEngine } from "../PhysicsEngine";
import { TerrainManager } from "../Terrain";
import { createZeusState } from "../../zeus/zeusDomain";
import { TERRAIN_MATERIAL, type TerrainMaterial } from "../../../types/terrain";

describe("deterministic v3 scene reconstruction", () => {
  beforeEach(() => vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  function setup() {
    const engine = new GameEngine(800, 480);
    engine.setLocalMatch(false); engine.setLocalPlayerId("a");
    const players = [makePlayer({ id: "a", tank: makeTank("a", 120, 300) }),
      makePlayer({ id: "b", tank: makeTank("b", 680, 300) })];
    engine.reconstructCombat(makeRoundMap(), players);
    return { engine, players };
  }

  function simulate(engine: GameEngine, weaponId: WeaponId, shotId: number) {
    const tm = engine.getTurnManager();
    tm.executeRemoteFire({ angle: 55, power: 37, weaponId }, { fromSlot: 0, mode: "CATCH_UP",
      identity: { shotId, isFirstShotOfRound: shotId === 1, physicsSeed: seedFromRoomShot("room", 1, shotId) } });
    const update = Reflect.get(engine, "update") as (dt: number) => void;
    let settled = false;
    tm.onAuthoritativeShotSettled = () => { settled = true; };
    for (let step = 0; step < 120 * 60 && !settled; step++) update.call(engine, 1 / 120);
    expect(settled).toBe(true);
    return { map: engine.getCombatMap(1), players: structuredClone(engine.getTankManager().getPlayers()) };
  }

  it("restores one keyboard listener while keeping reconstruction locked", () => {
    const keyboard = new EventTarget();
    vi.stubGlobal("window", keyboard);
    const { engine, players } = setup();
    const tm = engine.getTurnManager();
    const pressRight = () => {
      const event = new Event("keydown", { cancelable: true });
      Object.defineProperty(event, "key", { value: "ArrowRight" });
      keyboard.dispatchEvent(event);
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      engine.reconstructCombat(makeRoundMap(), players);
      const tank = engine.getTankManager().getPlayers()[0].tank;
      const angle = tank.angle;
      pressRight();
      expect(tank.angle).toBe(angle);
      tm.unlockAfterCatchUp();
      pressRight();
      expect(tank.angle).toBe(angle + 1);
    }
    tm.removeInputListeners();
  });

  it.each(["CLUSTER", "GRENADE", "THERMONUCLEAR"] as const)("reconstructs %s impacts and health from the same shot seed", (weapon) => {
    const live = setup(), rebuilt = setup();
    const resolved = vi.fn(); rebuilt.engine.onShotResolved = resolved;
    const first = simulate(live.engine, weapon, 1);
    const second = simulate(rebuilt.engine, weapon, 1);
    expect(second).toEqual(first);
    expect(resolved).not.toHaveBeenCalled();
    rebuilt.engine.reconstructCombat(makeRoundMap(), rebuilt.players);
    expect(simulate(rebuilt.engine, weapon, 1)).toEqual(first);
  });

  it("invalidates an in-flight simulation before rebuilding and preserves economic balances", () => {
    const { engine, players } = setup();
    engine.getTankManager().getPlayers()[0].money = 1234;
    engine.restoreRoundEarningsByPlayer({ a: 80, b: 0 });
    engine.getTurnManager().executeRemoteFire({ angle: 45, power: 90, weaponId: "GRENADE" }, {
      fromSlot: 0, mode: "ACTIVE_RECOVERY", identity: { shotId: 99, isFirstShotOfRound: false, physicsSeed: 99 },
    });
    engine.invalidateCombatSimulation();
    const resolved = vi.fn(); engine.onShotResolved = resolved;
    engine.reconstructCombat(makeRoundMap(), players);
    const update = Reflect.get(engine, "update") as (dt: number) => void;
    for (let step = 0; step < 120; step++) update.call(engine, 1 / 120);
    expect(resolved).not.toHaveBeenCalled();
    expect(engine.getCombatMap(1).heights).toEqual(makeRoundMap().heights);
    // Economy is restored separately from this fresh physical base.
    engine.syncAuthoritativeBalances([{ playerId: "a", money: 1234 }, { playerId: "b", money: 1000 }]);
    expect(engine.getTankManager().getPlayers()[0].money).toBe(1234);
  });

  it("isolates physical draws from the injected local RNG without replacing it", () => {
    const random = vi.fn(() => 0.123);
    const physics = new PhysicsEngine(random, false);
    const terrain = new TerrainManager(800, 480);
    terrain.loadHeights(makeRoundMap().heights, makeRoundMap().materials);
    physics.setShotSeed(42);
    physics.launchProjectile(120, 280, 55, 37, "CLUSTER");
    for (let step = 0; step < 7200 && physics.hasActiveProjectiles(); step++) physics.updateProjectiles(1 / 120, 260, 0, terrain);
    expect(random).not.toHaveBeenCalled();
    physics.setShotSeed(undefined);
    physics.launchProjectile(120, 280, 55, 37, "CLUSTER");
    for (let step = 0; step < 7200 && physics.hasActiveProjectiles(); step++) physics.updateProjectiles(1 / 120, 260, 0, terrain);
    expect(random).toHaveBeenCalled();
  });

  it("executes a nominated human's lightning automatically after a fully resolved miss", () => {
    const engine = new GameEngine(800, 480);
    const players = [makePlayer({ id: "a", money: 250, tank: makeTank("a", 120, 300, { health: 20 }) }),
      makePlayer({ id: "b", money: 250, tank: makeTank("b", 680, 300) })];
    engine.setPlayers(players, makeRoundMap());
    Reflect.set(engine, "zeusState", { ...createZeusState(), shotsWithoutEarnings: 9 });
    const result = vi.fn(); engine.onZeusStrikeApplied = result;
    const tm = engine.getTurnManager();
    tm.adjustAngle(135); tm.adjustPower(100);
    expect(tm.tryFire()).toBe(true);
    const update = Reflect.get(engine, "update") as (dt: number) => void;
    for (let step = 0; step < 1200 && !result.mock.calls.length; step++) update.call(engine, 1 / 120);
    expect(result).toHaveBeenCalledTimes(1);
    expect(result.mock.calls[0][0]).toMatchObject({ zeusId: "a", targetId: "b", award: { amount: 75 } });
    expect(engine.getTankManager().getPlayers()[0].money).toBe(325);
    expect(engine.getCombatMap(1).heights).toEqual(makeRoundMap().heights);
    expect(tm.tryFire()).toBe(false);
  });

  it.each(["NUKE", "THERMONUCLEAR"] as const)(
    "reconstructs online %s ROCK carving, falls, and inventory/economy cleanly across pre/mid/post-shot catch-up",
    (weapon) => {
      const rockMap = {
        ...makeRoundMap(1, 300),
        materials: new Array<TerrainMaterial>(800).fill(TERRAIN_MATERIAL.ROCK),
      };
      // Narrow tall ROCK wall at 320..324 between impact (~358) and target b (300)
      for (let x = 320; x <= 324; x++) rockMap.heights[x] = 260;

      const initialPlayers = [
        makePlayer({
          id: "a",
          money: 400,
          inventory: { MISSILE: 99, [weapon]: 1 },
          tank: makeTank("a", 120, 300, { shield: 40, maxShield: 40 }),
        }),
        makePlayer({
          id: "b",
          money: 400,
          tank: makeTank("b", 300, 300, { shield: 40, maxShield: 40 }),
        }),
      ];

      const command = { angle: 35, power: 40, weaponId: weapon };

      const runCatchUp = (interruptAtStep?: number) => {
        const eng = new GameEngine(800, 480);
        eng.setLocalMatch(false);
        eng.setLocalPlayerId("a");
        const resolved = vi.fn();
        eng.onShotResolved = resolved;
        eng.reconstructCombat(structuredClone(rockMap), structuredClone(initialPlayers));
        const tm = eng.getTurnManager();
        const update = Reflect.get(eng, "update") as (dt: number) => void;

        if (interruptAtStep !== undefined) {
          tm.executeRemoteFire(command, {
            fromSlot: 0,
            mode: "ACTIVE_RECOVERY",
            identity: { shotId: 1, isFirstShotOfRound: true, physicsSeed: seedFromRoomShot("room", 1, 1) },
          });
          for (let step = 0; step < interruptAtStep; step++) update.call(eng, 1 / 120);
          eng.reconstructCombat(structuredClone(rockMap), structuredClone(initialPlayers));
        }

        tm.executeRemoteFire(command, {
          fromSlot: 0,
          mode: "CATCH_UP",
          identity: { shotId: 1, isFirstShotOfRound: true, physicsSeed: seedFromRoomShot("room", 1, 1) },
        });

        let settled = false;
        tm.onAuthoritativeShotSettled = () => {
          settled = true;
        };
        for (let step = 0; step < 120 * 20 && !settled; step++) update.call(eng, 1 / 120);
        expect(settled).toBe(true);
        expect(resolved).not.toHaveBeenCalled();

        return {
          map: eng.getCombatMap(1),
          players: structuredClone(eng.getTankManager().getPlayers()),
        };
      };

      const baseline = runCatchUp();
      const midFlightRebuilt = runCatchUp(20);
      expect(midFlightRebuilt).toEqual(baseline);
      expect(baseline.map.heights[322]).toBeGreaterThan(260);
      expect(baseline.map.materials.every((m) => m === TERRAIN_MATERIAL.ROCK)).toBe(true);
      expect(baseline.players[0].inventory[weapon]).toBe(1);
      expect(baseline.players[0].money).toBe(400);
      expect(baseline.players[1].tank.health < 100 || baseline.players[1].tank.shield < 40).toBe(true);
    },
  );

  it.each(["NUKE", "THERMONUCLEAR"] as const)(
    "converges across render cadences (0 Hz, 60 Hz, 120 Hz) for online %s on ROCK",
    (weapon) => {
      const rockMap = {
        ...makeRoundMap(1, 300),
        materials: new Array<TerrainMaterial>(800).fill(TERRAIN_MATERIAL.ROCK),
      };
      const initialPlayers = [
        makePlayer({ id: "a", inventory: { MISSILE: 99, [weapon]: 1 }, tank: makeTank("a", 120, 300) }),
        makePlayer({ id: "b", tank: makeTank("b", 220, 300, { shield: 40, maxShield: 40 }) }),
      ];
      const ctx = {
        save: vi.fn(),
        restore: vi.fn(),
        clearRect: vi.fn(),
        fillRect: vi.fn(),
        beginPath: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        closePath: vi.fn(),
        drawImage: vi.fn(),
        fillText: vi.fn(),
        strokeRect: vi.fn(),
        translate: vi.fn(),
        rotate: vi.fn(),
        scale: vi.fn(),
        setTransform: vi.fn(),
      } as unknown as CanvasRenderingContext2D;

      const runAtCadence = (renderEverySteps: number) => {
        const eng = new GameEngine(800, 480);
        eng.setLocalMatch(false);
        eng.setLocalPlayerId("a");
        eng.reconstructCombat(structuredClone(rockMap), structuredClone(initialPlayers));
        const tm = eng.getTurnManager();
        let settled = false;
        tm.onAuthoritativeShotSettled = () => {
          settled = true;
        };
        tm.executeRemoteFire({ angle: 35, power: 40, weaponId: weapon }, {
          fromSlot: 0,
          mode: "LIVE_LOCAL",
          identity: { shotId: 1, isFirstShotOfRound: true, physicsSeed: seedFromRoomShot("room", 1, 1) },
        });
        const update = Reflect.get(eng, "update") as (dt: number) => void;
        const render = Reflect.get(eng, "render") as (c: CanvasRenderingContext2D) => void;
        for (let step = 1; step <= 120 * 20 && !settled; step++) {
          update.call(eng, 1 / 120);
          if (renderEverySteps > 0 && step % renderEverySteps === 0) render.call(eng, ctx);
        }
        expect(settled).toBe(true);
        return {
          map: eng.getCombatMap(1),
          players: structuredClone(eng.getTankManager().getPlayers()),
        };
      };

      const run0Hz = runAtCadence(0);
      expect(runAtCadence(2)).toEqual(run0Hz);
      expect(runAtCadence(1)).toEqual(run0Hz);
    },
  );
});
