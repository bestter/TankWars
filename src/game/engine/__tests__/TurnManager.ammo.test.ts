import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TurnManager } from "../TurnManager";
import { TankManager } from "../../entities/TankManager";
import { TerrainManager } from "../Terrain";
import type { FireCommand } from "../../../types/game";
import { makePlayer, makeTank } from "../../__tests__/helpers";

describe("TurnManager ammo and local fire", () => {
  let tanks: TankManager;
  let terrain: TerrainManager;
  let fireCb: ReturnType<
    typeof vi.fn<(from: { x: number; y: number }, command: FireCommand, ownerId?: string) => void>
  >;
  let tm: TurnManager;
  let human: ReturnType<typeof makePlayer>;
  let cpu: ReturnType<typeof makePlayer>;

  beforeEach(() => {
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    tanks = new TankManager();
    terrain = new TerrainManager(800, 480);
    fireCb = vi.fn<(from: { x: number; y: number }, command: FireCommand, ownerId?: string) => void>();
    human = makePlayer({
      id: "human-1",
      isHuman: true,
      inventory: { MISSILE: 99, GRENADE: 1, DRILLER: 1 },
      tank: makeTank("th", 100, 200, { currentWeapon: "GRENADE", angle: 45, power: 50 }),
    });
    cpu = makePlayer({
      id: "cpu-1",
      isHuman: false,
      aiProfile: "v1-random",
      tank: makeTank("tc", 400, 200),
    });
    tanks.setPlayers([human, cpu]);
    tm = new TurnManager(tanks, terrain, fireCb);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("consumes limited ammo and auto-switches to MISSILE when stock hits 0", () => {
    tm.startFirstTurn();
    expect(tm.tryFire()).toBe(true);
    expect(fireCb).toHaveBeenCalledTimes(1);
    expect(human.inventory.GRENADE).toBe(0);
    expect(human.tank.currentWeapon).toBe("MISSILE");
  });

  it("never decrements MISSILE", () => {
    human.tank.currentWeapon = "MISSILE";
    tm.startFirstTurn();
    expect(tm.tryFire()).toBe(true);
    expect(human.inventory.MISSILE).toBe(99);
    expect(human.tank.currentWeapon).toBe("MISSILE");
  });

  it("refuses selectWeapon when the stock is empty", () => {
    human.inventory.NUKE = 0;
    tm.startFirstTurn();
    expect(tm.selectWeapon("NUKE")).toBe(false);
    expect(human.tank.currentWeapon).toBe("GRENADE");
    expect(tm.selectWeapon("DRILLER")).toBe(true);
    expect(human.tank.currentWeapon).toBe("DRILLER");
  });

  it("cycleWeapon skips empty stocks and always includes MISSILE", () => {
    human.inventory = { GRENADE: 1 };
    human.tank.currentWeapon = "GRENADE";
    tm.startFirstTurn();
    expect(tm.cycleWeapon(1)).toBe(true);
    expect(human.tank.currentWeapon).toBe("MISSILE");
    expect(tm.cycleWeapon(1)).toBe(true);
    expect(human.tank.currentWeapon).toBe("GRENADE");
  });

  it("blocks tryFire while a tank is falling", () => {
    vi.spyOn(tanks, "anyTankIsFalling").mockReturnValue(true);
    tm.startFirstTurn();
    expect(tm.tryFire()).toBe(false);
    expect(fireCb).not.toHaveBeenCalled();
  });

  it("locks input on resumeForCombat when the current player is AI", () => {
    tanks.setPlayers([cpu, human]);
    tm.resumeForCombat();
    const info = tm.getCurrentTurnInfo();
    expect(info?.isHuman).toBe(false);
    expect(info?.isInputLocked).toBe(true);
    expect(tm.tryFire()).toBe(false);
  });
});
