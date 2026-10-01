import { afterEach, describe, expect, it, vi } from "vitest";
import { GameEngine } from "../GameEngine";
import * as preparation from "../../round/prepareRound";
import { makePlayer, makeTank } from "../../__tests__/helpers";
import { setRNG, createSeededRNG, resetRNG } from "../../../utils/random";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetRNG(); });

describe("transactional local preparation", () => {
  it("stops combat without changing terrain, wind or roster, then resets each tank once after retry", () => {
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    setRNG(createSeededRNG(18));
    const engine = new GameEngine(800, 480);
    engine.setPlayers([makePlayer({ id: "p1", tank: makeTank("t1", 120, 300) }),
      makePlayer({ id: "p2", tank: makeTank("t2", 620, 300) })]);
    const players = engine.getTankManager().getPlayers();
    players[0].money = 555;
    players[0].inventory.NUKE = 2;
    players[0].tank.health = 30;
    const before = structuredClone(players);
    const map = engine.getCombatMap(1);
    const firstTurn = vi.spyOn(engine.getTurnManager(), "startFirstTurn");
    const applyPlayers = vi.spyOn(engine.getTankManager(), "setPlayers");
    vi.spyOn(preparation, "prepareRound").mockReturnValueOnce({ ok: false, reason: "ROUND_PREPARATION_FAILED" });
    expect(() => engine.startNextRound(undefined, undefined, 2)).toThrow("ROUND_PREPARATION_FAILED");
    expect(engine.getCombatMap(1)).toEqual(map);
    expect(engine.getTankManager().getPlayers()).toEqual(before);
    expect(engine.isRoundCombatActive()).toBe(false);
    expect(firstTurn).not.toHaveBeenCalled();
    expect(applyPlayers).not.toHaveBeenCalled();
    expect(engine.startNextRound(undefined, undefined, 2)).toBe(true);
    expect(firstTurn).toHaveBeenCalledOnce();
    expect(applyPlayers).toHaveBeenCalledOnce();
    expect(engine.getTankManager().getPlayers()[0]).toMatchObject({ money: 555, inventory: { NUKE: 2 }, tank: { health: 100 } });
    engine.stop();
  });
});
