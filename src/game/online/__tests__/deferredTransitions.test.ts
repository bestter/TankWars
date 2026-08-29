import { describe, expect, it } from "vitest";
import { DeferredTransitionBuffer } from "../deferredTransitions";
import type {
  RoundEndMessage,
  ShopFinishMessage,
  ShopStateMessage,
} from "../protocol";

function shopState(epoch: number): ShopStateMessage {
  return {
    type: "SHOP_STATE",
    shopEpoch: epoch,
    roundNumber: 1,
    readySlots: [],
    players: [],
    purchasesByPlayerId: {},
    aiShopApplied: true,
  };
}

function shopFinish(epoch: number): ShopFinishMessage {
  return {
    type: "SHOP_FINISH",
    shopEpoch: epoch,
    completedRoundNumber: 1,
    nextRoundNumber: 2,
    players: [],
  };
}

function roundEnd(): RoundEndMessage {
  return {
    type: "ROUND_END",
    players: [],
    roundWinnerId: null,
    isDraw: true,
    roundNumber: 1,
  };
}

describe("DeferredTransitionBuffer", () => {
  it("keeps SHOP_STATE then SHOP_FINISH instead of overwriting", () => {
    const buffer = new DeferredTransitionBuffer();
    buffer.enqueue({ kind: "SHOP_STATE", message: shopState(1) });
    buffer.enqueue({ kind: "SHOP_FINISH", message: shopFinish(1) });
    expect(buffer.drain().map((item) => item.kind)).toEqual([
      "SHOP_STATE",
      "SHOP_FINISH",
    ]);
  });

  it("does not let a late SHOP_STATE wipe a pending SHOP_FINISH", () => {
    const buffer = new DeferredTransitionBuffer();
    buffer.enqueue({ kind: "SHOP_FINISH", message: shopFinish(1) });
    buffer.enqueue({ kind: "SHOP_STATE", message: shopState(1) });
    expect(buffer.drain().map((item) => item.kind)).toEqual(["SHOP_FINISH"]);
  });

  it("applies ROUND_END before shop transitions", () => {
    const buffer = new DeferredTransitionBuffer();
    buffer.enqueue({ kind: "SHOP_STATE", message: shopState(1) });
    buffer.enqueue({ kind: "ROUND_END", message: roundEnd() });
    buffer.enqueue({ kind: "SHOP_FINISH", message: shopFinish(1) });
    expect(buffer.drain().map((item) => item.kind)).toEqual([
      "ROUND_END",
      "SHOP_STATE",
      "SHOP_FINISH",
    ]);
  });

  it("replaces a pending SHOP_STATE with a later one before finish", () => {
    const buffer = new DeferredTransitionBuffer();
    buffer.enqueue({ kind: "SHOP_STATE", message: shopState(1) });
    buffer.enqueue({ kind: "SHOP_STATE", message: shopState(1) });
    const drained = buffer.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]?.kind).toBe("SHOP_STATE");
  });

  it("keeps a newer-epoch SHOP_STATE after a pending SHOP_FINISH", () => {
    const buffer = new DeferredTransitionBuffer();
    buffer.enqueue({ kind: "SHOP_FINISH", message: shopFinish(1) });
    buffer.enqueue({ kind: "SHOP_STATE", message: shopState(2) });
    expect(buffer.drain().map((item) => item.kind)).toEqual([
      "SHOP_FINISH",
      "SHOP_STATE",
    ]);
  });

  it("clears after drain", () => {
    const buffer = new DeferredTransitionBuffer();
    buffer.enqueue({ kind: "ROUND_END", message: roundEnd() });
    expect(buffer.isEmpty).toBe(false);
    buffer.drain();
    expect(buffer.isEmpty).toBe(true);
    expect(buffer.drain()).toEqual([]);
  });
});
