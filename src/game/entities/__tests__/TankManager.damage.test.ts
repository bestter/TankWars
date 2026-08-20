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

  it("deals 2x damage to shield on direct hit, and normal damage to health on overflow", () => {
    // Tank has 40 shield and 100 health.
    // Direct hit with damage 30:
    // Shield can absorb at most 40 / 2 = 20 damage points.
    // Absorbing 20 points consumes 20 * 2 = 40 shield -> shield = 0.
    // Remaining 10 damage is dealt 1x to health -> health = 90.
    const target = makePlayer({
      id: "victim",
      tank: makeTank("t-v", 100, 200, { health: 100, shield: 40, maxShield: 40 }),
    });
    const tm = managerWith(target);

    // Hitbox is [100 - 12, 100 + 12] and [200 - 15, 200].
    // Direct hit at x=100, y=200 (distance 0):
    tm.applyExplosionDamage(100, 200, 28, 30, "killer", "MISSILE", true);

    expect(target.tank.shield).toBe(0);
    expect(target.tank.health).toBe(90);
    expect(target.tank.isDead).toBe(false);
  });

  it("deals 2x damage to shield on direct hit without damaging health if shield suffices", () => {
    // Tank has 40 shield and 100 health.
    // Direct hit with damage 15:
    // Absorbing 15 damage consumes 15 * 2 = 30 shield -> shield = 10.
    // Remaining damage to health is 0 -> health remains 100.
    const target = makePlayer({
      id: "victim",
      tank: makeTank("t-v", 100, 200, { health: 100, shield: 40, maxShield: 40 }),
    });
    const tm = managerWith(target);

    tm.applyExplosionDamage(100, 200, 28, 15, "killer", "MISSILE", true);

    expect(target.tank.shield).toBe(10);
    expect(target.tank.health).toBe(100);
  });

  it("deals 1x damage to shield on indirect splash hit", () => {
    // Tank has 40 shield and 100 health.
    // Indirect splash damage 30:
    // Shield absorbs 30 -> shield = 10.
    // Health remains 100.
    const target = makePlayer({
      id: "victim",
      tank: makeTank("t-v", 100, 200, { health: 100, shield: 40, maxShield: 40 }),
    });
    const tm = managerWith(target);

    // Indirect explosion at distance 0 (radius=40, damage=30, isDirectHit=false)
    tm.applyExplosionDamage(100, 200, 40, 30, "killer", "MISSILE", false);

    expect(target.tank.shield).toBe(10);
    expect(target.tank.health).toBe(100);
  });

  it("handles odd shield = 1 on direct hit damage = 1 (shield = 0, health intact)", () => {
    // shield = 1, direct hit damage = 1 → shield = 0, health intact
    // Math.ceil(1 / 2) = 1 damage absorbable by shield
    // Absorbing 1 damage consumes 1 shield (clamped at 0) -> shield = 0.
    // Remaining damage to health = 0 -> health remains 100.
    const target = makePlayer({
      id: "victim",
      tank: makeTank("t-v", 100, 200, { health: 100, shield: 1, maxShield: 40 }),
    });
    const tm = managerWith(target);

    tm.applyExplosionDamage(100, 200, 28, 1, "killer", "MISSILE", true);

    expect(target.tank.shield).toBe(0);
    expect(target.tank.health).toBe(100);
    expect(target.tank.isDead).toBe(false);
  });

  it("handles odd shield = 39 on direct hit with non-multiple-of-2 damage = 25", () => {
    // Shield can absorb up to Math.ceil(39 / 2) = 20 damage points.
    // Absorbing 20 points consumes 39 shield -> shield = 0.
    // Remaining damage 25 - 20 = 5 is dealt 1x to health -> health = 95.
    const target = makePlayer({
      id: "victim",
      tank: makeTank("t-v", 100, 200, { health: 100, shield: 39, maxShield: 40 }),
    });
    const tm = managerWith(target);

    tm.applyExplosionDamage(100, 200, 28, 25, "killer", "MISSILE", true);

    expect(target.tank.shield).toBe(0);
    expect(target.tank.health).toBe(95);
    expect(target.tank.isDead).toBe(false);
  });

  it("handles odd shield = 39 on direct hit with damage = 15 without touching health", () => {
    // Direct hit with damage 15:
    // Absorbing 15 damage consumes 15 * 2 = 30 shield -> shield = 39 - 30 = 9.
    // Remaining damage to health = 0 -> health remains 100.
    const target = makePlayer({
      id: "victim",
      tank: makeTank("t-v", 100, 200, { health: 100, shield: 39, maxShield: 40 }),
    });
    const tm = managerWith(target);

    tm.applyExplosionDamage(100, 200, 28, 15, "killer", "MISSILE", true);

    expect(target.tank.shield).toBe(9);
    expect(target.tank.health).toBe(100);
    expect(target.tank.isDead).toBe(false);
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

  it("reduces health directly during fall damage while keeping shield untouched", () => {
    const tank = makeTank("t-v", 50, 80, { health: 100, shield: 40, maxShield: 40 });
    const player = makePlayer({ id: "victim", tank });
    const tm = managerWith(player);
    const terrain = flatTerrain(200, 200, 0.9);

    tm.updateTankPositions(terrain);
    for (let i = 0; i < 80; i++) {
      tm.applyGravity(1 / 60, terrain);
    }

    expect(tank.shield).toBe(40);
    expect(tank.health).toBeLessThan(100);
  });

  it("kills tank when fall damage reduces health to 0 even if shield is intact", () => {
    const tank = makeTank("t-v", 50, 80, { health: 1, shield: 40, maxShield: 40 });
    const player = makePlayer({ id: "victim", tank });
    const tm = managerWith(player);
    const died = vi.fn();
    tm.onPlayerDied = died;
    const terrain = flatTerrain(200, 200, 0.9);

    tm.updateTankPositions(terrain);
    for (let i = 0; i < 80; i++) {
      tm.applyGravity(1 / 60, terrain);
    }

    expect(tank.health).toBe(0);
    expect(tank.shield).toBe(40);
    expect(tank.isDead).toBe(true);
    expect(died).toHaveBeenCalledWith("victim", "burial", expect.stringContaining("fall damage"));
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
