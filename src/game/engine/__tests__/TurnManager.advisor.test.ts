// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnManager } from "../TurnManager";
import { TankManager } from "../../entities/TankManager";
import { flatTerrain, makePlayer, makeTank } from "../../__tests__/helpers";

function fixture() {
  const players = [makePlayer({ id: "self", isHuman: true, inventory: { NUKE: 1 },
    tank: makeTank("self", 100, 336) }), makePlayer({ id: "other", isHuman: true, tank: makeTank("other", 400, 336) })];
  const tanks = new TankManager(); tanks.setPlayers(players);
  const fire = vi.fn();
  const manager = new TurnManager(tanks, flatTerrain(800, 480), fire);
  manager.setLocalShotContextProvider(() => ({ playerCountAtMatchStart: 2, isFirstShotOfRound: true }));
  return { manager, tanks, players, fire };
}
afterEach(() => vi.restoreAllMocks());

describe("atomic human advisor controls", () => {
  it("captures a deep canonical snapshot independent of manual controls and without mutations", () => {
    const f = fixture(); const before = structuredClone(f.players);
    const first = f.manager.captureAdvisorState();
    expect(first).not.toBeNull();
    const canonical = structuredClone(first);
    first!.players[0].tank.health = 0;
    expect(f.players).toEqual(before);
    f.manager.adjustAngle(20); f.manager.adjustPower(10); f.manager.selectWeapon("NUKE");
    expect(f.manager.captureAdvisorState()).toEqual(canonical);
  });

  it("applies all three controls together even when the weapon is already selected, never firing", () => {
    const f = fixture(); const hud = vi.fn(); f.manager.onHudUpdate = hud;
    const beforeStock = structuredClone(f.players[0].inventory);
    expect(f.manager.applyAdvisorCommand({ angle: 60, power: 70, weaponId: "MISSILE" })).toBe(true);
    expect(f.players[0].tank).toMatchObject({ angle: 60, power: 70, currentWeapon: "MISSILE" });
    expect(hud).toHaveBeenCalledOnce(); expect(f.fire).not.toHaveBeenCalled();
    expect(f.players[0].inventory).toEqual(beforeStock);
  });

  it.each(["stock", "dead", "falling", "paused", "zeus", "catchup", "ai", "ended", "bounds"])("rejects %s before any mutation", (reason) => {
    const f = fixture();
    switch (reason) {
      case "stock": f.players[0].inventory.NUKE = 0; break;
      case "dead": f.players[0].tank.isDead = true; break;
      case "falling": vi.spyOn(f.tanks, "anyTankIsFalling").mockReturnValue(true); break;
      case "paused": f.manager.pauseForInterRound(); break;
      case "zeus": f.manager.lockSpecialTurn(); break;
      case "catchup": f.manager.lockForCatchUp(); break;
      case "ai": f.players[0].isHuman = false; break;
      case "ended": f.manager.setMatchEndedChecker(() => true); break;
    }
    const before = structuredClone(f.players);
    expect(f.manager.applyAdvisorCommand({ angle: reason === "bounds" ? 999 : 60, power: 70, weaponId: "NUKE" })).toBe(false);
    expect(f.players).toEqual(before); expect(f.fire).not.toHaveBeenCalled();
  });

  it("keyboard activation on an advisor button never fires the tank", () => {
    const f = fixture(); f.manager.setupInputListeners();
    const button = document.createElement("button"); document.body.append(button);
    button.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(f.fire).not.toHaveBeenCalled();
    f.manager.removeInputListeners(); button.remove();
  });
});
