// @vitest-environment jsdom
import { createElement, useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePlayer, makeRoundMap, makeTank } from "../../game/__tests__/helpers";
import { GameEngine } from "../../game/engine/GameEngine";
import type { GamePhase } from "../../types/game";
import type { Player } from "../../types/player";
import type { OnlineCanvasSnapshot } from "../../utils/onlineSession";
import { isCanvasPhaseActive, startCanvasLoop } from "../canvasLoop";
import { createEmptyShopSession, type GameCanvasState } from "../gameCanvasReducer";
import { useGameSession } from "../useGameSession";

vi.mock("../../utils/analytics", () => ({ trackEvent: vi.fn() }));

type SessionApi = ReturnType<typeof useGameSession>;

interface RafHarness {
  readonly pendingCount: () => number;
  readonly flushNext: () => void;
  readonly flushAllOnce: (timestamp?: number) => void;
  readonly requestSpy: ReturnType<typeof vi.fn>;
  readonly cancelSpy: ReturnType<typeof vi.fn>;
}

function installRafHarness(): RafHarness {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();

  const requestSpy = vi.fn((cb: FrameRequestCallback): number => {
    const id = nextId++;
    callbacks.set(id, cb);
    return id;
  });

  const cancelSpy = vi.fn((id: number): void => {
    callbacks.delete(id);
  });

  vi.stubGlobal("requestAnimationFrame", requestSpy);
  vi.stubGlobal("cancelAnimationFrame", cancelSpy);

  return {
    pendingCount: () => callbacks.size,
    flushNext: (timestamp = 16): void => {
      const first = callbacks.entries().next();
      if (first.done) return;
      const [id, cb] = first.value;
      callbacks.delete(id);
      cb(timestamp);
    },
    flushAllOnce: (timestamp = 16): void => {
      const batch = [...callbacks.entries()];
      callbacks.clear();
      for (const [, cb] of batch) {
        cb(timestamp);
      }
    },
    requestSpy,
    cancelSpy,
  };
}

function stubCanvas2d(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get: () => () => undefined,
    },
  ) as CanvasRenderingContext2D;
}

class MockCombatWebSocket {
  public readonly readyState = WebSocket.OPEN;
  public readonly send = vi.fn();
  public readonly close = vi.fn();
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onclose: ((event: CloseEvent) => void) | null = null;

  public receive(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
}

function setDocumentVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

function createContentVisibilityEvent(skipped: boolean): Event {
  const event = new Event("contentvisibilityautostatechange");
  Object.defineProperty(event, "skipped", {
    configurable: true,
    value: skipped,
  });
  return event;
}

function createPhaseState(
  overrides: Partial<
    Pick<
      GameCanvasState,
      "gamePhase" | "winner" | "protocolMismatch" | "roundPreparationError" | "networkError"
    >
  > = {},
): Pick<
  GameCanvasState,
  "gamePhase" | "winner" | "protocolMismatch" | "roundPreparationError" | "networkError"
> {
  return {
    gamePhase: "COMBAT",
    winner: null,
    protocolMismatch: null,
    roundPreparationError: null,
    networkError: null,
    ...overrides,
  };
}

function createOnlinePlayers(): Player[] {
  return [
    makePlayer({
      id: "player-1",
      name: "Local",
      isHuman: true,
      tank: makeTank("tank-1", 120, 300),
    }),
    makePlayer({
      id: "player-2",
      name: "Remote",
      isHuman: true,
      tank: makeTank("tank-2", 620, 300),
    }),
  ];
}

function createLocalPlayers(): Player[] {
  return [
    makePlayer({
      id: "player-1",
      name: "Joueur 1",
      isHuman: true,
      money: 1000,
      tank: makeTank("tank-1", 120, 300),
    }),
    makePlayer({
      id: "player-2",
      name: "Joueur 2",
      isHuman: true,
      money: 1000,
      tank: makeTank("tank-2", 620, 300),
    }),
  ];
}

function LocalLoopHarness({
  players,
  sessionRef,
}: {
  readonly players: Player[];
  readonly sessionRef: { current: SessionApi | null };
}) {
  const session = useGameSession({ initialPlayers: players, gameMode: "local" });
  useEffect(() => {
    sessionRef.current = session;
  });
  return createElement("canvas", {
    ref: session.canvasRef,
    className: "game-canvas",
    width: 800,
    height: 480,
  });
}

function OnlineResumeHarness({
  players,
  resumeCanvas,
  ws,
  sessionRef,
}: {
  readonly players: Player[];
  readonly resumeCanvas: OnlineCanvasSnapshot;
  readonly ws: WebSocket;
  readonly sessionRef: { current: SessionApi | null };
}) {
  const session = useGameSession({
    initialPlayers: players,
    gameMode: "online",
    roomId: "room-canvas-loop",
    localPlayerId: "player-1",
    initialCurrentPlayerIndex: 0,
    resumeCanvas,
    initialMap: resumeCanvas.map,
    slot: 0,
    token: "TOKEN1",
    ws,
  });
  useEffect(() => {
    sessionRef.current = session;
  });
  return createElement("canvas", {
    ref: session.canvasRef,
    className: "game-canvas",
    width: 800,
    height: 480,
  });
}

describe("isCanvasPhaseActive", () => {
  const winner = makePlayer({ id: "p1", name: "Winner" });

  it.each<[GamePhase, Player | null, boolean]>([
    ["COMBAT", null, true],
    ["RESOLUTION", null, true],
    ["CELEBRATION", null, true],
    ["GAME_OVER", winner, true],
    ["GAME_OVER", null, false],
    ["SUMMARY", null, false],
    ["SHOP", null, false],
    ["MENU", null, false],
  ])("returns %s for phase %s (winner=%o)", (gamePhase, win, expected) => {
    expect(isCanvasPhaseActive(createPhaseState({ gamePhase, winner: win }))).toBe(expected);
  });

  it("pauses when blocking protocol or round preparation errors are active", () => {
    expect(
      isCanvasPhaseActive(
        createPhaseState({
          gamePhase: "COMBAT",
          protocolMismatch: { requiredVersion: 6, receivedVersion: 4 },
        }),
      ),
    ).toBe(false);
    expect(
      isCanvasPhaseActive(
        createPhaseState({
          gamePhase: "CELEBRATION",
          roundPreparationError: "EXHAUSTED",
        }),
      ),
    ).toBe(false);
    expect(
      isCanvasPhaseActive(
        createPhaseState({
          gamePhase: "COMBAT",
          networkError: "transient_warning",
        }),
      ),
    ).toBe(true);
    expect(
      isCanvasPhaseActive(
        createPhaseState({
          gamePhase: "SHOP",
          networkError: "shop_sync_failed",
        }),
      ),
    ).toBe(false);
    expect(
      isCanvasPhaseActive(
        createPhaseState({
          gamePhase: "SUMMARY",
          networkError: "summary_sync_failed",
        }),
      ),
    ).toBe(false);
  });
});

describe("startCanvasLoop", () => {
  const originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(
    document,
    "visibilityState",
  );
  const originalContentVisibilityDescriptor = Object.getOwnPropertyDescriptor(
    CSSStyleDeclaration.prototype,
    "contentVisibility",
  );
  const originalStyleContentVisibility = Object.getOwnPropertyDescriptor(
    document.documentElement.style,
    "contentVisibility",
  );

  beforeEach(() => {
    setDocumentVisibility("visible");
  });

  afterEach(() => {
    cleanup();
    if (originalVisibilityDescriptor) {
      Object.defineProperty(document, "visibilityState", originalVisibilityDescriptor);
    } else {
      delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
    }
    if (originalContentVisibilityDescriptor) {
      Object.defineProperty(
        CSSStyleDeclaration.prototype,
        "contentVisibility",
        originalContentVisibilityDescriptor,
      );
    }
    if (originalStyleContentVisibility) {
      Object.defineProperty(
        document.documentElement.style,
        "contentVisibility",
        originalStyleContentVisibility,
      );
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("schedules requestAnimationFrame in active phase and cancels after 1 static frame on pause", () => {
    const raf = installRafHarness();
    const renderFn = vi.fn();
    const controller = startCanvasLoop(renderFn);

    expect(renderFn).toHaveBeenCalledTimes(1);
    expect(raf.pendingCount()).toBe(1);

    raf.flushNext();
    expect(renderFn).toHaveBeenCalledTimes(2);
    expect(raf.pendingCount()).toBe(1);

    controller.setPhaseActive(false);
    expect(renderFn).toHaveBeenCalledTimes(3);
    expect(raf.cancelSpy).toHaveBeenCalledTimes(1);
    expect(raf.pendingCount()).toBe(0);

    // Setting the same inactive state again does not render extra frames.
    controller.setPhaseActive(false);
    expect(renderFn).toHaveBeenCalledTimes(3);

    controller.setPhaseActive(true);
    expect(renderFn).toHaveBeenCalledTimes(4);
    expect(raf.pendingCount()).toBe(1);

    controller.dispose();
    expect(raf.pendingCount()).toBe(0);
  });

  it("draws exactly 1 static frame and schedules 0 rAF when started with initialPhaseActive=false", () => {
    const raf = installRafHarness();
    const renderFn = vi.fn();
    const controller = startCanvasLoop(renderFn, { initialPhaseActive: false });

    expect(renderFn).toHaveBeenCalledTimes(1);
    expect(raf.requestSpy).not.toHaveBeenCalled();
    expect(raf.pendingCount()).toBe(0);

    controller.setPhaseActive(true);
    expect(renderFn).toHaveBeenCalledTimes(2);
    expect(raf.requestSpy).toHaveBeenCalledTimes(1);
    expect(raf.pendingCount()).toBe(1);

    controller.dispose();
  });

  it("pauses on visibilitychange hidden and resumes without duplicate rAF on visible", () => {
    const raf = installRafHarness();
    const renderFn = vi.fn();
    const controller = startCanvasLoop(renderFn);

    expect(renderFn).toHaveBeenCalledTimes(1);
    expect(raf.pendingCount()).toBe(1);

    setDocumentVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(raf.cancelSpy).toHaveBeenCalledTimes(1);
    expect(raf.pendingCount()).toBe(0);

    // Phase transition while tab is hidden must not draw in background.
    controller.setPhaseActive(false);
    expect(renderFn).toHaveBeenCalledTimes(1);

    // Returning visible while phase is inactive draws the deferred static frame once without starting rAF.
    setDocumentVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(renderFn).toHaveBeenCalledTimes(2);
    expect(raf.pendingCount()).toBe(0);

    // Repeated hidden -> visible transitions while inactive do not redraw static frames.
    setDocumentVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    setDocumentVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(renderFn).toHaveBeenCalledTimes(2);
    expect(raf.pendingCount()).toBe(0);

    // Returning to active phase resumes cleanly with a single rAF.
    controller.setPhaseActive(true);
    expect(renderFn).toHaveBeenCalledTimes(3);
    expect(raf.pendingCount()).toBe(1);

    // Repeated visible events never schedule duplicate rAFs.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(renderFn).toHaveBeenCalledTimes(3);
    expect(raf.pendingCount()).toBe(1);

    // Hidden while active -> visible again resumes immediately.
    setDocumentVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(raf.pendingCount()).toBe(0);
    setDocumentVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(renderFn).toHaveBeenCalledTimes(4);
    expect(raf.pendingCount()).toBe(1);

    // Returning to active while still hidden clears pending static render and resumes normally once visible.
    setDocumentVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    controller.setPhaseActive(false);
    controller.setPhaseActive(true);
    expect(renderFn).toHaveBeenCalledTimes(4);
    expect(raf.pendingCount()).toBe(0);
    setDocumentVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(renderFn).toHaveBeenCalledTimes(5);
    expect(raf.pendingCount()).toBe(1);

    controller.dispose();
  });

  it("defers initial static frame when started hidden and draws once on visible without repeating", () => {
    const raf = installRafHarness();
    const renderFn = vi.fn();
    setDocumentVisibility("hidden");

    const controller = startCanvasLoop(renderFn, { initialPhaseActive: false });
    expect(renderFn).not.toHaveBeenCalled();
    expect(raf.requestSpy).not.toHaveBeenCalled();
    expect(raf.pendingCount()).toBe(0);

    setDocumentVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(renderFn).toHaveBeenCalledTimes(1);
    expect(raf.requestSpy).not.toHaveBeenCalled();
    expect(raf.pendingCount()).toBe(0);

    // Subsequent visibility toggles in static phase do not repeat the static draw.
    setDocumentVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    setDocumentVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(renderFn).toHaveBeenCalledTimes(1);
    expect(raf.pendingCount()).toBe(0);

    controller.dispose();

    // Disposing while a static frame is pending cancels any deferred draw on later visibility.
    setDocumentVisibility("hidden");
    const disposedRenderFn = vi.fn();
    const disposedController = startCanvasLoop(disposedRenderFn, {
      initialPhaseActive: false,
    });
    disposedController.dispose();
    setDocumentVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(disposedRenderFn).not.toHaveBeenCalled();
  });

  it("defers static frame when paused off-screen via contentvisibilityautostatechange and draws once when back in viewport", () => {
    const raf = installRafHarness();
    const canvas = document.createElement("canvas");
    Object.defineProperty(document.documentElement.style, "contentVisibility", {
      configurable: true,
      value: "auto",
      writable: true,
    });

    const renderFn = vi.fn();
    const controller = startCanvasLoop(renderFn, { canvas });
    expect(renderFn).toHaveBeenCalledTimes(1);
    expect(raf.pendingCount()).toBe(1);

    canvas.dispatchEvent(createContentVisibilityEvent(true));
    expect(raf.pendingCount()).toBe(0);

    controller.setPhaseActive(false);
    expect(renderFn).toHaveBeenCalledTimes(1);

    // Tab visibility changes while still off-screen must not draw.
    setDocumentVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    setDocumentVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(renderFn).toHaveBeenCalledTimes(1);

    // Returning to viewport draws the pending static frame once without scheduling rAF.
    canvas.dispatchEvent(createContentVisibilityEvent(false));
    expect(renderFn).toHaveBeenCalledTimes(2);
    expect(raf.pendingCount()).toBe(0);

    // Repeated off-screen toggles in static phase do not redraw.
    canvas.dispatchEvent(createContentVisibilityEvent(true));
    canvas.dispatchEvent(createContentVisibilityEvent(false));
    expect(renderFn).toHaveBeenCalledTimes(2);
    expect(raf.pendingCount()).toBe(0);

    controller.dispose();
  });

  it("pauses and resumes on canvas contentvisibilityautostatechange events", () => {
    const raf = installRafHarness();
    const canvas = document.createElement("canvas");
    Object.defineProperty(document.documentElement.style, "contentVisibility", {
      configurable: true,
      value: "auto",
      writable: true,
    });
    const observerSpy = vi.fn();
    vi.stubGlobal("IntersectionObserver", observerSpy);

    const renderFn = vi.fn();
    const controller = startCanvasLoop(renderFn, { canvas });

    expect(observerSpy).not.toHaveBeenCalled();
    expect(renderFn).toHaveBeenCalledTimes(1);
    expect(raf.pendingCount()).toBe(1);

    canvas.dispatchEvent(createContentVisibilityEvent(true));
    expect(raf.cancelSpy).toHaveBeenCalledTimes(1);
    expect(raf.pendingCount()).toBe(0);

    canvas.dispatchEvent(createContentVisibilityEvent(false));
    expect(renderFn).toHaveBeenCalledTimes(2);
    expect(raf.pendingCount()).toBe(1);

    // Repeated skipped=false does not create a second rAF.
    canvas.dispatchEvent(createContentVisibilityEvent(false));
    expect(renderFn).toHaveBeenCalledTimes(2);
    expect(raf.pendingCount()).toBe(1);

    controller.dispose();
    // Listeners removed on dispose.
    canvas.dispatchEvent(createContentVisibilityEvent(true));
    expect(raf.cancelSpy).toHaveBeenCalledTimes(2);
  });

  it("falls back to IntersectionObserver with rootMargin 200px when contentVisibility is unsupported", () => {
    const raf = installRafHarness();
    const canvas = document.createElement("canvas");
    const rootStyleWithoutCv = { display: "block" };
    vi.spyOn(document.documentElement, "style", "get").mockReturnValue(
      rootStyleWithoutCv as unknown as CSSStyleDeclaration,
    );

    const observerState: { callback: IntersectionObserverCallback | null } = {
      callback: null,
    };
    const observe = vi.fn();
    const disconnect = vi.fn();
    const observerOptions: IntersectionObserverInit[] = [];
    const MockIntersectionObserver = vi.fn(function FakeIntersectionObserver(
      callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit,
    ) {
      observerState.callback = callback;
      if (options) observerOptions.push(options);
      return {
        root: null,
        rootMargin: options?.rootMargin ?? "",
        thresholds: [0],
        observe,
        unobserve: vi.fn(),
        disconnect,
        takeRecords: () => [],
      };
    });
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);

    const renderFn = vi.fn();
    const controller = startCanvasLoop(renderFn, { canvas });

    expect(MockIntersectionObserver).toHaveBeenCalledOnce();
    expect(observerOptions[0]).toEqual({ rootMargin: "200px" });
    expect(observe).toHaveBeenCalledExactlyOnceWith(canvas);
    expect(renderFn).toHaveBeenCalledTimes(1);
    expect(raf.pendingCount()).toBe(1);

    observerState.callback?.(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    expect(raf.pendingCount()).toBe(0);

    observerState.callback?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    expect(renderFn).toHaveBeenCalledTimes(2);
    expect(raf.pendingCount()).toBe(1);

    // Pausing off-screen via IntersectionObserver defers static frame until re-entering viewport.
    observerState.callback?.(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    expect(raf.pendingCount()).toBe(0);

    controller.setPhaseActive(false);
    expect(renderFn).toHaveBeenCalledTimes(2);

    observerState.callback?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    expect(renderFn).toHaveBeenCalledTimes(3);
    expect(raf.pendingCount()).toBe(0);

    observerState.callback?.(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    observerState.callback?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    expect(renderFn).toHaveBeenCalledTimes(3);

    controller.dispose();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(raf.pendingCount()).toBe(0);
  });
});

function createOnlineResumeSnapshot(
  players: Player[],
  gamePhase: "COMBAT" | "SUMMARY" | "SHOP",
): OnlineCanvasSnapshot {
  const isPostRound = gamePhase === "SUMMARY" || gamePhase === "SHOP";
  return {
    map: makeRoundMap(1),
    gamePhase,
    currentManche: isPostRound ? 2 : 1,
    uiPlayers: players,
    shopPlayers: gamePhase === "SHOP" ? players : [],
    currentShopIndex: 0,
    roundResult: isPostRound
      ? {
          damageDealt: { "player-1": 100, "player-2": 0 },
          earningsByPlayer: { "player-1": 200, "player-2": 0 },
          terrainDestroyed: 50,
          survivors: ["player-1"],
        }
      : null,
    lastRoundOutcome: isPostRound ? { isDraw: false, winner: players[0] } : null,
    wind: 0,
    authoritySlot: 0,
    authorityEpoch: 1,
    lastAppliedShotId: 0,
    lastAppliedZeusStrikeId: 0,
    shopSession: {
      ...createEmptyShopSession(),
      epoch: isPostRound ? 1 : 0,
      roundNumber: isPostRound ? 1 : 0,
      authoritativeReceived: gamePhase === "SHOP",
    },
    lastAppliedShopEpoch: 0,
    lastCompletedRoundNumber: isPostRound ? 1 : 0,
    lastSeenShotId: 0,
    pendingFireIntent: null,
    fireRejection: null,
    roundEarningsByPlayer: {},
    earningsOverlay: null,
  };
}

describe("useGameSession canvasLoop integration", () => {
  const originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(
    document,
    "visibilityState",
  );

  beforeEach(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => stubCanvas2d(),
    });
    setDocumentVisibility("visible");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    cleanup();
    if (originalVisibilityDescriptor) {
      Object.defineProperty(document, "visibilityState", originalVisibilityDescriptor);
    } else {
      delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("pauses Canvas drawing during SUMMARY and SHOP while keeping GameEngine physics alive, then resumes in COMBAT", async () => {
    const raf = installRafHarness();
    const renderSpy = vi.spyOn(GameEngine.prototype, "render");
    const stopEngineSpy = vi.spyOn(GameEngine.prototype, "stop");
    const players = createLocalPlayers();
    const sessionRef: { current: SessionApi | null } = { current: null };

    render(createElement(LocalLoopHarness, { players, sessionRef }));

    // Initial COMBAT mount: 1 synchronous frame + 2 pending rAFs (1 GameEngine physics + 1 Canvas draw)
    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(raf.pendingCount()).toBe(2);

    // Flush one rAF batch -> both GameEngine physics and Canvas draw execute and reschedule
    raf.flushAllOnce(32);
    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(raf.pendingCount()).toBe(2);

    // Trigger end of round -> CELEBRATION (remains animated for fireworks)
    const engine = stopEngineSpy.mock.instances[0] as GameEngine | undefined;
    const activeEngine = engine ?? (renderSpy.mock.instances[0] as GameEngine);
    const roster = activeEngine.getTankManager().getPlayers();
    roster[1].tank.isDead = true;

    await act(async () => {
      activeEngine.onRoundEnded?.({
        survivors: [roster[0]],
        roundWinner: roster[0],
        isDraw: false,
      });
    });

    expect(sessionRef.current?.state.gamePhase).toBe("CELEBRATION");
    raf.flushAllOnce(48);
    expect(renderSpy).toHaveBeenCalledTimes(3);
    expect(raf.pendingCount()).toBe(2);

    // Skip celebration -> SUMMARY: clearRoundCelebration + 1 static frame, Canvas rAF canceled
    const clearCelebrationSpy = vi.spyOn(activeEngine, "clearRoundCelebration");
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    expect(sessionRef.current?.state.gamePhase).toBe("SUMMARY");
    expect(clearCelebrationSpy).toHaveBeenCalledOnce();
    expect(renderSpy).toHaveBeenCalledTimes(4);
    expect(raf.pendingCount()).toBe(1); // Only GameEngine physics rAF remains

    // Flushing rAFs while in SUMMARY executes GameEngine physics only, 0 Canvas draws
    raf.flushAllOnce(64);
    raf.flushAllOnce(80);
    expect(renderSpy).toHaveBeenCalledTimes(4);
    expect(raf.pendingCount()).toBe(1);
    expect(stopEngineSpy).not.toHaveBeenCalled();

    // Advance to SHOP -> remains static with 0 Canvas draws
    await act(async () => {
      sessionRef.current?.handleNextRound();
    });
    expect(sessionRef.current?.state.gamePhase).toBe("SHOP");
    raf.flushAllOnce(96);
    expect(renderSpy).toHaveBeenCalledTimes(4);
    expect(raf.pendingCount()).toBe(1);

    // Complete shop for both humans -> returns to COMBAT and resumes Canvas rAF immediately
    await act(async () => {
      sessionRef.current?.handleShopReady();
    });
    await act(async () => {
      sessionRef.current?.handleShopReady();
    });

    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    expect(renderSpy).toHaveBeenCalledTimes(5);
    expect(raf.pendingCount()).toBe(2);
  });

  it.each(["SUMMARY", "SHOP"] as const)(
    "renders 1 static frame without looping when online resumeCanvas starts directly in %s, then starts loop on COMBAT",
    async (initialPhase) => {
      const raf = installRafHarness();
      const renderSpy = vi.spyOn(GameEngine.prototype, "render");
      const players = createOnlinePlayers();
      const ws = new MockCombatWebSocket();
      const resumeCanvas = createOnlineResumeSnapshot(players, initialPhase);
      const sessionRef: { current: SessionApi | null } = { current: null };

      render(
        createElement(OnlineResumeHarness, {
          players,
          resumeCanvas,
          ws: ws as unknown as WebSocket,
          sessionRef,
        }),
      );

      expect(sessionRef.current?.state.gamePhase).toBe(initialPhase);
      expect(renderSpy).toHaveBeenCalledTimes(1);
      expect(raf.pendingCount()).toBe(1); // Only GameEngine physics loop

      raf.flushAllOnce(32);
      expect(renderSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        ws.receive({
          type: "SHOP_FINISH",
          shopEpoch: 1,
          completedRoundNumber: 1,
          nextRoundNumber: 2,
          players,
          map: makeRoundMap(2),
        });
      });

      expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
      expect(renderSpy).toHaveBeenCalledTimes(2);
      expect(raf.pendingCount()).toBe(2);
    },
  );

  it("defers static SUMMARY render when round ends while tab is hidden and draws once when visible", async () => {
    const raf = installRafHarness();
    const renderSpy = vi.spyOn(GameEngine.prototype, "render");
    const players = createLocalPlayers();
    const sessionRef: { current: SessionApi | null } = { current: null };

    render(createElement(LocalLoopHarness, { players, sessionRef }));

    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(raf.pendingCount()).toBe(2);

    const activeEngine = renderSpy.mock.instances[0] as GameEngine;
    const roster = activeEngine.getTankManager().getPlayers();
    roster[1].tank.isDead = true;

    await act(async () => {
      activeEngine.onRoundEnded?.({
        survivors: [roster[0]],
        roundWinner: roster[0],
        isDraw: false,
      });
    });

    expect(sessionRef.current?.state.gamePhase).toBe("CELEBRATION");

    setDocumentVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(raf.pendingCount()).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    expect(sessionRef.current?.state.gamePhase).toBe("SUMMARY");
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(raf.pendingCount()).toBe(1);

    setDocumentVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(raf.pendingCount()).toBe(1);

    raf.flushAllOnce(64);
    setDocumentVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    setDocumentVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(raf.pendingCount()).toBe(1);
  });

  it.each(["SUMMARY", "SHOP"] as const)(
    "defers initial static frame when online resumeCanvas starts in %s while hidden and draws once on visible",
    async (initialPhase) => {
      const raf = installRafHarness();
      const renderSpy = vi.spyOn(GameEngine.prototype, "render");
      const players = createOnlinePlayers();
      const ws = new MockCombatWebSocket();
      const resumeCanvas = createOnlineResumeSnapshot(players, initialPhase);
      const sessionRef: { current: SessionApi | null } = { current: null };

      setDocumentVisibility("hidden");
      render(
        createElement(OnlineResumeHarness, {
          players,
          resumeCanvas,
          ws: ws as unknown as WebSocket,
          sessionRef,
        }),
      );

      expect(sessionRef.current?.state.gamePhase).toBe(initialPhase);
      expect(renderSpy).not.toHaveBeenCalled();
      expect(raf.pendingCount()).toBe(1); // Only GameEngine physics loop

      raf.flushAllOnce(32);
      expect(renderSpy).not.toHaveBeenCalled();

      setDocumentVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      expect(renderSpy).toHaveBeenCalledTimes(1);
      expect(raf.pendingCount()).toBe(1);

      // Repeated visibility toggles in static phase do not repeat the static render.
      setDocumentVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      setDocumentVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      expect(renderSpy).toHaveBeenCalledTimes(1);
      expect(raf.pendingCount()).toBe(1);

      await act(async () => {
        ws.receive({
          type: "SHOP_FINISH",
          shopEpoch: 1,
          completedRoundNumber: 1,
          nextRoundNumber: 2,
          players,
          map: makeRoundMap(2),
        });
      });

      expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
      expect(renderSpy).toHaveBeenCalledTimes(2);
      expect(raf.pendingCount()).toBe(2);
    },
  );

  it("pauses Canvas drawing after 1 static frame on blocking protocolMismatch in COMBAT", async () => {
    const raf = installRafHarness();
    const renderSpy = vi.spyOn(GameEngine.prototype, "render");
    const players = createOnlinePlayers();
    const ws = new MockCombatWebSocket();
    const resumeCanvas = createOnlineResumeSnapshot(players, "COMBAT");
    const sessionRef: { current: SessionApi | null } = { current: null };

    render(
      createElement(OnlineResumeHarness, {
        players,
        resumeCanvas,
        ws: ws as unknown as WebSocket,
        sessionRef,
      }),
    );

    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(raf.pendingCount()).toBe(2);

    await act(async () => {
      ws.receive({
        type: "PROTOCOL_MISMATCH",
        requiredVersion: 6,
        receivedVersion: 4,
      });
    });

    expect(sessionRef.current?.state.protocolMismatch).toEqual({
      requiredVersion: 6,
      receivedVersion: 4,
    });
    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(raf.pendingCount()).toBe(1);

    raf.flushAllOnce(32);
    expect(renderSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps Canvas active on GAME_OVER with winner and paused on draw GAME_OVER", async () => {
    const raf = installRafHarness();
    const renderSpy = vi.spyOn(GameEngine.prototype, "render");

    // 1) Draw GAME_OVER (winner === null) stays paused
    const drawPlayers = createLocalPlayers();
    const drawSessionRef: { current: SessionApi | null } = { current: null };
    render(createElement(LocalLoopHarness, { players: drawPlayers, sessionRef: drawSessionRef }));
    const drawEngine = renderSpy.mock.instances[0] as GameEngine;

    await act(async () => {
      drawEngine.getTankManager().setPlayers([]);
      drawSessionRef.current?.handleNextRound();
    });

    expect(drawSessionRef.current?.state.gamePhase).toBe("GAME_OVER");
    expect(drawSessionRef.current?.state.winner).toBeNull();
    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(raf.pendingCount()).toBe(1);

    cleanup();
    renderSpy.mockClear();

    // 2) Victory GAME_OVER (winner !== null) resumes Canvas loop for fireworks
    const winPlayers = createLocalPlayers();
    const winSessionRef: { current: SessionApi | null } = { current: null };
    render(createElement(LocalLoopHarness, { players: winPlayers, sessionRef: winSessionRef }));
    const winEngine = renderSpy.mock.instances[0] as GameEngine;
    const survivor = winEngine.getTankManager().getPlayers()[0];

    await act(async () => {
      winEngine.getTankManager().setPlayers([survivor]);
      winSessionRef.current?.handleNextRound();
    });

    expect(winSessionRef.current?.state.gamePhase).toBe("GAME_OVER");
    expect(winSessionRef.current?.state.winner?.id).toBe(survivor.id);
    expect(raf.pendingCount()).toBe(2);
    raf.flushAllOnce(48);
    expect(renderSpy).toHaveBeenCalledTimes(2);
  });
});
