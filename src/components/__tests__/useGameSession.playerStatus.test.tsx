// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect } from "react";
import { render, act, cleanup } from "@testing-library/react";
import { useGameSession } from "../useGameSession";
import { makePlayer, makeTank, makeRoundMap } from "../../game/__tests__/helpers";
import type { Player } from "../../types/player";
import { AIByProfileStrategy } from "../../game/entities/ai/AIByProfileStrategy";
import { GameEngine, type ResolvedShotPreview } from "../../game/engine/GameEngine";
import { createEmptyShopSession } from "../gameCanvasReducer";
import type { OnlineCanvasSnapshot } from "../../utils/onlineSession";

vi.mock("../../utils/analytics", () => ({ trackEvent: vi.fn() }));

type SessionApi = ReturnType<typeof useGameSession>;

function stubCanvas2d(): CanvasRenderingContext2D {
  return new Proxy({}, { get: () => () => undefined }) as CanvasRenderingContext2D;
}

function Harness({
  players,
  sessionRef,
  freeWeapons = false,
  resumeCanvas,
  initialMap,
  initialCurrentPlayerIndex,
}: {
  players: Player[];
  sessionRef: { current: SessionApi | null };
  freeWeapons?: boolean;
  resumeCanvas?: OnlineCanvasSnapshot;
  initialMap?: OnlineCanvasSnapshot["map"];
  initialCurrentPlayerIndex?: number;
}) {
  const session = useGameSession({
    initialPlayers: players,
    gameMode: "local",
    freeWeapons,
    resumeCanvas,
    initialMap,
    initialCurrentPlayerIndex,
  });
  const { canvasRef } = session;
  useEffect(() => {
    sessionRef.current = session;
  });
  return <canvas ref={canvasRef} width={800} height={480} />;
}

function duo(secondHuman = false): Player[] {
  return [
    makePlayer({
      id: "human-1",
      name: "Alice",
      isHuman: true,
      inventory: { GRENADE: 2 },
      tank: makeTank("tank-1", 120, 300),
    }),
    makePlayer({
      id: "cpu-1",
      name: "Bob",
      isHuman: secondHuman,
      aiProfile: secondHuman ? undefined : "v1-random",
      inventory: {},
      tank: makeTank("tank-2", 620, 300),
    }),
  ];
}

describe("PlayerStatusList lifecycle", () => {
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

  it("publishes turn 1 as soon as the local match is mounted", () => {
    const sessionRef: { current: SessionApi | null } = { current: null };
    render(<Harness players={duo()} sessionRef={sessionRef} />);

    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    expect(sessionRef.current?.state.turnInfo).toMatchObject({
      playerId: "human-1",
      isHuman: true,
      isInputLocked: false,
      tanksAreFalling: false,
    });
    expect(sessionRef.current?.state.playerStatus?.map((player) => player.id)).toEqual([
      "human-1",
      "cpu-1",
    ]);
  });

  it("publishes the resumed combat turn without waiting for an aim change", () => {
    const roster = duo(true);
    const map = makeRoundMap(1);
    const snapshot: OnlineCanvasSnapshot = {
      map,
      gamePhase: "COMBAT",
      currentManche: 1,
      uiPlayers: roster,
      shopPlayers: [],
      currentShopIndex: 0,
      roundResult: null,
      lastRoundOutcome: null,
      wind: 0,
      authoritySlot: null,
      authorityEpoch: 0,
      lastAppliedShotId: 0,
      shopSession: createEmptyShopSession(),
      lastAppliedShopEpoch: 0,
      lastCompletedRoundNumber: 0,
      lastSeenShotId: 0,
      pendingFireIntent: null,
      fireRejection: null,
      roundEarningsByPlayer: {},
      earningsOverlay: null,
    };
    const sessionRef: { current: SessionApi | null } = { current: null };
    render(
      <Harness
        players={roster}
        sessionRef={sessionRef}
        resumeCanvas={snapshot}
        initialMap={map}
        initialCurrentPlayerIndex={0}
      />,
    );

    expect(sessionRef.current?.state.turnInfo?.playerId).toBe("human-1");
    expect(sessionRef.current?.state.playerStatus?.map((player) => player.id)).toEqual([
      "human-1",
      "cpu-1",
    ]);
  });

  it("publishes the first turn after the shop returns to combat", () => {
    const sessionRef: { current: SessionApi | null } = { current: null };
    render(<Harness players={duo()} sessionRef={sessionRef} />);

    act(() => {
      sessionRef.current?.handleNextRound();
    });
    expect(sessionRef.current?.state.gamePhase).toBe("SHOP");
    expect(sessionRef.current?.state.playerStatus).toBeNull();

    act(() => {
      sessionRef.current?.handleShopReady();
      vi.advanceTimersByTime(400);
    });

    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    expect(sessionRef.current?.state.turnInfo).toMatchObject({
      playerId: "human-1",
      isHuman: true,
      isInputLocked: false,
    });
    expect(sessionRef.current?.state.playerStatus?.map((player) => player.id)).toEqual([
      "human-1",
      "cpu-1",
    ]);
  });

  it("publishes the first turn of a free-weapons round opened from the summary", () => {
    const setPlayersSpy = vi.spyOn(GameEngine.prototype, "setPlayers");
    const sessionRef: { current: SessionApi | null } = { current: null };
    render(<Harness players={duo()} sessionRef={sessionRef} freeWeapons />);

    const engine = setPlayersSpy.mock.instances[0] as GameEngine;
    const roster = engine.getTankManager().getPlayers();
    roster[1].tank.isDead = true;
    act(() => {
      engine.onRoundEnded?.({
        survivors: [roster[0]],
        roundWinner: roster[0],
        isDraw: false,
      });
    });
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(sessionRef.current?.state.gamePhase).toBe("SUMMARY");

    act(() => {
      sessionRef.current?.handleNextRound();
    });

    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    expect(sessionRef.current?.state.turnInfo?.isHuman).toBe(true);
    expect(sessionRef.current?.state.playerStatus?.length).toBe(2);
  });

  it("republishes the aiming list after a new match replaces GAME_OVER", () => {
    const setPlayersSpy = vi.spyOn(GameEngine.prototype, "setPlayers");
    const sessionRef: { current: SessionApi | null } = { current: null };
    render(<Harness players={duo(true)} sessionRef={sessionRef} />);
    const engine = setPlayersSpy.mock.instances[0] as GameEngine;

    act(() => {
      sessionRef.current?.handleNextRound();
    });
    act(() => {
      engine.getTankManager().setPlayers([engine.getTankManager().getPlayers()[0]]);
      sessionRef.current?.handleShopReady();
      sessionRef.current?.handleShopReady();
    });
    expect(sessionRef.current?.state.gamePhase).toBe("GAME_OVER");
    expect(sessionRef.current?.state.playerStatus).toBeNull();

    act(() => {
      sessionRef.current?.handleNewGame();
    });

    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    expect(sessionRef.current?.state.turnInfo).toMatchObject({
      playerId: "player-1",
      isHuman: true,
      isInputLocked: false,
    });
    expect(sessionRef.current?.state.playerStatus?.map((player) => player.id)).toEqual([
      "player-1",
      "player-2",
    ]);
  });

  it("publishes turn 1 when the failed opening round is prepared again", () => {
    vi.spyOn(GameEngine.prototype, "setPlayers").mockImplementationOnce(() => {
      throw new Error("ROUND_PREPARATION_FAILED");
    });
    const sessionRef: { current: SessionApi | null } = { current: null };
    render(<Harness players={duo()} sessionRef={sessionRef} />);
    expect(sessionRef.current?.state.roundPreparationError).toBe("EXHAUSTED");
    expect(sessionRef.current?.state.playerStatus).toBeNull();

    act(() => {
      sessionRef.current?.retryRoundPreparation();
    });

    expect(sessionRef.current?.state.roundPreparationError).toBeNull();
    expect(sessionRef.current?.state.turnInfo?.playerId).toBe("human-1");
    expect(sessionRef.current?.state.playerStatus?.map((player) => player.id)).toEqual([
      "human-1",
      "cpu-1",
    ]);
  });
});

function shotPreview(): ResolvedShotPreview {
  return {
    shotId: 1,
    awards: [],
    damageDealtMilliByPlayer: {},
    hasEarnings: false,
    roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
    balances: [],
    directHitVictimIds: [],
  };
}

function trio(): Player[] {
  return [
    makePlayer({ id: "human-1", name: "Alice", isHuman: true, inventory: {}, tank: makeTank("tank-1", 120, 300) }),
    makePlayer({ id: "human-2", name: "Bea", isHuman: true, inventory: {}, tank: makeTank("tank-2", 400, 300) }),
    makePlayer({ id: "cpu-1", name: "Ced", isHuman: false, aiProfile: "v1-random", inventory: {}, tank: makeTank("tank-3", 620, 300) }),
  ];
}

function mount(players: Player[], freeWeapons = false) {
  const setPlayersSpy = vi.spyOn(GameEngine.prototype, "setPlayers");
  const sessionRef: { current: SessionApi | null } = { current: null };
  render(<Harness players={players} sessionRef={sessionRef} freeWeapons={freeWeapons} />);
  const engine = setPlayersSpy.mock.instances.at(-1) as GameEngine | undefined;
  if (!sessionRef.current || !engine) throw new Error("La session locale n'est pas montée.");
  return { sessionRef, engine };
}

function live(sessionRef: { current: SessionApi | null }): SessionApi {
  const session = sessionRef.current;
  if (!session) throw new Error("La session locale n'est pas montée.");
  return session;
}

class FakeAdvisorWorker {
  static posts: unknown[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  postMessage = (message: unknown): void => { FakeAdvisorWorker.posts.push(message); };
  terminate = (): void => {};
}

describe("local target lock across a match #375", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => stubCanvas2d(),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(AIByProfileStrategy.prototype, "executeTurn").mockImplementation(() => new Promise(() => {}));
    FakeAdvisorWorker.posts = [];
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps independent locks through the shop and a direct free-weapons round", () => {
    const shop = mount(duo());
    act(() => {
      const session = live(shop.sessionRef);
      session.advisor.toggleLock("cpu-1");
      session.advisor.setObjective("SURVIE");
      session.handleNextRound();
    });
    expect(live(shop.sessionRef).state.gamePhase).toBe("SHOP");
    expect(live(shop.sessionRef).state.playerStatus).toBeNull();
    act(() => {
      live(shop.sessionRef).handleShopReady();
      vi.advanceTimersByTime(400);
    });
    expect(live(shop.sessionRef).state.gamePhase).toBe("COMBAT");
    vi.stubGlobal("Worker", FakeAdvisorWorker);
    act(() => { live(shop.sessionRef).advisor.request(); });
    expect(live(shop.sessionRef).advisor.view).toMatchObject({ objective: "SURVIE", lockedTargetId: "cpu-1" });

    cleanup();
    const free = mount(duo(), true);
    act(() => {
      const session = live(free.sessionRef);
      session.advisor.toggleLock("cpu-1");
      session.advisor.setObjective("SURVIE");
      free.engine.onRoundEnded?.({
        survivors: [...free.engine.getTankManager().getPlayers()],
        roundWinner: null,
        isDraw: false,
      });
    });
    act(() => { vi.advanceTimersByTime(10000); });
    expect(live(free.sessionRef).state.gamePhase).toBe("SUMMARY");
    act(() => { live(free.sessionRef).handleNextRound(); });
    expect(live(free.sessionRef).state.gamePhase).toBe("COMBAT");
    act(() => { live(free.sessionRef).advisor.request(); });
    expect(live(free.sessionRef).advisor.view).toMatchObject({ objective: "OPTIMISER_PROFIT", lockedTargetId: "cpu-1" });
  });

  it("clears every human lock when the target dies and does not restore it after respawn", () => {
    const { sessionRef, engine } = mount(trio(), true);
    act(() => { live(sessionRef).advisor.toggleLock("cpu-1"); });
    act(() => { engine.getTurnManager().nextTurn(); });
    act(() => { live(sessionRef).advisor.toggleLock("cpu-1"); });
    expect(live(sessionRef).advisor.view).toMatchObject({ playerId: "human-2", lockedTargetId: "cpu-1" });
    const cpu = engine.getTankManager().getPlayers().find((player) => player.id === "cpu-1");
    if (!cpu) throw new Error("cpu");
    cpu.tank.isDead = true;
    cpu.tank.health = 0;
    act(() => { engine.onShotResolved?.(shotPreview()); });
    expect(cpu.tank.isDead).toBe(true);
    expect(live(sessionRef).advisor.view.lockedTargetId).toBeUndefined();
    act(() => { engine.getTurnManager().nextTurn(); });
    act(() => { live(sessionRef).advisor.setObjective("SURVIE"); });
    expect(live(sessionRef).advisor.view).toMatchObject({ playerId: "human-1" });
    expect(live(sessionRef).advisor.view.lockedTargetId).toBeUndefined();
    const alive = engine.getTankManager().getPlayers().filter((player) => player.id !== "cpu-1");
    act(() => {
      engine.onRoundEnded?.({ survivors: alive, roundWinner: alive[0] ?? null, isDraw: false });
    });
    expect(cpu.tank.isDead).toBe(true);
    act(() => { vi.advanceTimersByTime(10000); });
    act(() => { live(sessionRef).handleNextRound(); });
    vi.stubGlobal("Worker", FakeAdvisorWorker);
    act(() => { live(sessionRef).advisor.request(); });
    const respawned = engine.getTankManager().getPlayers().find((player) => player.id === "cpu-1");
    expect(respawned?.tank.isDead).toBe(false);
    expect(respawned?.tank.health).toBeGreaterThan(0);
    expect(live(sessionRef).advisor.view.lockedTargetId).toBeUndefined();
  });

  it("keeps the owner's lock when that owner dies and the target respawns with them", () => {
    const { sessionRef, engine } = mount(trio(), true);
    act(() => {
      const session = live(sessionRef);
      session.advisor.toggleLock("human-2");
      session.advisor.setObjective("SURVIE");
    });
    const owner = engine.getTankManager().getPlayers().find((player) => player.id === "human-1");
    if (!owner) throw new Error("owner");
    owner.tank.isDead = true;
    owner.tank.health = 0;
    act(() => { engine.onShotResolved?.(shotPreview()); });
    expect(live(sessionRef).advisor.view).toMatchObject({ lockedTargetId: "human-2", objective: "SURVIE" });
    const survivors = engine.getTankManager().getPlayers().filter((player) => !player.tank.isDead);
    act(() => {
      engine.onRoundEnded?.({ survivors, roundWinner: survivors[0] ?? null, isDraw: false });
    });
    expect(owner.tank.isDead).toBe(true);
    act(() => { vi.advanceTimersByTime(10000); });
    act(() => { live(sessionRef).handleNextRound(); });
    vi.stubGlobal("Worker", FakeAdvisorWorker);
    act(() => { live(sessionRef).advisor.request(); });
    const respawnedOwner = engine.getTankManager().getPlayers().find((player) => player.id === "human-1");
    expect(respawnedOwner?.tank.health).toBeGreaterThan(0);
    expect(live(sessionRef).advisor.view).toMatchObject({
      playerId: "human-1", objective: "OPTIMISER_PROFIT", lockedTargetId: "human-2",
    });
  });

  it("clears every lock when a new local match starts", () => {
    const { sessionRef } = mount(duo(true));
    act(() => { live(sessionRef).advisor.toggleLock("cpu-1"); });
    expect(live(sessionRef).advisor.view.lockedTargetId).toBe("cpu-1");
    act(() => { live(sessionRef).handleNewGame(); });
    expect(live(sessionRef).advisor.view.lockedTargetId).toBeUndefined();
    expect(live(sessionRef).advisor.view.objective).toBe("OPTIMISER_PROFIT");
    expect(live(sessionRef).state.playerStatus?.map((player) => player.id)).toEqual(["player-1", "player-2"]);
  });

  it("does not request advice again when the human aims by hand", () => {
    vi.stubGlobal("Worker", FakeAdvisorWorker);
    const { sessionRef, engine } = mount(duo());
    act(() => { live(sessionRef).advisor.toggleLock("cpu-1"); });
    act(() => { live(sessionRef).advisor.request(); });
    expect(FakeAdvisorWorker.posts).toHaveLength(1);
    expect(FakeAdvisorWorker.posts[0]).toMatchObject({ lockedTargetId: "cpu-1", objective: "OPTIMISER_PROFIT" });
    const before = engine.getTurnManager().getCurrentPlayer()?.tank.angle ?? 0;
    act(() => { live(sessionRef).handleAdjustAngle(4); });
    expect(engine.getTurnManager().getCurrentPlayer()?.tank.angle).toBe(before + 4);
    expect(FakeAdvisorWorker.posts).toHaveLength(1);
    expect(live(sessionRef).advisor.view.lockedTargetId).toBe("cpu-1");
    act(() => { live(sessionRef).advisor.setObjective("SURVIE"); });
    expect(FakeAdvisorWorker.posts).toHaveLength(1);
    expect(live(sessionRef).advisor.view).toMatchObject({ objective: "SURVIE", lockedTargetId: "cpu-1" });
  });
});
