import { describe, it, expect, vi } from "vitest";
import { TankManager } from "../TankManager";
import { TerrainManager } from "../../engine/Terrain";
import { makePlayer, makeTank, flatTerrain } from "../../__tests__/helpers";

function managerWith(...players: ReturnType<typeof makePlayer>[]): TankManager {
  const tm = new TankManager();
  tm.setPlayers(players);
  return tm;
}

describe("TankManager.applyExplosionDamage", () => {
  it("applies linear splash falloff and absorbs shield before health", () => {
    const target = makePlayer({
      id: "victim",
      tank: makeTank("t-v", 100, 200, { health: 100, shield: 20, maxShield: 20 }),
    });
    const tm = managerWith(target);
    const died = vi.fn();
    tm.onPlayerDied = died;

    const kills = tm.applyExplosionDamage(100, 200, 40, 40, "killer");

    expect(target.tank.shield).toBe(0);
    expect(target.tank.health).toBe(80);
    expect(target.tank.isDead).toBe(false);
    expect(kills).toBe(0);
    expect(died).not.toHaveBeenCalled();
  });

  it("kills on lethal splash and reports the explosion", () => {
    const target = makePlayer({
      id: "victim",
      tank: makeTank("t-v", 100, 200, { health: 10, shield: 0 }),
    });
    const tm = managerWith(target);
    const died = vi.fn();
    tm.onPlayerDied = died;

    const kills = tm.applyExplosionDamage(100, 200, 28, 35, "killer");

    expect(target.tank.health).toBe(0);
    expect(target.tank.isDead).toBe(true);
    expect(kills).toBe(1);
    expect(died).toHaveBeenCalledWith("victim", "explosion", expect.any(String), "killer");
  });

  it("deals BULLET 3x damage on a direct hitbox hit", () => {
    const target = makePlayer({
      id: "victim",
      tank: makeTank("t-v", 100, 200, { health: 100, shield: 0 }),
    });
    const tm = managerWith(target);

    tm.applyExplosionDamage(100, 195, 10, 25, "sniper", "BULLET", true);

    expect(target.tank.health).toBe(25);
    expect(target.tank.isDead).toBe(false);
  });

  it("instantly kills on a NUKE direct hitbox hit", () => {
    const target = makePlayer({
      id: "victim",
      tank: makeTank("t-v", 100, 200, { health: 100, shield: 40, maxShield: 40 }),
    });
    const tm = managerWith(target);

    tm.applyExplosionDamage(100, 195, 62, 75, "nuker", "NUKE", true);

    expect(target.tank.health).toBe(0);
    expect(target.tank.shield).toBe(0);
    expect(target.tank.isDead).toBe(true);
  });

  it("instantly kills tanks inside the THERMONUCLEAR 75px zone", () => {
    const target = makePlayer({
      id: "victim",
      tank: makeTank("t-v", 160, 200, { health: 100, shield: 40 }),
    });
    const tm = managerWith(target);

    tm.applyExplosionDamage(100, 200, 160, 120, "thermo", "THERMONUCLEAR", false);

    expect(target.tank.isDead).toBe(true);
    expect(target.tank.health).toBe(0);
  });

  it("ignores splash outside the blast radius", () => {
    const target = makePlayer({
      id: "victim",
      tank: makeTank("t-v", 300, 200, { health: 100, shield: 0 }),
    });
    const tm = managerWith(target);

    tm.applyExplosionDamage(100, 200, 28, 35, "miss");

    expect(target.tank.health).toBe(100);
    expect(target.tank.isDead).toBe(false);
  });

  it("records lastHitBy on a non-lethal hit and spawnTanks clears it", () => {
    const target = makePlayer({
      id: "victim",
      tank: makeTank("t-v", 100, 200, { health: 100, shield: 0, lastHitBy: undefined }),
    });
    const other = makePlayer({
      id: "other",
      tank: makeTank("t-o", 400, 200),
    });
    const tm = managerWith(target, other);
    tm.applyExplosionDamage(100, 200, 40, 20, "attacker");
    expect(target.tank.lastHitBy).toBe("attacker");

    const terrain = new TerrainManager(800, 480);
    terrain.generate();
    tm.spawnTanks([target, other], terrain);
    expect(target.tank.lastHitBy).toBeUndefined();
    expect(target.tank.isDead).toBe(false);
    expect(target.tank.health).toBe(target.tank.maxHealth);
  });

  it("stops splash behind a rock wall but not when exploding on top of the rock", () => {
    const terrain = new TerrainManager(200, 200);
    terrain.loadHeights(Array.from({ length: 200 }, () => 100));
    terrain.setMaterialRange(80, 120, "ROCK");

    const behind = makePlayer({
      id: "behind",
      tank: makeTank("t-behind", 150, 100, { health: 100, shield: 0 }),
    });
    const sameSide = makePlayer({
      id: "same",
      tank: makeTank("t-same", 40, 100, { health: 100, shield: 0 }),
    });
    const tm = managerWith(behind, sameSide);

    tm.applyExplosionDamage(30, 100, 160, 80, "killer", "MISSILE", false, terrain);

    expect(behind.tank.health).toBe(100);
    expect(sameSide.tank.health).toBeLessThan(100);

    behind.tank.health = 100;
    sameSide.tank.health = 100;
    tm.applyExplosionDamage(100, 100, 160, 80, "killer", "MISSILE", false, terrain);

    expect(behind.tank.health).toBeLessThan(100);
    expect(sameSide.tank.health).toBeLessThan(100);
  });
});

describe("TankManager.applyGravity and burial", () => {
  it("applies fall damage while dropping through a crater", () => {
    const tank = makeTank("t-v", 50, 80, { health: 100, shield: 0 });
    const player = makePlayer({ id: "victim", tank });
    const tm = managerWith(player);
    const terrain = flatTerrain(200, 200, 0.9);

    tm.updateTankPositions(terrain);
    for (let i = 0; i < 80; i++) {
      tm.applyGravity(1 / 60, terrain);
    }

    expect(tank.health).toBeLessThan(100);
  });

  it("kills instantly when the tank touches lava", () => {
    const terrain = new TerrainManager(200, 200);
    const tank = makeTank("t-v", 50, terrain.lavaTop + 1, { health: 80, shield: 0 });
    const player = makePlayer({ id: "victim", tank });
    const tm = managerWith(player);
    const died = vi.fn();
    tm.onPlayerDied = died;

    tm.applyGravity(1 / 60, terrain);

    expect(tank.isDead).toBe(true);
    expect(died).toHaveBeenCalledWith("victim", "burial", expect.stringContaining("lava"));
  });

  it("buries a tank with no remaining ground support", () => {
    const terrain = new TerrainManager(200, 200);
    const heights = (terrain as unknown as { heights: number[] }).heights;
    for (let x = 0; x < 200; x++) {
      heights[x] = terrain.height;
    }
    const tank = makeTank("t-v", 50, 100, { health: 100 });
    const player = makePlayer({ id: "victim", tank });
    const tm = managerWith(player);
    const died = vi.fn();
    tm.onPlayerDied = died;

    tm.checkTankBurial(terrain);

    expect(tank.isDead).toBe(true);
    expect(died).toHaveBeenCalledWith("victim", "burial", expect.stringContaining("no ground support"));
  });

  it("buries a tank that has fallen off the bottom of the map", () => {
    const terrain = new TerrainManager(200, 200);
    const tank = makeTank("t-v", 50, terrain.height + 20, { health: 100 });
    const player = makePlayer({ id: "victim", tank });
    const tm = managerWith(player);

    tm.checkTankBurial(terrain);

    expect(tank.isDead).toBe(true);
  });
});
