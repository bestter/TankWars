import { describe, expect, it, vi } from "vitest";
import { makePlayer } from "../../../game/__tests__/helpers";
import { createEmptyShopSession } from "../../gameCanvasReducer";
import {
  processNextShopperIfAI,
  type LocalHotseatShopHost,
} from "../localHotseatShop";

describe("processNextShopperIfAI", () => {
  it("uses the captured initial player count instead of the transient shop roster", () => {
    const aiPlayer = makePlayer({
      id: "ai-player",
      isHuman: false,
      aiProfile: "v2-heuristic",
      money: 20_000,
      inventory: {},
    });
    const finishShopPhase = vi.fn();
    const dispatch = vi.fn();
    const host: LocalHotseatShopHost = {
      gameMode: "local",
      initialPlayerCount: 4,
      engineRef: { current: null },
      shopPlayersRef: { current: [aiPlayer] },
      currentShopIndexRef: { current: 0 },
      shopSessionRef: { current: createEmptyShopSession() },
      shopFinishingRef: { current: false },
      gamePhaseRef: { current: "SHOP" },
      shopAiTimeoutRef: { current: null },
      dispatch,
      clearShopAiTimeout: vi.fn(),
      finishShopPhase,
    };

    processNextShopperIfAI(host);

    expect(host.shopPlayersRef.current).toHaveLength(1);
    expect(host.shopPlayersRef.current[0].inventory).toEqual({
      GRENADE: 12,
      CLUSTER: 12,
      DRILLER: 4,
      BULLDOZER: 4,
      NUKE: 1,
    });
    expect(host.shopSessionRef.current.counters[aiPlayer.id]).toEqual({
      GRENADE: 12,
      CLUSTER: 12,
      DRILLER: 4,
      BULLDOZER: 4,
      NUKE: 1,
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "APPLY_LOCAL_SHOP_TRANSACTION" }),
    );
    expect(finishShopPhase).toHaveBeenCalledOnce();
  });
});
