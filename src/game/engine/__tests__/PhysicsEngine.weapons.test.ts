import { describe, it, expect, vi, afterEach } from "vitest";
import { PhysicsEngine } from "../PhysicsEngine";
import { TankManager } from "../../entities/TankManager";
import { TerrainManager } from "../Terrain";
import { makePlayer, makeTank } from "../../__tests__/helpers";
import { DRILLER_SHAFT_DEPTH } from "../../../types/weapon";
import { TERRAIN_MATERIAL } from "../../../types/terrain";
import * as random from "../../../utils/random";

function mockTerrain(overrides: Partial<TerrainManager> = {}): TerrainManager {
  return {
    width: 800,
    height: 480,
    checkCollision: () => false,
    destroyTerrain: vi.fn(),
    destroyTerrainShaft: vi.fn(),
    getHeightAt: () => 400,
    getMaterialAt: () => TERRAIN_MATERIAL.DIRT,
    isBlastOccludedByRock: () => false,
    ...overrides,
  } as unknown as TerrainManager;
}

describe("PhysicsEngine weapon behavior", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignores the owner hitbox until the shell leaves it, then can hit others", () => {
    const owner = makePlayer({
      id: "owner",
      tank: makeTank("t-owner", 100, 200),
    });
    const enemy = makePlayer({
      id: "enemy",
      tank: makeTank("t-enemy", 200, 200),
    });
    const tanks = new TankManager();
    tanks.setPlayers([owner, enemy]);
    const apply = vi.spyOn(tanks, "applyExplosionDamage");

    const physics = new PhysicsEngine();
    physics.launchProjectile(100, 195, 0, 10, "MISSILE", "owner");

    const terrain = mockTerrain();
    physics.updateProjectiles(1 / 120, 0, 0, terrain, tanks);
    expect(apply).not.toHaveBeenCalled();
    expect(physics.count).toBe(1);

    const shell = physics.getProjectiles()[0];
    shell.x = 200;
    shell.y = 195;
    physics.updateProjectiles(1 / 120, 0, 0, terrain, tanks);

    expect(apply).toHaveBeenCalled();
    expect(physics.count).toBe(0);
  });

  it("explodes on a tank before checking terrain", () => {
    const enemy = makePlayer({
      id: "enemy",
      tank: makeTank("t-enemy", 200, 200),
    });
    const tanks = new TankManager();
    tanks.setPlayers([enemy]);
    const apply = vi.spyOn(tanks, "applyExplosionDamage");
    const destroy = vi.fn();

    const physics = new PhysicsEngine();
    physics.launchProjectile(200, 195, 0, 1, "MISSILE", "owner");

    physics.updateProjectiles(
      1 / 120,
      0,
      0,
      mockTerrain({ checkCollision: () => true, destroyTerrain: destroy }),
      tanks,
    );

    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        explosionX: expect.any(Number),
        explosionY: expect.any(Number),
        radius: 28,
        maxDamage: 35,
        shooterId: "owner",
        weaponId: "MISSILE",
        isDirectHit: true,
        terrain: expect.anything(),
      }),
    );
    expect(destroy).toHaveBeenCalled();
  });

  it("bounces a grenade on terrain then detonates after max bounces", () => {
    const destroy = vi.fn();
    const terrain = mockTerrain({
      checkCollision: () => true,
      destroyTerrain: destroy,
      getHeightAt: () => 300,
    });
    const physics = new PhysicsEngine();
    physics.launchProjectile(100, 290, 45, 80, "GRENADE", "owner");

    for (let i = 0; i < 12 && physics.hasActiveProjectiles(); i++) {
      physics.updateProjectiles(1 / 60, 260, 0, terrain);
    }

    expect(destroy).toHaveBeenCalled();
    expect(physics.count).toBe(0);
  });

  it("detonates a grenade on first contact with SOFT sand", () => {
    const destroy = vi.fn();
    const terrain = mockTerrain({
      checkCollision: () => true,
      destroyTerrain: destroy,
      getHeightAt: () => 300,
      getMaterialAt: () => TERRAIN_MATERIAL.SOFT,
    });
    const physics = new PhysicsEngine();
    physics.launchProjectile(100, 290, 45, 80, "GRENADE", "owner");
    physics.updateProjectiles(1 / 60, 260, 0, terrain);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(physics.count).toBe(0);
  });

  it("bounces a grenade about twice as high on ROCK as on DIRT", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0.5);

    const bounceOnce = (material: (typeof TERRAIN_MATERIAL)[keyof typeof TERRAIN_MATERIAL]) => {
      const physics = new PhysicsEngine();
      const terrain = mockTerrain({
        checkCollision: () => true,
        getHeightAt: () => 300,
        getMaterialAt: () => material,
      });
      physics.launchProjectile(100, 290, 45, 80, "GRENADE", "owner");
      const shell = physics.getProjectiles()[0];
      shell.vx = 4;
      shell.vy = 10;
      physics.updateProjectiles(1 / 60, 260, 0, terrain);
      return physics.getProjectiles()[0]?.vy ?? 0;
    };

    const vyDirt = bounceOnce(TERRAIN_MATERIAL.DIRT);
    const vyRock = bounceOnce(TERRAIN_MATERIAL.ROCK);

    expect(vyDirt).toBeLessThan(0);
    expect(vyRock).toBeLessThan(0);
    expect(Math.abs(vyRock) / Math.abs(vyDirt)).toBeCloseTo(Math.SQRT2, 1);
  });

  it("explodes a grenade immediately on a direct tank hit", () => {
    const enemy = makePlayer({
      id: "enemy",
      tank: makeTank("t-enemy", 200, 200),
    });
    const tanks = new TankManager();
    tanks.setPlayers([enemy]);
    const apply = vi.spyOn(tanks, "applyExplosionDamage");

    const physics = new PhysicsEngine();
    physics.launchProjectile(200, 195, 0, 20, "GRENADE", "owner");
    physics.updateProjectiles(1 / 120, 0, 0, mockTerrain(), tanks);

    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        explosionX: expect.any(Number),
        explosionY: expect.any(Number),
        radius: 24,
        maxDamage: 28,
        shooterId: "owner",
        weaponId: "GRENADE",
        isDirectHit: true,
        terrain: expect.anything(),
      }),
    );
    expect(physics.count).toBe(0);
  });

  it("splits a CLUSTER parent at apex into 5 submunitions", () => {
    const physics = new PhysicsEngine();
    physics.launchProjectile(200, 100, 90, 80, "CLUSTER", "owner");
    const parent = physics.getProjectiles()[0];
    parent.vy = -0.01;
    parent.lastVy = -2;

    physics.updateProjectiles(1 / 120, 260, 0, mockTerrain());

    expect(physics.count).toBe(5);
    expect(physics.getProjectiles().every((p) => p.isSubmunition === true)).toBe(true);
    expect(physics.getProjectiles().every((p) => p.weaponId === "CLUSTER")).toBe(true);
    expect(new Set(physics.getProjectiles().map((p) => p.shotId)).size).toBe(1);
    expect(new Set(physics.getProjectiles().map((p) => p.munitionId)).size).toBe(5);
  });

  it("DRILLER carves an angled shaft but keeps current splash damage", () => {
    const enemy = makePlayer({
      id: "enemy",
      tank: makeTank("t-enemy", 200, 200),
    });
    const tanks = new TankManager();
    tanks.setPlayers([enemy]);
    const apply = vi.spyOn(tanks, "applyExplosionDamage");
    const destroy = vi.fn();
    const shaft = vi.fn();

    const physics = new PhysicsEngine();
    physics.launchProjectile(200, 195, 0, 20, "DRILLER", "owner");
    const shell = physics.getProjectiles()[0];
    shell.vx = 8;
    shell.vy = 8;

    physics.updateProjectiles(
      1 / 120,
      0,
      0,
      mockTerrain({ checkCollision: () => true, destroyTerrain: destroy, destroyTerrainShaft: shaft }),
      tanks,
    );

    expect(destroy).not.toHaveBeenCalled();
    expect(shaft).toHaveBeenCalledTimes(1);
    const [, , dirX, dirY, depth, radius] = shaft.mock.calls[0] as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    expect(dirY).toBeGreaterThan(0);
    expect(depth).toBe(DRILLER_SHAFT_DEPTH);
    expect(radius).toBe(14);
    void dirX;

    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        explosionX: expect.any(Number),
        explosionY: expect.any(Number),
        radius: 14,
        maxDamage: 42,
        shooterId: "owner",
        weaponId: "DRILLER",
        isDirectHit: true,
        terrain: expect.anything(),
      }),
    );
    expect(physics.count).toBe(0);
  });
});
