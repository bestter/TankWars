import { describe, expect, it, vi } from "vitest";
import { DeferredTransitionBuffer } from "../deferredTransitions";
import {
  flushDeferredTransitions,
  scheduleDeferredTransition,
} from "../flushDeferredTransitions";
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

describe("flushDeferredTransitions", () => {
  it("does not apply while a shot replay is active", () => {
    const buffer = new DeferredTransitionBuffer();
    const apply = vi.fn();
    scheduleDeferredTransition(
      { replayActiveNow: true, pendingCount: 0 },
      buffer,
      apply,
      { kind: "SHOP_STATE", message: shopState(1) },
    );
    expect(apply).not.toHaveBeenCalled();
    expect(buffer.isEmpty).toBe(false);
  });

  it("applies SHOP_STATE then SHOP_FINISH when idle", () => {
    const buffer = new DeferredTransitionBuffer();
    const applied: string[] = [];
    const queue = { replayActiveNow: false, pendingCount: 0 };
    const apply = (item: { kind: string }): void => {
      applied.push(item.kind);
    };
    scheduleDeferredTransition(queue, buffer, apply, {
      kind: "SHOP_STATE",
      message: shopState(1),
    });
    scheduleDeferredTransition(queue, buffer, apply, {
      kind: "SHOP_FINISH",
      message: shopFinish(1),
    });
    expect(applied).toEqual(["SHOP_STATE", "SHOP_FINISH"]);
    expect(buffer.isEmpty).toBe(true);
  });

  it("keeps SHOP_FINISH when a late SHOP_STATE of the same epoch is scheduled", () => {
    const buffer = new DeferredTransitionBuffer();
    const applied: string[] = [];
    const replaying = { replayActiveNow: true, pendingCount: 0 };
    const apply = (item: { kind: string }): void => {
      applied.push(item.kind);
    };
    scheduleDeferredTransition(replaying, buffer, apply, {
      kind: "SHOP_FINISH",
      message: shopFinish(1),
    });
    scheduleDeferredTransition(replaying, buffer, apply, {
      kind: "SHOP_STATE",
      message: shopState(1),
    });
    flushDeferredTransitions(
      { replayActiveNow: false, pendingCount: 0 },
      buffer,
      apply,
    );
    expect(applied).toEqual(["SHOP_FINISH"]);
  });

  it("holds ROUND_END while shots are queued but still applies SHOP_STATE", () => {
    const buffer = new DeferredTransitionBuffer();
    const applied: string[] = [];
    const queue = { replayActiveNow: false, pendingCount: 1 };
    const apply = (item: { kind: string }): void => {
      applied.push(item.kind);
    };
    buffer.enqueue({ kind: "ROUND_END", message: roundEnd() });
    buffer.enqueue({ kind: "SHOP_STATE", message: shopState(1) });
    flushDeferredTransitions(queue, buffer, apply);
    expect(applied).toEqual(["SHOP_STATE"]);
    expect(buffer.drain().map((item) => item.kind)).toEqual(["ROUND_END"]);
  });

  it("applies ROUND_END when the shot queue is idle and empty", () => {
    const buffer = new DeferredTransitionBuffer();
    const apply = vi.fn();
    scheduleDeferredTransition(
      { replayActiveNow: false, pendingCount: 0 },
      buffer,
      apply,
      { kind: "ROUND_END", message: roundEnd() },
    );
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[0]).toMatchObject({ kind: "ROUND_END" });
  });
});
