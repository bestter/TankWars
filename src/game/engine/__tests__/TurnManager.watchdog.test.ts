import { afterEach, describe, expect, it, vi } from "vitest";
import { GameEngine } from "../GameEngine";
import { TurnManager } from "../TurnManager";
import { TankManager } from "../../entities/TankManager";
import type { TerrainManager } from "../Terrain";
import type { AIEngine } from "../../entities/ai/AIEngine";
import { makePlayer, makeTank } from "../../__tests__/helpers";
import * as random from "../../../utils/random";

const DT = 1 / 120;

function step(update: (dt: number) => void, seconds: number): void {
  const count = Math.round(seconds * 120);
  for (let i = 0; i < count; i++) update(DT);
}

describe("watchdogs de tir IA (#358)", () => {
  const engines: GameEngine[] = [];

  afterEach(() => {
    for (const engine of engines) engine.stop();
    engines.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function silence(): void {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(random, "secureRandom").mockReturnValue(0.5);
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  }

  it("ne relance ni ne passe au joueur suivant tant qu'un projectile est actif", async () => {
    vi.useFakeTimers();
    silence();
    const self = makePlayer({
      id: "s",
      isHuman: false,
      inventory: { DRILLER: 5, MISSILE: 99 },
      tank: makeTank("s", 100, 336, { currentWeapon: "DRILLER" }),
    });
    const target = makePlayer({ id: "c", isHuman: true, tank: makeTank("c", 600, 336) });
    const tanks = new TankManager();
    tanks.setPlayers([self, target]);
    const fallback = vi.fn(() => ({ angle: 45, power: 50 }));
    const fire = vi.fn();
    const ai: AIEngine = {
      executeTurn: vi.fn().mockResolvedValue({ angle: 70, power: 90, weaponId: "DRILLER" }),
      getResolutionFallback: fallback,
    };
    const turns = new TurnManager(tanks, {} as TerrainManager, fire, ai);
    turns.connectToPhysics({ hasActiveProjectiles: () => true } as never);

    turns.startFirstTurn();
    await vi.advanceTimersByTimeAsync(1600);

    expect(fire).toHaveBeenCalledTimes(1);
    expect(self.inventory.DRILLER).toBe(4);
    step((dt) => turns.update(dt), 12.2);
    expect(ai.executeTurn).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(self.inventory.DRILLER).toBe(4);
    expect(self.tank.currentWeapon).toBe("DRILLER");
    expect(turns.getCurrentPlayer()?.id).toBe("s");
  });

  it("émet un seul repli, ignore la décision tardive et récupère l'absence de résolution", async () => {
    vi.useFakeTimers();
    silence();
    const self = makePlayer({
      id: "s",
      isHuman: false,
      inventory: { DRILLER: 5, MISSILE: 99 },
      tank: makeTank("s", 100, 336, { currentWeapon: "DRILLER" }),
    });
    const target = makePlayer({ id: "c", isHuman: true, tank: makeTank("c", 600, 336) });
    const tanks = new TankManager();
    tanks.setPlayers([self, target]);
    let resolveDecision: ((decision: { angle: number; power: number; weaponId: "MISSILE" }) => void) | undefined;
    const fallback = vi.fn(() => ({ angle: 45, power: 50 }));
    const fire = vi.fn();
    const turns = new TurnManager(tanks, {} as TerrainManager, fire, {
      executeTurn: vi.fn().mockReturnValue(new Promise((resolve) => {
        resolveDecision = resolve;
      })),
      getResolutionFallback: fallback,
    });

    turns.startFirstTurn();
    step((dt) => turns.update(dt), 10.05);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(self.inventory.DRILLER).toBe(4);
    expect(turns.getCurrentPlayer()?.id).toBe("s");

    resolveDecision?.({ angle: 10, power: 10, weaponId: "MISSILE" });
    await vi.advanceTimersByTimeAsync(2000);
    step((dt) => turns.update(dt), 2.3);

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(self.inventory.DRILLER).toBe(4);
    expect(self.tank.currentWeapon).toBe("DRILLER");
    expect(turns.getCurrentPlayer()?.id).toBe("c");
  });

  it("conserve le stock et le registre quand le moteur refuse le repli", async () => {
    vi.useFakeTimers();
    silence();
    const engine = new GameEngine(800, 480, { headless: true });
    engines.push(engine);
    const self = makePlayer({
      id: "s",
      isHuman: false,
      inventory: { DRILLER: 5, MISSILE: 99 },
      tank: makeTank("s", 100, 336, { currentWeapon: "DRILLER" }),
    });
    const target = makePlayer({ id: "c", isHuman: true, tank: makeTank("c", 600, 336) });
    const tanks = new TankManager();
    tanks.setPlayers([self, target]);
    expect(engine.fireProjectile(self.tank.position, {
      angle: 45, power: 40, weaponId: "MISSILE",
    }, self.id)).toBe(true);
    const shotId = (Reflect.get(engine, "activeShotLedger") as { shotId: number }).shotId;
    const fallback = vi.fn(() => ({ angle: 45, power: 50 }));
    const turns = new TurnManager(
      tanks,
      engine.getTerrain(),
      (from, command, ownerId) => engine.fireProjectile(from, command, ownerId ?? self.id),
      {
        executeTurn: vi.fn().mockReturnValue(new Promise(() => {})),
        getResolutionFallback: fallback,
      },
    );

    turns.startFirstTurn();
    step((dt) => turns.update(dt), 12.2);

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(engine.fireProjectile(self.tank.position, {
      angle: 80, power: 80, weaponId: "DRILLER",
    }, self.id)).toBe(false);
    expect(self.inventory.DRILLER).toBe(5);
    expect(self.tank.currentWeapon).toBe("DRILLER");
    expect((Reflect.get(engine, "activeShotLedger") as { shotId: number }).shotId).toBe(shotId);
    expect(engine.getActiveProjectiles()).toHaveLength(1);
  });

  it("ne réarme pas un tir abandonné par la pause ou un callback tardif", async () => {
    vi.useFakeTimers();
    silence();
    const self = makePlayer({
      id: "s",
      isHuman: false,
      inventory: { DRILLER: 5, MISSILE: 99 },
      tank: makeTank("s", 100, 336, { currentWeapon: "DRILLER" }),
    });
    const target = makePlayer({ id: "c", isHuman: true, tank: makeTank("c", 600, 336) });
    const tanks = new TankManager();
    tanks.setPlayers([self, target]);
    let resolveDecision: ((decision: { angle: number; power: number; weaponId: "DRILLER" }) => void) | undefined;
    const fire = vi.fn();
    const turns = new TurnManager(tanks, {} as TerrainManager, fire, {
      executeTurn: vi.fn().mockReturnValue(new Promise((resolve) => {
        resolveDecision = resolve;
      })),
      getResolutionFallback: vi.fn(() => ({ angle: 45, power: 50 })),
    });

    turns.startFirstTurn();
    turns.pauseForInterRound();
    resolveDecision?.({ angle: 70, power: 90, weaponId: "DRILLER" });
    await vi.advanceTimersByTimeAsync(2000);
    turns.resumeForCombat();
    step((dt) => turns.update(dt), 15);

    expect(fire).not.toHaveBeenCalled();
    expect(self.inventory.DRILLER).toBe(5);
    expect(turns.getCurrentPlayer()?.id).toBe("s");
  });

  it("laisse le tour humain en place pendant un vol de plus de 12 s", () => {
    silence();
    const human = makePlayer({ id: "h", isHuman: true, tank: makeTank("h", 100, 336) });
    const other = makePlayer({ id: "o", isHuman: true, tank: makeTank("o", 600, 336) });
    const tanks = new TankManager();
    tanks.setPlayers([human, other]);
    const fire = vi.fn();
    const turns = new TurnManager(tanks, {} as TerrainManager, fire);
    turns.connectToPhysics({ hasActiveProjectiles: () => true } as never);
    turns.startFirstTurn();

    expect(turns.tryFire()).toBe(true);
    step((dt) => turns.update(dt), 12.2);

    expect(fire).toHaveBeenCalledTimes(1);
    expect(turns.getCurrentPlayer()?.id).toBe("h");
    expect(turns.getCurrentTurnInfo()?.isInputLocked).toBe(true);
  });

  it("joue une vraie GRENADE plus de 12 s sans second tir ni passage prématuré", async () => {
    vi.useFakeTimers();
    silence();
    const engine = new GameEngine(800, 480, { headless: true, gravity: 5, windForce: 0 });
    engines.push(engine);
    const fallback = vi.fn(() => ({ angle: 45, power: 50 }));
    const launch = vi.spyOn(engine.getPhysicsEngine(), "launchProjectile");
    const resolutions: number[] = [];
    engine.onShotResolved = (preview) => resolutions.push(preview.shotId);
    engine.setAIEngine({
      executeTurn: vi.fn().mockResolvedValue({ angle: 90, power: 90, weaponId: "GRENADE" }),
      getResolutionFallback: fallback,
    });
    engine.setPlayers([
      makePlayer({
        id: "s",
        isHuman: false,
        inventory: { GRENADE: 5, MISSILE: 99 },
        tank: makeTank("s", 120, 300, { currentWeapon: "GRENADE" }),
      }),
      makePlayer({
        id: "c",
        isHuman: true,
        tank: makeTank("c", 680, 300),
      }),
    ]);
    await vi.advanceTimersByTimeAsync(1600);

    const update = (dt: number): void => {
      (Reflect.get(engine, "update") as (this: GameEngine, stepDt: number) => void).call(engine, dt);
    };
    const shooter = engine.getTankManager().getPlayerById("s");
    expect(launch).toHaveBeenCalledTimes(1);
    expect(shooter?.inventory.GRENADE).toBe(4);
    expect(engine.getPhysicsEngine().hasActiveProjectiles()).toBe(true);

    step(update, 12.2);
    expect(engine.getPhysicsEngine().hasActiveProjectiles()).toBe(true);
    expect(engine.getTurnManager().getCurrentPlayer()?.id).toBe("s");
    expect(launch).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(resolutions).toHaveLength(0);
    expect(shooter?.inventory.GRENADE).toBe(4);

    const shell = engine.getActiveProjectiles()[0];
    shell.x = 400;
    shell.y = engine.getTerrain().getHeightAt(400) - 6;
    shell.vx = 0;
    shell.vy = 30;
    shell.bounceCount = 4;
    step(update, 2);

    expect(engine.getPhysicsEngine().hasActiveProjectiles()).toBe(false);
    expect(resolutions).toHaveLength(1);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(shooter?.inventory.GRENADE).toBe(4);
    step(update, 3);
    expect(resolutions).toHaveLength(1);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
