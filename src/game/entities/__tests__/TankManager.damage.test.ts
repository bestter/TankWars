import { describe, it, expect, vi } from "vitest";
import { TankManager, type ExplosionDamageOptions } from "../TankManager";
import { TerrainManager } from "../../engine/Terrain";
import { makePlayer, makeTank, flatTerrain } from "../../__tests__/helpers";
import { THERMONUCLEAR_INSTANT_KILL_RADIUS } from "../../combatConstants";

function managerWith(...players: ReturnType<typeof makePlayer>[]): TankManager {
  const tm = new TankManager();
  tm.setPlayers(players);
  return tm;
}

function explosion(overrides: Partial<ExplosionDamageOptions> = {}): ExplosionDamageOptions {
  return {
    explosionX: 100,
    explosionY: 200,
    radius: 40,
    maxDamage: 40,
    shooterId: "killer",
    weaponId: "MISSILE",
    isDirectHit: false,
    ...overrides,
  };
}

describe("TankManager.applyExplosionDamage", () => {
  it.each([
    { direct: true, shield: 40, damage: 5, lost: 10_000, absorbed: 5_000, health: 0 },
    { direct: false, shield: 40, damage: 5, lost: 5_000, absorbed: 5_000, health: 0 },
    { direct: true, shield: 0, damage: 5, lost: 0, absorbed: 0, health: 5_000 },
  ])("emits applied losses for direct=$direct and shield=$shield", ({ direct, shield, damage, lost, absorbed, health }) => {
    const target = makePlayer({ id: "victim", tank: makeTank("victim", 100, 200, { shield }) });
    const tm = managerWith(target);
    const applied = vi.fn();
    tm.onDamageApplied = applied;
    tm.applyExplosionDamage(explosion({ isDirectHit: direct, maxDamage: damage, shotId: 1, munitionId: 0 }));
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({
      shieldLostMilli: lost, shieldAbsorbedMilli: absorbed, healthDamageMilli: health,
    }));
  });

  it("normalizes fractional losses separately on successive applied events", () => {
    const target = makePlayer({ id: "victim", tank: makeTank("victim", 100, 200) });
    const tm = managerWith(target);
    const applied = vi.fn();
    tm.onDamageApplied = applied;
    for (const munitionId of [0, 1]) {
      tm.applyExplosionDamage(explosion({ maxDamage: 0.0004, shotId: 1, munitionId }));
    }
    expect(applied).toHaveBeenCalledTimes(2);
    for (const [event] of applied.mock.calls) {
      expect(event).toMatchObject({ shieldLostMilli: 0, healthDamageMilli: 0 });
    }
    expect(target.tank.health).toBeCloseTo(99.9992);
  });

  it.each([true, false])("reports actual THERMONUCLEAR losses for direct=$direct", (direct) => {
    const target = makePlayer({ id: "victim", tank: makeTank("victim", 100, 200, { shield: 39 }) });
    const tm = managerWith(target);
    const applied = vi.fn();
    tm.onDamageApplied = applied;
    tm.applyExplosionDamage(explosion({ weaponId: "THERMONUCLEAR", isDirectHit: direct, shotId: 1, munitionId: 0 }));
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({
      shieldLostMilli: 39_000, shieldAbsorbedMilli: direct ? 20_000 : 39_000,
      healthDamageMilli: 100_000,
    }));
  });

  it.each([-0.001, 0, 0.001])("preserves the inclusive THERMO kill boundary at 75 + %s px", (delta) => {
    const distance = THERMONUCLEAR_INSTANT_KILL_RADIUS + delta;
    const target = makePlayer({ id: "victim", tank: makeTank("victim", 100 + distance, 200,
      { health: 100, shield: 40 }) });
    const tm = managerWith(target);
    const killed = tm.applyExplosionDamage(explosion({
      weaponId: "THERMONUCLEAR", radius: 160, maxDamage: 120,
    }));
    expect(target.tank.isDead).toBe(delta <= 0);
    expect(killed).toBe(delta <= 0 ? 1 : 0);
    expect(target.tank.shield).toBe(0);
    if (delta <= 0) expect(target.tank.health).toBe(0);
    else expect(target.tank.health).toBeCloseTo(140 - 120 * (1 - distance / 160));
  });

  it("reports 5 incoming points absorbed when a direct hit consumes 10 shield points", () => {
    const target = makePlayer({
      id: "victim",
      tank: makeTank("t-v", 100, 200, { health: 100, shield: 10, maxShield: 10 }),
    });
    const tm = managerWith(target);
    const applied = vi.fn();
    tm.onDamageApplied = applied;
    tm.beginShotAttribution(7, "killer", "MISSILE");

    tm.applyExplosionDamage(explosion({
      maxDamage: 5,
      isDirectHit: true,
      shotId: 7,
      munitionId: 3,
    }));

    expect(applied).toHaveBeenCalledWith(expect.objectContaining({
      shotId: 7,
      munitionId: 3,
      classification: "direct",
      shieldAbsorbedMilli: 5_000,
      shieldLostMilli: 10_000,
      healthDamageMilli: 0,
    }));
  });

  it("caps rewarded health damage and reports shield overflow", () => {
    const target = makePlayer({
      id: "victim",
      tank: makeTank("t-v", 100, 200, { health: 4, shield: 4, maxShield: 4 }),
    });
    const tm = managerWith(target);
    const applied = vi.fn();
    tm.onDamageApplied = applied;
    tm.applyExplosionDamage(explosion({
      maxDamage: 100,
      isDirectHit: true,
      shotId: 9,
      munitionId: 0,
    }));
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({
      shieldAbsorbedMilli: 2_000,
      shieldLostMilli: 4_000,
      healthDamageMilli: 4_000,
    }));
  });

  it("reports absorption separately from actual shield and health loss for instant massive kill zones", () => {
    const target = makePlayer({
      id: "victim",
      tank: makeTank("t-v", 100, 200, { health: 100, shield: 40, maxShield: 40 }),
    });
    const tm = managerWith(target);
    const applied = vi.fn();
    tm.onDamageApplied = applied;
    tm.applyExplosionDamage(explosion({
      radius: 62,
      maxDamage: 75,
      weaponId: "NUKE",
      isDirectHit: true,
      shotId: 10,
      munitionId: 0,
    }));
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({
      shieldAbsorbedMilli: 20_000,
      shieldLostMilli: 40_000,
      healthDamageMilli: 100_000,
    }));
  });
  it("applies linear splash falloff and absorbs shield before health", () => {
    const target = makePlayer({
      id: "victim",
      tank: makeTank("t-v", 100, 200, { health: 100, shield: 20, maxShield: 20 }),
    });
    const tm = managerWith(target);
    const died = vi.fn();
    tm.onPlayerDied = died;

    const kills = tm.applyExplosionDamage(explosion());

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

    const kills = tm.applyExplosionDamage(explosion({ radius: 28, maxDamage: 35 }));

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

    tm.applyExplosionDamage(explosion({ explosionY: 195, radius: 10, maxDamage: 25, shooterId: "sniper", weaponId: "BULLET", isDirectHit: true }));

    expect(target.tank.health).toBe(25);
    expect(target.tank.isDead).toBe(false);
  });

  it("instantly kills on a NUKE direct hitbox hit", () => {
    const target = makePlayer({
      id: "victim",
      tank: makeTank("t-v", 100, 200, { health: 100, shield: 40, maxShield: 40 }),
    });
    const tm = managerWith(target);

    tm.applyExplosionDamage(explosion({ explosionY: 195, radius: 62, maxDamage: 75, shooterId: "nuker", weaponId: "NUKE", isDirectHit: true }));

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

    tm.applyExplosionDamage(explosion({ radius: 160, maxDamage: 120, shooterId: "thermo", weaponId: "THERMONUCLEAR" }));

    expect(target.tank.isDead).toBe(true);
    expect(target.tank.health).toBe(0);
  });

  it("ignores splash outside the blast radius", () => {
    const target = makePlayer({
      id: "victim",
      tank: makeTank("t-v", 300, 200, { health: 100, shield: 0 }),
    });
    const tm = managerWith(target);

    tm.applyExplosionDamage(explosion({ radius: 28, maxDamage: 35, shooterId: "miss" }));

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
    tm.applyExplosionDamage(explosion({ maxDamage: 20, shooterId: "attacker" }));
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

    tm.applyExplosionDamage(explosion({ explosionX: 30, explosionY: 100, radius: 160, maxDamage: 80, terrain }));

    expect(behind.tank.health).toBe(100);
    expect(sameSide.tank.health).toBeLessThan(100);

    behind.tank.health = 100;
    sameSide.tank.health = 100;
    tm.applyExplosionDamage(explosion({ explosionY: 100, radius: 160, maxDamage: 80, terrain }));

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
    tm.applyExplosionDamage(explosion({ radius: 28, maxDamage: 30, isDirectHit: true }));

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

    tm.applyExplosionDamage(explosion({ radius: 28, maxDamage: 15, isDirectHit: true }));

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
    tm.applyExplosionDamage(explosion({ maxDamage: 30 }));

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
    const applied = vi.fn();
    tm.onDamageApplied = applied;

    tm.applyExplosionDamage(explosion({ radius: 28, maxDamage: 1, isDirectHit: true, shotId: 1, munitionId: 0 }));

    expect(target.tank.shield).toBe(0);
    expect(target.tank.health).toBe(100);
    expect(target.tank.isDead).toBe(false);
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({
      shieldAbsorbedMilli: 1000, shieldLostMilli: 1000, healthDamageMilli: 0,
    }));
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
    const applied = vi.fn();
    tm.onDamageApplied = applied;

    tm.applyExplosionDamage(explosion({ radius: 28, maxDamage: 25, isDirectHit: true, shotId: 1, munitionId: 0 }));

    expect(target.tank.shield).toBe(0);
    expect(target.tank.health).toBe(95);
    expect(target.tank.isDead).toBe(false);
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({
      shieldAbsorbedMilli: 20000, shieldLostMilli: 39000, healthDamageMilli: 5000,
    }));
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

    tm.applyExplosionDamage(explosion({ radius: 28, maxDamage: 15, isDirectHit: true }));

    expect(target.tank.shield).toBe(9);
    expect(target.tank.health).toBe(100);
    expect(target.tank.isDead).toBe(false);
  });
});

describe("TankManager.applyGravity and burial", () => {
  it("keeps direct fall attribution for the whole Cluster resolution", () => {
    const tank = makeTank("t-v", 50, 80, { health: 100, shield: 0 });
    const player = makePlayer({ id: "victim", tank });
    const tm = managerWith(player);
    const terrain = flatTerrain(200, 200, 0.9);
    const applied = vi.fn();
    tm.onDamageApplied = applied;
    tm.beginShotAttribution(12, "cluster-owner", "CLUSTER");
    tm.markDirectlyAffected("victim", 4);
    tm.updateTankPositions(terrain);
    for (let i = 0; i < 80; i++) tm.applyGravity(1 / 60, terrain);
    expect(applied).toHaveBeenCalled();
    expect(applied.mock.calls.every(([event]) => event.classification === "direct")).toBe(true);
    expect(applied.mock.calls.every(([event]) => event.shotId === 12)).toBe(true);
    expect(applied.mock.calls.every(([event]) => event.shieldLostMilli === 0 &&
      event.munitionId === 4 && event.shooterId === "cluster-owner")).toBe(true);
  });
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
    const applied = vi.fn();
    tm.onDamageApplied = applied;
    tm.beginShotAttribution(13, "killer", "MISSILE");

    tm.updateTankPositions(terrain);
    for (let i = 0; i < 80; i++) {
      tm.applyGravity(1 / 60, terrain);
    }

    expect(tank.shield).toBe(40);
    expect(tank.health).toBeLessThan(100);
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({
      source: "fall", shieldLostMilli: 0, shieldAbsorbedMilli: 0,
    }));
    expect(applied.mock.calls.reduce((total, [event]) => total + event.healthDamageMilli, 0))
      .toBe(Math.round((100 - tank.health) * 1000));
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

  it("sets wasDirectHit on hitReaction on direct collision, but not on splash-only damage", () => {
    const directTarget = makePlayer({
      id: "direct",
      tank: makeTank("t-direct", 100, 200, { health: 100, shield: 0 }),
    });
    const splashTarget = makePlayer({
      id: "splash",
      tank: makeTank("t-splash", 120, 200, { health: 100, shield: 0 }),
    });
    const tm = managerWith(directTarget, splashTarget);

    // Direct collision on directTarget at (100, 195) with isDirectHit = true
    tm.applyExplosionDamage(explosion({ explosionY: 195, maxDamage: 25, shooterId: "attacker", isDirectHit: true }));

    expect(directTarget.tank.hitReaction?.wasDirectHit).toBe(true);
    expect(splashTarget.tank.hitReaction?.wasDirectHit).toBeUndefined();
    expect(splashTarget.tank.health).toBeLessThan(100); // took splash damage
  });

  it("tracks a shield-only direct attacker and excludes BULLDOZER", () => {
    const target = makePlayer({
      id: "victim",
      tank: makeTank("t-victim", 100, 200, { health: 100, shield: 40 }),
    });
    const tm = managerWith(target);

    tm.applyExplosionDamage(explosion({
      explosionY: 195,
      maxDamage: 5,
      shooterId: "attacker",
      isDirectHit: true,
    }));
    expect(target.tank.health).toBe(100);
    expect(target.tank.lastDirectAttackerId).toBe("attacker");

    target.tank.lastDirectAttackerId = undefined;
    tm.applyExplosionDamage(explosion({
      explosionY: 195,
      maxDamage: 0,
      shooterId: "bulldozer",
      weaponId: "BULLDOZER",
      isDirectHit: true,
    }));
    expect(target.tank.lastDirectAttackerId).toBeUndefined();
  });

  it("applies a Zeus strike only to its target, through shield and health", () => {
    const zeus = makePlayer({ id: "zeus" });
    const target = makePlayer({
      id: "target",
      tank: makeTank("t-target", 100, 200, { health: 100, shield: 40 }),
    });
    const bystander = makePlayer({
      id: "bystander",
      tank: makeTank("t-bystander", 105, 200, { health: 100, shield: 40 }),
    });
    const tm = managerWith(zeus, target, bystander);
    const died = vi.fn();
    tm.onPlayerDied = died;

    expect(tm.applyZeusStrike(zeus.id, target.id)).toBe(true);
    expect(target.tank).toMatchObject({ health: 0, shield: 0, isDead: true });
    expect(bystander.tank).toMatchObject({ health: 100, shield: 40, isDead: false });
    expect(died).toHaveBeenCalledWith(target.id, "zeus", expect.any(String), zeus.id);
    expect(tm.applyZeusStrike(zeus.id, target.id)).toBe(false);
  });

  it("accumulates fallDistance on hitReaction during gravity fall and spawnTanks clears it", () => {
    const terrain = new TerrainManager(200, 200);
    terrain.loadHeights(Array.from({ length: 200 }, () => 150));

    const fallingTank = makeTank("t-fall", 100, 100, { health: 100, shield: 0 });
    const fallingPlayer = makePlayer({ id: "falling", tank: fallingTank });
    const tm = managerWith(fallingPlayer);

    tm.updateTankPositions(terrain);
    tm.applyGravity(1 / 60, terrain);

    expect(fallingTank.hitReaction?.fallDistance).toBeGreaterThan(0);
    expect(fallingTank.hitReaction?.wasDirectHit).toBe(false);

    // spawnTanks clears hitReaction
    tm.spawnTanks([fallingPlayer], terrain);
    expect(fallingTank.hitReaction).toBeUndefined();
  });

  it("caps reaction distance at 120 without capping fall damage", () => {
    const terrain = new TerrainManager(200, 500);
    terrain.loadHeights(Array.from({ length: 200 }, () => 400));
    const tank = makeTank("t-cap", 100, 100, {
      health: 1000,
      maxHealth: 1000,
      shield: 40,
      hitReaction: { wasDirectHit: true, fallDistance: 119.9 },
    });
    const tm = managerWith(makePlayer({ id: "falling", tank }));
    tm.updateTankPositions(terrain);
    tm.applyGravity(1 / 60, terrain);
    expect(tank.hitReaction).toEqual({ wasDirectHit: true, fallDistance: 120 });
    for (let step = 0; step < 60; step += 1) tm.applyGravity(1 / 60, terrain);
    expect(tank.hitReaction?.fallDistance).toBe(120);
    expect(tank.health).toBeLessThan(1000);
    expect(tank.shield).toBe(40);
  });

  it("retains several direct hits and accumulates several falls until the AI riposte", () => {
    const terrain = new TerrainManager(200, 200);
    terrain.loadHeights(Array.from({ length: 200 }, () => 150));

    const tank = makeTank("t-fall", 100, 100, { health: 100, shield: 0 });
    const player = makePlayer({ id: "victim", tank });
    const tm = managerWith(player);

    tm.updateTankPositions(terrain);
    tm.applyGravity(1 / 60, terrain);
    const firstFall = tank.hitReaction?.fallDistance ?? 0;

    for (const shooterId of ["attacker-a", "attacker-b"]) {
      tm.applyExplosionDamage(
        explosion({
          explosionY: tank.position.y - 5,
          shooterId,
          isDirectHit: true,
        }),
      );
    }
    tm.applyGravity(1 / 60, terrain);
    tm.applyGravity(1 / 60, terrain);

    expect(tank.hitReaction).toMatchObject({
      wasDirectHit: true,
    });
    expect(tank.hitReaction?.fallDistance).toBeGreaterThan(firstFall);
    expect(tank.lastDirectAttackerId).toBe("attacker-b");
  });
});

describe("Local nuclear projectile damage before falls (#302)", () => {
  it("kills a direct-hit NUKE victim on the spot and damages a bystander before the fall", () => {
    const terrain = new TerrainManager(300, 300);
    terrain.loadHeights(Array.from({ length: 300 }, () => 120));
    terrain.setMaterialRange(0, 299, "ROCK");

    const directVictim = makePlayer({
      id: "direct",
      tank: makeTank("t-direct", 100, 120, { health: 100, shield: 40, maxShield: 40 }),
    });
    const fallingBystander = makePlayer({
      id: "bystander",
      tank: makeTank("t-bystander", 130, 120, { health: 100, shield: 40, maxShield: 40 }),
    });
    const tm = managerWith(directVictim, fallingBystander);
    const damageEvents: unknown[] = [];
    const destructionEvents: unknown[] = [];
    const diedCalls: Array<{ playerId: string; cause: string }> = [];
    tm.onDamageApplied = (e) => damageEvents.push(e);
    tm.onTankDestroyed = (e) => destructionEvents.push(e);
    tm.onPlayerDied = (playerId, cause) => diedCalls.push({ playerId, cause });

    tm.beginShotAttribution(1, "shooter", "NUKE", 0);
    terrain.destroyTerrain(100, 115, 45, { canCarveRock: true });
    tm.beginLocalNuclearImpact({
      explosionX: 100,
      explosionY: 115,
      radius: 62,
      maxDamage: 113, // 75 * 1.5 rounded on ROCK
      shooterId: "shooter",
      weaponId: "NUKE",
      isDirectHit: true,
      terrain,
      shotId: 1,
      munitionId: 0,
    });

    // Direct victim is dead, and the bystander already took splash, before any fall.
    expect(directVictim.tank.isDead).toBe(true);
    expect(directVictim.tank.health).toBe(0);
    expect(directVictim.tank.shield).toBe(0);
    expect(directVictim.tank.hitReaction).toEqual({ wasDirectHit: true, fallDistance: 0 });
    expect(directVictim.tank.lastDirectAttackerId).toBe("shooter");
    expect(directVictim.tank.position.y).toBe(120);

    expect(fallingBystander.tank.position.y).toBe(120);
    expect(fallingBystander.tank.shield).toBeLessThan(40);
    expect(fallingBystander.tank.isDead).toBe(false);
    expect(fallingBystander.tank.hitReaction?.wasDirectHit).toBeFalsy();

    tm.updateTankPositions(terrain);
    tm.checkTankBurial(terrain);
    expect(tm.anyTankIsFalling()).toBe(true);

    for (let step = 0; step < 600 && tm.anyTankIsFalling(); step++) {
      tm.applyGravity(1 / 120, terrain);
      tm.checkTankBurial(terrain);
    }

    expect(tm.anyTankIsFalling()).toBe(false);
    // Direct victim never fell and only died once by explosion
    expect(directVictim.tank.position.y).toBe(120);
    expect(diedCalls.filter((d) => d.playerId === "direct")).toEqual([
      { playerId: "direct", cause: "explosion" },
    ]);
    expect(
      damageEvents.filter(
        (e) => (e as { victimId: string; source: string }).victimId === "direct",
      ),
    ).toEqual([
      expect.objectContaining({
        victimId: "direct",
        source: "projectile",
        classification: "direct",
        shieldAbsorbedMilli: 20_000,
        shieldLostMilli: 40_000,
        healthDamageMilli: 100_000,
      }),
    ]);

    // Bystander took indirect splash first, then indirect fall damage.
    expect(fallingBystander.tank.position.y).toBeGreaterThan(120);
    expect(fallingBystander.tank.hitReaction?.wasDirectHit).toBe(false);
    expect(fallingBystander.tank.lastDirectAttackerId).toBeUndefined();
    const bystanderEvents = damageEvents.filter(
      (e) => (e as { victimId: string }).victimId === "bystander",
    ) as Array<{ source: string; classification: string }>;
    expect(bystanderEvents.length).toBeGreaterThanOrEqual(2);
    expect(bystanderEvents[0]).toMatchObject({
      source: "projectile",
      classification: "indirect",
    });
    expect(bystanderEvents.slice(1).every((e) => e.source === "fall" && e.classification === "indirect")).toBe(true);
    expect(bystanderEvents.filter((e) => e.source === "projectile")).toHaveLength(1);
    expect(destructionEvents).toHaveLength(directVictim.tank.isDead && fallingBystander.tank.isDead ? 2 : 1);
  });

  it("qualifies a thermonuclear direct hit and applies the 75 px zone before any fall", () => {
    const terrain = new TerrainManager(400, 300);
    terrain.loadHeights(Array.from({ length: 400 }, () => 100));
    terrain.setMaterialRange(0, 399, "ROCK");

    const directVictim = makePlayer({
      id: "direct",
      tank: makeTank("t-direct", 200, 100, { health: 100, shield: 39, maxShield: 40 }),
    });
    const tm = managerWith(directVictim);
    const damageEvents: Array<{
      victimId: string;
      source: string;
      classification: string;
      shieldAbsorbedMilli: number;
      shieldLostMilli: number;
      healthDamageMilli: number;
    }> = [];
    tm.onDamageApplied = (e) => damageEvents.push(e);

    tm.beginShotAttribution(5, "shooter", "THERMONUCLEAR", 0);
    terrain.destroyTerrain(200, 100, 30, { canCarveRock: true });
    tm.beginLocalNuclearImpact({
      explosionX: 200,
      explosionY: 95,
      radius: 160,
      maxDamage: 180,
      shooterId: "shooter",
      weaponId: "THERMONUCLEAR",
      isDirectHit: true,
      terrain,
      shotId: 5,
      munitionId: 0,
    });

    expect(directVictim.tank.isDead).toBe(true);
    expect(directVictim.tank.position.y).toBe(100);
    expect(directVictim.tank.hitReaction).toEqual({ wasDirectHit: true, fallDistance: 0 });
    expect(directVictim.tank.lastDirectAttackerId).toBe("shooter");
    expect(damageEvents).toEqual([
      expect.objectContaining({
        victimId: "direct",
        source: "projectile",
        classification: "direct",
        shieldAbsorbedMilli: 20_000,
        shieldLostMilli: 39_000,
        healthDamageMilli: 100_000,
      }),
    ]);

    tm.updateTankPositions(terrain);
    for (let step = 0; step < 30; step++) tm.applyGravity(1 / 120, terrain);
    expect(directVictim.tank.position.y).toBe(100);
    expect(damageEvents.some((event) => event.source === "fall")).toBe(false);
  });

  it("kills with the thermonuclear 75 px zone before a fall can leave that zone", () => {
    const terrain = new TerrainManager(400, 500);
    terrain.loadHeights(Array.from({ length: 400 }, () => 200));
    terrain.setMaterialRange(0, 399, "ROCK");

    const victim = makePlayer({
      id: "zone",
      tank: makeTank("t-zone", 170, 200, { health: 100, shield: 40, maxShield: 40 }),
    });
    const tm = managerWith(victim);
    const damageEvents: Array<{ source: string; classification: string }> = [];
    tm.onDamageApplied = (e) => damageEvents.push(e);

    tm.beginShotAttribution(7, "shooter", "THERMONUCLEAR", 0);
    terrain.destroyTerrain(100, 200, 160, { canCarveRock: true });
    tm.beginLocalNuclearImpact({
      explosionX: 100,
      explosionY: 200,
      radius: 160,
      maxDamage: 180,
      shooterId: "shooter",
      weaponId: "THERMONUCLEAR",
      isDirectHit: false,
      terrain,
      shotId: 7,
      munitionId: 0,
    });

    expect(victim.tank.isDead).toBe(true);
    expect(victim.tank.position.y).toBe(200);
    expect(damageEvents).toEqual([
      expect.objectContaining({ source: "projectile", classification: "indirect" }),
    ]);

    tm.updateTankPositions(terrain);
    tm.checkTankBurial(terrain);
    for (let step = 0; step < 600 && tm.anyTankIsFalling(); step++) {
      tm.applyGravity(1 / 120, terrain);
      tm.checkTankBurial(terrain);
    }

    expect(victim.tank.position.y).toBe(200);
    expect(damageEvents.filter((event) => event.source === "projectile")).toHaveLength(1);
    expect(damageEvents.some((event) => event.source === "fall")).toBe(false);
  });

  it("applies indirect thermonuclear splash before the fall and keeps that fall indirect", () => {
    const terrain = new TerrainManager(400, 400);
    terrain.loadHeights(Array.from({ length: 400 }, () => 100));
    terrain.setMaterialRange(0, 399, "ROCK");

    const indirect = makePlayer({
      id: "indirect",
      tank: makeTank("t-indirect", 200, 100, { health: 250, shield: 40, maxShield: 40 }),
    });
    const tm = managerWith(indirect);
    const damageEvents: Array<{
      source: string;
      classification: string;
      shieldAbsorbedMilli: number;
      shieldLostMilli: number;
      healthDamageMilli: number;
    }> = [];
    tm.onDamageApplied = (e) => damageEvents.push(e);

    tm.beginShotAttribution(5, "shooter", "THERMONUCLEAR", 0);
    terrain.destroyTerrain(100, 100, 160, { canCarveRock: true });
    tm.beginLocalNuclearImpact({
      explosionX: 100,
      explosionY: 100,
      radius: 160,
      maxDamage: 180,
      shooterId: "shooter",
      weaponId: "THERMONUCLEAR",
      isDirectHit: false,
      terrain,
      shotId: 5,
      munitionId: 0,
    });

    expect(indirect.tank.isDead).toBe(false);
    expect(indirect.tank.position.y).toBe(100);
    expect(indirect.tank.shield).toBe(0);
    expect(indirect.tank.health).toBeLessThan(250);
    expect(indirect.tank.hitReaction?.wasDirectHit).toBeFalsy();
    expect(indirect.tank.lastDirectAttackerId).toBeUndefined();
    expect(damageEvents).toEqual([
      expect.objectContaining({
        source: "projectile",
        classification: "indirect",
        shieldAbsorbedMilli: 40_000,
        shieldLostMilli: 40_000,
        healthDamageMilli: 27_500,
      }),
    ]);

    tm.updateTankPositions(terrain);
    tm.checkTankBurial(terrain);
    for (let step = 0; step < 600 && tm.anyTankIsFalling(); step++) {
      tm.applyGravity(1 / 120, terrain);
      tm.checkTankBurial(terrain);
    }

    const falls = damageEvents.filter((event) => event.source === "fall");
    expect(falls.length).toBeGreaterThan(0);
    expect(falls.every((event) => event.classification === "indirect")).toBe(true);
    expect(damageEvents.filter((event) => event.source === "projectile")).toHaveLength(1);
    expect(damageEvents[0]?.source).toBe("projectile");
  });

  it("applies NUKE splash before a fall onto the carved circle (#302 shot 99)", () => {
    const terrain = new TerrainManager(500, 500);
    terrain.loadHeights(Array.from({ length: 500 }, () => 375));
    terrain.setMaterialRange(0, 499, "ROCK");

    const tank = makeTank("t-near", 315, 375, { health: 100, shield: 40, maxShield: 40 });
    const player = makePlayer({ id: "player-1", tank });
    const tm = managerWith(player);
    const damageEvents: Array<{
      victimId: string;
      source: string;
      classification: string;
      healthDamageMilli: number;
    }> = [];
    tm.onDamageApplied = (e) => damageEvents.push(e);

    tm.beginShotAttribution(99, "player-4", "NUKE", 0);
    terrain.destroyTerrain(275, 367, 62, { canCarveRock: true });
    tm.beginLocalNuclearImpact({
      explosionX: 275,
      explosionY: 367,
      radius: 62,
      maxDamage: 113,
      shooterId: "player-4",
      weaponId: "NUKE",
      isDirectHit: false,
      terrain,
      shotId: 99,
      munitionId: 0,
    });

    expect(tank.position.y).toBe(375);
    expect(tank.isDead).toBe(false);
    expect(tank.health).toBe(100);
    expect(tank.shield).toBeGreaterThan(0);
    expect(tank.shield).toBeLessThan(40);
    expect(damageEvents).toEqual([
      expect.objectContaining({
        victimId: "player-1",
        source: "projectile",
        classification: "indirect",
        healthDamageMilli: 0,
      }),
    ]);

    tm.updateTankPositions(terrain);
    tm.checkTankBurial(terrain);
    for (let step = 0; step < 600 && tm.anyTankIsFalling(); step++) {
      tm.applyGravity(1 / 120, terrain);
      tm.checkTankBurial(terrain);
    }

    expect(tank.position.y).toBeGreaterThan(375);
    expect(tank.isDead).toBe(false);
    expect(damageEvents.filter((event) => event.source === "projectile")).toHaveLength(1);
    const falls = damageEvents.filter((event) => event.source === "fall");
    expect(falls.length).toBeGreaterThan(0);
    expect(falls.every((event) => event.classification === "indirect")).toBe(true);
  });

  it("applies one projectile hit before burial and does not blast again after death", () => {
    const terrain = new TerrainManager(300, 200);
    terrain.loadHeights(Array.from({ length: 300 }, () => 185));
    terrain.setMaterialRange(0, 299, "ROCK");

    const victim = makePlayer({
      id: "lava-victim",
      tank: makeTank("t-lava", 150, 185, { health: 100, shield: 40, maxShield: 40 }),
    });
    const tm = managerWith(victim);
    const damageEvents: Array<{ source: string }> = [];
    const destructionEvents: Array<{ cause: string }> = [];
    tm.onDamageApplied = (e) => damageEvents.push(e);
    tm.onTankDestroyed = (e) => destructionEvents.push(e);

    tm.beginShotAttribution(2, "shooter", "NUKE", 0);
    terrain.destroyTerrain(150, 185, 62, { canCarveRock: true });
    tm.beginLocalNuclearImpact({
      explosionX: 150,
      explosionY: 185,
      radius: 62,
      maxDamage: 113,
      shooterId: "shooter",
      weaponId: "NUKE",
      isDirectHit: false,
      terrain,
      shotId: 2,
      munitionId: 0,
    });

    expect(victim.tank.isDead).toBe(false);
    expect(victim.tank.health).toBeLessThan(100);
    expect(damageEvents.filter((event) => event.source === "projectile")).toHaveLength(1);

    tm.updateTankPositions(terrain);
    tm.checkTankBurial(terrain);
    for (let step = 0; step < 600 && tm.anyTankIsFalling(); step++) {
      tm.applyGravity(1 / 120, terrain);
      tm.checkTankBurial(terrain);
    }

    expect(victim.tank.isDead).toBe(true);
    expect(destructionEvents).toHaveLength(1);
    expect(["buried", "lava", "health-zero"]).toContain(destructionEvents[0]?.cause);
    expect(damageEvents.filter((event) => event.source === "projectile")).toHaveLength(1);
  });
});
