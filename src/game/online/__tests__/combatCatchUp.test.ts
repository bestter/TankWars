import { describe, expect, it } from "vitest";
import { makePlayer, makeRoundMap, makeTank } from "../../__tests__/helpers";
import { CombatCatchUpAssembler, fragmentCombat, type CombatSnapshot } from "../combatCatchUp";
import { encodedCombatBytes, MAX_COMBAT_MESSAGE_BYTES, utf8Bytes } from "../combatTransport";
import { isStrictOnlineMessage, parseStrictOnlineMessage } from "../protocol";

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
    expect(messages.filter((m) => m.type === "COMBAT_CATCH_UP_FRAGMENT" && m.kind === "BASE").length).toBeGreaterThan(1);
    expect(messages.filter((m) => m.type === "COMBAT_CATCH_UP_FRAGMENT" && m.kind === "EVENTS").length).toBeGreaterThan(1);
    expect(messages.every((m) => encodedCombatBytes(m) <= MAX_COMBAT_MESSAGE_BYTES)).toBe(true);
    for (const message of messages) expect(parseStrictOnlineMessage(JSON.stringify(message))).toEqual(message);
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
    const base = messages[1];
    if (base.type !== "COMBAT_CATCH_UP_FRAGMENT" || base.kind !== "BASE") throw new Error("Missing base fixture");
    expect(() => assembler.accept({ ...base, data: "different" })).toThrow("Contradictory");
    const next = fragmentCombat(snapshot(4), "next");
    assembler.accept(next[0]);
    expect(assembler.accept(messages.at(-1)!)).toBeNull();
    const events = next.find((m) => m.type === "COMBAT_CATCH_UP_FRAGMENT" && m.kind === "EVENTS")!;
    events.events[1].eventSequence = 99;
    expect(() => { for (const part of next.slice(1)) assembler.accept(part); }).toThrow("Invalid combat envelope");
  });

  const header = { catchUpId: "batch", roundNumber: 1, fragmentCount: 3, boundary: 2 };
  const base = { ...header, type: "COMBAT_CATCH_UP_FRAGMENT", index: 0, kind: "BASE", data: "{}" };
  const eventPart = { ...header, type: "COMBAT_CATCH_UP_FRAGMENT", index: 1, kind: "EVENTS",
    events: snapshot(2).events, firstSequence: 1, lastSequence: 2 };
  it.each([
    { ...header, type: "COMBAT_CATCH_UP_FRAGMENT" },
    { ...base, data: undefined }, { ...base, data: 2 }, { ...base, data: "" },
    { ...base, index: -1 }, { ...base, index: 0.5 }, { ...base, index: "0" },
    { ...base, index: 3 }, { ...base, kind: "OTHER" }, { ...base, events: [] },
    { ...base, roundNumber: 0 }, { ...base, fragmentCount: 0 }, { ...base, boundary: -1 },
    { ...header, type: "COMBAT_CATCH_UP_BEGIN", index: 0 },
    { ...header, type: "COMBAT_CATCH_UP_END", kind: "BASE" },
    { ...eventPart, events: undefined }, { ...eventPart, events: {} }, { ...eventPart, events: [] },
    { ...eventPart, firstSequence: 0 }, { ...eventPart, lastSequence: 3 },
    { ...eventPart, firstSequence: 2, lastSequence: 1 }, { ...eventPart, firstSequence: "1" },
    { ...eventPart, boundary: 1 }, { ...eventPart, data: "unexpected" },
    { ...eventPart, events: [{ type: "ZEUS_STATE" }] },
    { ...eventPart, events: [{ type: "COMBAT_CATCH_UP_BEGIN", ...header }] },
    { ...eventPart, events: snapshot(2).events.map((event) => ({ ...event, roundNumber: 2 })) },
    { ...eventPart, events: snapshot(2).events.map((event) => ({ ...event, eventSequence: 1 })) },
    { ...eventPart, events: snapshot(2).events.map((event) => ({ ...event, command: { angle: 45, power: 101, weaponId: "MISSILE" } })) },
  ])("rejects malformed fragments at both guard and parser (%j)", (message) => {
    expect(isStrictOnlineMessage(message)).toBe(false);
    expect(parseStrictOnlineMessage(JSON.stringify(message))).toBeNull();
  });

  it("accepts only the four combat event variants", () => {
    const identity = { roundNumber: 1, eventSequence: 1, afterShotId: 0 };
    const events = [snapshot(1).events[0],
      { type: "ZEUS_APPOINTED", ...identity, appointmentId: 1, zeusId: "a", zeusSlot: 0, rotationSlots: [0, 1] },
      { type: "ZEUS_STRIKE", ...identity, strikeId: 1, zeusId: "a", targetId: "b", resolveAt: 800 },
      { type: "ZEUS_STRIKE_APPLIED", ...identity, strikeId: 1, zeusId: "a", targetId: "b",
        economicRevision: 1, roundEarningsByPlayer: { a: 75, b: 0 }, award: { playerId: "a", amount: 75 },
        balances: [{ playerId: "a", money: 1075 }, { playerId: "b", money: 1000 }], deadSlots: [false, true], nextPlayerIndex: null,
        roundOutcome: { isRoundEnd: true, isDraw: false, roundWinnerId: "a" } }];
    for (const event of events) {
      const message = { ...eventPart, firstSequence: 1, lastSequence: 1, events: [event] };
      expect(parseStrictOnlineMessage(JSON.stringify(message))).toEqual(message);
    }
  });

  it("retains cross-fragment sequence and final snapshot validation", () => {
    const messages = fragmentCombat(snapshot(2), "cross-fragment");
    const index = messages.findIndex((m) => m.type === "COMBAT_CATCH_UP_FRAGMENT" && m.kind === "EVENTS");
    const event = snapshot(2).events[1];
    const original = messages[index];
    if (original.type !== "COMBAT_CATCH_UP_FRAGMENT" || original.kind !== "EVENTS") throw new Error("Missing event fixture");
    messages[index] = { ...original, firstSequence: 2, lastSequence: 2, events: [event] };
    expect(isStrictOnlineMessage(messages[index])).toBe(true);
    const assembler = new CombatCatchUpAssembler();
    expect(() => { for (const message of messages) assembler.accept(message); }).toThrow("Discontinuous");
    const invalid = snapshot(); invalid.roundEarningsByPlayer.a = -1;
    const finalAssembler = new CombatCatchUpAssembler();
    expect(() => { for (const message of fragmentCombat(invalid, "invalid-base")) finalAssembler.accept(message); }).toThrow("Invalid combat snapshot");
  });

  it("bounds complete UTF-8 envelopes and the original raw JSON at exactly 64 KiB", () => {
    const empty = { ...base, data: "" };
    const capacity = MAX_COMBAT_MESSAGE_BYTES - encodedCombatBytes(empty);
    const exact = { ...base, data: "😀".repeat(Math.floor(capacity / 4)) + "a".repeat(capacity % 4) };
    expect(encodedCombatBytes(exact)).toBe(MAX_COMBAT_MESSAGE_BYTES);
    expect(JSON.stringify(exact).length).toBeLessThan(MAX_COMBAT_MESSAGE_BYTES);
    expect(parseStrictOnlineMessage(JSON.stringify(exact))).toEqual(exact);
    const over = { ...exact, data: exact.data + "a" };
    expect(isStrictOnlineMessage(over)).toBe(false);
    expect(parseStrictOnlineMessage(JSON.stringify(over))).toBeNull();
    const raw = JSON.stringify({ ...header, type: "COMBAT_CATCH_UP_BEGIN" });
    const padded = raw + " ".repeat(MAX_COMBAT_MESSAGE_BYTES - utf8Bytes(raw));
    expect(parseStrictOnlineMessage(padded)).not.toBeNull();
    expect(parseStrictOnlineMessage(padded + " ")).toBeNull();
  });

  it("measures UTF-8 JSON escaping including the envelope", () => {
    const message = { envelope: "a", payload: "é😀\n" };
    expect(encodedCombatBytes(message)).toBe(new TextEncoder().encode(JSON.stringify(message)).length);
    expect(encodedCombatBytes(message)).toBeGreaterThan(JSON.stringify(message).length);
  });
});
