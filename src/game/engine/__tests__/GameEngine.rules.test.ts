import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GameEngine } from "../GameEngine";
import type { ResolvedShotPreview } from "../GameEngine";
import * as random from "../../../utils/random";
import { makePlayer, makeTank } from "../../__tests__/helpers";
import type { Player } from "../../../types/player";

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
    engine.getTankManager().applyExplosionDamage({
      explosionX: tankX,
      explosionY: tankY,
      radius: 80,
      maxDamage: 200,
      shooterId: killerId,
      weaponId: "MISSILE",
      isDirectHit: false,
    });
  }

  it("does not apply the historical $300 death reward", () => {
    const { a, b, c } = threePlayers();
    killAt(b.tank.position.x, b.tank.position.y, "a");

    expect(b.tank.isDead).toBe(true);
    expect(a.money).toBe(0);
    expect(c.money).toBe(0);
  });

  it("does not apply the historical $600 last-survivor reward immediately", () => {
    const { a, b, c } = threePlayers();
    killAt(b.tank.position.x, b.tank.position.y, "a");
    expect(a.money).toBe(0);

    killAt(c.tank.position.x, c.tank.position.y, "a");
    expect(c.tank.isDead).toBe(true);
    expect(a.money).toBe(0);
    expect(b.money).toBe(0);
  });

  it("does not pay a suicide", () => {
    const { a, b } = threePlayers();
    killAt(a.tank.position.x, a.tank.position.y, "a");

    expect(a.tank.isDead).toBe(true);
    expect(a.money).toBe(0);
    expect(b.money).toBe(0);
  });

  it("builds the round summary without applying the historical $500 reward", () => {
    const { a, b, c } = threePlayers();
    b.tank.isDead = true;
    b.tank.health = 0;
    engine.getTankManager().invalidateAliveCache();

    const result = engine.buildRoundResult();

    expect(a.money).toBe(0);
    expect(c.money).toBe(0);
    expect(b.money).toBe(0);
    expect(result.survivors).toEqual(["a", "c"]);
    expect(result.earningsByPlayer).toEqual({});
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

  it("finalizes real shot events, applies earnings once, and accumulates round earnings", () => {
    const { a, b } = threePlayers();
    engine.fireProjectile(
      a.tank.position,
      { angle: 0, power: 50, weaponId: "MISSILE" },
      a.id,
    );
    const projectile = engine.getActiveProjectiles()[0];
    engine.getTankManager().applyExplosionDamage({
      explosionX: b.tank.position.x,
      explosionY: b.tank.position.y,
      radius: 80,
      maxDamage: 200,
      shooterId: a.id,
      weaponId: "MISSILE",
      isDirectHit: true,
      shotId: projectile.shotId,
      munitionId: projectile.munitionId,
    });
    const finalize = Reflect.get(engine, "finalizeActiveShot") as () => ResolvedShotPreview;
    const preview = finalize.call(engine);

    expect(preview.awards.find((award) => award.playerId === a.id)?.amount).toBe(525);
    expect(a.money).toBe(525);
    expect(engine.buildRoundResult().earningsByPlayer).toEqual({ a: 525 });

    engine.applyResolvedEarnings(preview.shotId, preview.balances);
    expect(a.money).toBe(525);
  });

  it("resets the first-shot flag and round earnings for a new round", () => {
    const { a } = threePlayers();
    engine.fireProjectile(a.tank.position, { angle: 0, power: 50, weaponId: "MISSILE" }, a.id);
    const firstLedger = Reflect.get(engine, "activeShotLedger") as { isFirstShotOfRound: boolean };
    expect(firstLedger.isFirstShotOfRound).toBe(true);

    expect(engine.startNextRound()).toBe(true);
    const nextA = engine.getTankManager().getPlayerById(a.id);
    if (!nextA) throw new Error("Alice should respawn");
    engine.fireProjectile(nextA.tank.position, { angle: 0, power: 50, weaponId: "MISSILE" }, nextA.id);
    const nextLedger = Reflect.get(engine, "activeShotLedger") as { isFirstShotOfRound: boolean };
    expect(nextLedger.isFirstShotOfRound).toBe(true);
    expect(engine.buildRoundResult().earningsByPlayer).toEqual({});
  });

  it("runs a local deadlock through rotations, appointment, strike, and round end", async () => {
    vi.useFakeTimers();
    try {
      const first = makePlayer({
        id: "ai-1",
        name: "CPU-1",
        isHuman: false,
        money: 0,
        tank: makeTank("tank-ai-1", 120, 200),
      });
      const second = makePlayer({
        id: "ai-2",
        name: "CPU-2",
        isHuman: false,
        money: 0,
        tank: makeTank("tank-ai-2", 680, 200),
      });
      engine.setAIEngine({
        executeTurn: vi.fn().mockResolvedValue({
          angle: 45,
          power: 50,
          weaponId: "MISSILE",
        }),
      });
      const appointed = vi.fn();
      const struck = vi.fn();
      const roundEnded = vi.fn();
      engine.onZeusAppointed = appointed;
      engine.onZeusStrikeApplied = struck;
      engine.onRoundEnded = roundEnded;
      engine.setPlayers([first, second]);

      const physics = Reflect.get(engine, "physicsEngine") as {
        clear: (notifySettlement?: boolean) => void;
      };
      for (let shot = 0; shot < 10; shot++) {
        await vi.advanceTimersByTimeAsync(1_500);
        expect(engine.getActiveProjectiles()).toHaveLength(1);
        physics.clear(true);
        engine.getTurnManager().update(1 / 120);
      }

      expect(appointed).toHaveBeenCalledOnce();
      const appointment = appointed.mock.calls[0]?.[0] as { zeusId: string };
      expect(engine.getActiveZeusId()).toBe(appointment.zeusId);
      expect(engine.getTurnManager().getCurrentPlayer()?.id).toBe(appointment.zeusId);

      const updateZeusStrike = Reflect.get(engine, "updateZeusStrike") as (dt: number) => void;
      updateZeusStrike.call(engine, 0.71);
      updateZeusStrike.call(engine, 0.1);

      const zeus = engine.getTankManager().getPlayerById(appointment.zeusId);
      const target = engine.getTankManager().getPlayers().find((player) => player.id !== appointment.zeusId);
      expect(struck).toHaveBeenCalledOnce();
      expect(target?.tank).toMatchObject({ health: 0, shield: 0, isDead: true });
      expect(zeus?.money).toBe(75);
      expect(roundEnded).toHaveBeenCalledOnce();
      expect(roundEnded.mock.calls[0]?.[0].survivors.map((player: Player) => player.id)).toEqual([
        appointment.zeusId,
      ]);
      expect(engine.isRoundCombatActive()).toBe(false);
      expect(engine.getActiveZeusId()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
});
