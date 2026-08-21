import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GameEngine } from "../GameEngine";
import * as random from "../../../utils/random";
import { makePlayer, makeTank } from "../../__tests__/helpers";

describe("GameEngine match rules", () => {
  let engine: GameEngine;

  beforeEach(() => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0.5);
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    engine = new GameEngine(800, 480);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function threePlayers() {
    const a = makePlayer({
      id: "a",
      name: "Alice",
      money: 0,
      tank: makeTank("ta", 80, 200, { shield: 0, maxShield: 0 }),
    });
    const b = makePlayer({
      id: "b",
      name: "Bob",
      money: 0,
      tank: makeTank("tb", 200, 200, { shield: 0, maxShield: 0 }),
    });
    const c = makePlayer({
      id: "c",
      name: "Cara",
      money: 0,
      tank: makeTank("tc", 320, 200, { shield: 0, maxShield: 0 }),
    });
    engine.setPlayers([a, b, c]);
    const live = engine.getTankManager().getPlayers();
    const alice = live.find((p) => p.id === "a");
    const bob = live.find((p) => p.id === "b");
    const cara = live.find((p) => p.id === "c");
    if (!alice || !bob || !cara) {
      throw new Error("expected three spawned players");
    }
    alice.money = 0;
    bob.money = 0;
    cara.money = 0;
    return { a: alice, b: bob, c: cara };
  }

  function killAt(tankX: number, tankY: number, killerId: string): void {
    engine.getTankManager().applyExplosionDamage(tankX, tankY, 80, 200, killerId);
  }

  it("awards $300 to the killer when more than one tank remains", () => {
    const { a, b, c } = threePlayers();
    killAt(b.tank.position.x, b.tank.position.y, "a");

    expect(b.tank.isDead).toBe(true);
    expect(a.money).toBe(300);
    expect(c.money).toBe(0);
  });

  it("awards $600 to the last tank standing and no suicide payout", () => {
    const { a, b, c } = threePlayers();
    killAt(b.tank.position.x, b.tank.position.y, "a");
    expect(a.money).toBe(300);

    killAt(c.tank.position.x, c.tank.position.y, "a");
    expect(c.tank.isDead).toBe(true);
    expect(a.money).toBe(900);
    expect(b.money).toBe(0);
  });

  it("does not pay a suicide", () => {
    const { a, b } = threePlayers();
    killAt(a.tank.position.x, a.tank.position.y, "a");

    expect(a.tank.isDead).toBe(true);
    expect(a.money).toBe(0);
    expect(b.money).toBe(0);
  });

  it("awards $500 survival money only to living tanks", () => {
    const { a, b, c } = threePlayers();
    b.tank.isDead = true;
    b.tank.health = 0;
    engine.getTankManager().invalidateAliveCache();

    const result = engine.awardEndOfRoundEarnings();

    expect(a.money).toBe(500);
    expect(c.money).toBe(500);
    expect(b.money).toBe(0);
    expect(result.survivors).toEqual(["a", "c"]);
  });

  it("startNextRound respawns the roster and refuses a single-player match", () => {
    const { a, b } = threePlayers();
    a.tank.health = 1;
    a.tank.isDead = true;
    a.tank.lastHitBy = "c";

    expect(engine.startNextRound()).toBe(true);
    const after = engine.getTankManager().getPlayers();
    const alice = after.find((p) => p.id === "a");
    expect(alice?.tank.isDead).toBe(false);
    expect(alice?.tank.health).toBe(alice?.tank.maxHealth);
    expect(alice?.tank.lastHitBy).toBeUndefined();
    expect(engine.isRoundCombatActive()).toBe(true);

    engine.setPlayers([b]);
    expect(engine.startNextRound()).toBe(false);
  });

  it("launches the projectile from the barrel tip, not the tank origin", () => {
    const { a } = threePlayers();
    engine.fireProjectile(
      a.tank.position,
      { angle: 0, power: 50, weaponId: "MISSILE" },
      a.id,
    );
    const shot = engine.getActiveProjectiles()[0];
    expect(shot).toBeDefined();
    expect(shot.x).toBeCloseTo(a.tank.position.x + 20, 5);
    expect(shot.y).toBeCloseTo(a.tank.position.y - 13, 5);
  });

  it("declareMatchWinner and declareMatchDraw set game-over state", () => {
    const { a } = threePlayers();
    const onOver = vi.fn();
    const onDraw = vi.fn();
    engine.onGameOver = onOver;
    engine.onDraw = onDraw;

    engine.declareMatchWinner(a);
    expect(engine.isGameOver()).toBe(true);
    expect(engine.getWinner()?.id).toBe("a");
    expect(onOver).toHaveBeenCalledWith(a);

    engine.declareMatchWinner(a);
    expect(onOver).toHaveBeenCalledTimes(1);

    const engine2 = new GameEngine(200, 200);
    engine2.onDraw = onDraw;
    engine2.declareMatchDraw();
    expect(engine2.isGameOver()).toBe(true);
    expect(engine2.getWinner()).toBeNull();
    expect(onDraw).toHaveBeenCalledTimes(1);
  });

  it("kills a tank and plays burial sound when it falls out of bounds (burial check)", () => {
    const { a } = threePlayers();
    const burialSpy = vi.spyOn(engine as unknown as { playTankSadBurialSound: () => void }, "playTankSadBurialSound");

    // Move the tank far below the terrain to simulate a fall
    a.tank.position.y = 2000;

    // Call engine update to trigger the checkBurials (inlined via tankManager.checkTankBurial)
    (engine as unknown as { update: (dt: number) => void }).update(0.016);

    expect(a.tank.isDead).toBe(true);
    expect(burialSpy).toHaveBeenCalledTimes(1);
  });
});
