import { describe, expect, it, vi } from "vitest";
import { makePlayer } from "../../../game/__tests__/helpers";
import { createEmptyShopSession } from "../../gameCanvasReducer";
import { fixture } from "../../../game/endurance/__tests__/helpers";
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
      endurance: fixture().run,
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
    const visit = vi.spyOn(host.endurance!, "beginShopVisit").mockReturnValue("visit-1");
    const applied = vi.spyOn(host.endurance!, "endShopVisit").mockImplementation((_id, player, purchases) => {
      expect(host.shopPlayersRef.current[0]).toBe(player);
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "APPLY_LOCAL_SHOP_TRANSACTION" }));
      expect(purchases.length).toBeGreaterThan(0);
    });

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
    expect(visit).toHaveBeenCalledOnce(); expect(applied).toHaveBeenCalledOnce();
  });
});
