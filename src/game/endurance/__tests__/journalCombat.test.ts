import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhysicsEngine, type Projectile } from "../../engine/PhysicsEngine";
import { GameEngine } from "../../engine/GameEngine";
import { flatTerrain, makePlayer, makeTank } from "../../__tests__/helpers";
import { createSeededRNG } from "../../../utils/random";
import type { PhysicalObservation } from "../../observation";
import type { EnduranceEvent } from "../types";
import type { TerrainManager } from "../../engine/Terrain";
import type { PlayerShotReward } from "../../economy/shotRewards";
import { TankManager } from "../../entities/TankManager";
import { TurnManager } from "../../engine/TurnManager";

beforeEach(() => vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("faithful launch, physical draws and applied credits", () => {
  it("records ammunition only after accepted consumption and keeps unlimited MISSILE unchanged", () => {
    const tanks = new TankManager(); tanks.setPlayers([makePlayer({ inventory: { GRENADE: 1 } })]);
    const player = tanks.getPlayers()[0], events: EnduranceEvent[] = [];
    const tm = new TurnManager(tanks, flatTerrain(800, 480), vi.fn(), { executeTurn: async () => ({ angle: 45, power: 50 }) });
    tm.combatObserver = { emit: event => { events.push(event); return true; } };
    const consume = Reflect.get(tm, "consumeAmmo") as (p: typeof player, weapon: "GRENADE" | "MISSILE") => void;
    consume.call(tm, player, "GRENADE"); consume.call(tm, player, "GRENADE"); consume.call(tm, player, "MISSILE");
    expect(events.filter(e => e.kind === "ammo-consumed")).toEqual([
      { kind: "ammo-consumed", playerId: player.id, weaponId: "GRENADE", before: 1, after: 0 },
      { kind: "ammo-consumed", playerId: player.id, weaponId: "MISSILE", before: 0, after: 0 },
    ]); tm.removeInputListeners();
  });
  it("retains the exact rational explanations and each draw beneficiary after real resolution, without double credits", () => {
    const engine = new GameEngine(800, 480, { headless: true });
    engine.setPlayers([makePlayer({ id: "a", money: 0, tank: makeTank("ta", 100, 300) }),
      makePlayer({ id: "b", money: 0, tank: makeTank("tb", 650, 300) }),
      makePlayer({ id: "c", money: 0, tank: makeTank("tc", 400, 300) })]);
    const events: EnduranceEvent[] = []; engine.combatObserver = { emit: e => { events.push(e); return true; } };
    const players = engine.getTankManager().getPlayers();
    engine.fireProjectile(players[0].tank.position, { angle: 0, power: 50, weaponId: "MISSILE" }, "a");
    const shot = engine.getActiveProjectiles()[0];
    for (const player of players) engine.getTankManager().applyExplosionDamage({ explosionX: player.tank.position.x,
      explosionY: player.tank.position.y, radius: 20, maxDamage: 200, shooterId: "a", weaponId: "MISSILE", isDirectHit: true,
      shotId: shot.shotId, munitionId: 0 });
    const finalize = Reflect.get(engine, "finalizeActiveShot") as () => import("../../engine/GameEngine").ResolvedShotPreview;
    const result = finalize.call(engine); finalize.call(engine);
    expect(result.roundOutcome.isDraw).toBe(true);
    const credits = events.flatMap(e => e.kind === "credit" ? [e.credit] : []);
    expect(credits.map(c => c.playerId).sort()).toEqual(result.awards.filter(a => a.amount > 0).map(a => a.playerId).sort());
    for (const credit of credits) {
      expect(credit.components).toEqual(result.awards.find(a => a.playerId === credit.playerId)!.components);
      expect(players.find(p => p.id === credit.playerId)!.money).toBe(credit.amount);
    }
    expect(events.filter(e => e.kind === "shot-result")).toHaveLength(1); engine.stop();
  });
  it.each(["CLUSTER", "GRENADE"] as const)("observes actual %s draws without changing trajectories", weapon => {
    function execute(observe: boolean) {
      const rng = createSeededRNG(77); const draws: number[] = [], details: PhysicalObservation[] = [];
      const physics = new PhysicsEngine(() => { const value = rng.next(); draws.push(value); return value; });
      if (observe) physics.onPhysicalObserved = v => details.push(v);
      physics.launchProjectile(300, 100, 60, 60, weapon, "a", undefined, { shotId: 12, munitionId: 0 });
      const terrain = flatTerrain(800, 480);
      if (weapon === "CLUSTER") {
        const p = physics.getProjectiles()[0]; p.vy = 1; p.lastVy = -1;
        physics.updateProjectiles(1 / 120, 260, 0, terrain);
      } else {
        const internal = physics as unknown as { bounceGrenade(i: number, p: Projectile, t: TerrainManager): void };
        const p = physics.getProjectiles()[0]; p.vy = 20;
        internal.bounceGrenade(0, p, terrain);
      }
      return { draws, details, projectiles: structuredClone(physics.getProjectiles()) };
    }
    const observed = execute(true), ordinary = execute(false);
    expect(observed.draws.length).toBeGreaterThan(0);
    expect(observed.draws).toEqual(ordinary.draws);
    expect(observed.projectiles).toEqual(ordinary.projectiles);
    expect(observed.details.flatMap(v => v.draws)).toEqual(observed.draws);
    expect(observed.details.every(v => v.shotId === 12)).toBe(true);
    for (const detail of observed.details) {
      const p = observed.projectiles.find(p => p.munitionId === detail.munitionId)!;
      if (weapon === "CLUSTER") expect(detail.parameters).toMatchObject({ vx: p.vx, vy: p.vy, x: p.x, y: p.y });
      else expect(detail.parameters.after).toEqual({ vx: p.vx, vy: p.vy });
    }
  });
  it("records confirmed arguments and barrel position, refuses a duplicate launch and credits only once after mutation", () => {
    const engine = new GameEngine(800, 480, { headless: true });
    engine.setPlayers([makePlayer({ id: "a", money: 0, tank: makeTank("ta", 100, 300) }), makePlayer({ id: "b", money: 0, tank: makeTank("tb", 650, 300) })]);
    const events: EnduranceEvent[] = [];
    engine.combatObserver = { emit: e => {
      if (e.kind === "credit") expect(engine.getTankManager().getPlayerById(e.credit.playerId)?.money).toBe(e.credit.after);
      events.push(e); return true;
    } };
    const command = { angle: 0, power: 50, weaponId: "MISSILE" as const }, from = { x: 100, y: 300 };
    const launch = vi.spyOn(engine.getPhysicsEngine(), "launchProjectile");
    engine.fireProjectile(from, command, "a"); engine.fireProjectile(from, command, "a");
    expect(launch).toHaveBeenCalledOnce();
    const confirmed = events.find(e => e.kind === "shot-launched");
    expect(confirmed).toMatchObject({ command, position: from, launch: { x: launch.mock.calls[0][0], y: launch.mock.calls[0][1] } });
    expect(events.filter(e => e.kind === "shot-refused")).toHaveLength(1);
    const awards: PlayerShotReward[] = [{ playerId: "a", amount: 7, components: [{ kind: "projectile-damage", value: { numerator: "13", denominator: "2" } }] }];
    engine.applyResolvedEarnings(1, [{ playerId: "a", money: 7 }], awards);
    engine.applyResolvedEarnings(1, [{ playerId: "a", money: 14 }], awards);
    expect(events.filter(e => e.kind === "credit")).toEqual([{ kind: "credit", credit: {
      source: "shot", causalId: 1, playerId: "a", before: 0, after: 7, amount: 7, components: awards[0].components,
    } }]); engine.stop();
  });
});
