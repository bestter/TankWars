// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useShotAdvisor } from "../useShotAdvisor";
import type { AdvisorWorker } from "../AdvisorController";
import { GameEngine } from "../../../game/engine/GameEngine";
import { makePlayer, makeTank } from "../../../game/__tests__/helpers";
import type { GamePhase } from "../../../types/game";

function fixture(gameMode: "local" | "online" = "local", phase: GamePhase = "COMBAT") {
  vi.useFakeTimers();
  const engine = new GameEngine(800, 480);
  engine.getTankManager().setPlayers([
    makePlayer({ id: "self", isHuman: true, tank: makeTank("self", 100, 336) }),
    makePlayer({ id: "other", isHuman: true, tank: makeTank("other", 400, 336) }),
  ]);
  const worker: AdvisorWorker = { onmessage: null, onerror: null, onmessageerror: null, postMessage: vi.fn(), terminate: vi.fn() };
  const create = vi.fn(function () { return worker; });
  vi.stubGlobal("Worker", create);
  const phaseRef = { current: phase };
  const engineRef = { current: engine };
  const countRef = { current: 4 };
  const hook = renderHook(() => useShotAdvisor(engineRef, phaseRef, gameMode, countRef));
  act(() => vi.advanceTimersByTime(100));
  return { engine, worker, create, phaseRef, ...hook };
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("advisor browser integration", () => {
  it("posts an isolated snapshot with the initial match count to a module worker", () => {
    const f = fixture();
    expect(f.result.current.view.playerId).toBe("self");
    act(() => f.result.current.request());
    expect(f.create).toHaveBeenCalledWith(expect.any(URL), { type: "module" });
    expect(f.worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      objective: "SURVIE", snapshot: expect.objectContaining({ state: expect.objectContaining({
        localShotContext: { playerCountAtMatchStart: 4, isFirstShotOfRound: true },
      }) }),
    }));
    f.unmount(); expect(f.worker.terminate).toHaveBeenCalledOnce();
  });

  it("never starts a worker in online multiplayer", () => {
    const f = fixture("online"); act(() => f.result.current.request());
    expect(f.result.current.view.playerId).toBeUndefined(); expect(f.create).not.toHaveBeenCalled();
  });

  it.each(["MENU", "SHOP", "RESOLUTION", "SUMMARY", "CELEBRATION", "GAME_OVER"] as const)("is unavailable in %s", (phase) => {
    const f = fixture("local", phase); act(() => f.result.current.request());
    expect(f.result.current.view.playerId).toBeUndefined(); expect(f.create).not.toHaveBeenCalled();
  });

  it("manual aim during a pending worker keeps the result context, while phase exit cancels it", () => {
    const f = fixture(); act(() => f.result.current.request());
    const aimBefore = f.engine.getTurnManager().getCurrentPlayer()!.tank.angle;
    act(() => { f.engine.getTurnManager().adjustAngle(10); vi.advanceTimersByTime(100); });
    expect(f.engine.getTurnManager().getCurrentPlayer()!.tank.angle).toBe(aimBefore + 10);
    expect(f.result.current.view.status).toBe("calculating");
    expect(f.worker.terminate).not.toHaveBeenCalled();
    act(() => { f.phaseRef.current = "SHOP"; vi.advanceTimersByTime(100); });
    expect(f.worker.terminate).toHaveBeenCalledOnce(); expect(f.result.current.view.playerId).toBeUndefined();
  });
});
