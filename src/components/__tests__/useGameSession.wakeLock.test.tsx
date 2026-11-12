// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useGameSession } from "../useGameSession";
import { fixture } from "../../game/endurance/__tests__/helpers";

vi.mock("../../utils/analytics", () => ({ trackEvent: vi.fn() }));

describe("combat wake lock session wiring", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["local", "online", "endurance"] as const)("uses the shared lifecycle in %s mode", async mode => {
    const release = vi.fn(async () => {});
    const sentinel = Object.assign(new EventTarget(), {
      released: false, type: "screen" as const, onrelease: null, release,
    });
    const request = vi.fn<WakeLock["request"]>().mockResolvedValue(sentinel);
    vi.stubGlobal("navigator", Object.create(navigator, { wakeLock: { value: { request } } }));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const f = fixture();
    // No canvas is attached: this checks session ownership independently of the engine loop.
    const { result, unmount } = renderHook(() => useGameSession({
      gameMode: mode === "online" ? "online" : "local",
      endurance: mode === "endurance" ? f.run : undefined,
      initialPlayers: f.players,
    }));
    await act(async () => {});
    expect(result.current.state.gamePhase).toBe("COMBAT");
    expect(request).toHaveBeenCalledExactlyOnceWith("screen");
    unmount();
    await act(async () => {});
    expect(release).toHaveBeenCalledTimes(1);
  });
});
