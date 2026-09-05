import { afterEach, describe, expect, it, vi } from "vitest";
import { AIHeuristicStrategy } from "../AIHeuristicStrategy";
import { AISimpleStrategy } from "../AISimpleStrategy";
import { AISmartStrategy } from "../AISmartStrategy";
import { AISniperStrategy } from "../AISniperStrategy";
import type { AimMemory } from "../aimMemory";
import {
  flatTerrain,
  makeGameState,
  makePlayer,
  makeTank,
} from "../../../__tests__/helpers";
import * as random from "../../../../utils/random";
import type { AiProfile, Player } from "../../../../types/player";

type AimStrategy =
  | AISimpleStrategy
  | AIHeuristicStrategy
  | AISniperStrategy
  | AISmartStrategy;

interface InspectableStrategy {
  memories: Map<string, AimMemory>;
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

  it.each(strategyFactories)(
    "compte une grosse gaffe comme la première tentative",
    async ({ profile, create }) => {
      const terrain = flatTerrain(800, 480);
      const strategy = create();
      const self = makeShooter(profile);
      const target = makeTarget("target", 500);
      vi.spyOn(random, "secureRandom").mockReturnValue(0);

      await strategy.executeTurn(
        "self-tank",
        { ...makeGameState(self, target, profile), roundNumber: 1 },
        terrain,
      );
      expect(inspectMemory(strategy, self.id)).toMatchObject({
        currentTargetId: "target",
        currentTargetAttempts: 1,
      });
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
});
