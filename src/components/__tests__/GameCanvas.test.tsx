// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { GameCanvas } from "../GameCanvas";
import { useGameSession } from "../useGameSession";
import { makePlayer, makeTank } from "../../game/__tests__/helpers";
import type { Color, GamePhase, RoundResult } from "../../types/game";
import type { Player } from "../../types/player";
import type { WeaponId } from "../../types/weapon";
import type { CurrentTurnInfo } from "../../game/engine/TurnManager";
import { createEmptyShopSession } from "../gameCanvasReducer";
import type { PlayerStatusCard } from "../playerStatus";
import fr from "../../locales/fr.json";
import en from "../../locales/en.json";
import { AdvisorController } from "../advisor/AdvisorController";
import type { AdvisorSnapshot } from "../../game/entities/ai/shotAdvisor";
import { copyLivingPlayerStatus } from "../playerStatus";

const language = vi.hoisted(() => ({ current: "fr" }));

// Mock react-i18next
vi.mock("react-i18next", async () => {
  const fr = (await import("../../locales/fr.json")).default;
  const en = (await import("../../locales/en.json")).default;
  return {
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) => {
        if (key === "round_new_game_required") return (language.current === "fr" ? fr : en).round_new_game_required;
        if (options && options.name !== undefined) {
          return `${key}_${options.name}`;
        }
        return key;
      },
      i18n: { language: language.current },
    }),
    Trans: ({ i18nKey, values }: { i18nKey: string; values?: Record<string, unknown> }) => (
      <span data-testid="trans-component">{i18nKey} {values ? JSON.stringify(values) : ""}</span>
    ),
    i18n: language,
  };
});

// Mock useGameSession to control state & handlers cleanly
vi.mock("../useGameSession", () => ({
  useGameSession: vi.fn(),
}));

describe("GameCanvas component", () => {
  const p1 = makePlayer({
    id: "p1",
    name: "Player 1",
    isHuman: true,
    tank: makeTank("t1", 100, 300, { color: "#ff0000" as Color }),
  });

  const p2 = makePlayer({
    id: "p2",
    name: "CPU 2",
    isHuman: false,
    aiProfile: "v1-random",
    tank: makeTank("t2", 400, 300, { color: "#00ff00" as Color }),
  });

  const defaultTurnInfo: CurrentTurnInfo = {
    playerName: "Player 1",
    playerId: "p1",
    isHuman: true,
    playerColor: "#ff0000" as Color,
    angle: 45,
    power: 60,
    currentWeapon: "MISSILE",
    inventory: { MISSILE: -1 },
    turn: 1,
    isInputLocked: false,
    tanksAreFalling: false,
  };

  const defaultSessionState = {
    gamePhase: "COMBAT" as GamePhase,
    wind: 5,
    turnInfo: defaultTurnInfo,
    winner: null as Player | null,
    showNewGameButton: false,
    roundResult: null as RoundResult | null,
    currentManche: 1,
    lastRoundOutcome: null,
    shopPlayers: [p1, p2],
    currentShopIndex: 0,
    uiPlayers: [p1, p2],
    earningsOverlay: null,
    zeusAnnouncement: null,
    shopSession: createEmptyShopSession(),
    lastAppliedShopEpoch: 0,
    lastCompletedRoundNumber: 0,
    lastSeenShotId: 0,
    pendingFireIntent: null,
    fireRejection: null,
    protocolMismatch: null,
    playerStatus: null as readonly PlayerStatusCard[] | null,
  };

  let mockHandlers: {
    handleCanvasClick: Mock<() => void>;
    handleWeaponSelect: Mock<(weaponId: WeaponId) => void>;
    handleShopBuySell: Mock<(weaponId: WeaponId, delta: number) => void>;
    handleShopReady: Mock<() => void>;
    handleNextRound: Mock<() => void>;
    retryRoundPreparation: Mock<() => void>;
    handleNewGameFromSummary: Mock<() => void>;
    handleNewGame: Mock<() => void>;
    handleAdjustAngle: Mock<(delta: number) => void>;
    handleAdjustPower: Mock<(delta: number) => void>;
    handleCycleWeapon: Mock<() => void>;
    handleFire: Mock<() => void>;
    dismissEarningsOverlay: Mock<() => void>;
  };

  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    language.current = "fr";
    vi.clearAllMocks();
    cleanup();

    originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    mockHandlers = {
      handleCanvasClick: vi.fn(),
      handleWeaponSelect: vi.fn(),
      handleShopBuySell: vi.fn(),
      handleShopReady: vi.fn(),
      handleNextRound: vi.fn(),
      retryRoundPreparation: vi.fn(),
      handleNewGameFromSummary: vi.fn(),
      handleNewGame: vi.fn(),
      handleAdjustAngle: vi.fn(),
      handleAdjustPower: vi.fn(),
      handleCycleWeapon: vi.fn(),
      handleFire: vi.fn(),
      dismissEarningsOverlay: vi.fn(),
    };

    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn() },
      canvasRef: { current: null },
      state: defaultSessionState,
      CANVAS_WIDTH: 800,
      CANVAS_HEIGHT: 480,
      isLocalShopTurn: true,
      shopDisplayPlayer: p1,
      localShopDone: false,
      ...mockHandlers,
    });
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    cleanup();
  });

  it("renders canvas element with proper attributes and accessibility roles", () => {
    render(<GameCanvas />);

    const canvas = screen.getByRole("img");
    expect(canvas).toBeDefined();
    expect(canvas.getAttribute("aria-label")).toBe("canvas_game_aria_label");
    expect(canvas.tabIndex).toBe(0);
  });

  it("renders the bilingual Zeus announcement key with the appointed player name", () => {
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn() },
      canvasRef: { current: null },
      state: {
        ...defaultSessionState,
        zeusAnnouncement: {
          appointmentId: 1,
          playerName: "CPU 2",
          displayedAt: Date.now(),
        },
      },
      CANVAS_WIDTH: 800,
      CANVAS_HEIGHT: 480,
      isLocalShopTurn: true,
      shopDisplayPlayer: p1,
      localShopDone: false,
      ...mockHandlers,
    });

    render(<GameCanvas />);
    expect(screen.getByRole("status").textContent).toBe(
      "zeus_appointed_announcement_CPU 2",
    );
  });

  it("triggers handleCanvasClick on canvas click and keyboard Enter/Space", () => {
    render(<GameCanvas />);
    const canvas = screen.getByRole("img");

    fireEvent.click(canvas);
    expect(mockHandlers.handleCanvasClick).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(canvas, { key: "Enter" });
    expect(mockHandlers.handleCanvasClick).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(canvas, { key: " " });
    expect(mockHandlers.handleCanvasClick).toHaveBeenCalledTimes(3);

    // Other keys do not trigger click
    fireEvent.keyDown(canvas, { key: "ArrowUp" });
    expect(mockHandlers.handleCanvasClick).toHaveBeenCalledTimes(3);
  });

  it("renders onReturnToMenu button when provided and triggers callback on click", () => {
    const onReturnToMenu = vi.fn();
    render(<GameCanvas onReturnToMenu={onReturnToMenu} />);

    const returnBtn = screen.getByRole("button", { name: "btn_menu" });
    expect(returnBtn).toBeDefined();
    expect(returnBtn.title).toBe("btn_menu_title");

    fireEvent.click(returnBtn);
    expect(onReturnToMenu).toHaveBeenCalledTimes(1);
  });

  it("renders WindBanner, GameHUD, and MobileControls during COMBAT phase", () => {
    render(<GameCanvas />);

    // Wind banner
    expect(screen.getAllByText(/WIND/i).length).toBeGreaterThan(0);

    // Game HUD angle & power controls
    expect(screen.getByText("ANG")).toBeDefined();
    expect(screen.getByText("POW")).toBeDefined();

    // Mobile controls
    expect(screen.getByText("mobile_fire_btn")).toBeDefined();
  });

  it("renders RoundSummary during SUMMARY phase", () => {
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn() },
      canvasRef: { current: null },
      state: {
        ...defaultSessionState,
        gamePhase: "SUMMARY",
        currentManche: 2,
        roundResult: {
          damageDealt: { p1: 50, p2: 0 },
          earningsByPlayer: { p1: 150, p2: 0 },
          terrainDestroyed: 120,
          survivors: ["p1"],
        },
      },
      CANVAS_WIDTH: 800,
      CANVAS_HEIGHT: 480,
      isLocalShopTurn: false,
      shopDisplayPlayer: null,
      localShopDone: false,
      ...mockHandlers,
    });

    render(<GameCanvas />);

    expect(screen.getByText("PHASE: SUMMARY")).toBeDefined();
    expect(screen.getByText(/round_summary_title/i)).toBeDefined();
  });

  it("renders Celebration banner during CELEBRATION phase", () => {
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn() },
      canvasRef: { current: null },
      state: {
        ...defaultSessionState,
        gamePhase: "CELEBRATION",
      },
      CANVAS_WIDTH: 800,
      CANVAS_HEIGHT: 480,
      isLocalShopTurn: false,
      shopDisplayPlayer: null,
      localShopDone: false,
      ...mockHandlers,
    });

    render(<GameCanvas />);
    expect(screen.getByText("celebration_banner")).toBeDefined();
  });

  it("renders WeaponShop when human player is shopping in SHOP phase", () => {
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn() },
      canvasRef: { current: null },
      state: {
        ...defaultSessionState,
        gamePhase: "SHOP",
        shopPlayers: [p1, p2],
        currentShopIndex: 0,
      },
      CANVAS_WIDTH: 800,
      CANVAS_HEIGHT: 480,
      isLocalShopTurn: true,
      shopDisplayPlayer: p1,
      localShopDone: false,
      ...mockHandlers,
    });

    render(<GameCanvas />);
    expect(screen.getByRole("button", { name: /btn_ready/i })).toBeDefined();
  });

  it("renders AI shopping overlay when AI is shopping in local SHOP phase", () => {
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn() },
      canvasRef: { current: null },
      state: {
        ...defaultSessionState,
        gamePhase: "SHOP",
        shopPlayers: [p1, p2],
        currentShopIndex: 1, // CPU 2
      },
      CANVAS_WIDTH: 800,
      CANVAS_HEIGHT: 480,
      isLocalShopTurn: false,
      shopDisplayPlayer: p2,
      localShopDone: false,
      ...mockHandlers,
    });

    render(<GameCanvas />);
    expect(screen.getByTestId("trans-component")).toBeDefined();
  });

  it("waits for the authoritative shop state online", () => {
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn() },
      canvasRef: { current: null },
      state: { ...defaultSessionState, gamePhase: "SHOP" },
      CANVAS_WIDTH: 800,
      CANVAS_HEIGHT: 480,
      isLocalShopTurn: true,
      shopDisplayPlayer: p1,
      localShopDone: false,
      ...mockHandlers,
    });

    render(<GameCanvas gameMode="online" />);
    expect(screen.getByText("shop_waiting_state")).toBeDefined();
  });

  it("renders the local player's authoritative shop online", () => {
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn() },
      canvasRef: { current: null },
      state: {
        ...defaultSessionState,
        gamePhase: "SHOP",
        shopSession: {
          ...createEmptyShopSession(),
          authoritativeReceived: true,
        },
      },
      CANVAS_WIDTH: 800,
      CANVAS_HEIGHT: 480,
      isLocalShopTurn: true,
      shopDisplayPlayer: p1,
      localShopDone: false,
      ...mockHandlers,
    });

    render(<GameCanvas gameMode="online" />);
    expect(screen.getByRole("button", { name: /btn_ready/i })).toBeDefined();
  });

  it.each([
    [false, "shop_waiting_opponent_Player 1"],
    [true, "shop_waiting_others"],
  ])("renders the online waiting state when localShopDone is %s", (localShopDone, expected) => {
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn() },
      canvasRef: { current: null },
      state: {
        ...defaultSessionState,
        gamePhase: "SHOP",
        shopSession: {
          ...createEmptyShopSession(),
          authoritativeReceived: true,
        },
      },
      CANVAS_WIDTH: 800,
      CANVAS_HEIGHT: 480,
      isLocalShopTurn: false,
      shopDisplayPlayer: null,
      localShopDone,
      ...mockHandlers,
    });

    render(<GameCanvas gameMode="online" />);
    expect(screen.getByText(expected)).toBeDefined();
  });

  it("renders GameOverOverlay during GAME_OVER phase", () => {
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn() },
      canvasRef: { current: null },
      state: {
        ...defaultSessionState,
        gamePhase: "GAME_OVER",
        winner: p1,
      },
      CANVAS_WIDTH: 800,
      CANVAS_HEIGHT: 480,
      isLocalShopTurn: false,
      shopDisplayPlayer: null,
      localShopDone: false,
      ...mockHandlers,
    });

    render(<GameCanvas />);
    expect(screen.getByText("game_over")).toBeDefined();
    expect(screen.getByText("winner_wins_Player 1")).toBeDefined();
  });

  it("renders New Game button when showNewGameButton is true and handles click", () => {
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn() },
      canvasRef: { current: null },
      state: {
        ...defaultSessionState,
        showNewGameButton: true,
      },
      CANVAS_WIDTH: 800,
      CANVAS_HEIGHT: 480,
      isLocalShopTurn: false,
      shopDisplayPlayer: null,
      localShopDone: false,
      ...mockHandlers,
    });

    render(<GameCanvas />);
    const newGameBtn = screen.getByRole("button", { name: "btn_new_game" });
    expect(newGameBtn).toBeDefined();

    fireEvent.click(newGameBtn);
    expect(mockHandlers.handleNewGame).toHaveBeenCalledTimes(1);
  });

  it("handles unmount gracefully without throwing errors", () => {
    const { unmount } = render(<GameCanvas />);
    expect(() => unmount()).not.toThrow();
  });

  it("renders fireRejection alert toast during COMBAT phase", () => {
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn() },
      canvasRef: { current: null },
      state: {
        ...defaultSessionState,
        gamePhase: "COMBAT",
        fireRejection: "NO_AMMO",
      },
      CANVAS_WIDTH: 800,
      CANVAS_HEIGHT: 480,
      isLocalShopTurn: false,
      shopDisplayPlayer: null,
      localShopDone: false,
      ...mockHandlers,
    });

    render(<GameCanvas />);
    const alert = screen.getByRole("alert");
    expect(alert).toBeDefined();
    expect(alert.className).toBe("fire-rejection-toast");
    expect(alert.textContent).toBe("fire_rejected_no_ammo");
  });

  it("renders a blocking protocol mismatch overlay", () => {
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn() },
      canvasRef: { current: null },
      state: {
        ...defaultSessionState,
        protocolMismatch: { requiredVersion: 1, receivedVersion: null },
      },
      CANVAS_WIDTH: 800,
      CANVAS_HEIGHT: 480,
      isLocalShopTurn: false,
      shopDisplayPlayer: null,
      localShopDone: false,
      ...mockHandlers,
    });

    render(<GameCanvas />);
    const alert = screen.getByRole("alert");
    expect(alert.className).toBe("protocol-mismatch-overlay");
    expect(alert.textContent).toContain("protocol_mismatch_title");
    expect(
      screen.getByRole("button", { name: "protocol_mismatch_refresh" }),
    ).toBeDefined();
  });

  it.each(["fr", "en"])("shows the incompatible game format in %s and returns to menu", (locale) => {
    language.current = locale;
    const onReturnToMenu = vi.fn();
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn() },
      canvasRef: { current: null },
      state: { ...defaultSessionState, roundPreparationError: "NEW_GAME_REQUIRED" },
      CANVAS_WIDTH: 800, CANVAS_HEIGHT: 480, isLocalShopTurn: false,
      shopDisplayPlayer: null, localShopDone: false, ...mockHandlers,
    });
    render(<GameCanvas onReturnToMenu={onReturnToMenu} />);
    expect(screen.getByRole("alert").textContent).toBe((locale === "fr" ? fr : en).round_new_game_required);
    expect(screen.queryByRole("button", { name: "btn_retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "btn_menu" }));
    expect(onReturnToMenu).toHaveBeenCalledOnce();
  });

  it("keeps complete catch-up retry available on a network error", () => {
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn() },
      canvasRef: { current: null }, state: { ...defaultSessionState, networkError: "round_preparation_failed" },
      CANVAS_WIDTH: 800, CANVAS_HEIGHT: 480, isLocalShopTurn: false,
      shopDisplayPlayer: null, localShopDone: false, ...mockHandlers,
    });
    render(<GameCanvas />);
    fireEvent.click(screen.getByRole("button", { name: "btn_retry" }));
    expect(mockHandlers.retryRoundPreparation).toHaveBeenCalledOnce();
  });

  const livingStatus: PlayerStatusCard[] = [
    {
      id: "p1",
      name: "Player 1",
      color: "#ff0000",
      isHuman: true,
      aiProfile: null,
      health: 100,
      maxHealth: 100,
      shield: 40,
      maxShield: 40,
      inventory: { MISSILE: 1 },
    },
    {
      id: "p2",
      name: "CPU 2",
      color: "#00ff00",
      isHuman: false,
      aiProfile: "v1-random",
      health: 80,
      maxHealth: 100,
      shield: 0,
      maxShield: 40,
      inventory: {},
    },
  ];

  let toggleLock = vi.fn();

  function renderSession(state: typeof defaultSessionState) {
    toggleLock = vi.fn();
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { playerId: "p1", objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock, releaseDeadTargets: vi.fn() },
      canvasRef: { current: null },
      state,
      CANVAS_WIDTH: 800,
      CANVAS_HEIGHT: 480,
      isLocalShopTurn: true,
      shopDisplayPlayer: p1,
      localShopDone: false,
      ...mockHandlers,
    });
    render(<GameCanvas />);
  }

  it("hides the tank status list when no copy is published", () => {
    render(<GameCanvas />);
    expect(screen.queryByRole("region", { name: "player_status_title" })).toBeNull();
  });

  it("shows the tank status list before the advisor while the aim is open", () => {
    renderSession({ ...defaultSessionState, playerStatus: livingStatus });
    const list = screen.getByRole("region", { name: "player_status_title" });
    const advisor = document.querySelector(".shot-advisor");
    expect(advisor).not.toBeNull();
    expect(list.compareDocumentPosition(advisor as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(list);
    fireEvent.click(screen.getByRole("button", { name: "player_status_lock_name_CPU 2" }));
    expect(toggleLock).toHaveBeenCalledExactlyOnceWith("p2");
    expect(mockHandlers.handleCanvasClick).not.toHaveBeenCalled();
    expect(mockHandlers.handleAdjustAngle).not.toHaveBeenCalled();
    expect(mockHandlers.handleAdjustPower).not.toHaveBeenCalled();
    expect(mockHandlers.handleWeaponSelect).not.toHaveBeenCalled();
    expect(mockHandlers.handleFire).not.toHaveBeenCalled();
  });

  it("hides the tank status list while the turn is locked", () => {
    renderSession({
      ...defaultSessionState,
      playerStatus: livingStatus,
      turnInfo: { ...defaultTurnInfo, isInputLocked: true },
    });
    expect(screen.queryByRole("region", { name: "player_status_title" })).toBeNull();
  });

  it.each([false, true])("keeps Alice's lock private before Bea's refresh, with early click %s", (earlyClick) => {
    vi.useFakeTimers();
    const alice = { ...p1, name: "Alice" };
    const bea = { ...p2, name: "Bea", isHuman: true };
    const target = makePlayer({ id: "target", name: "Target" });
    const players = [alice, bea, target];
    const snapshot: AdvisorSnapshot = {
      state: { phase: "COMBAT", players, currentPlayerIndex: 0, turn: 1, roundNumber: 1, windForce: 0, gravity: 260 },
      width: 800, height: 480, heights: [], materials: [],
    };
    const session = vi.mocked(useGameSession)({});
    const controller = new AdvisorController({ capture: () => snapshot, apply: vi.fn() },
      () => { throw new Error("NO_ADVICE_REQUESTED"); }, view => { session.advisor.view = view; });
    session.advisor.toggleLock = id => controller.toggleLock(id);
    session.state = { ...defaultSessionState, playerStatus: copyLivingPlayerStatus(players) };
    vi.mocked(useGameSession).mockReturnValue(session);
    controller.toggleLock("target");
    const interval = window.setInterval(() => controller.refresh(), 100);
    const { rerender } = render(<GameCanvas />);
    const locked = () => screen.queryByRole("button", { name: "player_status_locked_name_Target" });
    const unlocked = () => screen.getByRole("button", { name: "player_status_lock_name_Target" });
    try {
      expect(locked()?.getAttribute("aria-pressed")).toBe("true");
      snapshot.state.currentPlayerIndex = 1;
      session.state = { ...session.state, turnInfo: { ...defaultTurnInfo, playerId: bea.id, playerName: bea.name } };
      rerender(<GameCanvas />);
      act(() => vi.advanceTimersByTime(99));
      expect(session.advisor.view.playerId).toBe(alice.id);
      expect(locked()).toBeNull();
      expect(unlocked().getAttribute("aria-pressed")).toBe("false");
      expect(unlocked().textContent).toBe("player_status_lock");
      if (earlyClick) {
        fireEvent.click(unlocked());
        rerender(<GameCanvas />);
        expect(session.advisor.view.playerId).toBe(bea.id);
        expect(locked()?.getAttribute("aria-pressed")).toBe("true");
      }
      act(() => vi.advanceTimersByTime(1));
      rerender(<GameCanvas />);
      expect(session.advisor.view.playerId).toBe(bea.id);
      expect(Boolean(locked())).toBe(earlyClick);
      snapshot.state.currentPlayerIndex = 0;
      session.state = { ...session.state, turnInfo: defaultTurnInfo };
      act(() => vi.advanceTimersByTime(100));
      rerender(<GameCanvas />);
      expect(session.advisor.view.playerId).toBe(alice.id);
      expect(locked()?.getAttribute("aria-pressed")).toBe("true");
      expect(mockHandlers.handleFire).not.toHaveBeenCalled();
    } finally {
      window.clearInterval(interval);
      controller.dispose();
      vi.useRealTimers();
    }
  });
});
