// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { GameCanvas } from "../GameCanvas";
import { useGameSession } from "../useGameSession";
import { makePlayer, makeTank } from "../../game/__tests__/helpers";
import type { Color, GamePhase, RoundResult } from "../../types/game";
import type { Player } from "../../types/player";
import type { ShopItemId } from "../../game/shop/shopTransaction";
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
        if (
          key === "round_new_game_required" ||
          key === "status_ai_turn" ||
          key === "status_ai_waiting" ||
          key === "status_resolving" ||
          key === "status_tanks_falling" ||
          key === "advisor_calculating"
        ) {
          return (language.current === "fr" ? fr : en)[key];
        }
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
    handleShopBuySell: Mock<(item: ShopItemId, delta: number) => void>;
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
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
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
    expect(canvas.classList.contains("game-canvas")).toBe(true);
    expect(canvas.getAttribute("aria-label")).toBe("canvas_game_aria_label");
    expect(canvas.tabIndex).toBe(0);
  });

  it("updates the stage's height budget when the touch controls wrap or disappear", () => {
    type Resize = (entries: { contentRect: { height: number } }[]) => void;
    let notifyResize: Resize | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      observe = observe;
      disconnect = disconnect;

      constructor(callback: Resize) {
        notifyResize = callback;
      }
    });

    try {
      const { container, unmount } = render(<GameCanvas />);
      const shell = container.querySelector<HTMLElement>(".combat-shell");
      const controls = container.querySelector(".combat-mobile-controls");
      expect(shell).not.toBeNull();
      expect(controls?.querySelector(".mobile-controls-panel")).not.toBeNull();
      expect(observe).toHaveBeenCalledWith(controls);

      notifyResize?.([{ contentRect: { height: 151.5 } }]);
      expect(shell?.style.getPropertyValue("--combat-controls-height")).toBe("151.5px");
      notifyResize?.([{ contentRect: { height: 0 } }]);
      expect(shell?.style.getPropertyValue("--combat-controls-height")).toBe("0px");

      unmount();
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders the bilingual Zeus announcement key with the appointed player name", () => {
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
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
    const zeusElement = document.querySelector(".zeus-announcement");
    expect(zeusElement?.getAttribute("role")).toBe("status");
    expect(zeusElement?.textContent).toBe(
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
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
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
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
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
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
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
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
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
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
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
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
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
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
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
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
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
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
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
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
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
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
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
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("protocol-mismatch-overlay");
    expect(dialog.textContent).toContain("protocol_mismatch_title");
    expect(screen.getByRole("alert").textContent).toContain("protocol_mismatch_body");
    const refreshBtn = screen.getByRole("button", { name: "protocol_mismatch_refresh" });
    expect(refreshBtn).toBeDefined();
    expect(document.activeElement).toBe(refreshBtn);
  });

  it("replaces WeaponShop with SessionErrorDialog on EXHAUSTED roundPreparationError in online SHOP", () => {
    const onReturnToMenu = vi.fn();
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
      canvasRef: { current: null },
      state: {
        ...defaultSessionState,
        gamePhase: "SHOP",
        roundPreparationError: "EXHAUSTED",
        shopSession: {
          ...createEmptyShopSession(),
          authoritativeReceived: true,
          epoch: 1,
          pendingIntent: { kind: "READY", shopEpoch: 1, actionId: "act-1" },
        },
      },
      CANVAS_WIDTH: 800,
      CANVAS_HEIGHT: 480,
      isLocalShopTurn: true,
      shopDisplayPlayer: p1,
      localShopDone: false,
      ...mockHandlers,
    });

    render(<GameCanvas gameMode="online" onReturnToMenu={onReturnToMenu} />);
    expect(screen.queryByText("btn_ready_next_player")).toBeNull();
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("round_preparation_failed");
    const retryBtn = screen.getByRole("button", { name: "btn_retry" });
    expect(document.activeElement).toBe(retryBtn);

    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(mockHandlers.handleShopReady).not.toHaveBeenCalled();

    fireEvent.click(retryBtn);
    expect(mockHandlers.retryRoundPreparation).toHaveBeenCalledOnce();

    const menuButtons = screen.getAllByRole("button", { name: "btn_menu" });
    expect(menuButtons.some((btn) => dialog.contains(btn))).toBe(true);
    fireEvent.click(menuButtons.find((btn) => dialog.contains(btn))!);
    expect(onReturnToMenu).toHaveBeenCalledOnce();
  });

  it("focuses Menu in SessionErrorDialog on NEW_GAME_REQUIRED during SHOP", () => {
    const onReturnToMenu = vi.fn();
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
      canvasRef: { current: null },
      state: {
        ...defaultSessionState,
        gamePhase: "SHOP",
        roundPreparationError: "NEW_GAME_REQUIRED",
        shopSession: {
          ...createEmptyShopSession(),
          authoritativeReceived: true,
          epoch: 1,
          pendingIntent: { kind: "READY", shopEpoch: 1, actionId: "act-1" },
        },
      },
      CANVAS_WIDTH: 800,
      CANVAS_HEIGHT: 480,
      isLocalShopTurn: true,
      shopDisplayPlayer: p1,
      localShopDone: false,
      ...mockHandlers,
    });

    render(<GameCanvas gameMode="online" onReturnToMenu={onReturnToMenu} />);
    const dialog = screen.getByRole("dialog");
    expect(screen.queryByRole("button", { name: "btn_retry" })).toBeNull();
    expect(dialog.textContent).toContain(fr.round_new_game_required);
    const dialogMenuBtn = screen.getAllByRole("button", { name: "btn_menu" }).find((btn) => dialog.contains(btn))!;
    expect(document.activeElement).toBe(dialogMenuBtn);
    fireEvent.click(dialogMenuBtn);
    expect(onReturnToMenu).toHaveBeenCalledOnce();
  });

  it("replaces WeaponShop and RoundSummary with ProtocolMismatchDialog on protocolMismatch", () => {
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
      canvasRef: { current: null },
      state: {
        ...defaultSessionState,
        gamePhase: "SHOP",
        protocolMismatch: { requiredVersion: 1, receivedVersion: 0 },
        shopSession: {
          ...createEmptyShopSession(),
          authoritativeReceived: true,
          epoch: 1,
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
    expect(screen.queryByText("btn_ready_next_player")).toBeNull();
    const dialogs = screen.getAllByRole("dialog");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].className).toContain("protocol-mismatch-overlay");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "protocol_mismatch_refresh" }));

    cleanup();
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
      canvasRef: { current: null },
      state: {
        ...defaultSessionState,
        gamePhase: "SUMMARY",
        protocolMismatch: { requiredVersion: 1, receivedVersion: 0 },
      },
      CANVAS_WIDTH: 800,
      CANVAS_HEIGHT: 480,
      isLocalShopTurn: false,
      shopDisplayPlayer: null,
      localShopDone: false,
      ...mockHandlers,
    });

    render(<GameCanvas gameMode="online" />);
    expect(screen.queryByText(/round_summary_title/i)).toBeNull();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "protocol_mismatch_refresh" }));
  });

  it("replaces RoundSummary with SessionErrorDialog on EXHAUSTED roundPreparationError in SUMMARY", () => {
    const onReturnToMenu = vi.fn();
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
      canvasRef: { current: null },
      state: {
        ...defaultSessionState,
        gamePhase: "SUMMARY",
        roundPreparationError: "EXHAUSTED",
      },
      CANVAS_WIDTH: 800,
      CANVAS_HEIGHT: 480,
      isLocalShopTurn: false,
      shopDisplayPlayer: null,
      localShopDone: false,
      ...mockHandlers,
    });

    render(<GameCanvas onReturnToMenu={onReturnToMenu} />);
    expect(screen.queryByText(/round_summary_title/i)).toBeNull();
    const dialog = screen.getByRole("dialog");
    const retryBtn = screen.getByRole("button", { name: "btn_retry" });
    expect(dialog.contains(retryBtn)).toBe(true);
    expect(document.activeElement).toBe(retryBtn);
    fireEvent.click(retryBtn);
    expect(mockHandlers.retryRoundPreparation).toHaveBeenCalledOnce();
  });

  it.each(["fr", "en"])("shows the incompatible game format in %s and returns to menu", (locale) => {
    language.current = locale;
    const onReturnToMenu = vi.fn();
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
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
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
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
      advisor: { view: { playerId: "p1", objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock, releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
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
    session.advisor.lockFor = id => controller.lockFor(id);
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

  it("restores Bea's lock before the advisor's 100 ms refresh and clears it on a single click", () => {
    vi.useFakeTimers();
    const alice = { ...p1, name: "Alice" };
    const bea = { ...p2, name: "Bea", isHuman: true };
    const targetC = makePlayer({ id: "target-c", name: "TargetC" });
    const players = [alice, bea, targetC];
    const snapshot: AdvisorSnapshot = {
      state: { phase: "COMBAT", players, currentPlayerIndex: 1, turn: 1, roundNumber: 1, windForce: 0, gravity: 260 },
      width: 800, height: 480, heights: [], materials: [],
    };
    const session = vi.mocked(useGameSession)({});
    const controller = new AdvisorController({ capture: () => snapshot, apply: vi.fn() },
      () => { throw new Error("NO_ADVICE_REQUESTED"); }, view => { session.advisor.view = view; });
    session.advisor.toggleLock = id => controller.toggleLock(id);
    session.advisor.lockFor = id => controller.lockFor(id);
    session.state = {
      ...defaultSessionState,
      playerStatus: copyLivingPlayerStatus(players),
      turnInfo: { ...defaultTurnInfo, playerId: bea.id, playerName: bea.name },
    };
    vi.mocked(useGameSession).mockReturnValue(session);

    // 1. Pendant son tour, Béa verrouille la cible C. C reste en vie pendant le tour d’Alice.
    controller.toggleLock("target-c");
    const interval = window.setInterval(() => controller.refresh(), 100);
    const { rerender } = render(<GameCanvas />);
    const lockedC = () => screen.queryByRole("button", { name: "player_status_locked_name_TargetC" });
    const unlockedC = () => screen.getByRole("button", { name: "player_status_lock_name_TargetC" });

    try {
      expect(lockedC()?.getAttribute("aria-pressed")).toBe("true");

      // Tour d'Alice : TargetC reste en vie. Le conseiller se rafraîchit pour Alice.
      snapshot.state.currentPlayerIndex = 0;
      session.state = { ...session.state, turnInfo: { ...defaultTurnInfo, playerId: alice.id, playerName: alice.name } };
      act(() => vi.advanceTimersByTime(100));
      rerender(<GameCanvas />);
      expect(session.advisor.view.playerId).toBe(alice.id);
      expect(lockedC()).toBeNull();
      expect(unlockedC().getAttribute("aria-pressed")).toBe("false");

      // 2. Le tour revient à Béa. Le HUD indique déjà que Béa joue, mais la vue du conseiller peut prendre jusqu'à 100 ms pour se rafraîchir.
      snapshot.state.currentPlayerIndex = 1;
      session.state = { ...session.state, turnInfo: { ...defaultTurnInfo, playerId: bea.id, playerName: bea.name } };
      rerender(<GameCanvas />);
      act(() => vi.advanceTimersByTime(99));

      // 3. Pendant cet intervalle, assertions avant le prochain cycle du conseiller :
      expect(session.advisor.view.playerId).toBe(alice.id);
      expect(lockedC()).not.toBeNull();
      expect(lockedC()?.getAttribute("aria-pressed")).toBe("true");
      expect(lockedC()?.textContent).toBe("player_status_locked");

      // Un seul clic retire son verrou
      fireEvent.click(lockedC()!);
      rerender(<GameCanvas />);
      expect(lockedC()).toBeNull();
      expect(unlockedC().getAttribute("aria-pressed")).toBe("false");
      expect(unlockedC().textContent).toBe("player_status_lock");
      expect(controller.lockFor(bea.id)).toBeUndefined();
    } finally {
      window.clearInterval(interval);
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it("renders CombatStatusAnnouncer in COMBAT and omits it outside combat phases", () => {
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
      canvasRef: { current: null },
      state: {
        ...defaultSessionState,
        gamePhase: "COMBAT",
      },
      CANVAS_WIDTH: 800,
      CANVAS_HEIGHT: 480,
      isLocalShopTurn: true,
      shopDisplayPlayer: p1,
      localShopDone: false,
      ...mockHandlers,
    });

    const { rerender } = render(<GameCanvas />);
    const statusRegions = screen.getAllByRole("status");
    expect(statusRegions.length).toBeGreaterThan(0);
    const announcer = statusRegions.find((el) => el.classList.contains("visually-hidden"));
    expect(announcer).toBeDefined();

    // In SUMMARY phase, CombatControls (and CombatStatusAnnouncer) is not rendered
    vi.mocked(useGameSession).mockReturnValue({
      diagnostics: { read: async () => null, capture: () => {}, mark: () => {} },
      advisor: { view: { objective: "SURVIE" as const, status: "idle" as const }, request: vi.fn(), apply: vi.fn(), setObjective: vi.fn(), reset: vi.fn(), toggleLock: vi.fn(), releaseDeadTargets: vi.fn(), lockFor: vi.fn() },
      canvasRef: { current: null },
      state: {
        ...defaultSessionState,
        gamePhase: "SUMMARY",
        roundResult: {
          damageDealt: { p1: 50, p2: 0 },
          earningsByPlayer: { p1: 150, p2: 0 },
          terrainDestroyed: 120,
          survivors: ["p1"],
        },
      },
      CANVAS_WIDTH: 800,
      CANVAS_HEIGHT: 480,
      isLocalShopTurn: true,
      shopDisplayPlayer: p1,
      localShopDone: false,
      ...mockHandlers,
    });

    rerender(<GameCanvas />);
    const summaryStatus = screen.queryAllByRole("status");
    const announcerInSummary = summaryStatus.find((el) => el.classList.contains("visually-hidden"));
    expect(announcerInSummary).toBeUndefined();
  });

  it.each(["fr", "en"] as const)(
    "tracks local AI preparation, shot resolution, falling, consecutive AI turns, and human aim return in %s",
    (locale) => {
      language.current = locale;
      const dict = locale === "fr" ? fr : en;
      const session = vi.mocked(useGameSession)({});
      const ai1Turn: CurrentTurnInfo = {
        ...defaultTurnInfo,
        playerId: "p2",
        playerName: "CPU 2",
        isHuman: false,
        isInputLocked: true,
        isResolving: false,
        tanksAreFalling: false,
      };

      session.state = { ...defaultSessionState, turnInfo: ai1Turn };
      vi.mocked(useGameSession).mockReturnValue(session);
      const { rerender } = render(<GameCanvas />);

      const canvas = screen.getByRole("img") as HTMLCanvasElement;
      expect(screen.getAllByRole("progressbar", { name: dict.status_ai_turn })).toHaveLength(1);
      expect(canvas.style.cursor).toBe("wait");

      // AI shot launched
      session.state = { ...defaultSessionState, turnInfo: { ...ai1Turn, isResolving: true } };
      rerender(<GameCanvas />);
      expect(screen.getAllByRole("progressbar", { name: dict.status_resolving })).toHaveLength(1);
      expect(canvas.style.cursor).toBe("wait");

      // Tanks falling
      session.state = { ...defaultSessionState, turnInfo: { ...ai1Turn, isResolving: true, tanksAreFalling: true } };
      rerender(<GameCanvas />);
      expect(screen.getAllByRole("progressbar", { name: dict.status_tanks_falling })).toHaveLength(1);
      expect(canvas.style.cursor).toBe("wait");

      // Second consecutive AI turn
      session.state = {
        ...defaultSessionState,
        turnInfo: { ...ai1Turn, playerId: "p3", playerName: "CPU 3", turn: 2 },
      };
      rerender(<GameCanvas />);
      expect(screen.getAllByRole("progressbar", { name: dict.status_ai_turn })).toHaveLength(1);
      expect(canvas.style.cursor).toBe("wait");

      // Return to human turn
      session.state = { ...defaultSessionState, turnInfo: { ...defaultTurnInfo, turn: 3 } };
      rerender(<GameCanvas />);
      expect(screen.queryByRole("progressbar")).toBeNull();
      expect(canvas.style.cursor).toBe("crosshair");
    },
  );

  it("shows progress cursor and keeps controls usable while advisor calculates, then clears on completion or fire", () => {
    const session = vi.mocked(useGameSession)({});
    session.advisor = {
      ...session.advisor,
      view: { playerId: "p1", objective: "SURVIE", status: "calculating" },
    };
    session.state = { ...defaultSessionState, turnInfo: defaultTurnInfo };
    vi.mocked(useGameSession).mockReturnValue(session);

    const { rerender } = render(<GameCanvas />);
    const canvas = screen.getByRole("img") as HTMLCanvasElement;
    expect(screen.getAllByRole("progressbar", { name: fr.advisor_calculating })).toHaveLength(1);
    expect(canvas.style.cursor).toBe("progress");

    // Controls and canvas fire remain active during advisor calculation
    fireEvent.click(canvas);
    expect(mockHandlers.handleCanvasClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("combobox").hasAttribute("disabled")).toBe(false);

    // Result or error clears calculation wait and restores crosshair
    session.advisor = {
      ...session.advisor,
      view: { playerId: "p1", objective: "SURVIE", status: "error" },
    };
    rerender(<GameCanvas />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(canvas.style.cursor).toBe("crosshair");

    // Firing before advisor responds switches immediately to shot resolution
    session.advisor = {
      ...session.advisor,
      view: { playerId: "p1", objective: "SURVIE", status: "calculating" },
    };
    session.state = {
      ...defaultSessionState,
      turnInfo: { ...defaultTurnInfo, isInputLocked: true, isResolving: true },
    };
    rerender(<GameCanvas />);
    expect(screen.getAllByRole("progressbar", { name: fr.status_resolving })).toHaveLength(1);
    expect(canvas.style.cursor).toBe("wait");

    // Stale calculating state for another player does not leak onto the next human turn
    session.state = {
      ...defaultSessionState,
      turnInfo: { ...defaultTurnInfo, playerId: "p2", playerName: "Player 2", turn: 2 },
    };
    rerender(<GameCanvas />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(canvas.style.cursor).toBe("crosshair");
  });

  it("handles online AI wait, confirmed shot, rejection/remote aim/catch-up/Zeus without false waits, and victory/exit reset", () => {
    const session = vi.mocked(useGameSession)({});
    const onlineAiTurn: CurrentTurnInfo = {
      ...defaultTurnInfo,
      playerId: "p2",
      playerName: "CPU 2",
      isHuman: false,
      isInputLocked: true,
      isResolving: false,
      tanksAreFalling: false,
    };

    // Online AI turn
    session.state = { ...defaultSessionState, turnInfo: onlineAiTurn };
    vi.mocked(useGameSession).mockReturnValue(session);
    const { rerender } = render(<GameCanvas gameMode="online" />);
    const canvas = screen.getByRole("img") as HTMLCanvasElement;
    expect(screen.getAllByRole("progressbar", { name: fr.status_ai_waiting })).toHaveLength(1);
    expect(canvas.style.cursor).toBe("wait");

    // Confirmed SHOT replay
    session.state = { ...defaultSessionState, turnInfo: { ...onlineAiTurn, isResolving: true } };
    rerender(<GameCanvas gameMode="online" />);
    expect(screen.getAllByRole("progressbar", { name: fr.status_resolving })).toHaveLength(1);
    expect(canvas.style.cursor).toBe("wait");

    // Waiting for server next turn after shot settled
    session.state = {
      ...defaultSessionState,
      turnInfo: { ...onlineAiTurn, isResolving: false, isAwaitingServerTurn: true },
    };
    rerender(<GameCanvas gameMode="online" />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(canvas.style.cursor).toBe("crosshair");

    // Remote human aiming, FIRE intent/rejection, catch-up, Zeus special turn + overlays must NOT show spinner
    for (const turnInfo of [
      { ...defaultTurnInfo, playerId: "p2", isHuman: true, isInputLocked: true, isResolving: false },
      { ...defaultTurnInfo, isHuman: true, isInputLocked: true, isResolving: false },
      { ...onlineAiTurn, isCatchUp: true, isResolving: true },
      { ...onlineAiTurn, isSpecialTurn: true },
    ]) {
      session.state = {
        ...defaultSessionState,
        fireRejection: "NOT_YOUR_TURN",
        zeusAnnouncement: { appointmentId: 1, playerName: "CPU 2", displayedAt: 1 },
        earningsOverlay: { shotId: 1, awards: [], displayedAt: 1 },
        turnInfo,
      };
      rerender(<GameCanvas gameMode="online" />);
      expect(screen.queryByRole("progressbar")).toBeNull();
      expect(canvas.style.cursor).toBe("crosshair");
    }

    // Winner restores default cursor and clears wait status
    session.state = {
      ...defaultSessionState,
      gamePhase: "CELEBRATION",
      winner: p1,
      turnInfo: { ...onlineAiTurn, isResolving: true },
    };
    rerender(<GameCanvas gameMode="online" />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(canvas.style.cursor).toBe("default");

    // Exit to SUMMARY / SHOP clears wait indicators
    session.state = {
      ...defaultSessionState,
      gamePhase: "SUMMARY",
      roundResult: {
        damageDealt: { p1: 50, p2: 0 },
        earningsByPlayer: { p1: 150, p2: 0 },
        terrainDestroyed: 10,
        survivors: ["p1"],
      },
      turnInfo: { ...onlineAiTurn, isResolving: true },
    };
    rerender(<GameCanvas gameMode="online" />);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("keeps clicks on the weapon label and selector gaps isolated from canvas fire while preserving weapon buttons and canvas clicks", () => {
    const session = vi.mocked(useGameSession)({});
    session.state = {
      ...defaultSessionState,
      turnInfo: {
        ...defaultTurnInfo,
        inventory: { MISSILE: 99, GRENADE: 2 },
      },
    };
    vi.mocked(useGameSession).mockReturnValue(session);

    render(<GameCanvas gameMode="online" />);

    const weaponLabel = screen.getByText("hud_weapon");
    const weaponsContainer = weaponLabel.closest(".retro-hud-weapons");
    expect(weaponsContainer).not.toBeNull();

    // Clicking the weapon label or the container gap between buttons does not fire or switch weapons
    fireEvent.click(weaponLabel);
    fireEvent.click(weaponsContainer!);
    expect(mockHandlers.handleCanvasClick).not.toHaveBeenCalled();
    expect(mockHandlers.handleWeaponSelect).not.toHaveBeenCalled();

    // Clicking an available weapon button selects it without firing
    fireEvent.click(screen.getByTitle("weapons.GRENADE"));
    expect(mockHandlers.handleWeaponSelect).toHaveBeenCalledTimes(1);
    expect(mockHandlers.handleWeaponSelect).toHaveBeenCalledWith("GRENADE");
    expect(mockHandlers.handleCanvasClick).not.toHaveBeenCalled();

    // Clicking the canvas outside the HUD fires normally
    fireEvent.click(screen.getByRole("img"));
    expect(mockHandlers.handleCanvasClick).toHaveBeenCalledTimes(1);
  });

  it("uses fluid combat shell without 800px MenuButton lock and isolates spatial overlays inside .combat-canvas-stage (#445)", () => {
    const session = vi.mocked(useGameSession)({});
    session.state = {
      ...defaultSessionState,
      playerStatus: livingStatus,
      earningsOverlay: {
        shotId: 2,
        displayedAt: Date.now(),
        awards: [{ playerId: "p1", playerName: "Player 1", color: "#ff0000", amount: 40, x: 200, y: 240 }],
      },
      zeusAnnouncement: { appointmentId: 1, playerName: "CPU 2", displayedAt: Date.now() },
      fireRejection: "NO_AMMO",
    };
    session.advisor = {
      ...session.advisor,
      view: { playerId: "p1", objective: "SURVIE" as const, status: "idle" as const },
    };
    vi.mocked(useGameSession).mockReturnValue(session);

    const { rerender } = render(<GameCanvas onReturnToMenu={vi.fn()} />);

    const shell = document.querySelector(".combat-shell");
    const stage = document.querySelector(".combat-canvas-stage");
    const topbar = document.querySelector(".combat-topbar") as HTMLElement | null;
    expect(shell).not.toBeNull();
    expect(stage).not.toBeNull();
    expect(topbar).not.toBeNull();
    expect(topbar?.style.width).toBe("");

    expect(stage?.contains(screen.getByRole("img"))).toBe(true);
    expect(stage?.contains(document.querySelector(".shot-earnings-overlay"))).toBe(true);
    expect(stage?.contains(document.querySelector(".zeus-announcement"))).toBe(true);
    expect(stage?.contains(document.querySelector(".fire-rejection-toast"))).toBe(true);

    const mobilePanel = document.querySelector(".mobile-controls-panel");
    const playerStatus = screen.getByRole("region", { name: "player_status_title" });
    const advisorPanel = document.querySelector(".shot-advisor");
    expect(mobilePanel).not.toBeNull();
    expect(advisorPanel).not.toBeNull();
    expect(stage?.contains(mobilePanel)).toBe(false);
    expect(stage?.contains(playerStatus)).toBe(false);
    expect(stage?.contains(advisorPanel)).toBe(false);
    expect(shell?.contains(mobilePanel)).toBe(true);
    expect(shell?.contains(playerStatus)).toBe(true);
    expect(shell?.contains(advisorPanel)).toBe(true);
    expect(playerStatus.compareDocumentPosition(advisorPanel as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    session.state = {
      ...defaultSessionState,
      gamePhase: "GAME_OVER",
      winner: p1,
    };
    rerender(<GameCanvas onReturnToMenu={vi.fn()} />);
    expect(stage?.contains(document.querySelector(".game-over-overlay"))).toBe(true);
  });
});
