// @vitest-environment jsdom
import { StrictMode, useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGameSession } from "../useGameSession";
import { fixture } from "../../game/endurance/__tests__/helpers";
import { getRNG, setRNG } from "../../utils/random";
import { GameEngine } from "../../game/engine/GameEngine";
import { AIByProfileStrategy } from "../../game/entities/ai/AIByProfileStrategy";
import type { EnduranceSession } from "../../game/endurance/session";
import type { Player } from "../../types/player";
import { trackEvent } from "../../utils/analytics";

vi.mock("../../utils/analytics", () => ({ trackEvent: vi.fn() }));

function Harness({ run, players, sessionRef }: { run?: EnduranceSession; players: Player[]; sessionRef: { current: ReturnType<typeof useGameSession> | null } }) {
  const session = useGameSession({ endurance: run, initialPlayers: players });
  useEffect(() => { sessionRef.current = session; });
  const { canvasRef } = session;
  return <canvas ref={canvasRef} />;
}
describe("real local endurance session integration", () => {
  const previous = getRNG();
  beforeEach(() => {
    vi.mocked(trackEvent).mockClear();
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => new Proxy({}, { get: () => () => undefined }) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(AIByProfileStrategy.prototype, "executeTurn").mockImplementation(() => new Promise(() => {}));
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); setRNG(previous); });
  it("initializes once in StrictMode, restores the exact prior RNG and cancels the hung decision", async () => {
    const f = fixture(); await f.run.start();
    const stop = vi.spyOn(GameEngine.prototype, "stop");
    const sessionRef = { current: null as ReturnType<typeof useGameSession> | null };
    render(<StrictMode><Harness run={f.run} players={structuredClone(f.players)} sessionRef={sessionRef} /></StrictMode>);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(f.run.session.roundsStarted).toBe(1);
    expect(getRNG()).not.toBe(previous);
    await act(async () => { await f.run.stop(); });
    expect(stop).toHaveBeenCalledOnce(); expect(getRNG()).toBe(previous);
    expect(f.run.emit({ kind: "decision-start", playerId: "player-1" })).toBe(false);
  });
  it("automates celebration, three-second summary and AI shop; finishes without final purchases", async () => {
    const f = fixture(); await f.run.start();
    const setPlayers = vi.spyOn(GameEngine.prototype, "setPlayers");
    const sessionRef = { current: null as ReturnType<typeof useGameSession> | null };
    render(<Harness run={f.run} players={structuredClone(f.players)} sessionRef={sessionRef} />);
    await act(async () => { vi.advanceTimersByTime(1); });
    const engine = setPlayers.mock.instances[0] as GameEngine;
    const finish = async () => {
      const roster = engine.getTankManager().getPlayers(); roster[1].tank.isDead = true;
      await act(async () => { engine.onRoundEnded?.({ survivors: [roster[0]], roundWinner: roster[0], isDraw: false }); });
      expect(sessionRef.current?.state.gamePhase).toBe("CELEBRATION");
      await act(async () => { vi.advanceTimersByTime(10000); });
      expect(sessionRef.current?.state.gamePhase).toBe("SUMMARY");
      await act(async () => { vi.advanceTimersByTime(3000); });
    };
    await finish();
    expect(sessionRef.current?.state.gamePhase).toBe("SHOP");
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    expect(f.run.session.roundsStarted).toBe(2);
    const roster = engine.getTankManager().getPlayers();
    expect(roster.every(p => !p.isHuman)).toBe(true);
    expect(roster.some(p => p.money < 250)).toBe(true);
    await finish();
    expect(f.run.session.completed).toBe(1);
    expect(trackEvent).not.toHaveBeenCalled();
    const data = await f.run.export();
    expect(data.rounds.filter(r => r.completed)).toHaveLength(2);
  });
  it("turns explicit initial preparation failure into one abandonment", async () => {
    const f = fixture(); await f.run.start();
    vi.spyOn(GameEngine.prototype, "setPlayers").mockImplementation(() => { throw new Error("ROUND_PREPARATION_FAILED"); });
    const sessionRef = { current: null as ReturnType<typeof useGameSession> | null };
    render(<Harness run={f.run} players={structuredClone(f.players)} sessionRef={sessionRef} />);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(f.run.session.abandoned).toBe(1); expect(f.run.latestIncident?.reason).toBe("ROUND_PREPARATION_FAILED");
    await f.run.stop();
  });
  it("preserves start and round-end analytics for ordinary matches", async () => {
    const f = fixture();
    const setPlayers = vi.spyOn(GameEngine.prototype, "setPlayers");
    const sessionRef = { current: null as ReturnType<typeof useGameSession> | null };
    render(<Harness players={structuredClone(f.players)} sessionRef={sessionRef} />);
    expect(trackEvent).toHaveBeenCalledWith("game_start", expect.objectContaining({ playerCount: 2 }));
    const engine = setPlayers.mock.instances[0] as GameEngine;
    const roster = engine.getTankManager().getPlayers();
    roster[1].tank.isDead = true;
    await act(async () => { engine.onRoundEnded?.({ survivors: [roster[0]], roundWinner: roster[0], isDraw: false }); });
    expect(trackEvent).toHaveBeenCalledWith("round_end", expect.objectContaining({ roundNumber: 1 }));
  });
});
