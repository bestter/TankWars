import { afterEach, describe, expect, it, vi } from "vitest";
import { AIHeuristicStrategy } from "../AIHeuristicStrategy";
import { AISimpleStrategy } from "../AISimpleStrategy";
import { AISmartStrategy } from "../AISmartStrategy";
import { AISniperStrategy } from "../AISniperStrategy";
import {
  ADVANCED_GAFFES,
  finalizeAdvancedAim,
  finalizeSimpleAim,
  interpolateAimCommands,
} from "../aimCorruption";
import type { AimMemory } from "../aimMemory";
import * as fallibleAim from "../fallibleAim";
import * as aimCorruption from "../aimCorruption";
import * as heuristicShot from "../heuristicShot";
import {
  flatTerrain,
  makeGameState,
  makePlayer,
  makeTank,
} from "../../../__tests__/helpers";
import * as random from "../../../../utils/random";
import type { AiProfile, Player } from "../../../../types/player";
import type { TerrainManager } from "../../../engine/Terrain";

type AimStrategy =
  | AISimpleStrategy
  | AIHeuristicStrategy
  | AISniperStrategy
  | AISmartStrategy;

interface InspectableStrategy {
  memories: Map<string, AimMemory>;
}

interface SniperTestDouble {
  computePrecisionShot: (
    self: Player,
    targetX: number,
    targetY: number,
    wind: number,
    gravity: number,
    terrain: TerrainManager,
  ) => { angle: number; power: number };
}

const strategyFactories: ReadonlyArray<{
  profile: AiProfile;
  create: () => AimStrategy;
}> = [
  { profile: "v1-random", create: () => new AISimpleStrategy() },
  { profile: "v2-heuristic", create: () => new AIHeuristicStrategy() },
  { profile: "v3-sniper", create: () => new AISniperStrategy() },
  { profile: "v4-smart", create: () => new AISmartStrategy() },
];

const advancedStrategyFactories: ReadonlyArray<{
  profile: Exclude<AiProfile, "v1-random">;
  create: () => Exclude<AimStrategy, AISimpleStrategy>;
  firstAimRandomCalls: number;
}> = [
  {
    profile: "v2-heuristic",
    create: () => new AIHeuristicStrategy(),
    firstAimRandomCalls: 2,
  },
  {
    profile: "v3-sniper",
    create: () => new AISniperStrategy(),
    firstAimRandomCalls: 1,
  },
  {
    profile: "v4-smart",
    create: () => new AISmartStrategy(),
    firstAimRandomCalls: 2,
  },
];

function inspectMemory(strategy: AimStrategy, playerId: string): AimMemory {
  const memory = (strategy as unknown as InspectableStrategy).memories.get(
    playerId,
  );
  if (!memory) throw new Error("Mémoire IA absente");
  return memory;
}

function makeShooter(profile: AiProfile): Player {
  return makePlayer({
    id: "self",
    isHuman: false,
    aiProfile: profile,
    inventory: { MISSILE: 99 },
    tank: makeTank("self-tank", 80, 336, { currentWeapon: "MISSILE" }),
  });
}

function makeTarget(id: string, x: number, isHuman = true): Player {
  return makePlayer({
    id,
    isHuman,
    tank: makeTank(id + "-tank", x, 336, { health: 80, shield: 0 }),
  });
}

describe("contrats de séquence des stratégies IA", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(strategyFactories)(
    "repart au tir 1 pour A -> B -> A et à la manche suivante",
    async ({ profile, create }) => {
      const terrain = flatTerrain(800, 480);
      const strategy = create();
      const self = makeShooter(profile);
      const targetA = makeTarget("A", 500);
      const targetB = makeTarget("B", 600);
      vi.spyOn(random, "secureRandom").mockReturnValue(0.99);

      await strategy.executeTurn(
        "self-tank",
        { ...makeGameState(self, targetA, profile), roundNumber: 1 },
        terrain,
      );
      expect(inspectMemory(strategy, self.id)).toMatchObject({
        currentTargetId: "A",
        currentTargetAttempts: 1,
      });

      await strategy.executeTurn(
        "self-tank",
        { ...makeGameState(self, targetB, profile), roundNumber: 1 },
        terrain,
      );
      expect(inspectMemory(strategy, self.id)).toMatchObject({
        currentTargetId: "B",
        currentTargetAttempts: 1,
      });

      await strategy.executeTurn(
        "self-tank",
        { ...makeGameState(self, targetA, profile), roundNumber: 1 },
        terrain,
      );
      expect(inspectMemory(strategy, self.id)).toMatchObject({
        currentTargetId: "A",
        currentTargetAttempts: 1,
      });

      await strategy.executeTurn(
        "self-tank",
        { ...makeGameState(self, targetA, profile), roundNumber: 2 },
        terrain,
      );
      expect(inspectMemory(strategy, self.id)).toMatchObject({
        currentTargetId: "A",
        currentTargetAttempts: 1,
        lastRoundNumber: 2,
      });
    },
  );

  it("SIMPLE compte deux gaffes sans solveur ni décisions de remplacement", async () => {
    const strategy = new AISimpleStrategy();
    const self = makeShooter("v1-random");
    const target = makeTarget("target", 500);
    const decision = vi.spyOn(fallibleAim, "maybeGaffe").mockReturnValue(true);
    const sample = vi.spyOn(aimCorruption, "sampleSimpleGaffe")
      .mockReturnValue({ angle: 90, power: 5 });
    const solver = vi.spyOn(heuristicShot, "computeHeuristicShot");

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      decision.mockClear();
      sample.mockClear();
      const shot = await strategy.executeTurn(
        "self-tank",
        { ...makeGameState(self, target, "v1-random"), roundNumber: 1 },
        flatTerrain(800, 480),
      );
      expect(decision).toHaveBeenCalledExactlyOnceWith(0.5);
      expect(sample).toHaveBeenCalledTimes(1);
      expect(solver).not.toHaveBeenCalled();
      expect(shot).toEqual({ angle: 90, power: 5, weaponId: "MISSILE" });
      expect(inspectMemory(strategy, self.id)).toMatchObject({
        currentTargetId: "target",
        currentTargetAttempts: attempt,
      });
    }
  });

  it.each(advancedStrategyFactories)(
    "$profile compte deux gaffes avec une seule décision par tour",
    async ({ profile, create }) => {
      const terrain = flatTerrain(800, 480);
      const strategy = create();
      const self = makeShooter(profile);
      const target = makeTarget("target", 500);
      vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
      const decision = vi.spyOn(fallibleAim, "maybeGaffe").mockReturnValue(true);
      const chance = { "v2-heuristic": 0.10, "v3-sniper": 0.05, "v4-smart": 0.02 }[profile];
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        decision.mockClear();
        await strategy.executeTurn(
          "self-tank",
          { ...makeGameState(self, target, profile), roundNumber: 1 },
          terrain,
        );
        expect(decision).toHaveBeenCalledExactlyOnceWith(chance);
        expect(inspectMemory(strategy, self.id)).toMatchObject({
          currentTargetId: "target",
          currentTargetAttempts: attempt,
        });
      }
    },
  );

  it("SIMPLE garde sa cible IA malgré lastHitBy et privilégie les IA", async () => {
    const terrain = flatTerrain(800, 480);
    const strategy = new AISimpleStrategy();
    const self = makeShooter("v1-random");
    const aiTarget = makeTarget("ai-target", 500, false);
    const humanTarget = makeTarget("human-target", 300, true);
    humanTarget.tank.health = 1;
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);

    await strategy.executeTurn(
      "self-tank",
      {
        phase: "COMBAT",
        players: [self, aiTarget, humanTarget],
        currentPlayerIndex: 0,
        turn: 1,
        windForce: 0,
        gravity: 260,
        roundNumber: 1,
      },
      terrain,
    );
    expect(inspectMemory(strategy, self.id).currentTargetId).toBe("ai-target");

    self.tank.lastHitBy = "human-target";
    await strategy.executeTurn(
      "self-tank",
      {
        phase: "COMBAT",
        players: [self, aiTarget, humanTarget],
        currentPlayerIndex: 0,
        turn: 2,
        windForce: 0,
        gravity: 260,
        roundNumber: 1,
      },
      terrain,
    );
    expect(inspectMemory(strategy, self.id)).toMatchObject({
      currentTargetId: "ai-target",
      currentTargetAttempts: 2,
    });
  });

  it("SIMPLE applique les remplacements indépendants de direction et puissance", async () => {
    const terrain = flatTerrain(800, 480);
    const target = makeTarget("target", 500);

    const directionOnly = new AISimpleStrategy();
    vi.spyOn(random, "secureRandom")
      .mockReturnValueOnce(0.99)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.99);
    const directionShot = await directionOnly.executeTurn(
      "self-tank",
      {
        ...makeGameState(makeShooter("v1-random"), target, "v1-random"),
        roundNumber: 5,
      },
      terrain,
    );
    expect(directionShot.angle).toBe(90);

    vi.restoreAllMocks();
    const powerOnly = new AISimpleStrategy();
    vi.spyOn(random, "secureRandom")
      .mockReturnValueOnce(0.99)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.99)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5);
    const powerShot = await powerOnly.executeTurn(
      "self-tank",
      {
        ...makeGameState(makeShooter("v1-random"), target, "v1-random"),
        roundNumber: 5,
      },
      terrain,
    );
    expect(powerShot.power).toBe(50);

    vi.restoreAllMocks();
    const both = new AISimpleStrategy();
    vi.spyOn(random, "secureRandom")
      .mockReturnValueOnce(0.99)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5);
    const bothShot = await both.executeTurn(
      "self-tank",
      {
        ...makeGameState(makeShooter("v1-random"), target, "v1-random"),
        roundNumber: 5,
      },
      terrain,
    );
    expect(bothShot).toMatchObject({ angle: 90, power: 50 });
  });

  it("SIMPLE ne tire une référence de gaffe que lorsqu'une réaction est en attente", async () => {
    const terrain = flatTerrain(800, 480);
    const target = makeTarget("target", 500);
    const noReaction = new AISimpleStrategy();
    const noReactionSpy = vi
      .spyOn(random, "secureRandom")
      .mockReturnValue(0.99);
    await noReaction.executeTurn(
      "self-tank",
      {
        ...makeGameState(
          makeShooter("v1-random"),
          target,
          "v1-random",
        ),
        roundNumber: 5,
      },
      terrain,
    );
    expect(noReactionSpy).toHaveBeenCalledTimes(5);

    vi.restoreAllMocks();
    const withReaction = new AISimpleStrategy();
    const self = makeShooter("v1-random");
    self.tank.hitReaction = { wasDirectHit: true, fallDistance: 0 };
    const reactionSpy = vi
      .spyOn(random, "secureRandom")
      .mockReturnValue(0.99);
    await withReaction.executeTurn(
      "self-tank",
      {
        ...makeGameState(self, target, "v1-random"),
        roundNumber: 5,
      },
      terrain,
    );
    expect(reactionSpy).toHaveBeenCalledTimes(8);
    expect(self.tank.hitReaction).toEqual({
      wasDirectHit: false,
      fallDistance: 0,
    });
  });

  it("SNIPER inverse seulement le côté de la tentative 2 et garde celui de la tentative 3+", async () => {
    const terrain = flatTerrain(800, 480);
    const strategy = new AISniperStrategy();
    const precisionSpy = vi
      .spyOn(
        strategy as unknown as SniperTestDouble,
        "computePrecisionShot",
      )
      .mockReturnValue({ angle: 45, power: 50 });
    const self = makeShooter("v3-sniper");
    const target = makeTarget("target", 500);
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);

    for (let turn = 1; turn <= 4; turn += 1) {
      await strategy.executeTurn(
        "self-tank",
        {
          ...makeGameState(self, target, "v3-sniper"),
          roundNumber: 1,
          turn,
        },
        terrain,
      );
    }

    expect(precisionSpy.mock.calls.map((call) => call[1])).toEqual([
      438.05,
      539.975,
      482,
      482,
    ]);
  });

  it.each(advancedStrategyFactories)(
    "applique une seule grosse gaffe $profile après la réaction",
    async ({ profile, create, firstAimRandomCalls }) => {
      const terrain = flatTerrain(800, 480);
      const baselineSelf = makeShooter(profile);
      const baselineTarget = makeTarget("target", 500);
      vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
      const baseline = await create().executeTurn(
        "self-tank",
        makeGameState(baselineSelf, baselineTarget, profile),
        terrain,
      );

      vi.restoreAllMocks();
      const self = makeShooter(profile);
      self.tank.hitReaction = { wasDirectHit: true, fallDistance: 0 };
      const target = makeTarget("target", 500);
      const remainingValues = [
        ...Array.from({ length: firstAimRandomCalls }, () => 0.99),
        0.99,
        0.99,
        0,
        0,
        0,
      ];
      const randomSpy = vi
        .spyOn(random, "secureRandom")
        .mockImplementation(() => remainingValues.shift() ?? 0.99);
      const shot = await create().executeTurn(
        "self-tank",
        makeGameState(self, target, profile),
        terrain,
      );

      const gaffe = ADVANCED_GAFFES[profile];
      const directIntensity =
        profile === "v2-heuristic"
          ? 0.22
          : profile === "v3-sniper"
            ? 0.15
            : 0.1;
      const expected = finalizeAdvancedAim({
        angle:
          baseline.angle +
          directIntensity * gaffe.angleAmplitude -
          gaffe.angleAmplitude,
        power:
          baseline.power +
          directIntensity * gaffe.powerAmplitude -
          gaffe.powerAmplitude,
      });
      expect(shot.angle).toBeCloseTo(expected.angle, 1);
      expect(Math.abs(shot.power - expected.power)).toBeLessThanOrEqual(1);
      expect(shot.power).toBeLessThan(baseline.power);
      expect(randomSpy).toHaveBeenCalledTimes(firstAimRandomCalls + 5);
      expect(self.tank.hitReaction).toEqual({
        wasDirectHit: false,
        fallDistance: 0,
      });
    },
  );

  it("SIMPLE vise l'adversaire lors d'un tir normal sans corruption", async () => {
    const terrain = flatTerrain(800, 480);
    const rightStrategy = new AISimpleStrategy();
    const rightSelf = makeShooter("v1-random");
    const rightTarget = makeTarget("right", 500);
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const rightShot = await rightStrategy.executeTurn(
      "self-tank",
      {
        ...makeGameState(rightSelf, rightTarget, "v1-random"),
        roundNumber: 11,
      },
      terrain,
    );

    vi.restoreAllMocks();
    const leftStrategy = new AISimpleStrategy();
    const leftSelf = makeShooter("v1-random");
    leftSelf.tank.position.x = 720;
    const leftTarget = makeTarget("left", 300);
    vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
    const leftShot = await leftStrategy.executeTurn(
      "self-tank",
      {
        ...makeGameState(leftSelf, leftTarget, "v1-random"),
        roundNumber: 11,
      },
      terrain,
    );

    expect(rightShot.angle).toBeLessThan(90);
    expect(leftShot.angle).toBeGreaterThan(90);
  });

  it.each([
    {
      name: "sans remplacement",
      randomValues: [0.99, 0.99, 0.99, 0.99, 0.99, 0.5, 0.99, 0.99],
      beforeReaction: (baseline: { angle: number; power: number }) => baseline,
    },
    {
      name: "avec direction seule",
      randomValues: [0.99, 0.99, 0.99, 0, 0.5, 0.99, 0.5, 0.99, 0.99],
      beforeReaction: (baseline: { angle: number; power: number }) => ({
        angle: 90,
        power: baseline.power,
      }),
    },
    {
      name: "avec puissance seule",
      randomValues: [0.99, 0.99, 0.99, 0.99, 0, 0.5, 0.5, 0.99, 0.99],
      beforeReaction: (baseline: { angle: number; power: number }) => ({
        angle: baseline.angle,
        power: 50,
      }),
    },
    {
      name: "avec direction et puissance",
      randomValues: [0.99, 0.99, 0.99, 0, 0.5, 0, 0.5, 0.5, 0.99, 0.99],
      beforeReaction: () => ({ angle: 90, power: 50 }),
    },
  ])(
    "SIMPLE interpole $name avant de consommer sa réaction",
    async ({ randomValues, beforeReaction }) => {
      const terrain = flatTerrain(800, 480);
      const baselineTarget = makeTarget("target", 500);
      const baselineSelf = makeShooter("v1-random");
      vi.spyOn(random, "secureRandom").mockReturnValue(0.99);
      const baseline = await new AISimpleStrategy().executeTurn(
        "self-tank",
        {
          ...makeGameState(baselineSelf, baselineTarget, "v1-random"),
          roundNumber: 5,
        },
        terrain,
      );

      vi.restoreAllMocks();
      const self = makeShooter("v1-random");
      self.tank.hitReaction = { wasDirectHit: true, fallDistance: 0 };
      const target = makeTarget("target", 500);
      const remainingValues = [...randomValues];
      vi.spyOn(random, "secureRandom").mockImplementation(
        () => remainingValues.shift() ?? 0.99,
      );
      const shot = await new AISimpleStrategy().executeTurn(
        "self-tank",
        {
          ...makeGameState(self, target, "v1-random"),
          roundNumber: 5,
        },
        terrain,
      );

      expect(shot).toMatchObject(
        finalizeSimpleAim(
          interpolateAimCommands(
            beforeReaction(baseline),
            { angle: 90, power: 99 },
            0.28,
          ),
        ),
      );
      expect(self.tank.hitReaction).toEqual({
        wasDirectHit: false,
        fallDistance: 0,
      });
    },
  );

  it("SIMPLE consomme sa réaction même lorsqu'une grosse gaffe court-circuite le solveur", async () => {
    const terrain = flatTerrain(800, 480);
    const self = makeShooter("v1-random");
    self.tank.hitReaction = { wasDirectHit: true, fallDistance: 120 };
    const remainingValues = [0, 0.5, 0.99, 0.99];
    vi.spyOn(random, "secureRandom").mockImplementation(
      () => remainingValues.shift() ?? 0.99,
    );

    const shot = await new AISimpleStrategy().executeTurn(
      "self-tank",
      {
        ...makeGameState(self, makeTarget("target", 500), "v1-random"),
        roundNumber: 5,
      },
      terrain,
    );

    expect(shot).toMatchObject({ angle: 90, power: 99 });
    expect(self.tank.hitReaction).toEqual({
      wasDirectHit: false,
      fallDistance: 0,
    });
  });
});
