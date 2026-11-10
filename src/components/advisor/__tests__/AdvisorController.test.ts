import { afterEach, describe, expect, it, vi } from "vitest";
import { AdvisorController, type AdvisorView, type AdvisorWorker } from "../AdvisorController";
import type { AdvisorResult } from "../../../game/entities/ai/advisorProtocol";
import type { AdvisorSnapshot } from "../../../game/entities/ai/shotAdvisor";
import { flatTerrain, makePlayer, makeTank } from "../../../game/__tests__/helpers";

function fixture(observing = false) {
  const players = [makePlayer({ id: "human1", isHuman: true, tank: makeTank("human1", 100, 336) }),
    makePlayer({ id: "human2", isHuman: true, tank: makeTank("human2", 400, 336) })];
  const terrain = flatTerrain(800, 480);
  let snapshot: AdvisorSnapshot | null = { state: { phase: "COMBAT", players, currentPlayerIndex: 0,
    turn: 1, roundNumber: 1, windForce: 0, gravity: 260,
    localShotContext: { playerCountAtMatchStart: 2, isFirstShotOfRound: true } },
    width: 800, height: 480, heights: [...terrain.getHeightmap()], materials: [...terrain.getMaterials()] };
  const worker: AdvisorWorker = { onmessage: null, onerror: null, onmessageerror: null,
    postMessage: vi.fn(), terminate: vi.fn() };
  const create = vi.fn(() => worker);
  const apply = vi.fn(() => true);
  const observe = vi.fn();
  let view: AdvisorView = { objective: "OPTIMISER_PROFIT", status: "idle" };
  const publish = vi.fn((next: AdvisorView) => { view = next; });
  const controller = new AdvisorController({
    capture: () => snapshot, apply, ...(observing ? { observing: () => true, observe } : {}),
  }, create, publish);
  const result: AdvisorResult = { objective: "OPTIMISER_PROFIT", command: { angle: 45, power: 50, weaponId: "MISSILE" },
    targetIds: ["human2"], cost: 0, gain: 80, profit: 80, shooterDestroyed: false, consequences: [] };
  const reply = (advice: unknown = result) => worker.onmessage?.({ data: { advice } } as MessageEvent<unknown>);
  return { controller, worker, create, apply, reply, publish, result, observe,
    get snapshot() { return snapshot; }, set snapshot(next) { snapshot = next; }, get view() { return view; } };
}
afterEach(() => vi.restoreAllMocks());

describe("advisor delayed lifecycle", () => {
  it("allows one request, does not apply implicitly, and applies only on request", () => {
    const f = fixture();
    f.controller.request(); f.controller.request();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.view.status).toBe("calculating");
    expect(f.apply).not.toHaveBeenCalled();
    f.reply();
    expect(f.view.status).toBe("result");
    expect(f.apply).not.toHaveBeenCalled();
    f.controller.apply();
    expect(f.apply).toHaveBeenCalledExactlyOnceWith(f.result);
  });

  it("objective changes cancel and discard late results before starting another request", () => {
    const f = fixture(); f.controller.request();
    const late = f.worker.onmessage;
    f.controller.setObjective("SURVIE");
    late?.({ data: { advice: f.result } } as MessageEvent<unknown>);
    expect(f.view).toMatchObject({ objective: "SURVIE", status: "idle" });
    expect(f.worker.terminate).toHaveBeenCalledOnce();
    f.controller.request();
    expect(f.worker.postMessage).toHaveBeenLastCalledWith({ snapshot: f.snapshot, objective: "SURVIE", requestId: 2 });
  });

  it("keeps objectives per human within a round, resets to OPTIMISER_PROFIT across rounds and on a new match", () => {
    const f = fixture(); f.controller.refresh();
    expect(f.view.objective).toBe("OPTIMISER_PROFIT");
    f.snapshot!.state.currentPlayerIndex = 1; f.controller.refresh();
    expect(f.view.objective).toBe("OPTIMISER_PROFIT");

    f.snapshot!.state.currentPlayerIndex = 0; f.controller.refresh();
    f.controller.setObjective("SURVIE");
    expect(f.view.objective).toBe("SURVIE");
    f.snapshot!.state.currentPlayerIndex = 1; f.controller.refresh();
    expect(f.view.objective).toBe("OPTIMISER_PROFIT");

    f.snapshot = null; f.controller.refresh();
    f.snapshot = {
      state: {
        phase: "COMBAT", players: [
          makePlayer({ id: "human1", isHuman: true, tank: makeTank("human1", 100, 336) }),
          makePlayer({ id: "human2", isHuman: true, tank: makeTank("human2", 400, 336) }),
        ], currentPlayerIndex: 0,
        turn: 2, roundNumber: 1, windForce: 0, gravity: 260,
        localShotContext: { playerCountAtMatchStart: 2, isFirstShotOfRound: false },
      },
      width: 800, height: 480, heights: [...flatTerrain(800, 480).getHeightmap()],
      materials: [...flatTerrain(800, 480).getMaterials()],
    };
    f.controller.refresh();
    expect(f.view.objective).toBe("SURVIE");

    f.snapshot.state.roundNumber = 2;
    f.controller.refresh();
    expect(f.view.objective).toBe("OPTIMISER_PROFIT");

    f.controller.setObjective("SURVIE");
    expect(f.view.objective).toBe("SURVIE");
    f.controller.reset();
    expect(f.view.objective).toBe("OPTIMISER_PROFIT");
    f.controller.refresh();
    expect(f.view.objective).toBe("OPTIMISER_PROFIT");
  });

  it.each(["terrain", "position", "health", "shield", "stock", "wind", "gravity", "economy", "turn", "round", "unavailable"])(
    "invalidates %s at reception and application", (change) => {
      const mutate = (f: ReturnType<typeof fixture>) => {
        const state = f.snapshot!.state;
        switch (change) {
          case "terrain": f.snapshot = { ...f.snapshot!, heights: f.snapshot!.heights.map((h, i) => i === 1 ? h - 1 : h) }; break;
          case "position": state.players[0].tank.position.x++; break;
          case "health": state.players[0].tank.health--; break;
          case "shield": state.players[0].tank.shield++; break;
          case "stock": state.players[0].inventory.NUKE = 1; break;
          case "wind": state.windForce++; break;
          case "gravity": state.gravity++; break;
          case "economy": state.localShotContext!.isFirstShotOfRound = false; break;
          case "turn": state.turn++; break;
          case "round": state.roundNumber = 2; break;
          case "unavailable": f.snapshot = null; break;
        }
      };
      const f = fixture(); f.controller.request(); mutate(f); f.reply();
      expect(f.view.result).toBeUndefined(); expect(f.worker.terminate).toHaveBeenCalledOnce();
      const g = fixture(); g.controller.request(); g.reply(); mutate(g); g.controller.apply();
      expect(g.apply).not.toHaveBeenCalled(); expect(g.view.result).toBeUndefined();
    });

  it("shows absence/error, logs failures and releases the request lock", () => {
    const f = fixture(); f.controller.request(); f.reply(null);
    expect(f.view.status).toBe("empty");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    f.controller.request(); f.worker.onerror?.({ message: "failed" } as ErrorEvent);
    expect(f.view.status).toBe("error"); expect(log).toHaveBeenCalled();
    f.controller.request(); f.reply({ ...f.result, command: { angle: 999, power: 50, weaponId: "MISSILE" } });
    expect(f.view.status).toBe("error");
    f.controller.request(); f.reply(); expect(f.view.status).toBe("result");
  });

  it("fails without partial mutation if the live application guard refuses", () => {
    const f = fixture(); f.controller.request(); f.reply(); f.apply.mockReturnValue(false);
    f.controller.apply(); expect(f.view.status).toBe("expired"); expect(f.view.result).toBeUndefined();
  });

  it("cleans up on exit and ignores worker completion after disposal", () => {
    const f = fixture(); f.controller.request(); const late = f.worker.onmessage;
    f.controller.dispose(); f.publish.mockClear(); late?.({ data: { advice: f.result } } as MessageEvent<unknown>);
    expect(f.worker.terminate).toHaveBeenCalledOnce(); expect(f.publish).not.toHaveBeenCalled();
  });

  it("correlates one terminal conclusion and never cancels a successful completion", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const f = fixture(); f.controller.request(); f.reply(); f.controller.refresh(); f.controller.dispose();
    const traces = log.mock.calls.filter(([line]) => String(line).startsWith("[Shot advisor] Décision {"))
      .map(([line]) => JSON.parse(String(line).slice("[Shot advisor] Décision ".length)) as { requestId: number; status: string });
    expect(traces.map((trace) => trace.status)).toEqual(["calculating", "result"]);
    expect(traces.every((trace) => trace.requestId === 1)).toBe(true);
  });

  it("records only one cancellation when refresh invalidates a result during onmessage", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const f = fixture(); f.controller.request(); f.snapshot!.state.windForce++; f.reply(); f.controller.dispose();
    const traces = log.mock.calls.filter(([line]) => String(line).startsWith("[Shot advisor] Décision {"))
      .map(([line]) => JSON.parse(String(line).slice("[Shot advisor] Décision ".length)) as { status: string });
    expect(traces.map((trace) => trace.status)).toEqual(["calculating", "cancelled"]);
  });

  it("keeps one lock per human, including across an AI turn, and drops only dead targets", () => {
    const f = fixture();
    const cpu = makePlayer({ id: "cpu", isHuman: false, aiProfile: "v1-random", tank: makeTank("cpu", 620, 336) });
    f.snapshot!.state.players.push(cpu);
    f.snapshot!.state.localShotContext!.playerCountAtMatchStart = 3;
    f.controller.refresh();
    f.controller.setObjective("SURVIE");
    f.controller.toggleLock("cpu");
    expect(f.view).toMatchObject({ playerId: "human1", objective: "SURVIE", lockedTargetId: "cpu" });
    f.controller.toggleLock("cpu");
    expect(f.view.lockedTargetId).toBeUndefined();
    expect(f.view.objective).toBe("SURVIE");
    f.controller.toggleLock("cpu");

    f.snapshot!.state.currentPlayerIndex = 1;
    f.controller.refresh();
    expect(f.view).toMatchObject({ playerId: "human2", objective: "OPTIMISER_PROFIT" });
    expect(f.view.lockedTargetId).toBeUndefined();
    f.controller.toggleLock("cpu");
    expect(f.view.lockedTargetId).toBe("cpu");

    f.snapshot!.state.currentPlayerIndex = 2;
    f.controller.refresh();
    expect(f.view).toMatchObject({ playerId: "cpu", objective: "OPTIMISER_PROFIT" });
    expect(f.view.lockedTargetId).toBeUndefined();

    f.snapshot!.state.currentPlayerIndex = 0;
    f.controller.refresh();
    expect(f.view).toMatchObject({ playerId: "human1", objective: "SURVIE", lockedTargetId: "cpu" });

    f.snapshot!.state.roundNumber = 2;
    f.controller.refresh();
    expect(f.view).toMatchObject({ objective: "OPTIMISER_PROFIT", lockedTargetId: "cpu" });

    f.controller.releaseDeadTargets(["human1"]);
    expect(f.view.lockedTargetId).toBe("cpu");
    f.controller.releaseDeadTargets(["cpu"]);
    expect(f.view.lockedTargetId).toBeUndefined();
    f.snapshot!.state.currentPlayerIndex = 1;
    f.controller.refresh();
    expect(f.view.lockedTargetId).toBeUndefined();

    f.controller.reset();
    f.snapshot!.state.currentPlayerIndex = 0;
    f.controller.refresh();
    expect(f.view.lockedTargetId).toBeUndefined();
    expect(f.view.objective).toBe("OPTIMISER_PROFIT");
  });

  it("ignores a stale reply after B to C to B and refuses to apply a result from another lock", () => {
    const f = fixture();
    const cpu = makePlayer({ id: "cpu", isHuman: false, aiProfile: "v1-random", tank: makeTank("cpu", 620, 336) });
    f.snapshot!.state.players.push(cpu);
    f.controller.refresh();
    f.controller.setObjective("SURVIE");
    f.controller.toggleLock("human2");
    f.controller.request();
    const late = f.worker.onmessage;
    f.controller.toggleLock("cpu");
    f.controller.toggleLock("human2");
    expect(f.view).toMatchObject({ objective: "SURVIE", lockedTargetId: "human2", status: "idle" });
    f.controller.request();
    expect(f.worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      objective: "SURVIE", lockedTargetId: "human2", requestId: 2,
    }));
    late?.({ data: { advice: { ...f.result, objective: "SURVIE" } } } as MessageEvent<unknown>);
    expect(f.view.status).toBe("calculating");
    expect(f.view.result).toBeUndefined();
    f.reply({ ...f.result, objective: "SURVIE" });
    expect(f.view.status).toBe("result");
    f.controller.toggleLock("cpu");
    f.controller.apply();
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.view).toMatchObject({ objective: "SURVIE", lockedTargetId: "cpu", status: "idle" });
    expect(f.view.result).toBeUndefined();
  });

  it("prints and observes the locked target on the advisor decision", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const f = fixture(true);
    f.controller.refresh();
    f.controller.toggleLock("human2");
    f.controller.request();
    f.reply({ ...f.result, decision: { lockedTargetId: "human2", phase: "OPTIMISER_PROFIT" } });
    const traces = log.mock.calls.filter(([line]) => String(line).startsWith("[Shot advisor] Décision {"))
      .map(([line]) => JSON.parse(String(line).slice("[Shot advisor] Décision ".length)) as { status: string; lockedTargetId?: string });
    expect(traces.map((trace) => trace.status)).toEqual(["calculating", "result"]);
    expect(traces.every((trace) => trace.lockedTargetId === "human2")).toBe(true);
    expect(f.observe).toHaveBeenCalledWith(expect.objectContaining({
      status: "calculating",
      detail: expect.objectContaining({ lockedTargetId: "human2" }),
    }));
    expect(f.observe).toHaveBeenCalledWith(expect.objectContaining({
      status: "result",
      detail: expect.objectContaining({ lockedTargetId: "human2" }),
    }));
  });
});
