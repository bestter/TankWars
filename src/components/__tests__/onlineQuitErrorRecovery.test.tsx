// @vitest-environment jsdom
import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import App from "../../App";
import { makePlayer, makeRoundMap, makeTank } from "../../game/__tests__/helpers";
import { createEmptyShopSession } from "../gameCanvasReducer";
import type { PersistedOnlineSession } from "../../utils/onlineSession";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: {
      language: "fr",
      changeLanguage: vi.fn(),
    },
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
  initReactI18next: {
    type: "3rdParty",
    init: () => {},
  },
}));

function stubCanvas2d(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get: () => () => undefined,
    },
  ) as CanvasRenderingContext2D;
}

interface TopLayerEntry {
  dialog: HTMLDialogElement;
  invoker: HTMLElement | null;
}

describe("Online quit confirmation during round transitions", () => {
  const topLayerStack: TopLayerEntry[] = [];
  let originalShowModal: (() => void) | undefined;
  let originalClose: ((returnValue?: string) => void) | undefined;
  let originalWebSocket: typeof WebSocket;
  let latestCombatWs: {
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    emitMessage: (payload: unknown) => void;
  } | null = null;

  const sessionStorageData = new Map<string, string>();
  const sessionStorageMock: Storage = {
    get length() {
      return sessionStorageData.size;
    },
    clear: () => sessionStorageData.clear(),
    getItem: (key) => sessionStorageData.get(key) ?? null,
    key: (index) => [...sessionStorageData.keys()][index] ?? null,
    removeItem: (key) => sessionStorageData.delete(key),
    setItem: (key, value) => sessionStorageData.set(key, value),
  };

  function seedSession(gamePhase: "COMBAT" | "SHOP" = "SHOP") {
    const p1 = makePlayer({ id: "player-1", name: "Host" });
    const p2 = makePlayer({
      id: "player-2",
      name: "Guest",
      tank: makeTank("tank-2", 620, 300),
    });
    const session: PersistedOnlineSession = {
      meta: {
        initialMap: makeRoundMap(),
        roomId: "room-stack-1",
        localPlayerId: "player-1",
        slot: 0,
        token: "TOKEN1",
      },
      players: [p1, p2],
      canvas: {
        map: makeRoundMap(),
        gamePhase,
        currentManche: 1,
        uiPlayers: [p1, p2],
        shopPlayers: [p1, p2],
        currentShopIndex: 1,
        roundResult: null,
        lastRoundOutcome: null,
        wind: 0,
        authoritySlot: 0,
        authorityEpoch: 1,
        lastAppliedShotId: 0,
        lastAppliedZeusStrikeId: 0,
        shopSession: createEmptyShopSession(),
        lastAppliedShopEpoch: 0,
        lastCompletedRoundNumber: 0,
        lastSeenShotId: 0,
        pendingFireIntent: null,
        fireRejection: null,
        roundEarningsByPlayer: {},
        earningsOverlay: null,
      },
    };
    window.sessionStorage.setItem(
      "tankwars-online-session-v2",
      JSON.stringify(session),
    );
    return session.players;
  }

  function installTopLayerDialogDouble(): void {
    const proto = HTMLDialogElement.prototype as HTMLDialogElement & {
      showModal?: () => void;
      close?: (returnValue?: string) => void;
    };
    originalShowModal = proto.showModal;
    originalClose = proto.close;

    proto.showModal = function (this: HTMLDialogElement) {
      if (this.hasAttribute("open")) return;
      const invoker =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      topLayerStack.push({ dialog: this, invoker });
      this.setAttribute("open", "");
      Object.defineProperty(this, "open", {
        configurable: true,
        get: () => true,
      });
    };

    proto.close = function (this: HTMLDialogElement, returnValue?: string) {
      if (!this.hasAttribute("open")) return;
      this.removeAttribute("open");
      Object.defineProperty(this, "open", {
        configurable: true,
        get: () => false,
      });
      if (returnValue !== undefined) {
        this.returnValue = returnValue;
      }
      const idx = topLayerStack.findIndex((item) => item.dialog === this);
      const removed = idx >= 0 ? topLayerStack.splice(idx, 1)[0] : undefined;
      if (this.isConnected && removed?.invoker?.isConnected) {
        removed.invoker.focus();
      }
      this.dispatchEvent(new Event("close"));
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    topLayerStack.length = 0;
    latestCombatWs = null;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => stubCanvas2d(),
    });
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: sessionStorageMock,
    });
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/");

    installTopLayerDialogDouble();

    originalWebSocket = window.WebSocket;
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      onclose: ((ev: { code: number; reason: string }) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      send = vi.fn();
      close = vi.fn(() => {
        this.readyState = 3;
      });
      private listeners = new Map<string, Array<(ev: unknown) => void>>();

      constructor(url: string) {
        if (String(url).includes("/api/rooms/")) {
          latestCombatWs = {
            send: this.send,
            close: this.close,
            emitMessage: (payload: unknown) => {
              const ev = { data: JSON.stringify(payload) };
              this.onmessage?.(ev);
              for (const fn of this.listeners.get("message") ?? []) {
                fn(ev);
              }
            },
          };
        }
      }

      addEventListener(type: string, fn: (ev: unknown) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(fn);
        this.listeners.set(type, list);
      }

      removeEventListener(type: string, fn: (ev: unknown) => void): void {
        const list = this.listeners.get(type) ?? [];
        this.listeners.set(
          type,
          list.filter((entry) => entry !== fn),
        );
      }
    }
    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      value: MockWebSocket,
    });
  });

  afterEach(() => {
    cleanup();
    const proto = HTMLDialogElement.prototype as HTMLDialogElement & {
      showModal?: () => void;
      close?: (returnValue?: string) => void;
    };
    if (originalShowModal) proto.showModal = originalShowModal;
    else Reflect.deleteProperty(proto, "showModal");
    if (originalClose) proto.close = originalClose;
    else Reflect.deleteProperty(proto, "close");

    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      value: originalWebSocket,
    });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["COMBAT", "SHOP"] as const)("keeps an open confirmation through a normal transition from %s", (phase) => {
    const players = seedSession(phase);
    render(
      <StrictMode>
        <HelmetProvider>
          <App />
        </HelmetProvider>
      </StrictMode>,
    );
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(latestCombatWs).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "btn_menu" }));
    const confirmDialog = screen.getByRole("dialog", { name: "online_quit_confirm" });
    act(() => {
      if (phase === "COMBAT") {
        latestCombatWs?.emitMessage({
          type: "ROUND_END", players, roundNumber: 1, roundWinnerId: null, isDraw: true,
        });
      } else {
        latestCombatWs?.emitMessage({
          type: "SHOP_STATE", players, shopEpoch: 1, roundNumber: 1,
          readySlots: [], purchasesByPlayerId: {}, aiShopApplied: true,
        });
      }
    });
    if (phase === "COMBAT") {
      expect(screen.getByText("celebration_banner")).toBeDefined();
      act(() => vi.advanceTimersByTime(10000));
    }

    expect(topLayerStack.map(({ dialog }) => dialog)).toEqual([confirmDialog]);
    const cancel = screen.getByRole("button", { name: "online_quit_cancel" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.click(cancel);

    const nextDialog = screen.getByRole("dialog", {
      name: phase === "COMBAT" ? "round_summary_title" : "shop_header",
    });
    expect(topLayerStack.map(({ dialog }) => dialog)).toEqual([nextDialog]);
    expect(nextDialog.contains(document.activeElement)).toBe(true);
  });

  it("lets the player open quit confirmation and exit after ROUND_PREPARATION_FAILED (NEW_GAME_REQUIRED) arrives while confirm dialog is open", () => {
    seedSession();
    render(
      <StrictMode>
        <HelmetProvider>
          <App />
        </HelmetProvider>
      </StrictMode>,
    );

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(latestCombatWs).not.toBeNull();

    // Open quit confirmation while waiting in shop
    const topMenuBtn = screen.getByRole("button", { name: "btn_menu" });
    topMenuBtn.focus();
    fireEvent.click(topMenuBtn);

    const confirmDialog = screen.getByRole("dialog", {
      name: "online_quit_confirm",
    }) as HTMLDialogElement;
    expect(topLayerStack.at(-1)?.dialog).toBe(confirmDialog);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "online_quit_cancel" }),
    );

    // Server sends ROUND_PREPARATION_FAILED with NEW_GAME_REQUIRED
    act(() => {
      latestCombatWs?.emitMessage({
        type: "ROUND_PREPARATION_FAILED",
        reason: "NEW_GAME_REQUIRED",
        roundNumber: 1,
      });
    });

    // SessionErrorDialog becomes the sole open modal; prior confirmation was dismissed
    expect(document.querySelectorAll("dialog[open]")).toHaveLength(1);
    const errorDialog = screen.getByRole("dialog", {
      name: "round_new_game_required",
    }) as HTMLDialogElement;
    expect(topLayerStack.map((entry) => entry.dialog)).toEqual([errorDialog]);
    expect(screen.queryByRole("button", { name: "btn_retry" })).toBeNull();

    const errorMenuBtn = errorDialog.querySelector(
      "button.round-summary-menu-btn",
    ) as HTMLButtonElement;
    expect(errorMenuBtn).not.toBeNull();
    expect(document.activeElement).toBe(errorMenuBtn);

    // Clicking MENU from SessionErrorDialog opens OnlineQuitConfirmDialog on top
    fireEvent.click(errorMenuBtn);
    const reopenedConfirm = screen.getByRole("dialog", {
      name: "online_quit_confirm",
    }) as HTMLDialogElement;
    expect(topLayerStack.at(-1)?.dialog).toBe(reopenedConfirm);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "online_quit_cancel" }),
    );

    // Cancel button returns focus to SessionErrorDialog's MENU button
    fireEvent.click(screen.getByRole("button", { name: "online_quit_cancel" }));
    expect(
      screen.queryByRole("dialog", { name: "online_quit_confirm" }),
    ).toBeNull();
    expect(topLayerStack.at(-1)?.dialog).toBe(errorDialog);
    expect(document.activeElement).toBe(errorMenuBtn);

    // Esc also cancels confirmation and returns focus to SessionErrorDialog's MENU button
    fireEvent.click(errorMenuBtn);
    const reopenedForEsc = screen.getByRole("dialog", {
      name: "online_quit_confirm",
    });
    fireEvent(reopenedForEsc, new Event("cancel", { cancelable: true }));
    expect(
      screen.queryByRole("dialog", { name: "online_quit_confirm" }),
    ).toBeNull();
    expect(document.activeElement).toBe(errorMenuBtn);

    // Reopen and confirm exit -> returns to MainMenu and clears online storage
    fireEvent.click(errorMenuBtn);
    fireEvent.click(
      screen.getByRole("button", { name: "online_quit_confirm_btn" }),
    );
    expect(screen.getByText("main_title")).toBeDefined();
    expect(
      window.sessionStorage.getItem("tankwars-online-session-v2"),
    ).toBeNull();
  });

  it("preserves Retry on EXHAUSTED without leaving a stale confirmation dialog behind", () => {
    seedSession();
    render(
      <StrictMode>
        <HelmetProvider>
          <App />
        </HelmetProvider>
      </StrictMode>,
    );

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(latestCombatWs).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "btn_menu" }));
    expect(
      screen.getByRole("dialog", { name: "online_quit_confirm" }),
    ).toBeDefined();

    act(() => {
      latestCombatWs?.emitMessage({
        type: "ROUND_PREPARATION_FAILED",
        reason: "EXHAUSTED",
        roundNumber: 1,
      });
    });

    expect(document.querySelectorAll("dialog[open]")).toHaveLength(1);
    const errorDialog = screen.getByRole("dialog", {
      name: "round_preparation_failed",
    }) as HTMLDialogElement;
    const retryBtn = screen.getByRole("button", { name: "btn_retry" });
    const errorMenuBtn = errorDialog.querySelector(
      "button.round-summary-menu-btn",
    ) as HTMLButtonElement;
    expect(document.activeElement).toBe(retryBtn);

    // Open confirm from error dialog then cancel back to error dialog
    errorMenuBtn.focus();
    fireEvent.click(errorMenuBtn);
    expect(
      topLayerStack.at(-1)?.dialog,
    ).toBe(screen.getByRole("dialog", { name: "online_quit_confirm" }));
    fireEvent.click(screen.getByRole("button", { name: "online_quit_cancel" }));
    expect(document.activeElement).toBe(errorMenuBtn);

    // Retry still works and leaves no zombie confirmation dialog behind
    fireEvent.click(retryBtn);
    expect(latestCombatWs?.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"REQUEST_GAME_START"'),
    );

    const nextMap = makeRoundMap(2);
    const nextPlayers = [
      makePlayer({
        id: "player-1",
        name: "Host",
        tank: makeTank("tank-1", 120, 300),
      }),
      makePlayer({
        id: "player-2",
        name: "Guest",
        tank: makeTank("tank-2", 620, 300),
      }),
    ];
    act(() => {
      latestCombatWs?.emitMessage({
        type: "SHOP_FINISH",
        shopEpoch: 1,
        completedRoundNumber: 1,
        nextRoundNumber: 2,
        map: nextMap,
        players: nextPlayers,
      });
    });

    expect(document.querySelectorAll("dialog[open]")).toHaveLength(0);
    expect(
      screen.queryByRole("dialog", { name: "online_quit_confirm" }),
    ).toBeNull();
    expect(
      screen.queryByRole("dialog", { name: "round_preparation_failed" }),
    ).toBeNull();
  });

  it("stops an active mobile hold when OnlineQuitConfirmDialog opens and ignores old release after Esc or Cancel", () => {
    const originalMatchMedia = window.matchMedia;
    const originalMaxTouchPoints = navigator.maxTouchPoints;
    const originalPointerEvent = window.PointerEvent;

    vi.useRealTimers();
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance", "Date"],
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === "(pointer: coarse)",
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    Object.defineProperty(navigator, "maxTouchPoints", {
      value: 1,
      writable: true,
      configurable: true,
    });
    if (typeof window.PointerEvent === "undefined") {
      class PointerEventDouble extends MouseEvent {
        pointerId: number;
        pointerType: string;
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 0;
          this.pointerType = init.pointerType ?? "touch";
        }
      }
      Object.defineProperty(window, "PointerEvent", { value: PointerEventDouble, configurable: true });
    }

    try {
      const players = seedSession("COMBAT");
      render(
        <StrictMode>
          <HelmetProvider>
            <App />
          </HelmetProvider>
        </StrictMode>,
      );

      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(latestCombatWs).not.toBeNull();

      const snapshotBase = {
        roundNumber: 1,
        map: makeRoundMap(),
        initialPlayers: players,
        players,
        economicRevision: 0,
        roundEarningsByPlayer: { "player-1": 0, "player-2": 0 },
        currentPlayerIndex: 0,
        zeus: {
          type: "ZEUS_STATE",
          activeZeusId: null,
          currentPlayerIndex: 0,
          rotationSlots: [0, 1],
          deadSlots: [false, false],
          activeStrike: null,
          lastAppliedStrikeId: 0,
        },
        activeShotId: null,
        activeShot: null,
        authoritySlot: 0,
        authorityEpoch: 1,
      };
      act(() => {
        latestCombatWs?.emitMessage({
          type: "COMBAT_CATCH_UP_BEGIN",
          catchUpId: "c-mobile-hold",
          roundNumber: 1,
          fragmentCount: 1,
          boundary: 0,
        });
        latestCombatWs?.emitMessage({
          type: "COMBAT_CATCH_UP_FRAGMENT",
          catchUpId: "c-mobile-hold",
          roundNumber: 1,
          fragmentCount: 1,
          boundary: 0,
          index: 0,
          kind: "BASE",
          data: JSON.stringify(snapshotBase),
        });
        latestCombatWs?.emitMessage({
          type: "COMBAT_CATCH_UP_END",
          catchUpId: "c-mobile-hold",
          roundNumber: 1,
          fragmentCount: 1,
          boundary: 0,
        });
      });

      act(() => {
        vi.advanceTimersByTime(100);
      });

      const readHudValue = (label: "ANG" | "POW"): number => {
        const labelEl = screen.getByText(label);
        return Number.parseInt(labelEl.nextElementSibling?.textContent ?? "", 10);
      };

      const menuBtn = screen.getByRole("button", { name: "btn_menu" });
      const anglePlusBtn = screen.getByRole("button", { name: "mobile_angle_increase" });
      const powerPlusBtn = screen.getByRole("button", { name: "mobile_power_increase" });

      // 1) Maintien sur angle (+), ouverture Menu, fermeture Échap doigt encore posé
      expect(readHudValue("ANG")).toBe(45);
      fireEvent.pointerDown(anglePlusBtn, { pointerId: 11, pointerType: "touch", button: 0, buttons: 1 });
      act(() => {
        vi.advanceTimersByTime(250 + 80);
      });
      expect(readHudValue("ANG")).toBe(47);

      fireEvent.click(menuBtn);
      const escDialog = screen.getByRole("dialog", { name: "online_quit_confirm" });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(readHudValue("ANG")).toBe(47);

      fireEvent(escDialog, new Event("cancel", { cancelable: true }));
      expect(screen.queryByRole("dialog", { name: "online_quit_confirm" })).toBeNull();
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(readHudValue("ANG")).toBe(47);

      fireEvent.pointerUp(anglePlusBtn, { pointerId: 11, pointerType: "touch" });
      fireEvent.pointerOut(anglePlusBtn, { pointerId: 11, pointerType: "touch" });
      fireEvent.pointerLeave(anglePlusBtn, { pointerId: 11, pointerType: "touch" });
      fireEvent.click(anglePlusBtn, { detail: 1 });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(readHudValue("ANG")).toBe(47);

      fireEvent.pointerDown(anglePlusBtn, { pointerId: 12, pointerType: "touch", button: 0, buttons: 1 });
      fireEvent.pointerUp(anglePlusBtn, { pointerId: 12, pointerType: "touch" });
      fireEvent.click(anglePlusBtn, { detail: 1 });
      expect(readHudValue("ANG")).toBe(48);

      // 2) Maintien sur puissance (+), ouverture Menu, fermeture Annuler doigt encore posé
      expect(readHudValue("POW")).toBe(55);
      fireEvent.pointerDown(powerPlusBtn, { pointerId: 21, pointerType: "touch", button: 0, buttons: 1 });
      act(() => {
        vi.advanceTimersByTime(250 + 80);
      });
      expect(readHudValue("POW")).toBe(57);

      fireEvent.click(menuBtn);
      expect(screen.getByRole("dialog", { name: "online_quit_confirm" })).toBeDefined();
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(readHudValue("POW")).toBe(57);

      fireEvent.click(screen.getByRole("button", { name: "online_quit_cancel" }));
      expect(screen.queryByRole("dialog", { name: "online_quit_confirm" })).toBeNull();
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(readHudValue("POW")).toBe(57);

      fireEvent.pointerUp(powerPlusBtn, { pointerId: 21, pointerType: "touch" });
      fireEvent.pointerOut(powerPlusBtn, { pointerId: 21, pointerType: "touch" });
      fireEvent.pointerLeave(powerPlusBtn, { pointerId: 21, pointerType: "touch" });
      fireEvent.click(powerPlusBtn, { detail: 1 });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(readHudValue("POW")).toBe(57);

      fireEvent.pointerDown(powerPlusBtn, { pointerId: 22, pointerType: "touch", button: 0, buttons: 1 });
      fireEvent.pointerUp(powerPlusBtn, { pointerId: 22, pointerType: "touch" });
      fireEvent.click(powerPlusBtn, { detail: 1 });
      expect(readHudValue("POW")).toBe(58);
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
      });
      Object.defineProperty(navigator, "maxTouchPoints", {
        value: originalMaxTouchPoints,
        writable: true,
        configurable: true,
      });
      if (originalPointerEvent === undefined) {
        Reflect.deleteProperty(window, "PointerEvent");
      }
    }
  });
});
