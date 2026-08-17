import { describe, it, expect, vi, afterEach } from "vitest";
import { AISniperStrategy } from "../AISniperStrategy";
import { AIHeuristicStrategy } from "../AIHeuristicStrategy";
import { AISmartStrategy } from "../AISmartStrategy";
import { AISimpleStrategy } from "../AISimpleStrategy";
import { TerrainManager } from "../../../engine/Terrain";
import { makeGameState, makePlayer, makeTank, flatTerrain } from "../../../__tests__/helpers";
import * as random from "../../../../utils/random";

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

  it("AISimpleStrategy returns a naive FireCommand", async () => {
    const strategy = new AISimpleStrategy();
    const gameState = makeGameState(
      { ...aiShooter, aiProfile: "v1-random" },
      enemy,
      "v1-random",
    );
    const shot = await strategy.executeTurn("shooter-tank", gameState, terrain);
    expect(shot.angle).toBeGreaterThan(0);
    expect(shot.power).toBeGreaterThan(50);
    expect(shot.weaponId).toBeDefined();
  });
});

describe("AI weapon gates", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("heuristic picks NUKE only when the target is healthy enough and RNG passes", async () => {
    const terrain = flatTerrain(800, 480);
    const strategy = new AIHeuristicStrategy();
    const shooter = makePlayer({
      id: "ai",
      isHuman: false,
      aiProfile: "v2-heuristic",
      tank: makeTank("shooter-tank", 80, 310),
      inventory: { NUKE: 1 },
    });
    const healthy = makePlayer({
      id: "enemy",
      tank: makeTank("enemy-tank", 500, 310, { health: 80, shield: 0 }),
    });

    vi.spyOn(random, "secureRandom").mockReturnValue(0.1);
    const nukeShot = await strategy.executeTurn(
      "shooter-tank",
      makeGameState({ ...shooter, aiProfile: "v2-heuristic" }, healthy, "v2-heuristic"),
      terrain,
    );
    expect(nukeShot.weaponId).toBe("NUKE");

    const weak = makePlayer({
      id: "enemy",
      tank: makeTank("enemy-tank", 500, 310, { health: 10, shield: 0 }),
    });
    const missShot = await strategy.executeTurn(
      "shooter-tank",
      makeGameState({ ...shooter, aiProfile: "v2-heuristic" }, weak, "v2-heuristic"),
      terrain,
    );
    expect(missShot.weaponId).not.toBe("NUKE");
  });

  it("smart skips THERMONUCLEAR when the target is below the health gate", async () => {
    const terrain = flatTerrain(800, 480);
    const strategy = new AISmartStrategy();
    const shooter = makePlayer({
      id: "ai",
      isHuman: false,
      aiProfile: "v4-smart",
      tank: makeTank("shooter-tank", 80, 310),
      inventory: { THERMONUCLEAR: 1, NUKE: 1 },
    });
    const weak = makePlayer({
      id: "enemy",
      tank: makeTank("enemy-tank", 500, 310, { health: 20, shield: 0 }),
    });
    vi.spyOn(random, "secureRandom").mockReturnValue(0.05);
    const shot = await strategy.executeTurn(
      "shooter-tank",
      makeGameState({ ...shooter, aiProfile: "v4-smart" }, weak, "v4-smart"),
      terrain,
    );
    expect(shot.weaponId).not.toBe("THERMONUCLEAR");
  });
});