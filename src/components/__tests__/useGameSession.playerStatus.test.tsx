// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect } from "react";
import { render, act, cleanup } from "@testing-library/react";
import { useGameSession } from "../useGameSession";
import { makePlayer, makeTank, makeRoundMap } from "../../game/__tests__/helpers";
import type { Player } from "../../types/player";
import { AIByProfileStrategy } from "../../game/entities/ai/AIByProfileStrategy";
import { GameEngine } from "../../game/engine/GameEngine";
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
