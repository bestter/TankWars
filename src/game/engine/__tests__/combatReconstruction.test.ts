import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine } from "../GameEngine";
import { makePlayer, makeRoundMap, makeTank } from "../../__tests__/helpers";
import { seedFromRoomShot } from "../../../utils/random";
import type { WeaponId } from "../../../types/weapon";
import { PhysicsEngine } from "../PhysicsEngine";
import { TerrainManager } from "../Terrain";
import { createZeusState } from "../../zeus/zeusDomain";

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
});
