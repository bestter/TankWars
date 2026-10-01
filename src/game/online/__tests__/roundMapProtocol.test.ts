import { describe, expect, it } from "vitest";
import { makePlayer, makeRoundMap, makeTank } from "../../__tests__/helpers";
import { isStrictOnlineMessage, type GameStartMessage } from "../protocol";

function start(): GameStartMessage {
  return { type: "GAME_START", protocolVersion: 2, currentPlayerIndex: 0, map: makeRoundMap(),
    players: [makePlayer({ tank: makeTank("t1", 120, 300) }),
      makePlayer({ id: "p2", tank: makeTank("t2", 620, 300) })] };
}

describe("mandatory v2 round maps", () => {
  it("accepts a complete initial map and rejects missing/version 1 contracts", () => {
    expect(isStrictOnlineMessage(start())).toBe(true);
    expect(isStrictOnlineMessage({ ...start(), map: undefined })).toBe(false);
    expect(isStrictOnlineMessage({ ...start(), protocolVersion: 1 })).toBe(false);
    expect(isStrictOnlineMessage({ ...start(), players: [] })).toBe(false);
  });

  it("rejects malformed arrays, dimensions, materials, nonfinite values and round identities", () => {
    for (const fields of [
      { heights: [] }, { materials: [] }, { width: 801 }, { height: 481 },
      { roundNumber: 0 }, { roundNumber: 1.5 }, { wind: Infinity }, { wind: 53 },
      { heights: new Array(800).fill(NaN) }, { heights: new Array(800).fill(481) },
      { materials: new Array(800).fill("LAVA") }, { heights: new Array(800) },
    ]) expect(isStrictOnlineMessage({ ...start(), map: { ...makeRoundMap(), ...fields } })).toBe(false);
  });

  it("rejects duplicate identities, invalid tanks, mixed bases and misplaced initial positions", () => {
    for (const modify of [
      (s: GameStartMessage) => { s.players[1].id = s.players[0].id; },
      (s: GameStartMessage) => { s.players[1].tank.id = s.players[0].tank.id; },
      (s: GameStartMessage) => { s.players[1].tank.position.x = 120; },
      (s: GameStartMessage) => { s.players[1].tank.position.x = NaN; },
      (s: GameStartMessage) => { s.players[1].tank.position.y = 299; },
      (s: GameStartMessage) => { s.players[1].tank.shield = Infinity; },
      (s: GameStartMessage) => { s.players[1].tank.health = -1; },
      (s: GameStartMessage) => { s.map.materials[130] = "ROCK"; },
    ]) {
      const message = start(); modify(message);
      expect(isStrictOnlineMessage(message)).toBe(false);
    }
  });

  it("correlates SHOP_FINISH map, completed round and next round", () => {
    const finish = { type: "SHOP_FINISH", shopEpoch: 1, completedRoundNumber: 1, nextRoundNumber: 2,
      players: start().players, map: makeRoundMap(2) };
    expect(isStrictOnlineMessage(finish)).toBe(true);
    expect(isStrictOnlineMessage({ ...finish, map: makeRoundMap(1) })).toBe(false);
    expect(isStrictOnlineMessage({ ...finish, nextRoundNumber: 3 })).toBe(false);
  });
});
