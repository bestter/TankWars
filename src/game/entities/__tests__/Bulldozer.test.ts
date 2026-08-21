import { describe, it, expect, vi } from "vitest";
import { PhysicsEngine } from "../../engine/PhysicsEngine";
import { TankManager } from "../TankManager";
import { TerrainManager } from "../../engine/Terrain";
import { makePlayer, makeTank } from "../../__tests__/helpers";
import {
  BULLDOZER_PUSH_FACTOR,
  MAX_BULLDOZER_PUSH,
  WEAPON_REGISTRY,
} from "../../../types/weapon";
import { TERRAIN_MATERIAL } from "../../../types/terrain";

function mockCustomTerrain(heightMap: (x: number) => number, width = 800, height = 480): TerrainManager {
  return {
    width,
    height,
    checkCollision: (x: number, y: number) => y >= heightMap(x),
    destroyTerrain: vi.fn(),
    destroyTerrainShaft: vi.fn(),
    getHeightAt: (x: number) => heightMap(x),
    getMaterialAt: () => TERRAIN_MATERIAL.DIRT,
    isBlastOccludedByRock: () => false,
    lavaTop: 474,
  } as unknown as TerrainManager;
}

describe("Bulldozer Weapon & Displacement Mechanics", () => {
  describe("WEAPON_REGISTRY definition", () => {
    it("has correct parameters for BULLDOZER", () => {
      const def = WEAPON_REGISTRY.BULLDOZER;
      expect(def).toBeDefined();
      expect(def.name).toBe("Bulldozer");
      expect(def.price).toBe(150);
      expect(def.damage).toBe(0);
      expect(def.blastRadius).toBe(0);
      expect(def.physicsType).toBe("projectile");
      expect(def.defaultAmmo).toBe(2);
      expect(BULLDOZER_PUSH_FACTOR).toBe(0.25);
    });
  });

  describe("TankManager.applyBulldozerDisplacement", () => {
    it("displaces a tank horizontally on flat ground by the requested distance", () => {
      const target = makePlayer({ id: "p1", tank: makeTank("t1", 200, 300) });
      const tanks = new TankManager();
      tanks.setPlayers([target]);
      const terrain = mockCustomTerrain(() => 300);

      const actualDist = tanks.applyBulldozerDisplacement("p1", 1, 50, terrain);
      expect(actualDist).toBe(50);
      expect(target.tank.position.x).toBe(250);
      expect(target.tank.position.y).toBe(300);
    });

    it("climbs a gentle slope (slope <= BULLDOZER_MAX_CLIMB_SLOPE)", () => {
      // Slope: rises 0.5px per 1px horizontal (deltaY = 0.5 <= 1.0)
      const target = makePlayer({ id: "p1", tank: makeTank("t1", 200, 300) });
      const tanks = new TankManager();
      tanks.setPlayers([target]);
      const terrain = mockCustomTerrain((x) => 300 - (x - 200) * 0.5);

      const actualDist = tanks.applyBulldozerDisplacement("p1", 1, 40, terrain);
      expect(actualDist).toBe(40);
      expect(target.tank.position.x).toBe(240);
      expect(target.tank.position.y).toBe(300 - 40 * 0.5); // 280
    });

    it("stops immediately at the base of a steep wall or cliff (slope > BULLDOZER_MAX_CLIMB_SLOPE)", () => {
      // Flat at y=300 for x < 230, then vertical cliff at x=230 rising to y=200
      const target = makePlayer({ id: "p1", tank: makeTank("t1", 200, 300) });
      const tanks = new TankManager();
      tanks.setPlayers([target]);
      const terrain = mockCustomTerrain((x) => (x < 230 ? 300 : 200));

      const actualDist = tanks.applyBulldozerDisplacement("p1", 1, 60, terrain);
      expect(target.tank.position.x).toBe(229);
      expect(actualDist).toBe(29);
    });

    it("stops before overlapping another alive tank (< 24px)", () => {
      const target = makePlayer({ id: "p1", tank: makeTank("t1", 200, 300) });
      const obstacleTank = makePlayer({ id: "p2", tank: makeTank("t2", 240, 300) });
      const tanks = new TankManager();
      tanks.setPlayers([target, obstacleTank]);
      const terrain = mockCustomTerrain(() => 300);

      // Distance is 40px, tank width is 24px -> can move at most 16px before reaching 24px distance
      const actualDist = tanks.applyBulldozerDisplacement("p1", 1, 50, terrain);
      expect(target.tank.position.x).toBe(216); // 240 - 24 = 216
      expect(actualDist).toBe(16);
    });

    it("ignores dead tanks during collision checks", () => {
      const target = makePlayer({ id: "p1", tank: makeTank("t1", 200, 300) });
      const deadTank = makePlayer({ id: "p2", tank: makeTank("t2", 240, 300, { isDead: true }) });
      const tanks = new TankManager();
      tanks.setPlayers([target, deadTank]);
      const terrain = mockCustomTerrain(() => 300);

      const actualDist = tanks.applyBulldozerDisplacement("p1", 1, 50, terrain);
      expect(actualDist).toBe(50);
      expect(target.tank.position.x).toBe(250);
    });

    it("allows movement beyond map edge and checkTankBurial eliminates the tank", () => {
      const target = makePlayer({ id: "p1", tank: makeTank("t1", 20, 300) });
      const tanks = new TankManager();
      tanks.setPlayers([target]);
      const terrain = mockCustomTerrain(() => 300, 800, 480);

      tanks.applyBulldozerDisplacement("p1", -1, 40, terrain);
      expect(target.tank.position.x).toBe(-20);

      const onDied = vi.fn();
      tanks.onPlayerDied = onDied;
      tanks.checkTankBurial(terrain);

      expect(target.tank.isDead).toBe(true);
      expect(onDied).toHaveBeenCalledWith(
        "p1",
        "burial",
        expect.stringContaining("pushed off map boundary"),
      );
    });

    it("retains independent recoil: obstacle on target does not stop shooter recoil", () => {
      const shooter = makePlayer({ id: "shooter", tank: makeTank("t-shoot", 400, 300) });
      const target = makePlayer({ id: "target", tank: makeTank("t-targ", 200, 300) });
      const tanks = new TankManager();
      tanks.setPlayers([shooter, target]);

      // Cliff right in front of target at x=205 (can move 4px), flat behind shooter
      const terrain = mockCustomTerrain((x) => (x > 204 && x < 300 ? 100 : 300));

      const targetMoved = tanks.applyBulldozerDisplacement("target", 1, 50, terrain);
      const shooterMoved = tanks.applyBulldozerDisplacement("shooter", 1, 50, terrain);

      expect(targetMoved).toBe(4);
      expect(shooterMoved).toBe(50);
    });

    it("follows a gentle downhill slope and snaps Y to the surface", () => {
      const target = makePlayer({ id: "p1", tank: makeTank("t1", 200, 300) });
      const tanks = new TankManager();
      tanks.setPlayers([target]);
      const terrain = mockCustomTerrain((x) => 300 + (x - 200) * 0.5);

      const actualDist = tanks.applyBulldozerDisplacement("p1", 1, 40, terrain);
      expect(actualDist).toBe(40);
      expect(target.tank.position.x).toBe(240);
      expect(target.tank.position.y).toBe(terrain.getHeightAt(240));
    });

    it("stays airborne when pushed over a crater (Y not snapped into the pit)", () => {
      const target = makePlayer({ id: "p1", tank: makeTank("t1", 200, 300) });
      const tanks = new TankManager();
      tanks.setPlayers([target]);
      const terrain = mockCustomTerrain((x) => (x < 230 ? 300 : 380));

      tanks.applyBulldozerDisplacement("p1", 1, 50, terrain);
      expect(target.tank.position.x).toBe(250);
      expect(target.tank.position.y).toBe(300);
      expect(terrain.getHeightAt(250)).toBe(380);
    });
  });

  describe("push over a void: fall damage / lava", () => {
    it("inflicts fall damage after a push over a crater", () => {
      const target = makePlayer({
        id: "p1",
        tank: makeTank("t1", 200, 300, { health: 100, shield: 40, maxShield: 40 }),
      });
      const tanks = new TankManager();
      tanks.setPlayers([target]);
      const terrain = mockCustomTerrain((x) => (x < 230 ? 300 : 380));

      tanks.applyBulldozerDisplacement("p1", 1, 50, terrain);
      tanks.updateTankPositions(terrain);
      for (let i = 0; i < 120; i++) {
        tanks.applyGravity(1 / 60, terrain);
      }

      expect(target.tank.position.x).toBe(250);
      expect(target.tank.health).toBeLessThan(100);
      expect(target.tank.shield).toBe(40);
      expect(target.tank.hitReaction?.fallDistance).toBeGreaterThan(0);
    });

    it("kills on lava after a push over a pit", () => {
      const target = makePlayer({
        id: "p1",
        tank: makeTank("t1", 200, 300, { health: 250, maxHealth: 250, shield: 0 }),
      });
      const tanks = new TankManager();
      tanks.setPlayers([target]);
      const onDied = vi.fn();
      tanks.onPlayerDied = onDied;
      const terrain = mockCustomTerrain((x) => (x < 230 ? 300 : 480), 800, 480);

      tanks.applyBulldozerDisplacement("p1", 1, 50, terrain);
      tanks.updateTankPositions(terrain);
      for (let i = 0; i < 600 && !target.tank.isDead; i++) {
        tanks.applyGravity(1 / 60, terrain);
      }

      expect(target.tank.isDead).toBe(true);
      expect(onDied).toHaveBeenCalledWith(
        "p1",
        "burial",
        expect.stringContaining("lava"),
      );
    });
  });

  describe("PhysicsEngine Bulldozer projectile interaction", () => {
    it("applies symmetrical push and recoil on direct tank hit", () => {
      const shooter = makePlayer({ id: "shooter", tank: makeTank("t-shoot", 100, 300) });
      const target = makePlayer({ id: "target", tank: makeTank("t-targ", 300, 300) });
      const tanks = new TankManager();
      tanks.setPlayers([shooter, target]);
      const terrain = mockCustomTerrain(() => 300);

      const physics = new PhysicsEngine();
      // Launch Bulldozer moving right with vx = 200
      physics.launchProjectile(290, 295, 0, 10, "BULLDOZER", "shooter");

      const proj = physics.getProjectiles()[0];
      proj.x = 300;
      proj.y = 295;
      proj.vx = 200;
      proj.hasLeftOwnerHitbox = true;

      physics.updateProjectiles(1 / 120, 0, 0, terrain, tanks);

      // Symmetrical push ~49.88px
      const targetPush = target.tank.position.x - 300;
      const shooterRecoil = 100 - shooter.tank.position.x;
      expect(targetPush).toBeCloseTo(shooterRecoil, 5);
      expect(targetPush).toBeCloseTo(50, 0);
    });

    it("clamps push distance to MAX_BULLDOZER_PUSH for high velocity hits", () => {
      const shooter = makePlayer({ id: "shooter", tank: makeTank("t-shoot", 200, 300) });
      const target = makePlayer({ id: "target", tank: makeTank("t-targ", 400, 300) });
      const tanks = new TankManager();
      tanks.setPlayers([shooter, target]);
      const terrain = mockCustomTerrain(() => 300);

      const physics = new PhysicsEngine();
      physics.launchProjectile(390, 295, 0, 10, "BULLDOZER", "shooter");

      const proj = physics.getProjectiles()[0];
      proj.x = 400;
      proj.y = 295;
      proj.vx = 800; // 800 * 0.25 = 200 -> clamped to 120
      proj.hasLeftOwnerHitbox = true;

      physics.updateProjectiles(1 / 120, 0, 0, terrain, tanks);

      expect(target.tank.position.x).toBe(400 + MAX_BULLDOZER_PUSH);
      expect(shooter.tank.position.x).toBe(200 - MAX_BULLDOZER_PUSH);
    });

    it("produces negligible horizontal push for near-vertical impacts (small vx)", () => {
      const shooter = makePlayer({ id: "shooter", tank: makeTank("t-shoot", 200, 300) });
      const target = makePlayer({ id: "target", tank: makeTank("t-targ", 300, 300) });
      const tanks = new TankManager();
      tanks.setPlayers([shooter, target]);
      const terrain = mockCustomTerrain(() => 300);

      const physics = new PhysicsEngine();
      physics.launchProjectile(295, 290, 89, 5, "BULLDOZER", "shooter");

      const proj = physics.getProjectiles()[0];
      proj.x = 300;
      proj.y = 295;
      proj.vx = 4; // small vx -> push < 1px
      proj.vy = 200;
      proj.hasLeftOwnerHitbox = true;

      physics.updateProjectiles(1 / 120, 0, 0, terrain, tanks);

      const targetPush = target.tank.position.x - 300;
      expect(targetPush).toBeLessThan(1.0);
      expect(targetPush).toBeGreaterThan(0);
    });

    it("does not displace any tanks when hitting terrain only", () => {
      const shooter = makePlayer({ id: "shooter", tank: makeTank("t-shoot", 200, 300) });
      const target = makePlayer({ id: "target", tank: makeTank("t-targ", 400, 300) });
      const tanks = new TankManager();
      tanks.setPlayers([shooter, target]);

      const destroyTerrain = vi.fn();
      const terrain = mockCustomTerrain(() => 300);
      terrain.checkCollision = (_x, y) => y >= 300;
      terrain.destroyTerrain = destroyTerrain;

      const physics = new PhysicsEngine();
      physics.launchProjectile(250, 200, 45, 5, "BULLDOZER", "shooter");

      const proj = physics.getProjectiles()[0];
      proj.x = 260;
      proj.y = 300; // hits ground at 260, no tank there
      proj.vx = 150;
      proj.hasLeftOwnerHitbox = true;

      physics.updateProjectiles(1 / 120, 0, 0, terrain, tanks);

      expect(target.tank.position.x).toBe(400);
      expect(shooter.tank.position.x).toBe(200);
      expect(destroyTerrain).not.toHaveBeenCalled();
    });

    it("cancels forces on self-hit (Option A: net 0 displacement)", () => {
      const shooter = makePlayer({ id: "shooter", tank: makeTank("t-shoot", 200, 300) });
      const tanks = new TankManager();
      tanks.setPlayers([shooter]);
      const terrain = mockCustomTerrain(() => 300);

      const physics = new PhysicsEngine();
      physics.launchProjectile(200, 200, 90, 5, "BULLDOZER", "shooter");

      const proj = physics.getProjectiles()[0];
      proj.x = 200;
      proj.y = 295;
      proj.vx = 100;
      proj.hasLeftOwnerHitbox = true; // shell was blown back into owner

      physics.updateProjectiles(1 / 120, 0, 0, terrain, tanks);

      expect(shooter.tank.position.x).toBe(200);
    });
  });
});
