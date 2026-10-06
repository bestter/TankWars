import { describe, expect, it } from "vitest";
import { makePlayer, makeRoundMap, makeTank } from "../../__tests__/helpers";
import { CombatCatchUpAssembler, fragmentCombat, encodedCombatBytes, MAX_COMBAT_MESSAGE_BYTES, type CombatSnapshot } from "../combatCatchUp";

function snapshot(count = 0): CombatSnapshot {
  const players = [makePlayer({ id: "a", tank: makeTank("a", 120, 300) }), makePlayer({ id: "b", tank: makeTank("b", 650, 300) })];
  return { roundNumber: 1, map: makeRoundMap(), initialPlayers: players, players,
    currentPlayerIndex: 0, economicRevision: 12, roundEarningsByPlayer: { a: 20, b: 0 },
    activeShotId: null, activeShot: null, authoritySlot: 0, authorityEpoch: 2,
    zeus: { type: "ZEUS_STATE", activeZeusId: null, currentPlayerIndex: 0, rotationSlots: [], deadSlots: [false, false], activeStrike: null, lastAppliedStrikeId: 0 },
    events: Array.from({ length: count }, (_, index) => ({ type: "SHOT", actionId: `action-${index + 1}`, shotId: index + 1,
      eventSequence: index + 1, roundNumber: 1, physicsSeed: index, shotNumberInRound: index + 1,
      isFirstShotOfRound: index === 0, ownerId: "a", slot: 0, command: { angle: 45, power: 50, weaponId: "MISSILE" } })),
  };
}

describe("coherent bounded combat transport", () => {
  it("fragments the base and an unlimited round journal with envelopes under 64 KiB", () => {
    const source = snapshot(2000);
    const messages = fragmentCombat(source, "batch");
    expect(messages.filter((m) => m.kind === "BASE").length).toBeGreaterThan(1);
    expect(messages.filter((m) => m.kind === "EVENTS").length).toBeGreaterThan(1);
    expect(messages.every((m) => encodedCombatBytes(m) <= MAX_COMBAT_MESSAGE_BYTES)).toBe(true);
    source.players[0].money = 0;
    const assembler = new CombatCatchUpAssembler();
    let rebuilt: CombatSnapshot | null = null;
    for (const message of messages) rebuilt = assembler.accept(message) ?? rebuilt;
    expect(rebuilt?.events).toHaveLength(2000);
    expect(rebuilt?.players[0].money).toBe(1000);
    expect(rebuilt?.roundEarningsByPlayer).toEqual({ a: 20, b: 0 });
    expect(assembler.accept(messages[0])).toBeNull();
  });

  it("requires END and every fragment, tolerates identical duplicates and late delivery", () => {
    const messages = fragmentCombat(snapshot(4), "batch");
    const assembler = new CombatCatchUpAssembler();
    expect(assembler.accept(messages[0])).toBeNull();
    expect(assembler.accept(messages.at(-1)!)).toBeNull();
    for (const message of messages.slice(1, -2)) {
      expect(assembler.accept(message)).toBeNull();
      expect(assembler.accept(message)).toBeNull();
    }
    expect(assembler.accept(messages.at(-2)!)?.events).toHaveLength(4);
  });

  it("rejects contradictory fragments and event holes; ignores an abandoned batch", () => {
    const messages = fragmentCombat(snapshot(4), "first");
    const assembler = new CombatCatchUpAssembler();
    assembler.accept(messages[0]); assembler.accept(messages[1]);
    expect(() => assembler.accept({ ...messages[1], data: "different" })).toThrow("Contradictory");
    const next = fragmentCombat(snapshot(4), "next");
    assembler.accept(next[0]);
    expect(assembler.accept(messages.at(-1)!)).toBeNull();
    const events = next.find((m) => m.events)!;
    events.events![1].eventSequence = 99;
    expect(() => { for (const part of next.slice(1)) assembler.accept(part); }).toThrow("Discontinuous");
  });

  it("measures UTF-8 JSON escaping including the envelope", () => {
    const message = { envelope: "a", payload: "é😀\n" };
    expect(encodedCombatBytes(message)).toBe(new TextEncoder().encode(JSON.stringify(message)).length);
    expect(encodedCombatBytes(message)).toBeGreaterThan(JSON.stringify(message).length);
  });
});
