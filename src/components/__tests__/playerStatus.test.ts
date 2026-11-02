import { describe, expect, it } from "vitest";
import { makePlayer, makeTank } from "../../game/__tests__/helpers";
import type { Player } from "../../types/player";
import type { CurrentTurnInfo } from "../../game/engine/TurnManager";
import { VGA_PALETTE } from "../../types/game";
import {
  copyLivingPlayerStatus,
  formatStatusNumber,
  isAimingInspectionVisible,
  playerStatusEqual,
  playerStatusProfileKey,
  visibleStatusWeapons,
} from "../playerStatus";

function turn(overrides: Partial<CurrentTurnInfo> = {}): CurrentTurnInfo {
  return {
    playerName: "Alice",
    playerId: "p1",
    isHuman: true,
    playerColor: VGA_PALETTE.RED,
    angle: 45,
    power: 50,
    currentWeapon: "MISSILE",
    inventory: {},
    turn: 1,
    isInputLocked: false,
    tanksAreFalling: false,
    ...overrides,
  };
}

describe("player status copy and format", () => {
  it("opens only for an unlocked human aim during combat", () => {
    expect(isAimingInspectionVisible({ gamePhase: "COMBAT", turnInfo: turn() })).toBe(true);
    expect(isAimingInspectionVisible({ gamePhase: "COMBAT", turnInfo: null })).toBe(false);
    expect(isAimingInspectionVisible({ gamePhase: "SUMMARY", turnInfo: turn() })).toBe(false);
    expect(isAimingInspectionVisible({ gamePhase: "COMBAT", turnInfo: turn({ isHuman: false }) })).toBe(false);
    expect(isAimingInspectionVisible({ gamePhase: "COMBAT", turnInfo: turn({ isInputLocked: true }) })).toBe(false);
    expect(isAimingInspectionVisible({ gamePhase: "COMBAT", turnInfo: turn({ tanksAreFalling: true }) })).toBe(false);
  });

  it("copies living roster order and known finite weapon stocks only", () => {
    const alive = makePlayer({
      id: "alive",
      name: "A LiCe",
      isHuman: true,
      aiProfile: "v4-smart",
      money: 999,
      tank: makeTank("t1", 10, 20, { health: 0.04, maxHealth: 100, shield: 0, maxShield: 40.25, color: VGA_PALETTE.GREEN }),
      inventory: { MISSILE: 3, GRENADE: 0, BULLET: -2, THERMONUCLEAR: 1 },
    });
    (alive.inventory as Record<string, number>).LASER = 9;
    alive.inventory.NUKE = Number.NaN;
    alive.inventory.CLUSTER = Number.POSITIVE_INFINITY;
    const dead = makePlayer({
      id: "dead",
      tank: makeTank("t2", 30, 40, { isDead: true, health: 80 }),
    });
    const empty = makePlayer({
      id: "empty",
      isHuman: false,
      tank: makeTank("t3", 50, 60, { health: 0 }),
    });
    const tail = makePlayer({
      id: "tail",
      name: "Tail",
      isHuman: false,
      tank: makeTank("t4", 70, 80, { health: 12, shield: 4, maxShield: 40 }),
    });

    const cards = copyLivingPlayerStatus([alive, dead, empty, tail]);

    expect(cards.map((card) => card.id)).toEqual(["alive", "tail"]);
    expect(cards[0]).toMatchObject({
      name: "A LiCe",
      color: VGA_PALETTE.GREEN,
      isHuman: true,
      aiProfile: "v4-smart",
      health: 0.04,
      maxHealth: 100,
      shield: 0,
      maxShield: 40.25,
    });
    expect(cards[0].inventory).toEqual({
      MISSILE: 3,
      GRENADE: 0,
      BULLET: -2,
      THERMONUCLEAR: 1,
    });
    expect(cards[0]).not.toHaveProperty("money");
    alive.tank.health = 50;
    alive.inventory.GRENADE = 8;
    expect(cards[0].health).toBe(0.04);
    expect(cards[0].inventory.GRENADE).toBe(0);
  });

  it("treats an angle or power change as the same displayed status", () => {
    const player = makePlayer({ id: "p1", tank: makeTank("t1", 1, 2, { angle: 10, power: 20, health: 80 }) });
    const first = copyLivingPlayerStatus([player]);
    player.tank.angle = 170;
    player.tank.power = 99;
    const second = copyLivingPlayerStatus([player]);
    expect(playerStatusEqual(first, second)).toBe(true);
    expect(playerStatusEqual(first, null)).toBe(false);
    expect(playerStatusEqual(null, null)).toBe(true);
    player.tank.health = 79;
    expect(playerStatusEqual(first, copyLivingPlayerStatus([player]))).toBe(false);
  });

  it("shows missile as unlimited and hides non-positive stocks", () => {
    expect(visibleStatusWeapons({
      GRENADE: 0,
      NUKE: 2,
      THERMONUCLEAR: 1,
      DRILLER: -1,
      BULLET: Number.NaN,
    }).map((weapon) => [weapon.id, weapon.quantity])).toEqual([
      ["MISSILE", null],
      ["NUKE", 2],
      ["THERMONUCLEAR", 1],
    ]);
  });

  it("formats one decimal, a living-health floor and the active language", () => {
    expect(formatStatusNumber(0.04, "fr", "current", "health")).toBe("0,1");
    expect(formatStatusNumber(0, "fr", "current", "shield")).toBe("0,0");
    expect(formatStatusNumber(72.5, "fr", "current", "health")).toBe("72,5");
    expect(formatStatusNumber(100, "fr", "max", "health")).toBe("100");
    expect(formatStatusNumber(40.25, "fr", "max", "shield")).toBe("40,3");
    expect(formatStatusNumber(72.5, "fr-CA", "current", "health")).toBe("72,5");
    expect(formatStatusNumber(72.5, "en", "current", "health")).toBe("72.5");
    expect(formatStatusNumber(0, "en", "current", "shield")).toBe("0.0");
    expect(formatStatusNumber(40.25, "en-US", "max", "shield")).toBe("40.3");
    expect(formatStatusNumber(72.5, undefined, "current", "health")).toBe("72,5");
    expect(formatStatusNumber(72.5, null, "current", "health")).toBe("72,5");
  });

  it("labels humans without their AI profile and unknown AI as simple", () => {
    expect(playerStatusProfileKey({ isHuman: true, aiProfile: "v4-smart" })).toBe("controller_human");
    expect(playerStatusProfileKey({ isHuman: false, aiProfile: "v2-heuristic" })).toBe("controller_ai_ok");
    expect(playerStatusProfileKey({ isHuman: false, aiProfile: "v3-sniper" })).toBe("controller_ai_sniper");
    expect(playerStatusProfileKey({ isHuman: false, aiProfile: "v4-smart" })).toBe("controller_ai_expert");
    expect(playerStatusProfileKey({ isHuman: false, aiProfile: "v1-random" })).toBe("controller_ai_simple");
    expect(playerStatusProfileKey({ isHuman: false, aiProfile: null })).toBe("controller_ai_simple");
    expect(playerStatusProfileKey({ isHuman: false, aiProfile: "nope" as Player["aiProfile"] & string })).toBe("controller_ai_simple");
  });
});
