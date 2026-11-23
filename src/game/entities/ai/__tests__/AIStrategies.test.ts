import { describe, it, expect, vi, afterEach } from "vitest";
import { AISniperStrategy } from "../AISniperStrategy";
import { AIHeuristicStrategy } from "../AIHeuristicStrategy";
import { AISmartStrategy } from "../AISmartStrategy";
import {
  AISimpleStrategy,
  getSimpleErrorChances,
} from "../AISimpleStrategy";
import { TerrainManager } from "../../../engine/Terrain";
import { simulateShot } from "../BallisticsSimulator";
import { makeGameState, makePlayer, makeTank, flatTerrain } from "../../../__tests__/helpers";
import {
  finalizeAdvancedAim,
  finalizeSimpleAim,
  interpolateAimCommands,
} from "../aimCorruption";
import * as aimCorruption from "../aimCorruption";
import * as random from "../../../../utils/random";
import * as fallible from "../fallibleAim";
import * as heuristicShot from "../heuristicShot";
import { AIByProfileStrategy } from "../AIByProfileStrategy";
import { autoBuyForAI } from "../aiShopHelper";
import { replenishPlayerFreeWeapons } from "../../../shop/freeWeapons";
import { prepareScenarioRound, type EnduranceScenario } from "../../../endurance/scenario";
import { calculateShotAdvice } from "../shotAdvisor";
import type { GameState } from "../../../../types/game";
import type { Player } from "../../../../types/player";
import { TERRAIN_MATERIAL } from "../../../../types/terrain";
import * as expertEvaluator from "../expertShotEvaluator";
import type { AimMemory } from "../aimMemory";

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

    expect(shot.angle).toBeGreaterThanOrEqual(0);
    expect(shot.angle).toBeLessThanOrEqual(180);
    expect(shot.power).toBeGreaterThanOrEqual(1);
    expect(shot.power).toBeLessThanOrEqual(99);
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

    expect(shot.angle).toBeGreaterThanOrEqual(0);
    expect(shot.angle).toBeLessThanOrEqual(180);
    expect(shot.power).toBeGreaterThanOrEqual(1);
    expect(shot.power).toBeLessThanOrEqual(99);
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

    expect(shot.angle).toBeGreaterThanOrEqual(0);
    expect(shot.angle).toBeLessThanOrEqual(180);
    expect(shot.power).toBeGreaterThanOrEqual(1);
    expect(shot.power).toBeLessThanOrEqual(99);
    expect(shot.weaponId).toBeDefined();
  });

  it("AISimpleStrategy retourne un FireCommand dans son enveloppe", async () => {
    const strategy = new AISimpleStrategy();
    const gameState = makeGameState(
      { ...aiShooter, aiProfile: "v1-random" },
      enemy,
      "v1-random",
    );
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const shot = await strategy.executeTurn("shooter-tank", gameState, terrain);
    expect(shot.angle).toBeGreaterThanOrEqual(0);
    expect(shot.angle).toBeLessThan(180);
    expect(shot.power).toBeGreaterThanOrEqual(1);
    expect(shot.power).toBeLessThanOrEqual(99);
    expect(shot.weaponId).toBeDefined();
  });

  it("AISimpleStrategy court-circuite le solveur pour une grosse gaffe", async () => {
    const strategy = new AISimpleStrategy();
    const shooterWithoutNuclear = {
      ...aiShooter,
      aiProfile: "v1-random" as const,
      inventory: { MISSILE: 99, GRENADE: 2, BULLET: 2, DRILLER: 1 },
    };
    const gameState = {
      ...makeGameState(shooterWithoutNuclear, enemy, "v1-random"),
      roundNumber: 1,
    };
    const spy = vi.spyOn(random, "secureRandom");
    spy
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5);
    const shot = await strategy.executeTurn("shooter-tank", gameState, terrain);
    expect(shot.angle).toBe(90);
    expect(shot.power).toBe(5);
    expect(shot.weaponId).toBe("MISSILE");
    spy.mockRestore();
  });

  it("AISimpleStrategy applique les frontières de probabilités par manche", () => {
    expect(getSimpleErrorChances(1)).toEqual({
      gaffe: 0.5,
      direction: 0.4,
      power: 0.5,
    });
    expect(getSimpleErrorChances(4)).toEqual({
      gaffe: 0.25,
      direction: 0.25,
      power: 0.35,
    });
    expect(getSimpleErrorChances(5)).toEqual({
      gaffe: 0.22,
      direction: 0.22,
      power: 0.3,
    });
    expect(getSimpleErrorChances(10)).toEqual(
      getSimpleErrorChances(5),
    );
    expect(getSimpleErrorChances(11)).toEqual({
      gaffe: 0.2,
      direction: 0.2,
      power: 0.25,
    });
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

  it("heuristic upgrades MISSILE to DRILLER when the target sits on SOFT", async () => {
    const terrain = flatTerrain(800, 480);
    terrain.setMaterialRange(480, 520, TERRAIN_MATERIAL.SOFT);
    const strategy = new AIHeuristicStrategy();
    const shooter = makePlayer({
      id: "ai",
      isHuman: false,
      aiProfile: "v2-heuristic",
      tank: makeTank("shooter-tank", 80, 310),
      inventory: { DRILLER: 1 },
    });
    const target = makePlayer({
      id: "enemy",
      tank: makeTank("enemy-tank", 500, 310),
    });
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const shot = await strategy.executeTurn(
      "shooter-tank",
      makeGameState({ ...shooter, aiProfile: "v2-heuristic" }, target, "v2-heuristic"),
      terrain,
    );
    expect(shot.weaponId).toBe("DRILLER");
  });

  it("sniper never fires DRILLER when the target rests on ROCK", async () => {
    const terrain = flatTerrain(800, 480);
    terrain.setMaterialRange(480, 520, TERRAIN_MATERIAL.ROCK);
    const strategy = new AISniperStrategy();
    const shooter = makePlayer({
      id: "ai",
      isHuman: false,
      aiProfile: "v3-sniper",
      tank: makeTank("shooter-tank", 80, 336),
      inventory: { DRILLER: 1 },
    });
    const target = makePlayer({
      id: "enemy",
      tank: makeTank("enemy-tank", 500, 336),
    });
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const gs = makeGameState(
      { ...shooter, aiProfile: "v3-sniper" },
      target,
      "v3-sniper",
    );
    const first = await strategy.executeTurn("shooter-tank", gs, terrain);
    const second = await strategy.executeTurn("shooter-tank", gs, terrain);
    expect(first.weaponId).not.toBe("DRILLER");
    expect(second.weaponId).not.toBe("DRILLER");
  });

  it("simple v1 does not switch to DRILLER just because the target sits on SOFT", async () => {
    const terrain = flatTerrain(800, 480);
    terrain.setMaterialRange(480, 520, TERRAIN_MATERIAL.SOFT);
    const strategy = new AISimpleStrategy();
    const shooter = makePlayer({
      id: "ai",
      isHuman: false,
      aiProfile: "v1-random",
      tank: makeTank("shooter-tank", 80, 310, { currentWeapon: "MISSILE" }),
      inventory: { DRILLER: 1 },
    });
    const target = makePlayer({
      id: "enemy",
      tank: makeTank("enemy-tank", 500, 310),
    });
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const shot = await strategy.executeTurn(
      "shooter-tank",
      makeGameState({ ...shooter, aiProfile: "v1-random" }, target, "v1-random"),
      terrain,
    );
    expect(shot.weaponId).toBe("MISSILE");
  });

  it("heuristic picks BULLDOZER when the target sits at the map edge", async () => {
    const terrain = flatTerrain(800, 480);
    const strategy = new AIHeuristicStrategy();
    const shooter = makePlayer({
      id: "ai",
      isHuman: false,
      aiProfile: "v2-heuristic",
      tank: makeTank("shooter-tank", 80, 310),
      inventory: { BULLDOZER: 1 },
    });
    const edge = makePlayer({
      id: "enemy",
      tank: makeTank("enemy-tank", 780, 310),
    });
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const shot = await strategy.executeTurn(
      "shooter-tank",
      makeGameState({ ...shooter, aiProfile: "v2-heuristic" }, edge, "v2-heuristic"),
      terrain,
    );
    expect(shot.weaponId).toBe("BULLDOZER");
  });

  it("heuristic does not pick BULLDOZER on flat interior ground", async () => {
    const terrain = flatTerrain(800, 480);
    const strategy = new AIHeuristicStrategy();
    const shooter = makePlayer({
      id: "ai",
      isHuman: false,
      aiProfile: "v2-heuristic",
      tank: makeTank("shooter-tank", 80, 310),
      inventory: { BULLDOZER: 1 },
    });
    const interior = makePlayer({
      id: "enemy",
      tank: makeTank("enemy-tank", 400, 310),
    });
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const shot = await strategy.executeTurn(
      "shooter-tank",
      makeGameState(
        { ...shooter, aiProfile: "v2-heuristic" },
        interior,
        "v2-heuristic",
      ),
      terrain,
    );
    expect(shot.weaponId).not.toBe("BULLDOZER");
  });

  it.each([
    { round: 1, previousAttempts: 0, expected: "BULLDOZER" },
    { round: 12, previousAttempts: 1, expected: "MISSILE" },
  ])("smart fallback compares BULLDOZER and MISSILE after offset at the map edge (round=$round)", async ({ round, previousAttempts, expected }) => {
    const terrain = flatTerrain(800, 480);
    const strategy = new AISmartStrategy();
    const shooter = makePlayer({
      id: "ai",
      isHuman: false,
      aiProfile: "v4-smart",
      tank: makeTank("shooter-tank", 80, 310),
      inventory: { BULLDOZER: 2 },
    });
    const edge = makePlayer({
      id: "enemy",
      tank: makeTank("enemy-tank", 780, 310),
    });
    const memories = (strategy as unknown as { memories: Map<string, AimMemory> }).memories;
    memories.set("ai", { currentTargetId: "enemy", currentTargetAttempts: previousAttempts, lastRoundNumber: round });
    const fallback = vi.spyOn(expertEvaluator, "chooseExpertFallback");
    const rng = vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const shot = await strategy.executeTurn(
      "shooter-tank",
      { ...makeGameState({ ...shooter, aiProfile: "v4-smart" }, edge, "v4-smart"), roundNumber: round },
      terrain,
    );
    expect(shot.weaponId).toBe(expected);
    const choice = fallback.mock.results[0].value as expertEvaluator.ExpertFallbackChoice;
    expect(choice).toMatchObject({ kind: "evaluated", useful: true,
      attempts: previousAttempts + 1, offset: previousAttempts === 0 ? 56.879999999999995 : 0 });
    expect(choice.forecast?.survivors).toContain("ai");
    expect(shot).toEqual({ ...choice.command, weaponId: choice.weaponId });
    const keys = [...fallback.mock.calls[0][5].physics.keys()];
    expect(keys.some((key) => key.includes('"BULLDOZER"'))).toBe(true);
    expect(keys.some((key) => key.includes('"MISSILE"'))).toBe(true);
    expect(rng).toHaveBeenCalledTimes(3); // Both offset draws, even with residual zero, then gaffe.
  });

  it("simple v1 does not switch to BULLDOZER even with stock at the map edge", async () => {
    const terrain = flatTerrain(800, 480);
    const strategy = new AISimpleStrategy();
    const shooter = makePlayer({
      id: "ai",
      isHuman: false,
      aiProfile: "v1-random",
      tank: makeTank("shooter-tank", 80, 310, { currentWeapon: "MISSILE" }),
      inventory: { BULLDOZER: 2 },
    });
    const edge = makePlayer({
      id: "enemy",
      tank: makeTank("enemy-tank", 780, 310),
    });
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const shot = await strategy.executeTurn(
      "shooter-tank",
      makeGameState({ ...shooter, aiProfile: "v1-random" }, edge, "v1-random"),
      terrain,
    );
    expect(shot.weaponId).toBe("MISSILE");
  });
});

describe("AI fallibility contracts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { bulletStock: 4, expectedWeapon: "BULLET" as const },
    { bulletStock: 0, expectedWeapon: "DRILLER" as const },
  ])("sniper first attempt selects $expectedWeapon with BULLET stock $bulletStock and does not spend ammo", async ({ bulletStock, expectedWeapon }) => {
    const terrain = flatTerrain(800, 480);
    const strategy = new AISniperStrategy();
    const shooter = makePlayer({
      id: "ai",
      isHuman: false,
      aiProfile: "v3-sniper",
      tank: makeTank("shooter-tank", 100, 336),
      inventory: { BULLET: bulletStock, DRILLER: 1 },
    });
    const enemy = makePlayer({
      id: "enemy",
      tank: makeTank("enemy-tank", 400, 336),
    });
    // Isolate first-attempt selection while keeping the solver and physics real.
    const offset = vi.spyOn(fallible, "calculateImpactOffsetMagnitude").mockReturnValue(0);
    vi.spyOn(fallible, "maybeGaffe").mockReturnValue(false);
    const gameState = makeGameState(
      { ...shooter, aiProfile: "v3-sniper" },
      enemy,
      "v3-sniper",
    );
    const before = { ...gameState.players[0].inventory };
    const shot = await strategy.executeTurn("shooter-tank", gameState, terrain);
    expect(offset).toHaveBeenCalledTimes(1);
    expect(offset.mock.calls[0]?.[0]).toBe(1);
    expect(shot.weaponId).toBe(expectedWeapon);
    expect(before[expectedWeapon]).toBeGreaterThan(0);
    expect({ angle: shot.angle, power: shot.power }).toEqual(
      finalizeAdvancedAim({ angle: shot.angle, power: shot.power }),
    );
    expect(gameState.players[0].inventory).toEqual(before);
    expect(gameState.players[0].tank.currentWeapon).toBe(expectedWeapon);
  });

  it("smart fallback prefers a healthy AI over a wounded human", async () => {
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

  it("consomme la réaction après une seule riposte", async () => {
    const terrain = flatTerrain(800, 480);
    const shooter = makePlayer({
      id: "ai-shooter",
      isHuman: false,
      aiProfile: "v3-sniper",
      tank: makeTank("shooter-tank", 100, 336, {
        hitReaction: { wasDirectHit: true, fallDistance: 60 },
      }),
    });
    const target = makePlayer({
      id: "target",
      isHuman: true,
      tank: makeTank("target-tank", 500, 336),
    });
    const strategy = new AISniperStrategy();
    const gameState = makeGameState(shooter, target, "v3-sniper");

    await strategy.executeTurn("shooter-tank", gameState, terrain);
    expect(shooter.tank.hitReaction?.wasDirectHit).toBe(false);
    expect(shooter.tank.hitReaction?.fallDistance).toBe(0);
  });
});

describe("AI nuclear combat selection (#429)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function installSequence(values: readonly number[]) {
    const queue = [...values];
    return vi
      .spyOn(random, "secureRandom")
      .mockImplementation(() => queue.shift() ?? 0.99);
  }

  describe("SIMPLE (v1-random)", () => {
    it.each([
      {
        label: "aucune munition nucléaire (0 jet de sélection)",
        inventory: { MISSILE: 99, GRENADE: 2 },
        currentWeapon: "GRENADE" as const,
        rolls: [] as number[],
        expectedWeapon: "GRENADE" as const,
        expectedDraws: 5,
      },
      {
        label: "NUKE seule réussie à 0",
        inventory: { NUKE: 1 },
        currentWeapon: "MISSILE" as const,
        rolls: [0],
        expectedWeapon: "NUKE" as const,
        expectedDraws: 6,
      },
      {
        label: "NUKE seule réussie juste sous le seuil 0.20 (0.1999)",
        inventory: { NUKE: 2 },
        currentWeapon: "MISSILE" as const,
        rolls: [0.1999],
        expectedWeapon: "NUKE" as const,
        expectedDraws: 6,
      },
      {
        label: "NUKE seule ratée exactement à 0.20",
        inventory: { NUKE: 1 },
        currentWeapon: "MISSILE" as const,
        rolls: [0.2],
        expectedWeapon: "MISSILE" as const,
        expectedDraws: 6,
      },
      {
        label: "THERMONUCLEAR seule réussie à 0",
        inventory: { THERMONUCLEAR: 1 },
        currentWeapon: "MISSILE" as const,
        rolls: [0],
        expectedWeapon: "THERMONUCLEAR" as const,
        expectedDraws: 6,
      },
      {
        label: "THERMONUCLEAR seule réussie juste sous 0.10 (0.0999)",
        inventory: { THERMONUCLEAR: 1 },
        currentWeapon: "MISSILE" as const,
        rolls: [0.0999],
        expectedWeapon: "THERMONUCLEAR" as const,
        expectedDraws: 6,
      },
      {
        label: "THERMONUCLEAR seule ratée exactement à 0.10",
        inventory: { THERMONUCLEAR: 1 },
        currentWeapon: "MISSILE" as const,
        rolls: [0.1],
        expectedWeapon: "MISSILE" as const,
        expectedDraws: 6,
      },
      {
        label: "les deux en stock : succès NUKE s'arrête sans jet THERMONUCLEAR",
        inventory: { NUKE: 2, THERMONUCLEAR: 1 },
        currentWeapon: "MISSILE" as const,
        rolls: [0.1999],
        expectedWeapon: "NUKE" as const,
        expectedDraws: 6,
      },
      {
        label: "les deux en stock : échec NUKE à 0.20 puis succès THERMONUCLEAR à 0.0999",
        inventory: { NUKE: 1, THERMONUCLEAR: 1 },
        currentWeapon: "MISSILE" as const,
        rolls: [0.2, 0.0999],
        expectedWeapon: "THERMONUCLEAR" as const,
        expectedDraws: 7,
      },
      {
        label: "les deux en stock : échec NUKE (0.20) puis échec THERMONUCLEAR (0.10)",
        inventory: { NUKE: 1, THERMONUCLEAR: 1, GRENADE: 2 },
        currentWeapon: "GRENADE" as const,
        rolls: [0.2, 0.1],
        expectedWeapon: "GRENADE" as const,
        expectedDraws: 7,
      },
    ])(
      "$label",
      async ({ inventory, currentWeapon, rolls, expectedWeapon, expectedDraws }) => {
        const terrain = flatTerrain(800, 480);
        const strategy = new AISimpleStrategy();
        const shooter = makePlayer({
          id: "ai",
          isHuman: false,
          aiProfile: "v1-random",
          inventory,
          tank: makeTank("shooter-tank", 80, 336, { currentWeapon }),
        });
        const target = makePlayer({
          id: "enemy",
          tank: makeTank("enemy-tank", 500, 336, { health: 80 }),
        });
        const rng = installSequence([...rolls, 0.99, 0.99, 0.99, 0.99, 0.99]);
        const gameState = makeGameState(shooter, target, "v1-random");
        const shot = await strategy.executeTurn(
          "shooter-tank",
          gameState,
          terrain,
        );
        expect(shot.weaponId).toBe(expectedWeapon);
        expect(gameState.players[0].tank.currentWeapon).toBe(expectedWeapon);
        expect(rng).toHaveBeenCalledTimes(expectedDraws);
      },
    );

    it.each([
      {
        label: "NUKE équipée avec stock restant mais jet échoué -> MISSILE",
        inventory: { NUKE: 2 },
        currentWeapon: "NUKE" as const,
        rolls: [0.5],
        expectedDraws: 6,
      },
      {
        label: "NUKE équipée avec stock nul -> MISSILE sans jet",
        inventory: { NUKE: 0 },
        currentWeapon: "NUKE" as const,
        rolls: [] as number[],
        expectedDraws: 5,
      },
      {
        label: "THERMONUCLEAR équipée avec stock restant mais jet échoué -> MISSILE",
        inventory: { THERMONUCLEAR: 1 },
        currentWeapon: "THERMONUCLEAR" as const,
        rolls: [0.2],
        expectedDraws: 6,
      },
      {
        label: "THERMONUCLEAR équipée avec stock nul -> MISSILE sans jet",
        inventory: { THERMONUCLEAR: 0 },
        currentWeapon: "THERMONUCLEAR" as const,
        rolls: [] as number[],
        expectedDraws: 5,
      },
    ])(
      "arme courante nucléaire : $label",
      async ({ inventory, currentWeapon, rolls, expectedDraws }) => {
        const terrain = flatTerrain(800, 480);
        const strategy = new AISimpleStrategy();
        const shooter = makePlayer({
          id: "ai",
          isHuman: false,
          aiProfile: "v1-random",
          inventory,
          tank: makeTank("shooter-tank", 80, 336, { currentWeapon }),
        });
        const target = makePlayer({
          id: "enemy",
          tank: makeTank("enemy-tank", 500, 336),
        });
        const rng = installSequence([...rolls, 0.99, 0.99, 0.99, 0.99, 0.99]);
        const gameState = makeGameState(shooter, target, "v1-random");
        const shot = await strategy.executeTurn(
          "shooter-tank",
          gameState,
          terrain,
        );
        expect(shot.weaponId).toBe("MISSILE");
        expect(gameState.players[0].tank.currentWeapon).toBe("MISSILE");
        expect(rng).toHaveBeenCalledTimes(expectedDraws);
      },
    );

    it("refait les jets nucléaires au tour suivant quand du stock reste", async () => {
      const terrain = flatTerrain(800, 480);
      const strategy = new AISimpleStrategy();
      const shooter = makePlayer({
        id: "ai",
        isHuman: false,
        aiProfile: "v1-random",
        inventory: { NUKE: 2 },
        tank: makeTank("shooter-tank", 80, 336, { currentWeapon: "MISSILE" }),
      });
      const target = makePlayer({
        id: "enemy",
        tank: makeTank("enemy-tank", 500, 336),
      });

      const gameState = makeGameState(shooter, target, "v1-random");
      installSequence([0.1, 0.99, 0.99, 0.99, 0.99, 0.99]);
      const turn1 = await strategy.executeTurn(
        "shooter-tank",
        gameState,
        terrain,
      );
      expect(turn1.weaponId).toBe("NUKE");
      expect(gameState.players[0].tank.currentWeapon).toBe("NUKE");
      // Simule la consommation d'une unité par TurnManager
      gameState.players[0].inventory.NUKE = 1;

      vi.restoreAllMocks();
      const rng2 = installSequence([0.25, 0.99, 0.99, 0.99, 0.99, 0.99]);
      const turn2 = await strategy.executeTurn(
        "shooter-tank",
        { ...gameState, turn: 2 },
        terrain,
      );
      expect(turn2.weaponId).toBe("MISSILE");
      expect(gameState.players[0].tank.currentWeapon).toBe("MISSILE");
      expect(rng2).toHaveBeenCalledTimes(6);
      expect(gameState.players[0].inventory.NUKE).toBe(1);
    });

    it("autorise une cible proche et faible, préserve gaffes/erreurs/réactions et court-circuite le solveur", async () => {
      const terrain = flatTerrain(800, 480);
      const closeWeakTarget = makePlayer({
        id: "enemy",
        tank: makeTank("enemy-tank", 140, 336, { health: 5, shield: 0 }),
      });

      const gaffeStrategy = new AISimpleStrategy();
      const gaffeShooter = makePlayer({
        id: "ai",
        isHuman: false,
        aiProfile: "v1-random",
        inventory: { NUKE: 1, THERMONUCLEAR: 1 },
        tank: makeTank("shooter-tank", 80, 336, {
          currentWeapon: "MISSILE",
          hitReaction: { wasDirectHit: true, fallDistance: 40 },
        }),
      });
      const solverSpy = vi.spyOn(heuristicShot, "computeHeuristicShot");
      const gaffeRng = installSequence([0.2, 0.05, 0, 0.5, 0, 0.5]);
      const gaffeShot = await gaffeStrategy.executeTurn(
        "shooter-tank",
        { ...makeGameState(gaffeShooter, closeWeakTarget, "v1-random"), roundNumber: 1 },
        terrain,
      );
      expect(gaffeShot).toEqual({
        angle: 90,
        power: 5,
        weaponId: "THERMONUCLEAR",
      });
      expect(solverSpy).not.toHaveBeenCalled();
      expect(gaffeRng).toHaveBeenCalledTimes(6);
      expect(gaffeShooter.tank.hitReaction).toEqual({
        wasDirectHit: false,
        fallDistance: 0,
      });

      vi.restoreAllMocks();
      const errorStrategy = new AISimpleStrategy();
      const errorShooter = makePlayer({
        id: "ai",
        isHuman: false,
        aiProfile: "v1-random",
        inventory: { NUKE: 1 },
        tank: makeTank("shooter-tank", 80, 336, {
          currentWeapon: "MISSILE",
          hitReaction: { wasDirectHit: true, fallDistance: 0 },
        }),
      });
      const normalSolverSpy = vi.spyOn(heuristicShot, "computeHeuristicShot");
      // NUKE (0.05) -> no early gaffe (0.99) -> offset (0.5, 0.5)
      // -> dir error (0, -15 via r=0) -> power error (0, +14.97 via r=0.999)
      // -> reaction (0.5, 0.99, 0.99 -> { angle: 90, power: 99 })
      installSequence([0.05, 0.99, 0.5, 0.5, 0, 0, 0, 0.999, 0.5, 0.99, 0.99]);
      const corruptedShot = await errorStrategy.executeTurn(
        "shooter-tank",
        { ...makeGameState(errorShooter, closeWeakTarget, "v1-random"), roundNumber: 5 },
        terrain,
      );
      const solverCommand = normalSolverSpy.mock.results[0].value as {
        angle: number;
        power: number;
      };
      expect(corruptedShot).toEqual({
        ...finalizeSimpleAim(
          interpolateAimCommands(
            {
              angle: solverCommand.angle - 15,
              power: solverCommand.power + 14.97,
            },
            { angle: 90, power: 99 },
            0.28,
          ),
        ),
        weaponId: "NUKE",
      });
      expect(errorShooter.tank.hitReaction).toEqual({
        wasDirectHit: false,
        fallDistance: 0,
      });
    });

    it("conserve les fractions et dépassements temporaires jusqu'à finalizeSimpleAim avec ou sans réaction", async () => {
      const terrain = flatTerrain(800, 480);
      const target = makePlayer({
        id: "enemy",
        tank: makeTank("enemy-tank", 500, 336),
      });

      const runFractionCase = async (params: {
        solver: { angle: number; power: number };
        sequence: readonly number[];
        hitReaction?: { wasDirectHit: boolean; fallDistance: number };
      }) => {
        vi.restoreAllMocks();
        vi.spyOn(heuristicShot, "computeHeuristicShot").mockReturnValue(
          params.solver,
        );
        const interpolateSpy = vi.spyOn(aimCorruption, "interpolateAimCommands");
        const finalizeSpy = vi.spyOn(aimCorruption, "finalizeSimpleAim");
        const shooter = makePlayer({
          id: "ai",
          isHuman: false,
          aiProfile: "v1-random",
          inventory: { MISSILE: 99 },
          tank: makeTank("shooter-tank", 80, 336, {
            currentWeapon: "MISSILE",
            hitReaction: params.hitReaction,
          }),
        });
        const queue = [...params.sequence];
        vi.spyOn(random, "secureRandom").mockImplementation(() => {
          if (queue.length === 0) throw new Error("EXTRA_RNG_DRAW");
          return queue.shift()!;
        });
        const shot = await new AISimpleStrategy().executeTurn(
          "shooter-tank",
          { ...makeGameState(shooter, target, "v1-random"), roundNumber: 5 },
          terrain,
        );
        return {
          shot,
          interpolatedFrom: interpolateSpy.mock.calls[0]?.[0],
          finalizedInput: finalizeSpy.mock.calls[0]?.[0],
        };
      };

      // Angle bas (5 - 15 = -10) : sans réaction finit à 0°, avec réaction -10° est transmis tel quel
      const lowAngleNoReaction = await runFractionCase({
        solver: { angle: 5, power: 50 },
        sequence: [0.99, 0, 0, 0, 0, 0.99],
      });
      expect(lowAngleNoReaction.finalizedInput).toEqual({ angle: -10, power: 50 });
      expect(lowAngleNoReaction.shot).toMatchObject({ angle: 0, power: 50 });

      const lowAngleWithReaction = await runFractionCase({
        solver: { angle: 5, power: 50 },
        sequence: [0.99, 0, 0, 0, 0, 0.99, 0.5, 0.99, 0.99],
        hitReaction: { wasDirectHit: true, fallDistance: 0 },
      });
      expect(lowAngleWithReaction.interpolatedFrom).toEqual({
        angle: -10,
        power: 50,
      });
      expect(lowAngleWithReaction.shot).toMatchObject(
        finalizeSimpleAim(
          interpolateAimCommands(
            { angle: -10, power: 50 },
            { angle: 90, power: 99 },
            0.28,
          ),
        ),
      );

      // Angle haut (175 + 14.97 = 189.97) : sans réaction finit à 179.9°, avec réaction 189.97° est transmis
      const highAngleNoReaction = await runFractionCase({
        solver: { angle: 175, power: 50 },
        sequence: [0.99, 0, 0, 0, 0.999, 0.99],
      });
      expect(highAngleNoReaction.finalizedInput?.angle).toBeCloseTo(189.97, 10);
      expect(highAngleNoReaction.shot).toMatchObject({ angle: 179.9, power: 50 });

      const highAngleWithReaction = await runFractionCase({
        solver: { angle: 175, power: 50 },
        sequence: [0.99, 0, 0, 0, 0.999, 0.99, 0.5, 0, 0],
        hitReaction: { wasDirectHit: true, fallDistance: 0 },
      });
      expect(highAngleWithReaction.interpolatedFrom?.angle).toBeCloseTo(
        189.97,
        10,
      );
      expect(highAngleWithReaction.shot).toMatchObject(
        finalizeSimpleAim(
          interpolateAimCommands(
            { angle: 189.97, power: 50 },
            { angle: 90, power: 1 },
            0.28,
          ),
        ),
      );

      // Fraction de puissance sans réaction : 60 + (-7.5 via r=0.25) = 52.5 -> 53
      const fractionalPower = await runFractionCase({
        solver: { angle: 45, power: 60 },
        sequence: [0.99, 0, 0, 0.99, 0, 0.25],
      });
      expect(fractionalPower.finalizedInput).toEqual({ angle: 45, power: 52.5 });
      expect(fractionalPower.shot).toMatchObject({ angle: 45, power: 53 });

      // Puissance basse (5 - 15 = -10) et puissance haute (95 + 14.97 = 109.97)
      const lowPowerNoReaction = await runFractionCase({
        solver: { angle: 45, power: 5 },
        sequence: [0.99, 0, 0, 0.99, 0, 0],
      });
      expect(lowPowerNoReaction.finalizedInput).toEqual({ angle: 45, power: -10 });
      expect(lowPowerNoReaction.shot).toMatchObject({ angle: 45, power: 1 });

      const lowPowerWithReaction = await runFractionCase({
        solver: { angle: 45, power: 5 },
        sequence: [0.99, 0, 0, 0.99, 0, 0, 0.5, 0.99, 0.99],
        hitReaction: { wasDirectHit: true, fallDistance: 0 },
      });
      expect(lowPowerWithReaction.interpolatedFrom).toEqual({
        angle: 45,
        power: -10,
      });

      const highPowerNoReaction = await runFractionCase({
        solver: { angle: 45, power: 95 },
        sequence: [0.99, 0, 0, 0.99, 0, 0.999],
      });
      expect(highPowerNoReaction.finalizedInput?.power).toBeCloseTo(109.97, 10);
      expect(highPowerNoReaction.shot).toMatchObject({ angle: 45, power: 99 });

      const highPowerWithReaction = await runFractionCase({
        solver: { angle: 45, power: 95 },
        sequence: [0.99, 0, 0, 0.99, 0, 0.999, 0.5, 0, 0],
        hitReaction: { wasDirectHit: true, fallDistance: 0 },
      });
      expect(highPowerWithReaction.interpolatedFrom?.power).toBeCloseTo(
        109.97,
        10,
      );
    });
  });

  describe("OK (v2-heuristic)", () => {
    function installZeroPlanner() {
      vi.spyOn(fallible, "signedImpactOffset").mockReturnValue(0);
      vi.spyOn(fallible, "maybeGaffe").mockReturnValue(false);
    }

    it("exige une distance horizontale strictement > 380 px et PV + bouclier >= 40 sur la cible retenue", async () => {
      const terrain = flatTerrain(800, 480);

      // Distance exactement 380 -> exclue, 0 jet nucléaire
      const strat380 = new AIHeuristicStrategy();
      const shooter380 = makePlayer({
        id: "ai",
        isHuman: false,
        aiProfile: "v2-heuristic",
        inventory: { NUKE: 1, THERMONUCLEAR: 1 },
        tank: makeTank("shooter-tank", 100, 336),
      });
      const target380 = makePlayer({
        id: "enemy",
        tank: makeTank("enemy-tank", 480, 336, { health: 40, shield: 0 }),
      });
      installZeroPlanner();
      const rng380 = installSequence([0.01, 0.01]);
      const shot380 = await strat380.executeTurn(
        "shooter-tank",
        makeGameState(shooter380, target380, "v2-heuristic"),
        terrain,
      );
      expect(shot380.weaponId).toBe("MISSILE");
      expect(rng380).not.toHaveBeenCalled();

      // Distance 381 (vers la gauche) mais PV + bouclier = 39 -> exclue, 0 jet nucléaire
      vi.restoreAllMocks();
      const strat39 = new AIHeuristicStrategy();
      const shooter39 = makePlayer({
        id: "ai",
        isHuman: false,
        aiProfile: "v2-heuristic",
        inventory: { NUKE: 1, THERMONUCLEAR: 1 },
        tank: makeTank("shooter-tank", 500, 336),
      });
      const target39 = makePlayer({
        id: "enemy",
        tank: makeTank("enemy-tank", 119, 336, { health: 20, shield: 19 }),
      });
      installZeroPlanner();
      const rng39 = installSequence([0.01, 0.01]);
      const shot39 = await strat39.executeTurn(
        "shooter-tank",
        makeGameState(shooter39, target39, "v2-heuristic"),
        terrain,
      );
      expect(shot39.weaponId).toBe("MISSILE");
      expect(rng39).not.toHaveBeenCalled();

      // Distance 381 et PV + bouclier = 40 (20 + 20) -> admissible pour THERMONUCLEAR
      vi.restoreAllMocks();
      const strat40 = new AIHeuristicStrategy();
      const shooter40 = makePlayer({
        id: "ai",
        isHuman: false,
        aiProfile: "v2-heuristic",
        inventory: { THERMONUCLEAR: 1 },
        tank: makeTank("shooter-tank", 500, 336),
      });
      const target40 = makePlayer({
        id: "enemy",
        tank: makeTank("enemy-tank", 119, 336, { health: 20, shield: 20 }),
      });
      installZeroPlanner();
      const rng40 = installSequence([0.0999]);
      const shot40 = await strat40.executeTurn(
        "shooter-tank",
        makeGameState(shooter40, target40, "v2-heuristic"),
        terrain,
      );
      expect(shot40.weaponId).toBe("THERMONUCLEAR");
      expect(rng40).toHaveBeenCalledTimes(1);
    });

    it("évalue les seuils sur la cible retenue par vengeance même face à un autre ennemi admissible", async () => {
      const terrain = flatTerrain(800, 480);
      const strategy = new AIHeuristicStrategy();
      const shooter = makePlayer({
        id: "ai",
        isHuman: false,
        aiProfile: "v2-heuristic",
        inventory: { NUKE: 1, THERMONUCLEAR: 1 },
        tank: makeTank("shooter-tank", 80, 336, { lastHitBy: "close-revenge" }),
      });
      const closeRevenge = makePlayer({
        id: "close-revenge",
        tank: makeTank("revenge-tank", 300, 336, { health: 90, shield: 40 }),
      });
      const farEnemy = makePlayer({
        id: "far-enemy",
        tank: makeTank("far-tank", 700, 336, { health: 90, shield: 40 }),
      });
      installZeroPlanner();
      const rng = installSequence([0.01, 0.01]);
      const shot = await strategy.executeTurn(
        "shooter-tank",
        {
          phase: "COMBAT",
          players: [shooter, closeRevenge, farEnemy],
          currentPlayerIndex: 0,
          turn: 1,
          windForce: 0,
          gravity: 260,
          roundNumber: 1,
        },
        terrain,
      );
      expect(shot.weaponId).toBe("MISSILE");
      expect(rng).not.toHaveBeenCalled();
    });

    it("priorise GRENADE (relief) et CLUSTER (regroupement) sans consommer de jets nucléaires", async () => {
      // GRENADE sur relief
      const hilly = flatTerrain(800, 480);
      hilly.loadHeights(
        Array.from({ length: 800 }, (_, x) => (x > 250 && x < 450 ? 220 : 336)),
        Array.from({ length: 800 }, () => TERRAIN_MATERIAL.DIRT),
      );
      const grenadeStrategy = new AIHeuristicStrategy();
      const grenadeShooter = makePlayer({
        id: "ai",
        isHuman: false,
        aiProfile: "v2-heuristic",
        inventory: { GRENADE: 1, NUKE: 1, THERMONUCLEAR: 1 },
        tank: makeTank("shooter-tank", 80, 336),
      });
      const farTarget = makePlayer({
        id: "enemy",
        tank: makeTank("enemy-tank", 700, 336, { health: 80 }),
      });
      installZeroPlanner();
      const grenadeRng = installSequence([0.01]);
      const grenadeShot = await grenadeStrategy.executeTurn(
        "shooter-tank",
        makeGameState(grenadeShooter, farTarget, "v2-heuristic"),
        hilly,
      );
      expect(grenadeShot.weaponId).toBe("GRENADE");
      expect(grenadeRng).not.toHaveBeenCalled();

      // CLUSTER sur regroupement (>= 2 cibles proches)
      vi.restoreAllMocks();
      const flat = flatTerrain(800, 480);
      const clusterStrategy = new AIHeuristicStrategy();
      const clusterShooter = makePlayer({
        id: "ai",
        isHuman: false,
        aiProfile: "v2-heuristic",
        inventory: { CLUSTER: 1, NUKE: 1, THERMONUCLEAR: 1 },
        tank: makeTank("shooter-tank", 80, 336),
      });
      const mainTarget = makePlayer({
        id: "enemy-1",
        isHuman: false,
        tank: makeTank("enemy-1-tank", 650, 336, { health: 50 }),
      });
      const nearbyTarget = makePlayer({
        id: "enemy-2",
        isHuman: true,
        tank: makeTank("enemy-2-tank", 690, 336, { health: 80 }),
      });
      installZeroPlanner();
      const clusterRng = installSequence([0.01]);
      const clusterShot = await clusterStrategy.executeTurn(
        "shooter-tank",
        {
          phase: "COMBAT",
          players: [clusterShooter, mainTarget, nearbyTarget],
          currentPlayerIndex: 0,
          turn: 1,
          windForce: 0,
          gravity: 260,
          roundNumber: 1,
        },
        flat,
      );
      expect(clusterShot.weaponId).toBe("CLUSTER");
      expect(clusterRng).not.toHaveBeenCalled();
    });

    it("enchaîne NUKE puis THERMONUCLEAR puis BULLDOZER / MISSILE selon les seuils exacts", async () => {
      const terrain = flatTerrain(800, 480);
      const edgeTarget = makePlayer({
        id: "enemy",
        tank: makeTank("enemy-tank", 780, 336, { health: 80 }),
      });

      // 1. NUKE réussie (< 0.20) -> 1 tirage, pas de THERMONUCLEAR
      const stratNuke = new AIHeuristicStrategy();
      const shooterBoth = makePlayer({
        id: "ai",
        isHuman: false,
        aiProfile: "v2-heuristic",
        inventory: { NUKE: 1, THERMONUCLEAR: 1, BULLDOZER: 1 },
        tank: makeTank("shooter-tank", 80, 336),
      });
      installZeroPlanner();
      const rngNuke = installSequence([0.1999]);
      const shotNuke = await stratNuke.executeTurn(
        "shooter-tank",
        makeGameState(shooterBoth, edgeTarget, "v2-heuristic"),
        terrain,
      );
      expect(shotNuke.weaponId).toBe("NUKE");
      expect(rngNuke).toHaveBeenCalledTimes(1);

      // 2. NUKE ratée exactement à 0.20 -> THERMONUCLEAR réussie à 0.0999
      vi.restoreAllMocks();
      const stratThermo = new AIHeuristicStrategy();
      installZeroPlanner();
      const rngThermo = installSequence([0.2, 0.0999]);
      const shotThermo = await stratThermo.executeTurn(
        "shooter-tank",
        makeGameState(shooterBoth, edgeTarget, "v2-heuristic"),
        terrain,
      );
      expect(shotThermo.weaponId).toBe("THERMONUCLEAR");
      expect(rngThermo).toHaveBeenCalledTimes(2);

      // 3. NUKE absente (stock 0) -> 1 seul tirage pour THERMONUCLEAR
      vi.restoreAllMocks();
      const shooterThermoOnly = makePlayer({
        ...shooterBoth,
        inventory: { NUKE: 0, THERMONUCLEAR: 1, BULLDOZER: 1 },
      });
      installZeroPlanner();
      const rngThermoOnly = installSequence([0]);
      const shotThermoOnly = await new AIHeuristicStrategy().executeTurn(
        "shooter-tank",
        makeGameState(shooterThermoOnly, edgeTarget, "v2-heuristic"),
        terrain,
      );
      expect(shotThermoOnly.weaponId).toBe("THERMONUCLEAR");
      expect(rngThermoOnly).toHaveBeenCalledTimes(1);

      // 4. Échecs aux bornes exactes (0.20, 0.10) -> repli BULLDOZER au bord de carte, sinon MISSILE
      vi.restoreAllMocks();
      installZeroPlanner();
      const rngBulldozer = installSequence([0.2, 0.1]);
      const shotBulldozer = await new AIHeuristicStrategy().executeTurn(
        "shooter-tank",
        makeGameState(shooterBoth, edgeTarget, "v2-heuristic"),
        terrain,
      );
      expect(shotBulldozer.weaponId).toBe("BULLDOZER");
      expect(rngBulldozer).toHaveBeenCalledTimes(2);

      vi.restoreAllMocks();
      const shooterInterior = makePlayer({
        id: "ai",
        isHuman: false,
        aiProfile: "v2-heuristic",
        inventory: { NUKE: 1, THERMONUCLEAR: 1 },
        tank: makeTank("shooter-tank", 80, 336),
      });
      const interiorTarget = makePlayer({
        id: "enemy",
        tank: makeTank("enemy-tank", 550, 336, { health: 80 }),
      });
      installZeroPlanner();
      const rngMissile = installSequence([0.2, 0.1]);
      const shotMissile = await new AIHeuristicStrategy().executeTurn(
        "shooter-tank",
        makeGameState(shooterInterior, interiorTarget, "v2-heuristic"),
        terrain,
      );
      expect(shotMissile.weaponId).toBe("MISSILE");
      expect(rngMissile).toHaveBeenCalledTimes(2);
    });
  });

  describe("routeur, origines de stock et isolation des autres profils", () => {
    it("route un profil absent ou inconnu vers SIMPLE au combat même après achats boutique au repli OK", async () => {
      const terrain = flatTerrain(800, 480);
      const boughtBase = makePlayer({
        id: "ai-unknown",
        isHuman: false,
        money: 20_000,
        inventory: {},
        tank: makeTank("ai-tank", 80, 336, { currentWeapon: "MISSILE" }),
      });
      delete (boughtBase as { aiProfile?: unknown }).aiProfile;

      // En boutique, le repli inconnu suit OK et peut acquérir NUKE (0.05) + THERMONUCLEAR (0.02)
      vi.spyOn(random, "secureRandom")
        .mockReturnValueOnce(0.05)
        .mockReturnValueOnce(0.02);
      const shopResult = autoBuyForAI(boughtBase, 2, {}, false);
      expect(shopResult.player.inventory.NUKE).toBe(1);
      expect(shopResult.player.inventory.THERMONUCLEAR).toBe(1);
      vi.restoreAllMocks();

      // Au combat, le routeur exécute SIMPLE (admissible même contre une cible proche à 10 PV)
      const closeWeak = makePlayer({
        id: "enemy",
        tank: makeTank("enemy-tank", 180, 336, { health: 10, shield: 0 }),
      });
      const router = new AIByProfileStrategy();
      const unknownPlayer: Player = {
        ...shopResult.player,
        aiProfile: "future-profile" as unknown as Player["aiProfile"],
      };
      vi.spyOn(random, "secureRandom")
        .mockReturnValueOnce(0.2)
        .mockReturnValueOnce(0.05)
        .mockReturnValue(0.99);
      const shot = await router.executeTurn(
        "ai-tank",
        {
          phase: "COMBAT",
          players: [unknownPlayer, closeWeak],
          currentPlayerIndex: 0,
          turn: 1,
          windForce: 0,
          gravity: 260,
          roundNumber: 1,
        },
        terrain,
      );
      expect(shot.weaponId).toBe("THERMONUCLEAR");
      expect((router as unknown as { heuristic: object | null }).heuristic).toBeNull();
    });

    it("produit exactement la même sélection quelle que soit l'origine du stock (boutique, gratuit, scénario)", async () => {
      const terrain = flatTerrain(800, 480);
      const target = makePlayer({
        id: "enemy",
        tank: makeTank("enemy-tank", 620, 336, { health: 90, shield: 40 }),
      });

      // 1. Origine boutique payante
      vi.spyOn(random, "secureRandom").mockReturnValueOnce(0.05).mockReturnValueOnce(0.99);
      const shopPlayer = autoBuyForAI(
        makePlayer({
          id: "ok",
          isHuman: false,
          aiProfile: "v2-heuristic",
          money: 20_000,
          tank: makeTank("ok-tank", 110, 336),
        }),
        2,
        {},
        false,
      ).player;
      vi.restoreAllMocks();

      // 2. Origine armes gratuites (#355)
      const freePlayer = replenishPlayerFreeWeapons(
        makePlayer({
          id: "ok",
          isHuman: false,
          aiProfile: "v2-heuristic",
          money: 20_000,
          tank: makeTank("ok-tank", 110, 336),
        }),
        2,
      );

      // 3. Origine scénario personnalisé
      const scenario: EnduranceScenario = {
        schemaVersion: 1,
        id: "nuke-test",
        name: "Test",
        width: 800,
        height: 480,
        heights: Array.from({ length: 800 }, () => 336),
        materials: Array.from({ length: 800 }, () => TERRAIN_MATERIAL.DIRT),
        wind: 0,
        spawnXs: [110, 620],
        terrainId: "test-id",
      };
      const scenarioPlayer = prepareScenarioRound(
        scenario,
        [
          makePlayer({
            id: "ok",
            isHuman: false,
            aiProfile: "v2-heuristic",
            inventory: {
              GRENADE: 6,
              CLUSTER: 6,
              DRILLER: 2,
              BULLDOZER: 2,
              NUKE: 1,
            },
            tank: makeTank("ok-tank", 110, 336),
          }),
          target,
        ],
        1,
      ).players[0];

      const runWithOrigin = async (player: Player) => {
        const draws: number[] = [];
        vi.spyOn(random, "secureRandom").mockImplementation(() => {
          const val = draws.length === 0 ? 0.15 : 0.99;
          draws.push(val);
          return val;
        });
        const strategy = new AIHeuristicStrategy();
        const command = await strategy.executeTurn(
          "ok-tank",
          makeGameState(player, { ...target }, "v2-heuristic"),
          terrain,
        );
        vi.restoreAllMocks();
        return { command, draws };
      };

      const shopRun = await runWithOrigin(structuredClone(shopPlayer));
      const freeRun = await runWithOrigin(structuredClone(freePlayer));
      const scenarioRun = await runWithOrigin(structuredClone(scenarioPlayer));

      expect(shopRun.command.weaponId).toBe("NUKE");
      expect(freeRun).toEqual(shopRun);
      expect(scenarioRun).toEqual(shopRun);
    });

    it("laisse SNIPER, EXPERT et le conseiller inchangés", async () => {
      const terrain = flatTerrain(800, 480);
      const target = makePlayer({
        id: "enemy",
        tank: makeTank("enemy-tank", 600, 336, { health: 90 }),
      });

      // SNIPER avec stock nucléaire : aucun jet nucléaire, jamais NUKE/THERMONUCLEAR
      const sniperShooter = makePlayer({
        id: "sniper",
        isHuman: false,
        aiProfile: "v3-sniper",
        inventory: { NUKE: 2, THERMONUCLEAR: 1 },
        tank: makeTank("shooter-tank", 80, 336),
      });
      const sniperRng = installSequence([0.05, 0.05]);
      const sniperShot = await new AISniperStrategy().executeTurn(
        "shooter-tank",
        makeGameState(sniperShooter, target, "v3-sniper"),
        terrain,
      );
      expect(sniperShot.weaponId).toBe("MISSILE");
      expect(sniperRng).toHaveBeenCalledTimes(2); // amplitude + gaffe (direction déterministe pour SNIPER)

      // EXPERT et conseiller gardent leur comportement exact
      vi.restoreAllMocks();
      const human = makePlayer({
        id: "human",
        isHuman: true,
        inventory: { NUKE: 1 },
        tank: makeTank("human-tank", 80, 336),
      });
      const advisorState: GameState = {
        phase: "COMBAT",
        players: [human, target],
        currentPlayerIndex: 0,
        turn: 1,
        windForce: 0,
        gravity: 260,
        roundNumber: 1,
        localShotContext: { playerCountAtMatchStart: 2, isFirstShotOfRound: false },
      };
      const advisorRng = vi.spyOn(random, "secureRandom");
      const advice = calculateShotAdvice(
        {
          state: advisorState,
          width: terrain.width,
          height: terrain.height,
          heights: [...terrain.getHeightmap()],
          materials: [...terrain.getMaterials()],
        },
        "OPTIMISER_PROFIT",
      );
      expect(advice?.command.weaponId).toBeDefined();
      expect(advisorRng).not.toHaveBeenCalled();
    });
  });
});
