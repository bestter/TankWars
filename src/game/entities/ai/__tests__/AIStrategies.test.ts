import { describe, it, expect, vi, afterEach } from "vitest";
import { AISniperStrategy } from "../AISniperStrategy";
import { AIHeuristicStrategy } from "../AIHeuristicStrategy";
import { AISmartStrategy } from "../AISmartStrategy";
import { AISimpleStrategy } from "../AISimpleStrategy";
import { TerrainManager } from "../../../engine/Terrain";
import { simulateShot } from "../BallisticsSimulator";
import { makeGameState, makePlayer, makeTank, flatTerrain } from "../../../__tests__/helpers";
import * as random from "../../../../utils/random";
import type { GameState } from "../../../../types/game";
import type { Player } from "../../../../types/player";

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

  it("AISimpleStrategy is alcoholic on manche 1 (full random, can aim at self)", async () => {
    const strategy = new AISimpleStrategy();
    const gameState = {
      ...makeGameState({ ...aiShooter, aiProfile: "v1-random" }, enemy, "v1-random"),
      roundNumber: 1,
    };
    const spy = vi.spyOn(random, "secureRandom");
    spy.mockReturnValueOnce(0.15).mockReturnValue(0);
    const shot = await strategy.executeTurn("shooter-tank", gameState, terrain);
    expect(shot.angle).toBe(0);
    expect(shot.power).toBe(5);
    spy.mockRestore();
  });

  it("AISimpleStrategy uses current spec from manche 5", async () => {
    const strategy = new AISimpleStrategy();
    const gameState = {
      ...makeGameState({ ...aiShooter, aiProfile: "v1-random" }, enemy, "v1-random"),
      roundNumber: 5,
    };
    const shot = await strategy.executeTurn("shooter-tank", gameState, terrain);
    expect(shot.angle).toBeGreaterThanOrEqual(45);
    expect(shot.power).toBeGreaterThanOrEqual(60);
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

    // First roll = NUKE (0.19 < 0.20). Later rolls skip personality gaffes.
    vi.spyOn(random, "secureRandom")
      .mockReturnValueOnce(0.19)
      .mockReturnValue(0.99);
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

  it("heuristic does not pick CLUSTER against an isolated target", async () => {
    const terrain = flatTerrain(800, 480);
    const strategy = new AIHeuristicStrategy();
    const shooter = makePlayer({
      id: "ai",
      isHuman: false,
      aiProfile: "v2-heuristic",
      tank: makeTank("shooter-tank", 80, 310),
      inventory: { CLUSTER: 2 },
    });
    const isolated = makePlayer({
      id: "enemy",
      tank: makeTank("enemy-tank", 500, 310),
    });
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const shot = await strategy.executeTurn(
      "shooter-tank",
      makeGameState({ ...shooter, aiProfile: "v2-heuristic" }, isolated, "v2-heuristic"),
      terrain,
    );
    expect(shot.weaponId).not.toBe("CLUSTER");
  });
});

describe("AI fallibility contracts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sniper first shot uses MISSILE and lands a safe miss (≥50px)", async () => {
    const terrain = flatTerrain(800, 480);
    const strategy = new AISniperStrategy();
    const shooter = makePlayer({
      id: "ai",
      isHuman: false,
      aiProfile: "v3-sniper",
      tank: makeTank("shooter-tank", 80, 336),
      inventory: { BULLET: 4, DRILLER: 1 },
    });
    const enemy = makePlayer({
      id: "enemy",
      tank: makeTank("enemy-tank", 500, 336),
    });
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const gameState = makeGameState(
      { ...shooter, aiProfile: "v3-sniper" },
      enemy,
      "v3-sniper",
    );
    const shot = await strategy.executeTurn("shooter-tank", gameState, terrain);
    expect(shot.weaponId).toBe("MISSILE");

    const impact = simulateShot(
      80,
      336,
      shot.angle,
      shot.power,
      gameState.windForce,
      gameState.gravity,
      terrain,
    );
    expect(Math.abs(impact.landX - 500)).toBeGreaterThanOrEqual(50);
  });

  it("smart prefers a healthy AI over a wounded human", async () => {
    const terrain = flatTerrain(800, 480);
    const strategy = new AISmartStrategy();
    const shooter: Player = makePlayer({
      id: "ai",
      name: "Expert",
      isHuman: false,
      aiProfile: "v4-smart",
      tank: makeTank("shooter-tank", 80, 336),
      inventory: { MISSILE: 99 },
    });
    const woundedHuman = makePlayer({
      id: "human",
      name: "Human",
      isHuman: true,
      tank: makeTank("human-tank", 560, 336, { health: 20, shield: 0 }),
    });
    const healthyAi = makePlayer({
      id: "other-ai",
      name: "OtherAI",
      isHuman: false,
      tank: makeTank("other-ai-tank", 240, 336, { health: 100, shield: 0 }),
    });
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const gameState: GameState = {
      phase: "COMBAT",
      players: [
        { ...shooter, isHuman: false, aiProfile: "v4-smart" },
        woundedHuman,
        healthyAi,
      ],
      currentPlayerIndex: 0,
      turn: 1,
      windForce: 0,
      gravity: 260,
    };
    const shot = await strategy.executeTurn("shooter-tank", gameState, terrain);
    const impact = simulateShot(
      80,
      336,
      shot.angle,
      shot.power,
      0,
      260,
      terrain,
    );
    // First-shot expert offset is ≥36 px around the AI at x=240, not the human at 560.
    expect(Math.abs(impact.landX - 240)).toBeLessThan(90);
    expect(Math.abs(impact.landX - 560)).toBeGreaterThan(150);
  });
});
