import { describe, expect, it } from "vitest";
import { makePlayer, makeTank } from "../../__tests__/helpers";
import { earningsPlayers, validateEarnings } from "../earningsValidation";
import { isStrictOnlineMessage, type ShotEarningsMessage } from "../protocol";

function fixture(): { roster: ReturnType<typeof makePlayer>[]; report: ShotEarningsMessage } {
  const roster = [makePlayer({ id: "a", tank: makeTank("a", 100, 300) }),
    makePlayer({ id: "b", tank: makeTank("b", 650, 300, { maxShield: 50, shield: 20 }) })];
  return { roster, report: { type: "SHOT_EARNINGS", shotId: 1, authorityEpoch: 1,
    players: earningsPlayers(roster), awards: [{ playerId: "a", amount: 5 }],
    deadSlots: [false, false], directHitVictimIds: [],
    roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null } } };
}

describe("v3 earnings authority", () => {
  it("normalizes only network death health and preserves calculated awards and engine objects", () => {
    const { roster, report } = fixture();
    roster[1].tank.isDead = true;
    roster[1].tank.health = 37;
    roster[1].tank.position.x = -100;
    const copy = earningsPlayers(roster);
    expect(copy[1].tank).toMatchObject({ health: 0, shield: 20, position: { x: -100, y: 300 } });
    copy[1].inventory.GRENADE = 0;
    expect(roster[1].inventory.GRENADE).toBe(3);
    expect(roster[1].tank.health).toBe(37);
    report.players = copy; copy[1].inventory = { ...roster[1].inventory };
    report.deadSlots[1] = true;
    report.roundOutcome = { isRoundEnd: true, isDraw: false, roundWinnerId: "a" };
    expect(validateEarnings(report, roster, "a", "BULLDOZER").ok).toBe(true);
    expect(report.awards).toEqual([{ playerId: "a", amount: 5 }]);
  });

  it("matches identities by id, ignores money and attribution, copies only physical fields", () => {
    const { roster, report } = fixture();
    report.players.reverse();
    report.players[0].money = 0;
    report.players[0].tank.health = 100;
    report.players[0].tank.shield = 40;
    report.players[0].tank.lastHitBy = "untrusted";
    report.players[0].tank.lastDirectAttackerId = "untrusted";
    report.players[0].tank.hitReaction = { wasDirectHit: true, fallDistance: 500 };
    const result = validateEarnings(report, roster, "a", "MISSILE");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.players[1].money).toBe(roster[1].money);
    expect(result.players[1].tank).toMatchObject({ health: 100, shield: 40, hitReaction: { fallDistance: 120 } });
    expect(result.players[1].tank.lastHitBy).toBeUndefined();
    expect(result.players[1].tank.lastDirectAttackerId).toBeUndefined();
    expect(roster[1].tank.shield).toBe(20);
  });

  it.each([
    ["MISSING_PLAYER", (r: ShotEarningsMessage) => { r.players.pop(); }],
    ["DUPLICATE_PLAYER", (r: ShotEarningsMessage) => { r.players.push(r.players[0]); }],
    ["DEATH_INCONSISTENT", (r: ShotEarningsMessage) => { r.players[1].tank.isDead = true; }],
    ["IDENTITY_MISMATCH", (r: ShotEarningsMessage) => { r.players[1].name += " "; }],
    ["INVENTORY_MISMATCH", (r: ShotEarningsMessage) => { r.players[1].inventory.GRENADE = 2; }],
    ["CAP_MISMATCH", (r: ShotEarningsMessage) => { r.players[1].tank.shield = 51; }],
    ["CAP_MISMATCH", (r: ShotEarningsMessage) => { r.players[1].tank.maxShield = 51; }],
    ["ROUND_MISMATCH", (r: ShotEarningsMessage) => { r.roundOutcome.isRoundEnd = true; }],
    ["ILLEGAL_VICTIM", (r: ShotEarningsMessage) => { r.directHitVictimIds = ["a"]; }],
    ["ILLEGAL_VICTIM", (r: ShotEarningsMessage) => { r.directHitVictimIds = ["b", "b"]; }],
    ["MALFORMED", (r: ShotEarningsMessage) => { r.awards.push(r.awards[0]); }],
  ] as const)("refuses %s before modifying the roster", (reason, mutate) => {
    const { roster, report } = fixture();
    const before = structuredClone(roster);
    mutate(report);
    expect(validateEarnings(report, roster, "a", "MISSILE")).toEqual({ ok: false, reason });
    expect(roster).toEqual(before);
  });

  it("prioritizes resurrection over health/caps and accepts absent inventory keys as zero", () => {
    const { roster, report } = fixture();
    roster[1].tank.isDead = true; roster[1].tank.health = 0;
    report.players[1].tank.health = -1;
    expect(validateEarnings(report, roster, "a", "MISSILE")).toEqual({ ok: false, reason: "RESURRECTION" });
    const next = fixture();
    next.report.players[1].inventory.BULLET = 0;
    expect(validateEarnings(next.report, next.roster, "a", "MISSILE").ok).toBe(true);
  });

  it("validates structural fields before domain decisions and fits four complete players under 8192 characters", () => {
    const { report, roster } = fixture();
    report.players[1].tank.position.y = 900;
    expect(isStrictOnlineMessage(report)).toBe(true);
    const malformed = structuredClone(report);
    malformed.players[1].tank.power = 101;
    expect(isStrictOnlineMessage(malformed)).toBe(false);
    expect(isStrictOnlineMessage({ ...report, players: [{ ...roster[0], aiProfile: "unknown" }] })).toBe(false);
    expect(JSON.stringify({ ...report, players: [...report.players, ...report.players] }).length).toBeLessThan(8192);
  });
});
