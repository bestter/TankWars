import { describe, it, expect } from "vitest";
import { resetPlayersForSpawn, type SpawnTerrain } from "../spawnPlacement";
import { TERRAIN_MATERIAL } from "../../../types/terrain";
import { makePlayer, makeTank } from "../../__tests__/helpers";

describe("resetPlayersForSpawn", () => {
  it("preserves identities, money, and inventory", () => {
    const p1 = makePlayer({ id: "p1", name: "Player 1", money: 500, inventory: { MISSILE: 10 } });
    const p2 = makePlayer({ id: "p2", name: "Player 2", money: 100, inventory: { GRENADE: 5 } });

    const terrain: SpawnTerrain = { width: 800, getHeightAt: () => 100, getMaterialAt: () => TERRAIN_MATERIAL.DIRT };

    const result = resetPlayersForSpawn([p1, p2], [100, 700], terrain);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("p1");
    expect(result[0].name).toBe("Player 1");
    expect(result[0].money).toBe(500);
    expect(result[0].inventory).toEqual({ MISSILE: 10 });
    expect(result[0].inventory).not.toBe(p1.inventory); // Check deep copy

    expect(result[1].id).toBe("p2");
    expect(result[1].name).toBe("Player 2");
    expect(result[1].money).toBe(100);
    expect(result[1].inventory).toEqual({ GRENADE: 5 });
    expect(result[1].inventory).not.toBe(p2.inventory); // Check deep copy
  });

  it("updates position and orientation correctly based on terrain width", () => {
    const p1 = makePlayer();
    const p2 = makePlayer();

    const terrain: SpawnTerrain = {
      width: 800,
      getHeightAt: (x: number) => x === 100 ? 150 : 250,
      getMaterialAt: () => TERRAIN_MATERIAL.DIRT
    };

    const result = resetPlayersForSpawn([p1, p2], [100, 700], terrain);

    expect(result[0].tank.position).toEqual({ x: 100, y: 150 });
    expect(result[0].tank.angle).toBe(45); // Left side

    expect(result[1].tank.position).toEqual({ x: 700, y: 250 });
    expect(result[1].tank.angle).toBe(135); // Right side
  });

  it("restores health, shield, and isDead status", () => {
    const p1 = makePlayer({
      tank: makeTank("t1", 0, 0, { health: 10, maxHealth: 100, isDead: true, shield: 0, maxShield: 50 })
    });

    const terrain: SpawnTerrain = { width: 800, getHeightAt: () => 100, getMaterialAt: () => TERRAIN_MATERIAL.DIRT };
    const result = resetPlayersForSpawn([p1], [100], terrain);

    expect(result[0].tank.isDead).toBe(false);
    expect(result[0].tank.health).toBe(100);
    expect(result[0].tank.shield).toBe(50);
  });

  it("calculates default maxShield if not provided", () => {
    const p1 = makePlayer({
      tank: makeTank("t1", 0, 0, { health: 50, maxHealth: 200, maxShield: undefined })
    });

    const terrain: SpawnTerrain = { width: 800, getHeightAt: () => 100, getMaterialAt: () => TERRAIN_MATERIAL.DIRT };
    const result = resetPlayersForSpawn([p1], [100], terrain);

    // Default should be 40% of maxHealth
    expect(result[0].tank.maxShield).toBe(80);
    expect(result[0].tank.shield).toBe(80);
  });

  it("clears temporary combat state", () => {
    const p1 = makePlayer({
      tank: makeTank("t1", 0, 0, {
        lastHitBy: "p2",
        lastDirectAttackerId: "p2",
        hitReaction: { wasDirectHit: true, fallDistance: 50 },
        power: 100,
        currentWeapon: "NUKE"
      })
    });

    const terrain: SpawnTerrain = { width: 800, getHeightAt: () => 100, getMaterialAt: () => TERRAIN_MATERIAL.DIRT };
    const result = resetPlayersForSpawn([p1], [100], terrain);

    expect(result[0].tank.lastHitBy).toBeUndefined();
    expect(result[0].tank.lastDirectAttackerId).toBeUndefined();
    expect(result[0].tank.hitReaction).toBeUndefined();
    expect(result[0].tank.power).toBe(50);
    expect(result[0].tank.currentWeapon).toBe("MISSILE");
  });
});
