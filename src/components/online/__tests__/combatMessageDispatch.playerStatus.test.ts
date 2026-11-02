import { afterEach, describe, expect, it, vi } from "vitest";
import { GameEngine } from "../../../game/engine/GameEngine";
import { makePlayer, makeTank } from "../../../game/__tests__/helpers";
import type { AuthoritativeShotQueue } from "../../../game/online/authoritativeShotQueue";
import { isStrictOnlineMessage } from "../../../game/online/protocol";
import type { Player } from "../../../types/player";
import { createEmptyShopSession } from "../../gameCanvasReducer";
import { wireEngineSessionCallbacks } from "../../wireEngineSession";
import { dispatchCombatMessage, type CombatMessageContext } from "../combatMessageDispatch";

describe("STATE_UPDATE player status", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("copies inventories updated by the wire before the turn HUD", () => {
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const engine = new GameEngine(800, 480);
    const human = makePlayer({
      id: "human",
      name: "Alice",
      isHuman: true,
      inventory: { MISSILE: 99, GRENADE: 1 },
      tank: makeTank("tank-human", 120, 300, { currentWeapon: "MISSILE" }),
    });
    const cpu = makePlayer({
      id: "cpu",
      name: "Bob",
      isHuman: false,
      aiProfile: "v1-random",
      inventory: { MISSILE: 99 },
      tank: makeTank("tank-cpu", 620, 300),
    });
    engine.setPlayers([human, cpu]);
    const live = engine.getTankManager().getPlayers();
    live[0].inventory = { MISSILE: 99, GRENADE: 1 };
    live[0].tank.currentWeapon = "MISSILE";

    const wirePlayers: Player[] = live.map((player, index) => index === 0
      ? {
        ...player,
        money: player.money,
        inventory: { MISSILE: 99, GRENADE: 7, BULLET: 2 },
        tank: { ...player.tank, currentWeapon: "BULLET" },
      }
      : { ...player, inventory: { ...player.inventory }, tank: { ...player.tank } });
    const message = {
      type: "STATE_UPDATE",
      currentPlayerIndex: 0,
      roundEnded: false,
      players: wirePlayers,
    };
    expect(isStrictOnlineMessage(message)).toBe(true);

    const dispatch = vi.fn();
    wireEngineSessionCallbacks({
      engine,
      dispatch,
      gameMode: "online",
      sendCombatMessage: () => {},
      combatActiveShotId: () => null,
      gamePhaseRef: { current: "COMBAT" },
      currentMancheRef: { current: 1 },
      lastCompletedRoundNumberRef: { current: 0 },
      lastZeusAppointmentIdRef: { current: 0 },
      lastAppliedZeusStrikeIdRef: { current: 0 },
      zeusAnnouncementTimerRef: { current: null },
      celebrationTimerRef: { current: null },
      pendingShotPreviewsRef: { current: new Map() },
      submitShotEarningsRef: { current: () => {} },
      roundEndFromNetworkRef: { current: false },
      clearZeusAnnouncement: () => {},
      clearCelebrationTimer: () => {},
      goToSummary: () => {},
    });

    const ctx: CombatMessageContext = {
      engine,
      shotQueue: {
        processedEventSequence: 0,
        replayActiveNow: false,
        pendingCount: 0,
      } as AuthoritativeShotQueue,
      localSlotNum: 0,
      dispatch,
      protocolMismatchRef: { current: false },
      authoritySlotRef: { current: 0 },
      authorityEpochRef: { current: 1 },
      lastAppliedShotIdRef: { current: 0 },
      pendingShotPreviewsRef: { current: new Map() },
      shopSessionRef: { current: createEmptyShopSession() },
      gamePhaseRef: { current: "COMBAT" },
      applyFireRejection: vi.fn(),
      scheduleTransition: vi.fn(),
      submitShotEarnings: vi.fn(),
      syncWireEconomy: (value: unknown) => {
        if (!Array.isArray(value)) return;
        const updates = value as Player[];
        for (const update of updates) {
          const player = engine.getTankManager().getPlayers().find((entry) => entry.id === update.id);
          if (!player) continue;
          player.money = update.money;
          player.inventory = { ...update.inventory };
          player.tank.currentWeapon = update.tank.currentWeapon;
        }
      },
      buildOverlayAwards: () => [],
    };
    cleanups.push(() => {
      engine.getTurnManager().removeInputListeners();
      engine.stop();
    });

    dispatchCombatMessage(ctx, message);

    const turn = dispatch.mock.calls.find((call) => call[0].type === "SET_TURN_INFO")?.[0].info;
    const status = dispatch.mock.calls.find((call) => call[0].type === "SET_PLAYER_STATUS")?.[0].players;
    expect(turn.currentWeapon).toBe("BULLET");
    expect(turn.inventory.GRENADE).toBe(7);
    expect(status?.[0]?.inventory.GRENADE).toBe(7);
    expect(status?.[0]?.inventory.BULLET).toBe(2);
  });
});
