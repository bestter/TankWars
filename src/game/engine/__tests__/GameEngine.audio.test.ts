import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePlayer, makeRoundMap, makeTank } from "../../__tests__/helpers";
import type { ZeusStrikeResult } from "../../zeus/zeusDomain";
import { CombatAudio } from "../audio/CombatAudio";
import { GameEngine } from "../GameEngine";

function twoPlayers() {
  return [
    makePlayer({ id: "a", name: "Alice", tank: makeTank("tank-a", 120, 300) }),
    makePlayer({ id: "b", name: "Bob", tank: makeTank("tank-b", 680, 300) }),
  ];
}

describe("GameEngine audio", () => {
  let engine: GameEngine;
  let playFire: ReturnType<typeof vi.spyOn>;
  let playImpact: ReturnType<typeof vi.spyOn>;
  let playZeusAppointment: ReturnType<typeof vi.spyOn>;
  let playZeusStrike: ReturnType<typeof vi.spyOn>;
  let playExplosion: ReturnType<typeof vi.spyOn>;
  let playBurial: ReturnType<typeof vi.spyOn>;
  let playSliding: ReturnType<typeof vi.spyOn>;
  let playFloor: ReturnType<typeof vi.spyOn>;
  let stopVictoryMusic: ReturnType<typeof vi.spyOn>;
  let resetSlideThrottle: ReturnType<typeof vi.spyOn>;
  let dispose: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    playFire = vi.spyOn(CombatAudio.prototype, "playFire");
    playImpact = vi.spyOn(CombatAudio.prototype, "playImpact");
    playZeusAppointment = vi.spyOn(CombatAudio.prototype, "playZeusAppointment");
    playZeusStrike = vi.spyOn(CombatAudio.prototype, "playZeusStrike");
    playExplosion = vi.spyOn(CombatAudio.prototype, "playTankDestroyedByExplosion");
    playBurial = vi.spyOn(CombatAudio.prototype, "playTankSadBurial");
    playSliding = vi.spyOn(CombatAudio.prototype, "playTankSliding");
    playFloor = vi.spyOn(CombatAudio.prototype, "playTankTouchLowestFloor");
    stopVictoryMusic = vi.spyOn(CombatAudio.prototype, "stopVictoryMusic");
    resetSlideThrottle = vi.spyOn(CombatAudio.prototype, "resetSlideThrottle");
    dispose = vi.spyOn(CombatAudio.prototype, "dispose");
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    engine = new GameEngine(800, 480, { headless: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("joue le son de tir et le son d'impact", () => {
    const players = twoPlayers();
    const shooter = players[0];
    if (!shooter) throw new Error("roster");
    engine.setPlayers(players);
    playFire.mockClear();

    expect(engine.fireProjectile(
      shooter.tank.position,
      { angle: 45, power: 50, weaponId: "GRENADE" },
      shooter.id,
    )).toBe(true);
    expect(playFire).toHaveBeenCalledWith("GRENADE");

    engine.getPhysicsEngine().onProjectileHit?.({
      shotId: 1,
      munitionId: 1,
      x: 40,
      y: 20,
      weaponId: "NUKE",
    });
    expect(playImpact).toHaveBeenCalledWith("NUKE");
  });

  it("route les morts, la glissade et le plancher", () => {
    const tanks = engine.getTankManager();
    tanks.onPlayerDied?.("a", "explosion", "boom");
    tanks.onPlayerDied?.("a", "zeus", "lightning");
    tanks.onPlayerDied?.("a", "burial", "pit");
    tanks.onTankSliding?.("a");
    tanks.onTankTouchedFloor?.("a");

    expect(playExplosion).toHaveBeenCalledTimes(2);
    expect(playBurial).toHaveBeenCalledOnce();
    expect(playSliding).toHaveBeenCalledWith("a");
    expect(playFloor).toHaveBeenCalledOnce();
  });

  it("joue Zeus à distance avant les dégâts, et Zeus local à la nomination puis à la frappe", async () => {
    const [zeus, target] = twoPlayers();
    engine.setPlayers([zeus, target]);
    playZeusAppointment.mockClear();

    engine.applyRemoteZeusAppointment({
      appointmentId: 1,
      zeusId: zeus.id,
      rotationPlayerIds: [zeus.id, target.id],
    });
    expect(playZeusAppointment).toHaveBeenCalledOnce();

    const order: string[] = [];
    playZeusStrike.mockImplementation(() => {
      order.push("strike");
    });
    playExplosion.mockImplementation(() => {
      order.push("explosion");
    });
    const result: ZeusStrikeResult = {
      strikeId: 1,
      zeusId: zeus.id,
      targetId: target.id,
      award: { playerId: zeus.id, amount: 0 },
      balances: [],
      roundOutcome: { isRoundEnd: false, isDraw: false, roundWinnerId: null },
    };
    expect(engine.applyRemoteZeusStrikeResult(result)).toBe(true);
    expect(order).toEqual(["strike", "explosion"]);

    vi.useFakeTimers();
    const local = new GameEngine(800, 480, { headless: true });
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
    local.setAIEngine({
      executeTurn: vi.fn().mockResolvedValue({
        angle: 45,
        power: 50,
        weaponId: "MISSILE",
      }),
    });
    playZeusAppointment.mockClear();
    playZeusStrike.mockReset();
    local.setPlayers([first, second]);

    for (let shot = 0; shot < 10; shot++) {
      await vi.advanceTimersByTimeAsync(1_500);
      expect(local.getActiveProjectiles()).toHaveLength(1);
      local.getPhysicsEngine().clear(true);
      local.getTurnManager().update(1 / 120);
    }

    expect(playZeusAppointment).toHaveBeenCalledOnce();
    const updateZeusStrike = Reflect.get(local, "updateZeusStrike") as (dt: number) => void;
    updateZeusStrike.call(local, 0.71);
    expect(playZeusStrike).toHaveBeenCalledOnce();
  });

  it("réinitialise la glissade aux frontières de manche et arrête la fanfare", () => {
    expect(engine.startNextRound()).toBe(false);
    expect(stopVictoryMusic).not.toHaveBeenCalled();

    const players = twoPlayers();
    resetSlideThrottle.mockClear();
    engine.setPlayers(players);
    expect(resetSlideThrottle).toHaveBeenCalled();

    stopVictoryMusic.mockClear();
    resetSlideThrottle.mockClear();
    expect(engine.startNextRound()).toBe(true);
    expect(stopVictoryMusic).toHaveBeenCalled();
    expect(resetSlideThrottle).toHaveBeenCalled();

    stopVictoryMusic.mockClear();
    resetSlideThrottle.mockClear();
    engine.resetGame();
    expect(stopVictoryMusic).toHaveBeenCalled();
    expect(resetSlideThrottle).toHaveBeenCalled();

    resetSlideThrottle.mockClear();
    engine.reconstructCombat(makeRoundMap(), players);
    expect(resetSlideThrottle).toHaveBeenCalled();
  });

  it("ferme l'audio après avoir effacé le visuel Zeus", () => {
    engine.startRemoteZeusStrike({ strikeId: 1, zeusId: "a", targetId: "b" });
    expect(Reflect.get(engine, "activeZeusVisual")).not.toBeNull();
    dispose.mockImplementation(() => {
      expect(Reflect.get(engine, "activeZeusVisual")).toBeNull();
    });

    engine.stop();

    expect(dispose).toHaveBeenCalledOnce();
  });
});
