import { describe, expect, it } from "vitest";
import { RoundCollector } from "../metrics";
import { fixture } from "./helpers";
import type { CombatDamageEvent } from "../../economy/shotRewards";

describe("endurance physical statistics", () => {
  it("separates shield lost, absorption, HP, self damage and one offensive effect per CLUSTER shot", () => {
    const { players } = fixture(); const c = new RoundCollector(players);
    const [self, target] = players;
    c.observe({ kind: "shot", shotId: 7, playerId: self.id, command: { weaponId: "CLUSTER", angle: 60, power: 70 } });
    const damage: CombatDamageEvent = { shotId: 7, munitionId: 0, shooterId: self.id, victimId: target.id,
      weaponId: "CLUSTER", source: "projectile", classification: "direct", shieldAbsorbedMilli: 5000, shieldLostMilli: 10000, healthDamageMilli: 2000 };
    c.observe({ kind: "damage", event: damage });
    c.observe({ kind: "damage", event: { ...damage, munitionId: 1, classification: "indirect", source: "fall", shieldLostMilli: 0, healthDamageMilli: 3000 } });
    c.observe({ kind: "damage", event: { ...damage, victimId: self.id } });
    c.observe({ kind: "resolved", shotId: 7 });
    expect(c.data.weapons.CLUSTER).toMatchObject({ shots: 1, resolved: 1, offensiveShots: 1, shieldDealtMilli: 10000,
      healthDealtMilli: 5000, selfShieldMilli: 10000, selfHealthMilli: 2000 });
    expect(c.data.players[target.id]).toMatchObject({ healthLostMilli: 5000, shieldLostMilli: 10000 });
    expect(() => c.observe({ kind: "resolved", shotId: 7 })).toThrow("INVALID_SHOT_RESOLUTION");
  });
  it("counts zero-HP-loss lava/burial kills, suicides and unattributed deaths separately", () => {
    const { players } = fixture(); const c = new RoundCollector(players); const [self, target] = players;
    c.observe({ kind: "shot", shotId: 1, playerId: self.id, command: { weaponId: "DRILLER", angle: 50, power: 50 } });
    c.observe({ kind: "death", playerId: target.id, cause: "burial" });
    c.observe({ kind: "destruction", event: { shotId: 1, shooterId: self.id, victimId: target.id, weaponId: "DRILLER", cause: "buried" } });
    c.observe({ kind: "destruction", event: { shotId: 1, shooterId: self.id, victimId: self.id, weaponId: "DRILLER", cause: "lava" } });
    c.observe({ kind: "resolved", shotId: 1 }); c.finish([]);
    expect(c.data.total).toMatchObject({ kills: 1, suicides: 1, offensiveShots: 1, healthDealtMilli: 0, unattributedDeaths: 0 });
    const other = new RoundCollector(players); other.observe({ kind: "death", playerId: self.id, cause: "burial" }); other.finish(null);
    expect(other.data.total.unattributedDeaths).toBe(1);
    expect(other.data.total.participations).toBe(0);
  });
  it("keeps harmless BULLDOZER displacement and recoil out of offensive shots; Zeus is no weapon", () => {
    const { players } = fixture(); const c = new RoundCollector(players); const [self, target] = players;
    c.observe({ kind: "shot", shotId: 2, playerId: self.id, command: { weaponId: "BULLDOZER", angle: 30, power: 90 } });
    c.observe({ kind: "displacement", playerId: target.id, distance: 30, recoil: false });
    c.observe({ kind: "displacement", playerId: self.id, distance: 20, recoil: true }); c.observe({ kind: "resolved", shotId: 2 });
    c.observe({ kind: "zeus", result: { strikeId: 4, zeusId: self.id, targetId: target.id, award: { playerId: self.id, amount: 75 }, balances: [], roundOutcome: { isRoundEnd: true, isDraw: false, roundWinnerId: self.id } } });
    expect(c.data.weapons.BULLDOZER).toMatchObject({ displacement: 30, recoil: 20, offensiveShots: 0, shots: 1 });
    expect(c.data.weapons.ZEUS_LIGHTNING).toBeUndefined();
    expect(c.data.total).toMatchObject({ shots: 1, zeusActions: 1, zeusResults: 1 });
  });
});
