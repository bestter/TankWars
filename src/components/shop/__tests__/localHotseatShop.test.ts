import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePlayer, makeTank } from "../../../game/__tests__/helpers";
import { createEmptyShopSession } from "../../gameCanvasReducer";
import { fixture } from "../../../game/endurance/__tests__/helpers";
import { getRNG, setRNG, type RNG } from "../../../utils/random";
import {
  processNextShopperIfAI,
  type LocalHotseatShopHost,
} from "../localHotseatShop";

describe("processNextShopperIfAI", () => {
  let previousRng: RNG;

  beforeEach(() => {
    previousRng = getRNG();
  });

  afterEach(() => {
    setRNG(previousRng);
    vi.restoreAllMocks();
  });

  it("uses the captured initial player count instead of the transient shop roster", () => {
    let draws = 0;
    setRNG({
      next() {
        draws++;
        return 0.99;
      },
    });
    const aiPlayer = makePlayer({
      tank: makeTank("tank-1", 120, 300, { maxShield: 40 }),
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

    expect(draws).toBe(2);
    expect(host.shopPlayersRef.current).toHaveLength(1);
    expect(host.shopPlayersRef.current[0].inventory).toEqual({
      GRENADE: 12,
      CLUSTER: 12,
      DRILLER: 4,
      BULLDOZER: 4,
    });
    expect(host.shopSessionRef.current.counters[aiPlayer.id]).toEqual({
      GRENADE: 12,
      CLUSTER: 12,
      DRILLER: 4,
      BULLDOZER: 4,
      REINFORCED_SHIELD: 1,
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "APPLY_LOCAL_SHOP_TRANSACTION" }),
    );
    expect(finishShopPhase).toHaveBeenCalledOnce();
    expect(visit).toHaveBeenCalledOnce(); expect(applied).toHaveBeenCalledOnce();
  });

  it("records occasional NUKE and THERMONUCLEAR purchases for SIMPLE/OK without altering currentWeapon", () => {
    const rolls = [0.09, 0.04];
    let index = 0;
    setRNG({
      next() {
        return rolls[index++] ?? 0.99;
      },
    });
    const aiPlayer = makePlayer({
      tank: makeTank("tank-1", 120, 300, { maxShield: 40 }),
      id: "ai-simple",
      isHuman: false,
      aiProfile: "v1-random",
      money: 5_000,
      inventory: {},
    });
    const finishShopPhase = vi.fn();
    const dispatch = vi.fn();
    const host: LocalHotseatShopHost = {
      endurance: fixture().run,
      gameMode: "local",
      initialPlayerCount: 2,
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
    const recordedItems: string[] = [];
    vi.spyOn(host.endurance!, "beginShopVisit").mockReturnValue("visit-2");
    vi.spyOn(host.endurance!, "endShopVisit").mockImplementation((_id, _player, purchases) => {
      recordedItems.push(...purchases.map((p) => p.weaponId ?? p.equipmentId));
    });

    processNextShopperIfAI(host);

    expect(index).toBe(2);
    expect(host.shopPlayersRef.current[0].inventory).toEqual({
      GRENADE: 1,
      CLUSTER: 1,
      NUKE: 1,
      THERMONUCLEAR: 1,
    });
    expect(host.shopPlayersRef.current[0].money).toBe(5_000 - 75 - 135 - 420 - 2_500 - 420);
    expect(host.shopPlayersRef.current[0].tank.currentWeapon).toBe("MISSILE");
    expect(recordedItems).toEqual(["GRENADE", "CLUSTER", "NUKE", "THERMONUCLEAR", "REINFORCED_SHIELD"]);
  });
});
