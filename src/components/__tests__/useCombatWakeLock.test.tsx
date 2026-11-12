// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCombatWakeLock } from "../useCombatWakeLock";

type State = Parameters<typeof useCombatWakeLock>[0];
const combat: State = { gamePhase: "COMBAT", protocolMismatch: null, roundPreparationError: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function makeSentinel() {
  const events = new EventTarget();
  const sentinel = Object.assign(events, {
    released: false,
    type: "screen" as const,
    onrelease: null,
    release: vi.fn(async () => {
      sentinel.released = true;
      sentinel.dispatchEvent(new Event("release"));
    }),
  });
  return sentinel;
}

async function flush() {
  await act(async () => {});
}

function visibility(value: DocumentVisibilityState) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(value);
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
}

describe("useCombatWakeLock (#409)", () => {
  const request = vi.fn<WakeLock["request"]>();
  let sentinel = makeSentinel();

  beforeEach(() => {
    sentinel = makeSentinel();
    request.mockReset().mockResolvedValue(sentinel);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.stubGlobal("navigator", Object.create(navigator, {
      wakeLock: { value: { request }, configurable: true },
    }));
  });

  afterEach(async () => {
    cleanup();
    await flush();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["COMBAT", "RESOLUTION"] as const)("acquires in %s and releases on unmount", async gamePhase => {
    const { unmount } = renderHook(() => useCombatWakeLock({ ...combat, gamePhase }));
    await flush();
    expect(request).toHaveBeenCalledExactlyOnceWith("screen");
    unmount();
    await flush();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it("keeps the same lock between COMBAT and RESOLUTION", async () => {
    const { rerender } = renderHook((state: State) => useCombatWakeLock(state), { initialProps: combat });
    await flush();
    rerender({ ...combat, gamePhase: "RESOLUTION" });
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(sentinel.release).not.toHaveBeenCalled();
  });

  const inactive: State[] = [
    ...(["MENU", "CELEBRATION", "SUMMARY", "SHOP", "GAME_OVER"] as const).map(gamePhase => ({ ...combat, gamePhase })),
    { ...combat, protocolMismatch: { requiredVersion: 4, receivedVersion: 3 } },
    { ...combat, roundPreparationError: "EXHAUSTED" },
  ];

  it.each(inactive)("releases and does not reacquire for $gamePhase / $protocolMismatch / $roundPreparationError", async state => {
    const { rerender } = renderHook((props: State) => useCombatWakeLock(props), { initialProps: combat });
    await flush();
    rerender(state);
    await flush();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
    visibility("hidden");
    visibility("visible");
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(inactive)("does not acquire when initially blocked ($gamePhase / $protocolMismatch / $roundPreparationError)", async state => {
    renderHook(() => useCombatWakeLock(state));
    await flush();
    expect(request).not.toHaveBeenCalled();
  });

  it("acquires when a blocked combat becomes eligible again", async () => {
    const blocked: State = { ...combat, protocolMismatch: { requiredVersion: 4, receivedVersion: 3 } };
    const { rerender } = renderHook((state: State) => useCombatWakeLock(state), {
      initialProps: blocked,
    });
    rerender(combat);
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("waits for a visible document and releases on hiding", async () => {
    visibility("hidden");
    renderHook(() => useCombatWakeLock(combat));
    await flush();
    expect(request).not.toHaveBeenCalled();
    visibility("visible");
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    visibility("hidden");
    await flush();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it("forgets a system release without looping, then reacquires on visibility", async () => {
    renderHook(() => useCombatWakeLock(combat));
    await flush();
    sentinel.released = true;
    sentinel.dispatchEvent(new Event("release"));
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    const next = makeSentinel();
    request.mockResolvedValue(next);
    visibility("hidden");
    visibility("visible");
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(sentinel.release).not.toHaveBeenCalled();
  });

  it.each(["unmount", "phase", "error", "hidden"] as const)("releases a late acquisition after %s", async reason => {
    const late = deferred<WakeLockSentinel>();
    request.mockReturnValue(late.promise);
    const { rerender, unmount } = renderHook((state: State) => useCombatWakeLock(state), { initialProps: combat });
    if (reason === "unmount") unmount();
    if (reason === "phase") rerender({ ...combat, gamePhase: "SHOP" });
    if (reason === "error") rerender({ ...combat, roundPreparationError: "EXHAUSTED" });
    if (reason === "hidden") visibility("hidden");
    await act(async () => { late.resolve(sentinel); });
    expect(sentinel.release).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("serializes StrictMode restarts and releases the stale sentinel", async () => {
    const late = deferred<WakeLockSentinel>();
    const next = makeSentinel();
    request.mockReturnValueOnce(late.promise).mockResolvedValue(next);
    const { unmount } = renderHook(() => useCombatWakeLock(combat), { wrapper: StrictMode });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { late.resolve(sentinel); });
    expect(sentinel.release).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
    unmount();
    await flush();
    expect(next.release).toHaveBeenCalledTimes(1);
  });

  it("deduplicates visibility bursts and replaces an acquisition invalidated by hiding", async () => {
    const late = deferred<WakeLockSentinel>();
    const next = makeSentinel();
    request.mockReturnValueOnce(late.promise).mockResolvedValue(next);
    renderHook(() => useCombatWakeLock(combat));
    visibility("hidden");
    visibility("visible");
    visibility("visible");
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { late.resolve(sentinel); });
    expect(sentinel.release).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
    visibility("visible");
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("waits for explicit release before acquiring for the next combat", async () => {
    const releasing = deferred<void>();
    sentinel.release.mockReturnValue(releasing.promise);
    request.mockResolvedValueOnce(sentinel).mockResolvedValue(makeSentinel());
    const { rerender } = renderHook((state: State) => useCombatWakeLock(state), { initialProps: combat });
    await flush();
    rerender({ ...combat, gamePhase: "SHOP" });
    rerender(combat);
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { releasing.resolve(); });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, {}, { request: null }])("degrades gracefully with unavailable wakeLock: %j", async wakeLock => {
    vi.stubGlobal("navigator", { wakeLock });
    renderHook(() => useCombatWakeLock(combat));
    await flush();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([undefined, null])("handles an absent navigator (%j)", async nav => {
    vi.stubGlobal("navigator", nav);
    renderHook(() => useCombatWakeLock(combat));
    await flush();
    expect(request).not.toHaveBeenCalled();
  });

  it("warns on request rejection without retrying in a loop", async () => {
    const error = new DOMException("Denied", "NotAllowedError");
    request.mockRejectedValue(error);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderHook(() => useCombatWakeLock(combat));
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("acquire"), error);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("clears pending queue even if a tracked operation rejects unexpectedly", async () => {
    let rejectFirst!: (reason?: unknown) => void;
    request
      .mockReturnValueOnce(new Promise<WakeLockSentinel>((_, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce(sentinel);
    vi.spyOn(console, "warn").mockImplementationOnce(() => { throw new Error("warn failure"); });
    renderHook(() => useCombatWakeLock(combat));
    visibility("hidden");
    visibility("visible");
    await act(async () => { rejectFirst(new DOMException("Denied", "NotAllowedError")); });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("warns on release rejection without an unhandled error", async () => {
    const error = new Error("Release failed");
    sentinel.release.mockRejectedValue(error);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { unmount } = renderHook(() => useCombatWakeLock(combat));
    await flush();
    unmount();
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("release"), error);
  });
});
