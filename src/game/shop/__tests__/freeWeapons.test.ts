import { describe, expect, it } from "vitest";
import type { Player } from "../../../types/player";
import { makePlayer } from "../../__tests__/helpers";
import {
  HUMAN_FREE_WEAPONS_TARGETS,
  getAiFreeWeaponsTargets,
  replenishPlayerFreeWeapons,
  replenishRosterFreeWeapons,
  resolveAiProfileForFreeWeapons,
} from "../freeWeapons";

describe("freeWeapons domain rules (#355)", () => {
  it("resolves unknown AI profiles to v2-heuristic (OK)", () => {
    expect(resolveAiProfileForFreeWeapons("unknown")).toBe("v2-heuristic");
    expect(resolveAiProfileForFreeWeapons(undefined)).toBe("v2-heuristic");
    expect(resolveAiProfileForFreeWeapons("v1-random")).toBe("v1-random");
    expect(resolveAiProfileForFreeWeapons("v3-sniper")).toBe("v3-sniper");
    expect(resolveAiProfileForFreeWeapons("v4-smart")).toBe("v4-smart");
  });

  it("exposes the exact human target constants", () => {
    expect(HUMAN_FREE_WEAPONS_TARGETS).toEqual({
      BULLET: 12,
      GRENADE: 12,
      CLUSTER: 12,
      DRILLER: 12,
      BULLDOZER: 12,
      NUKE: 2,
      THERMONUCLEAR: 1,
    });
  });

  it("calculates exact AI targets for 2, 3, and 4 initial players", () => {
    // 2 players
    expect(getAiFreeWeaponsTargets("v1-random", 2)).toEqual({
      GRENADE: 1,
      CLUSTER: 1,
    });
    expect(getAiFreeWeaponsTargets("v2-heuristic", 2)).toEqual({
      GRENADE: 6,
      CLUSTER: 6,
      DRILLER: 2,
      BULLDOZER: 2,
      NUKE: 1,
    });
    expect(getAiFreeWeaponsTargets("v3-sniper", 2)).toEqual({
      BULLET: 6,
      DRILLER: 4,
      BULLDOZER: 4,
    });
    expect(getAiFreeWeaponsTargets("v4-smart", 2)).toEqual({
      GRENADE: 6,
      CLUSTER: 6,
      DRILLER: 6,
      BULLDOZER: 6,
      NUKE: 2,
      THERMONUCLEAR: 1,
    });

    // 3 players
    expect(getAiFreeWeaponsTargets("v1-random", 3)).toEqual({
      GRENADE: 2,
      CLUSTER: 2,
    });
    expect(getAiFreeWeaponsTargets("v2-heuristic", 3)).toEqual({
      GRENADE: 9,
      CLUSTER: 9,
      DRILLER: 3,
      BULLDOZER: 3,
      NUKE: 1,
    });
    expect(getAiFreeWeaponsTargets("v3-sniper", 3)).toEqual({
      BULLET: 9,
      DRILLER: 6,
      BULLDOZER: 6,
    });
    expect(getAiFreeWeaponsTargets("v4-smart", 3)).toEqual({
      GRENADE: 9,
      CLUSTER: 9,
      DRILLER: 9,
      BULLDOZER: 9,
      NUKE: 2,
      THERMONUCLEAR: 1,
    });

    // 4 players
    expect(getAiFreeWeaponsTargets("v1-random", 4)).toEqual({
      GRENADE: 3,
      CLUSTER: 3,
    });
    expect(getAiFreeWeaponsTargets("v2-heuristic", 4)).toEqual({
      GRENADE: 12,
      CLUSTER: 12,
      DRILLER: 4,
      BULLDOZER: 4,
      NUKE: 1,
    });
    expect(getAiFreeWeaponsTargets("v3-sniper", 4)).toEqual({
      BULLET: 12,
      DRILLER: 8,
      BULLDOZER: 8,
    });
    expect(getAiFreeWeaponsTargets("v4-smart", 4)).toEqual({
      GRENADE: 12,
      CLUSTER: 12,
      DRILLER: 12,
      BULLDOZER: 12,
      NUKE: 2,
      THERMONUCLEAR: 1,
    });
  });

  it("replenishes human player to exact minimal targets without modifying money or MISSILE", () => {
    const human = makePlayer({
      id: "h1",
      isHuman: true,
      money: 500,
      inventory: { GRENADE: 2, BULLET: 5 },
    });

    const replenished = replenishPlayerFreeWeapons(human, 2);

    expect(replenished.money).toBe(500);
    expect(replenished.inventory).toEqual({
      BULLET: 12,
      GRENADE: 12,
      CLUSTER: 12,
      DRILLER: 12,
      BULLDOZER: 12,
      NUKE: 2,
      THERMONUCLEAR: 1,
    });
    expect(replenished.inventory.MISSILE).toBeUndefined();
  });

  it("covers explicitly SIMPLE at 2 players with initial 2 GRENADE, out-of-policy weapon, surplus, and nuclear caps", () => {
    const simplePlayer = makePlayer({
      id: "simple-1",
      isHuman: false,
      aiProfile: "v1-random",
      money: 250,
      inventory: {
        GRENADE: 2, // initial default surplus over target (2 > 1)
        BULLET: 3, // out-of-policy weapon
        NUKE: 5, // illegal surplus > 2
        THERMONUCLEAR: 3, // illegal surplus > 1
      },
    });

    const replenished = replenishPlayerFreeWeapons(simplePlayer, 2);

    expect(replenished.money).toBe(250);
    expect(replenished.inventory.GRENADE).toBe(2); // Ordinary surplus preserved
    expect(replenished.inventory.CLUSTER).toBe(1); // Target N-1 = 1 provided
    expect(replenished.inventory.BULLET).toBe(3); // Out-of-policy preserved
    expect(replenished.inventory.NUKE).toBe(2); // Capped at legal maximum 2
    expect(replenished.inventory.THERMONUCLEAR).toBe(1); // Capped at legal maximum 1
  });

  it("is strictly idempotent on a second consecutive run", () => {
    const player = makePlayer({
      id: "ai-expert",
      isHuman: false,
      aiProfile: "v4-smart",
      money: 100,
      inventory: { GRENADE: 1, NUKE: 4, THERMONUCLEAR: 2 },
    });

    const run1 = replenishPlayerFreeWeapons(player, 3);
    const run2 = replenishPlayerFreeWeapons(run1, 3);

    expect(run1).toEqual(run2);
    expect(run2.money).toBe(100);
    expect(run2.inventory.NUKE).toBe(2);
    expect(run2.inventory.THERMONUCLEAR).toBe(1);
    expect(run2.inventory.GRENADE).toBe(9);
    expect(run2.inventory.CLUSTER).toBe(9);
    expect(run2.inventory.DRILLER).toBe(9);
    expect(run2.inventory.BULLDOZER).toBe(9);
  });

  it("replenishes the entire roster immutably", () => {
    const roster: Player[] = [
      makePlayer({ id: "p1", isHuman: true, inventory: {} }),
      makePlayer({
        id: "p2",
        isHuman: false,
        aiProfile: "v3-sniper",
        inventory: { BULLET: 1 },
      }),
    ];

    const replenished = replenishRosterFreeWeapons(roster, 2);

    expect(replenished).toHaveLength(2);
    expect(replenished[0].inventory.BULLET).toBe(12);
    expect(replenished[1].inventory.BULLET).toBe(6);
    expect(replenished[1].inventory.DRILLER).toBe(4);
    expect(replenished[1].inventory.BULLDOZER).toBe(4);
    // Original roster untouched
    expect(roster[0].inventory).toEqual({});
    expect(roster[1].inventory).toEqual({ BULLET: 1 });
  });
});
