import { describe, it, expect } from "vitest";
import { AISniperStrategy } from "../AISniperStrategy";
import { AIHeuristicStrategy } from "../AIHeuristicStrategy";
import { AISmartStrategy } from "../AISmartStrategy";
import { TerrainManager } from "../../../engine/Terrain";
import { makeGameState, makePlayer, makeTank } from "../../../__tests__/helpers";

describe("AI strategy executeTurn smoke", () => {
  const terrain = new TerrainManager(800, 480);
  terrain.generate();

  const aiShooter = makePlayer({
    id: "ai",
    name: "Shooter",
    isHuman: false,
    tank: makeTank("shooter-tank", 160, 310, { currentWeapon: "MISSILE" }),
    inventory: { MISSILE: 99, GRENADE: 2, BULLET: 2, DRILLER: 1, NUKE: 1 },
  });

  const enemy = makePlayer({
    id: "enemy",
    name: "Enemy",
    isHuman: true,
    tank: makeTank("enemy-tank", 600, 310),
  });

  it("AISniperStrategy returns a calibrated shot", async () => {
    const strategy = new AISniperStrategy();
    const gameState = makeGameState(
      { ...aiShooter, aiProfile: "v3-sniper" },
      enemy,
      "v3-sniper",
    );

    const shot = await strategy.executeTurn("shooter-tank", gameState, terrain);

    expect(shot.angle).toBeGreaterThan(0);
    expect(shot.power).toBeGreaterThan(20);
    expect(["MISSILE", "BULLET", "DRILLER"]).toContain(shot.weaponId);
  });

  it("AIHeuristicStrategy returns angle and weapon for heuristic profile", async () => {
    const strategy = new AIHeuristicStrategy();
    const gameState = makeGameState(
      { ...aiShooter, aiProfile: "v2-heuristic" },
      enemy,
      "v2-heuristic",
    );

    const shot = await strategy.executeTurn("shooter-tank", gameState, terrain);

    expect(shot.angle).toBeGreaterThan(0);
    expect(shot.power).toBeGreaterThan(25);
    expect(shot.weaponId).toBeDefined();
  });

  it("AISmartStrategy returns tactical shot for expert profile", async () => {
    const strategy = new AISmartStrategy();
    const gameState = makeGameState(
      {
        ...aiShooter,
        aiProfile: "v4-smart",
        inventory: {
          MISSILE: 99,
          GRENADE: 2,
          CLUSTER: 1,
          NUKE: 1,
          THERMONUCLEAR: 1,
          DRILLER: 1,
        },
      },
      enemy,
      "v4-smart",
    );

    const shot = await strategy.executeTurn("shooter-tank", gameState, terrain);

    expect(shot.angle).toBeGreaterThan(0);
    expect(shot.power).toBeGreaterThan(20);
    expect(shot.weaponId).toBeDefined();
  });
});