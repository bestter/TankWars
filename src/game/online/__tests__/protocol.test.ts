import { describe, expect, it } from "vitest";
import {
  decodeFireMessage,
  decodeShopBuySellMessage,
  decodeShopReadyMessage,
  isLegacyFirePayload,
  isLegacyShopPayload,
  isStrictOnlineMessage,
  parseStrictOnlineMessage,
  readProtocolVersion,
} from "../protocol";
import { MAX_ACTION_ID_LENGTH } from "../actionId";

describe("strict online protocol", () => {
  it("accepts a complete SHOT identity", () => {
    expect(isStrictOnlineMessage({
      type: "SHOT",
      actionId: "fire-4",
      shotId: 4,
      roundNumber: 2,
      shotNumberInRound: 1,
      isFirstShotOfRound: true,
      slot: 0,
      ownerId: "p1",
      command: { angle: 45, power: 60, weaponId: "MISSILE" },
    })).toBe(true);
  });

  it("rejects malformed, decimal, and unknown-weapon payloads", () => {
    expect(isStrictOnlineMessage({ type: "SHOT_EARNINGS", shotId: 1, authorityEpoch: 1, awards: [{ playerId: "p1", amount: 1.5 }], deadSlots: [false], directHitVictimIds: [], roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null } })).toBe(false);
    expect(isStrictOnlineMessage({ type: "SHOT", actionId: "fire-1", shotId: 1, roundNumber: 1, shotNumberInRound: 1, isFirstShotOfRound: true, slot: 0, ownerId: "p1", command: { angle: 0, power: 1, weaponId: "LASER" } })).toBe(false);
    expect(parseStrictOnlineMessage("{bad-json")).toBeNull();
  });

  it("accepts strict Zeus events and rejects Zeus as a FireCommand weapon", () => {
    expect(isStrictOnlineMessage({
      type: "ZEUS_APPOINTED",
      appointmentId: 1,
      zeusId: "p2",
      zeusSlot: 1,
      rotationSlots: [1, 2, 0],
    })).toBe(true);
    expect(isStrictOnlineMessage({
      type: "ZEUS_STRIKE",
      strikeId: 4,
      zeusId: "p2",
      targetId: "p1",
      resolveAt: 1000,
    })).toBe(true);
    expect(isStrictOnlineMessage({
      type: "ZEUS_STRIKE_APPLIED",
      strikeId: 4,
      zeusId: "p2",
      targetId: "p1",
      award: { playerId: "p2", amount: 75 },
      balances: [{ playerId: "p2", money: 325 }],
      deadSlots: [true, false],
      roundOutcome: { isRoundEnd: true, isDraw: false, roundWinnerId: "p2" },
      nextPlayerIndex: null,
    })).toBe(true);
    expect(isStrictOnlineMessage({
      type: "ZEUS_STATE",
      activeZeusId: "p2",
      currentPlayerIndex: 1,
      rotationSlots: [1, 0],
      deadSlots: [false, false],
      activeStrike: null,
      lastAppliedStrikeId: 0,
    })).toBe(true);
    expect(isStrictOnlineMessage({
      type: "SHOT",
      actionId: "fire-1",
      shotId: 1,
      roundNumber: 1,
      shotNumberInRound: 1,
      isFirstShotOfRound: true,
      slot: 0,
      ownerId: "p1",
      command: { angle: 45, power: 50, weaponId: "ZEUS_LIGHTNING" },
    })).toBe(false);
  });

  it("décode les intentions boutique et omet les champs malformés du refus", () => {
    expect(
      decodeShopBuySellMessage({
        type: "SHOP_BUY_SELL",
        shopEpoch: 2,
        actionId: "buy-1",
        weaponId: "NUKE",
        delta: 1,
      }),
    ).toMatchObject({ ok: true });

    expect(
      decodeShopBuySellMessage({
        type: "SHOP_BUY_SELL",
        shopEpoch: 2,
        actionId: "buy-2",
        weaponId: "LASER",
        delta: 2,
      }),
    ).toEqual({
      ok: false,
      rejection: {
        type: "SHOP_REJECTED",
        shopEpoch: 2,
        actionId: "buy-2",
        reason: "MALFORMED",
      },
    });

    expect(
      decodeShopReadyMessage({ type: "SHOP_READY", shopEpoch: 2 }),
    ).toEqual({
      ok: false,
      rejection: {
        type: "SHOP_REJECTED",
        shopEpoch: 2,
        reason: "MALFORMED",
      },
    });
  });

  it("valide FIRE, SHOP_STATE et SHOT_CATCH_UP avec identités strictes", () => {
    expect(
      decodeFireMessage({
        type: "FIRE",
        actionId: "fire-1",
        command: { angle: 45, power: 50, weaponId: "NUKE" },
      }),
    ).toMatchObject({ ok: true });
    expect(
      decodeFireMessage({
        type: "FIRE",
        actionId: "fire-2",
        command: { angle: 45, power: 50, weaponId: "LASER" },
      }),
    ).toEqual({ ok: false, actionId: "fire-2" });

    expect(
      isStrictOnlineMessage({
        type: "SHOP_STATE",
        shopEpoch: 3,
        roundNumber: 2,
        readySlots: [0],
        players: [],
        purchasesByPlayerId: { p1: { NUKE: 1 } },
        aiShopApplied: true,
      }),
    ).toBe(true);
    expect(
      isStrictOnlineMessage({
        type: "SHOT_CATCH_UP",
        roundNumber: 2,
        activeShotId: null,
        shots: [],
        lastFireResult: null,
      }),
    ).toBe(true);
  });

  it("borne les actionId réseau à 64 caractères", () => {
    const maxLengthId = "a".repeat(MAX_ACTION_ID_LENGTH);
    const overlongId = "b".repeat(MAX_ACTION_ID_LENGTH + 1);
    const command = { angle: 45, power: 50, weaponId: "MISSILE" } as const;

    expect(
      decodeFireMessage({ type: "FIRE", actionId: maxLengthId, command }),
    ).toMatchObject({ ok: true });
    expect(
      decodeFireMessage({ type: "FIRE", actionId: overlongId, command }),
    ).toEqual({ ok: false });
    expect(
      decodeShopBuySellMessage({
        type: "SHOP_BUY_SELL",
        shopEpoch: 1,
        actionId: overlongId,
        weaponId: "GRENADE",
        delta: 1,
      }),
    ).toEqual({
      ok: false,
      rejection: {
        type: "SHOP_REJECTED",
        shopEpoch: 1,
        weaponId: "GRENADE",
        delta: 1,
        reason: "MALFORMED",
      },
    });
    expect(
      isStrictOnlineMessage({
        type: "SHOT",
        actionId: `ai-${crypto.randomUUID()}`,
        shotId: 8,
        roundNumber: 1,
        shotNumberInRound: 1,
        isFirstShotOfRound: true,
        slot: 1,
        ownerId: "p2",
        command,
      }),
    ).toBe(true);
  });

  it("exige protocolVersion sur REQUEST_GAME_START et accepte PROTOCOL_MISMATCH", () => {
    expect(
      isStrictOnlineMessage({
        type: "REQUEST_GAME_START",
        roundNumber: 1,
        lastSeenShotId: 0,
        lastAppliedShopEpoch: 0,
      }),
    ).toBe(false);
    expect(
      isStrictOnlineMessage({
        type: "REQUEST_GAME_START",
        protocolVersion: 1,
        roundNumber: 1,
        lastSeenShotId: 0,
        lastAppliedShopEpoch: 0,
      }),
    ).toBe(true);
    expect(
      isStrictOnlineMessage({
        type: "PROTOCOL_MISMATCH",
        requiredVersion: 1,
        receivedVersion: null,
      }),
    ).toBe(true);
    expect(
      isStrictOnlineMessage({
        type: "GAME_START",
        protocolVersion: 1,
        currentPlayerIndex: 0,
      }),
    ).toBe(true);
    expect(readProtocolVersion({ type: "GAME_START" })).toBeNull();
    expect(
      readProtocolVersion({ type: "GAME_START", protocolVersion: 1 }),
    ).toBe(1);
  });

  it("détecte les payloads FIRE/SHOP de l'ère main", () => {
    expect(
      isLegacyFirePayload({
        type: "FIRE",
        command: { angle: 45, power: 50, weaponId: "MISSILE" },
      }),
    ).toBe(true);
    expect(
      isLegacyFirePayload({
        type: "FIRE",
        actionId: "fire-1",
        command: { angle: 45, power: 50, weaponId: "MISSILE" },
      }),
    ).toBe(false);
    expect(
      isLegacyShopPayload({
        type: "SHOP_BUY_SELL",
        player: { id: "p1" },
        slot: 0,
      }),
    ).toBe(true);
    expect(
      isLegacyShopPayload({
        type: "SHOP_BUY_SELL",
        shopEpoch: 1,
        actionId: "buy-1",
        weaponId: "GRENADE",
        delta: 1,
      }),
    ).toBe(false);
    expect(
      isLegacyShopPayload({ type: "SHOP_ENTER", roundNumber: 1 }),
    ).toBe(false);
    expect(isLegacyShopPayload({ type: "SHOP_ADVANCE", nextIndex: 1 })).toBe(
      true,
    );
  });
});
