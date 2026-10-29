// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect } from "react";
import { render, act, cleanup } from "@testing-library/react";
import { useGameSession } from "../useGameSession";
import { makePlayer, makeTank } from "../../game/__tests__/helpers";
import type { Player } from "../../types/player";
import { VGA_PALETTE } from "../../types/game";
import { GameEngine } from "../../game/engine/GameEngine";
import { AIByProfileStrategy } from "../../game/entities/ai/AIByProfileStrategy";
import { EnduranceSession, type EnduranceClock } from "../../game/endurance/session";
import { MemoryStorage } from "../../game/endurance/__tests__/helpers";
import { createLocalPlayers } from "../localPlayers";
import { defaultConfig } from "../../game/endurance/config";
import type { JournalEntry } from "../../game/endurance/journal";

vi.mock("../../utils/analytics", () => ({ trackEvent: vi.fn() }));

type SessionApi = ReturnType<typeof useGameSession>;

function stubCanvas2d(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get: () => () => undefined,
    },
  ) as CanvasRenderingContext2D;
}

function FreeWeaponsHarness({
  players,
  freeWeapons = true,
  sessionRef,
  endurance,
}: {
  players: Player[];
  freeWeapons?: boolean;
  sessionRef: { current: SessionApi | null };
  endurance?: EnduranceSession;
}) {
  const session = useGameSession({
    initialPlayers: players,
    gameMode: "local",
    freeWeapons,
    endurance,
  });
  const { canvasRef } = session;
  useEffect(() => {
    sessionRef.current = session;
  });
  return <canvas ref={canvasRef} width={800} height={480} />;
}

describe("useGameSession free weapons mode (#355)", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => stubCanvas2d(),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(AIByProfileStrategy.prototype, "executeTurn").mockImplementation(
      () => new Promise(() => {}),
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts round 1 with replenished inventories for human and AI tanks", () => {
    const players: Player[] = [
      makePlayer({
        id: "human-1",
        name: "Joueur Humain",
        isHuman: true,
        money: 0,
        inventory: {},
        tank: makeTank("tank-1", 120, 300),
      }),
      makePlayer({
        id: "cpu-expert",
        name: "CPU Expert",
        isHuman: false,
        aiProfile: "v4-smart",
        money: 0,
        inventory: {},
        tank: makeTank("tank-2", 620, 300),
      }),
    ];

    const sessionRef: { current: SessionApi | null } = { current: null };
    render(
      <FreeWeaponsHarness
        players={players}
        freeWeapons={true}
        sessionRef={sessionRef}
      />,
    );

    const uiPlayers = sessionRef.current?.state.uiPlayers;
    expect(uiPlayers).toBeDefined();
    expect(uiPlayers?.length).toBe(2);

    const human = uiPlayers?.find((p) => p.id === "human-1");
    expect(human?.inventory).toEqual({
      BULLET: 12,
      GRENADE: 12,
      CLUSTER: 12,
      DRILLER: 12,
      BULLDOZER: 12,
      NUKE: 2,
      THERMONUCLEAR: 1,
    });

    const cpu = uiPlayers?.find((p) => p.id === "cpu-expert");
    expect(cpu?.inventory).toEqual({
      GRENADE: 6,
      CLUSTER: 6,
      DRILLER: 6,
      BULLDOZER: 6,
      NUKE: 2,
      THERMONUCLEAR: 1,
    });
  });

  it("advances from SUMMARY to round 2 directly without entering SHOP phase", async () => {
    const setPlayersSpy = vi.spyOn(GameEngine.prototype, "setPlayers");
    const players: Player[] = [
      makePlayer({
        id: "human-1",
        name: "Joueur Humain",
        isHuman: true,
        money: 500,
        inventory: { BULLET: 5 },
        tank: makeTank("tank-1", 120, 300),
      }),
      makePlayer({
        id: "cpu-1",
        name: "CPU OK",
        isHuman: false,
        aiProfile: "v2-heuristic",
        money: 500,
        inventory: { GRENADE: 2 },
        tank: makeTank("tank-2", 620, 300),
      }),
    ];

    const sessionRef: { current: SessionApi | null } = { current: null };
    render(
      <FreeWeaponsHarness
        players={players}
        freeWeapons={true}
        sessionRef={sessionRef}
      />,
    );

    const engine = setPlayersSpy.mock.instances[0] as GameEngine;
    expect(sessionRef.current?.state.currentManche).toBe(1);
    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");

    // Spend some ammo during combat
    const humanTank = engine.getTankManager().getPlayers().find((p) => p.id === "human-1");
    if (humanTank) {
      humanTank.inventory.BULLET = 3;
      humanTank.inventory.NUKE = 0;
    }

    // Trigger end of round
    const roster = engine.getTankManager().getPlayers();
    roster[1].tank.isDead = true;
    await act(async () => {
      engine.onRoundEnded?.({
        survivors: [roster[0]],
        roundWinner: roster[0],
        isDraw: false,
      });
    });

    expect(sessionRef.current?.state.gamePhase).toBe("CELEBRATION");
    expect(sessionRef.current?.state.currentManche).toBe(2);

    // Skip celebration fireworks to SUMMARY
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    expect(sessionRef.current?.state.gamePhase).toBe("SUMMARY");

    // Call handleNextRound while in freeWeapons mode
    await act(async () => {
      sessionRef.current?.handleNextRound();
    });

    // The phase advances directly to COMBAT for round 2 without going through SHOP
    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    expect(sessionRef.current?.state.currentManche).toBe(2);

    // Human inventory has been replenished back to full targets
    const nextHuman = sessionRef.current?.state.uiPlayers.find(
      (p) => p.id === "human-1",
    );
    expect(nextHuman?.inventory.BULLET).toBe(12);
    expect(nextHuman?.inventory.NUKE).toBe(2);
  });

  it("blocks handleShopBuySell and handleShopReady when freeWeapons is active", () => {
    const players: Player[] = [
      makePlayer({
        id: "human-1",
        name: "Joueur Humain",
        isHuman: true,
        money: 1000,
        inventory: { BULLET: 12 },
        tank: makeTank("tank-1", 120, 300),
      }),
      makePlayer({
        id: "cpu-1",
        name: "CPU OK",
        isHuman: false,
        aiProfile: "v2-heuristic",
        money: 1000,
        inventory: {},
        tank: makeTank("tank-2", 620, 300),
      }),
    ];

    const sessionRef: { current: SessionApi | null } = { current: null };
    render(
      <FreeWeaponsHarness
        players={players}
        freeWeapons={true}
        sessionRef={sessionRef}
      />,
    );

    const prevMoney = sessionRef.current?.state.uiPlayers[0].money;
    const prevInventory = {
      ...sessionRef.current?.state.uiPlayers[0].inventory,
    };

    act(() => {
      sessionRef.current?.handleShopBuySell("NUKE", 1);
      sessionRef.current?.handleShopReady();
    });

    expect(sessionRef.current?.state.uiPlayers[0].money).toBe(prevMoney);
    expect(sessionRef.current?.state.uiPlayers[0].inventory).toEqual(
      prevInventory,
    );
  });

  it("automatically advances round in endurance without shop events when freeWeapons is enabled", async () => {
    class MockJournalStorage extends MemoryStorage {
      entries: JournalEntry[] = [];
      async appendJournal(entries: readonly JournalEntry[]) {
        this.entries.push(...structuredClone(entries));
      }
      async readJournal(_sessionId: string, after: number, limit: number) {
        return this.entries
          .filter((entry) => entry.sequence > after)
          .slice(0, limit);
      }
    }

    const setPlayersSpy = vi.spyOn(GameEngine.prototype, "setPlayers");
    const players = createLocalPlayers([
      { name: "Simple", isHuman: false, aiProfile: "v1-random", color: VGA_PALETTE.BLUE },
      { name: "Expert", isHuman: false, aiProfile: "v4-smart", color: VGA_PALETTE.RED },
    ]);
    const config = { ...defaultConfig(players), freeWeapons: true, maxBlocks: 2 };
    const now = 0;
    let ids = 0;
    const clock: EnduranceClock = {
      now: () => now,
      date: () => new Date(100000 + now).toISOString(),
      id: () => `id-${++ids}`,
      seed: () => 4294967295,
    };
    const storage = new MockJournalStorage();
    const run = new EnduranceSession(config, storage, clock, "test-build");
    await run.start();

    const sessionRef = { current: null as SessionApi | null };
    render(
      <FreeWeaponsHarness
        players={structuredClone(players)}
        freeWeapons={true}
        sessionRef={sessionRef}
        endurance={run}
      />,
    );

    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    // Check round 1 started
    expect(run.session.roundsStarted).toBe(1);

    const engine = setPlayersSpy.mock.instances[0] as GameEngine;
    const roster = engine.getTankManager().getPlayers();
    roster[1].tank.isDead = true;

    // Simulate end of round 1
    await act(async () => {
      engine.onRoundEnded?.({
        survivors: [roster[0]],
        roundWinner: roster[0],
        isDraw: false,
      });
    });
    expect(sessionRef.current?.state.gamePhase).toBe("CELEBRATION");

    // Skip celebration fireworks to SUMMARY
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    expect(sessionRef.current?.state.gamePhase).toBe("SUMMARY");

    // Endurance 3s timer advances directly to COMBAT for round 2
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    expect(sessionRef.current?.state.currentManche).toBe(2);
    expect(run.session.roundsStarted).toBe(2);

    // Verify that NO shop-start event exists in journal
    const hasShopStart = storage.entries.some((entry) => entry.event.kind === "shop-start");
    const hasPurchase = storage.entries.some((entry) => entry.event.kind === "purchase");
    expect(hasShopStart).toBe(false);
    expect(hasPurchase).toBe(false);

    await act(async () => {
      await run.stop();
    });
  });

  it("retries round preparation in round 1 with replenished weapons", () => {
    const players: Player[] = [
      makePlayer({
        id: "human-1",
        name: "Joueur Humain",
        isHuman: true,
        inventory: {},
        tank: makeTank("tank-1", 120, 300),
      }),
      makePlayer({
        id: "cpu-1",
        name: "CPU Simple",
        isHuman: false,
        aiProfile: "v1-random",
        inventory: {},
        tank: makeTank("tank-2", 620, 300),
      }),
    ];

    const sessionRef: { current: SessionApi | null } = { current: null };
    render(
      <FreeWeaponsHarness
        players={players}
        freeWeapons={true}
        sessionRef={sessionRef}
      />,
    );

    expect(sessionRef.current?.state.currentManche).toBe(1);

    act(() => {
      sessionRef.current?.retryRoundPreparation();
    });

    const human = sessionRef.current?.state.uiPlayers.find((p) => p.id === "human-1");
    expect(human?.inventory.BULLET).toBe(12);
    expect(human?.inventory.NUKE).toBe(2);
    expect(sessionRef.current?.state.roundPreparationError).toBeNull();
  });
});
