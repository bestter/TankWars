import { describe, it, expect } from "vitest";
import { AIByProfileStrategy } from "../AIByProfileStrategy";
import { TerrainManager } from "../../../engine/Terrain";
import { makeGameState, makePlayer, makeTank } from "../../../__tests__/helpers";
import type { Player } from "../../../../types/player";

describe("AIByProfileStrategy", () => {
  const terrain = new TerrainManager(800, 480);
  terrain.generate();

  const shooterBase = makePlayer({
    id: "ai-player",
    name: "AI Tank",
    isHuman: false,
    tank: makeTank("ai-tank", 140, 320),
    inventory: { MISSILE: 99, GRENADE: 2, BULLET: 1, DRILLER: 1 },
  });

  const target = makePlayer({
    id: "target-player",
    name: "Target",
    isHuman: true,
    tank: makeTank("target-tank", 620, 320),
  });

  const profiles = [
    "v1-random",
    "v2-heuristic",
    "v3-sniper",
    "v4-smart",
  ] as const;

  it.each(profiles)("executeTurn resolves for profile %s", async (profile) => {
    const strategy = new AIByProfileStrategy();
    const gameState = makeGameState(shooterBase, target, profile);

    const result = await strategy.executeTurn("ai-tank", gameState, terrain);

    expect(result.angle).toBeGreaterThanOrEqual(0);
    expect(result.angle).toBeLessThanOrEqual(180);
    expect(result.power).toBeGreaterThanOrEqual(0);
    expect(result.power).toBeLessThanOrEqual(100);
    expect(result.weaponId).toBeDefined();
  });

  it("falls back to simple strategy for unknown aiProfile", async () => {
    const strategy = new AIByProfileStrategy();
    const unknownProfilePlayer: Player = {
      ...shooterBase,
      aiProfile: undefined,
    };
    const gameState = makeGameState(unknownProfilePlayer, target, undefined);

    const result = await strategy.executeTurn("ai-tank", gameState, terrain);

    expect(result.power).toBeGreaterThan(0);
    expect(result.angle).toBeGreaterThan(0);
  });

  it("lazy-loads advanced strategies on first use (distinct instances)", async () => {
    const strategy = new AIByProfileStrategy();

    await strategy.executeTurn(
      "ai-tank",
      makeGameState(shooterBase, target, "v2-heuristic"),
      terrain,
    );
    await strategy.executeTurn(
      "ai-tank",
      makeGameState(shooterBase, target, "v3-sniper"),
      terrain,
    );
    await strategy.executeTurn(
      "ai-tank",
      makeGameState(shooterBase, target, "v4-smart"),
      terrain,
    );

    const internal = strategy as unknown as {
      heuristic: object | null;
      sniper: object | null;
      smart: object | null;
    };

    expect(internal.heuristic).not.toBeNull();
    expect(internal.sniper).not.toBeNull();
    expect(internal.smart).not.toBeNull();
  });

  it("getResolutionFallback delegates to simple strategy", () => {
    const strategy = new AIByProfileStrategy();
    const fallback = strategy.getResolutionFallback?.();

    expect(fallback).not.toBeNull();
    expect(fallback!.angle).toBeGreaterThanOrEqual(0);
    expect(fallback!.power).toBeGreaterThan(0);
  });
});