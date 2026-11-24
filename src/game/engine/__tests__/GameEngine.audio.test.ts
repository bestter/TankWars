import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePlayer, makeRoundMap, makeTank } from "../../__tests__/helpers";
import { TERRAIN_MATERIAL, type TerrainMaterial } from "../../../types/terrain";
import type { ZeusStrikeResult } from "../../zeus/zeusDomain";
import { CombatAudio } from "../audio/CombatAudio";
import { GameEngine } from "../GameEngine";

function getUpdateFn(engine: GameEngine): (dt: number) => void {
  return Reflect.get(engine, "update") as (dt: number) => void;
}

function twoPlayers() {
  return [
    makePlayer({ id: "a", name: "Alice", tank: makeTank("tank-a", 120, 300) }),
    makePlayer({ id: "b", name: "Bob", tank: makeTank("tank-b", 680, 300) }),
  ];
}

describe("GameEngine audio", () => {
  let engine: GameEngine;
  let playFire: ReturnType<typeof vi.spyOn>;
  let stopFlightAlert: ReturnType<typeof vi.spyOn>;
  let resumeFlightAlert: ReturnType<typeof vi.spyOn>;
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
    stopFlightAlert = vi.spyOn(CombatAudio.prototype, "stopFlightAlert");
    resumeFlightAlert = vi.spyOn(CombatAudio.prototype, "resumeFlightAlert");
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

  describe("cycle sonore des tirs nucléaires (#435)", () => {
    function setupFlatCombat(groundY = 360) {
      const players = [
        makePlayer({
          id: "a",
          name: "Alice",
          inventory: { NUKE: 2, THERMONUCLEAR: 2 },
          tank: makeTank("tank-a", 120, groundY),
        }),
        makePlayer({
          id: "b",
          name: "Bob",
          inventory: { NUKE: 2, THERMONUCLEAR: 2 },
          tank: makeTank("tank-b", 680, groundY),
        }),
      ];
      engine.setPlayers(players);
      engine.setWindForce(0);
      engine
        .getTerrain()
        .loadHeights(
          new Array<number>(800).fill(groundY),
          new Array<TerrainMaterial>(800).fill(TERRAIN_MATERIAL.DIRT),
        );
      const shooter = engine.getTankManager().getPlayerById("a")!;
      const target = engine.getTankManager().getPlayerById("b")!;
      shooter.tank.position = { x: 120, y: groundY };
      target.tank.position = { x: 680, y: groundY };
      playFire.mockClear();
      stopFlightAlert.mockClear();
      playImpact.mockClear();
      return { shooter, target };
    }

    it.each(["NUKE", "THERMONUCLEAR"] as const)(
      "démarre une seule alerte, la coupe avant l'explosion unique sur impact terrain (%s, vol court)",
      (weaponId) => {
        const { shooter } = setupFlatCombat();
        const order: string[] = [];
        stopFlightAlert.mockImplementation(() => {
          order.push("stop");
        });
        playImpact.mockImplementation(() => {
          order.push("impact");
        });

        expect(
          engine.fireProjectile(
            shooter.tank.position,
            { angle: 45, power: 25, weaponId },
            shooter.id,
          ),
        ).toBe(true);
        expect(playFire).toHaveBeenCalledTimes(1);
        expect(playFire).toHaveBeenCalledWith(weaponId);
        order.length = 0;

        const shell = engine.getActiveProjectiles()[0];
        shell.x = 300;
        shell.y = 360;
        shell.vy = 20;
        const stepUpdate = getUpdateFn(engine);
        stepUpdate.call(engine, 1 / 120);

        expect(engine.getActiveProjectiles()).toHaveLength(0);
        expect(playImpact).toHaveBeenCalledTimes(1);
        expect(playImpact).toHaveBeenCalledWith(weaponId);
        expect(order).toEqual(["stop", "impact"]);
      },
    );

    it.each(["NUKE", "THERMONUCLEAR"] as const)(
      "maintient l'alerte pendant un vol long puis la coupe sur impact direct tank (%s)",
      (weaponId) => {
        const { shooter, target } = setupFlatCombat(420);
        const stepUpdate = getUpdateFn(engine);

        expect(
          engine.fireProjectile(
            shooter.tank.position,
            { angle: 85, power: 80, weaponId },
            shooter.id,
          ),
        ).toBe(true);
        expect(playFire).toHaveBeenCalledTimes(1);
        stopFlightAlert.mockClear();

        // Vol long (~4 secondes = 480 pas à 120 Hz) sans coupure anticipée ni impact
        for (let step = 0; step < 480; step++) {
          const active = engine.getActiveProjectiles()[0];
          if (active) {
            active.x = 320;
            active.y = 80;
            active.vx = 0;
            active.vy = 0;
          }
          stepUpdate.call(engine, 1 / 120);
        }
        expect(engine.getActiveProjectiles()).toHaveLength(1);
        expect(stopFlightAlert).not.toHaveBeenCalled();
        expect(playImpact).not.toHaveBeenCalled();

        // Impact direct sur le tank cible
        const active = engine.getActiveProjectiles()[0];
        active.x = target.tank.position.x;
        active.y = target.tank.position.y - 6;
        stepUpdate.call(engine, 1 / 120);

        expect(engine.getActiveProjectiles()).toHaveLength(0);
        expect(stopFlightAlert).toHaveBeenCalled();
        expect(playImpact).toHaveBeenCalledTimes(1);
        expect(playImpact).toHaveBeenCalledWith(weaponId, 1);
      },
    );

    it.each(["NUKE", "THERMONUCLEAR"] as const)(
      "coupe l'alerte sans explosion lors d'une sortie hors limites (%s)",
      (weaponId) => {
        const { shooter } = setupFlatCombat();
        const stepUpdate = getUpdateFn(engine);

        expect(
          engine.fireProjectile(
            shooter.tank.position,
            { angle: 20, power: 100, weaponId },
            shooter.id,
          ),
        ).toBe(true);
        stopFlightAlert.mockClear();

        const shell = engine.getActiveProjectiles()[0];
        shell.x = 5000;
        stepUpdate.call(engine, 1 / 120);

        expect(engine.getActiveProjectiles()).toHaveLength(0);
        expect(stopFlightAlert).toHaveBeenCalledTimes(1);
        expect(playImpact).not.toHaveBeenCalled();
      },
    );

    it.each(["NUKE", "THERMONUCLEAR"] as const)(
      "coupe l'alerte sans explosion au nettoyage de manche, clear(false) ou arrêt du moteur (%s)",
      (weaponId) => {
        const { shooter } = setupFlatCombat();

        // 1. clear(false) direct (ex. annulation ou transition silencieuse)
        expect(
          engine.fireProjectile(
            shooter.tank.position,
            { angle: 45, power: 50, weaponId },
            shooter.id,
          ),
        ).toBe(true);
        stopFlightAlert.mockClear();
        engine.getPhysicsEngine().clear(false);
        expect(stopFlightAlert).toHaveBeenCalledTimes(1);
        expect(playImpact).not.toHaveBeenCalled();

        // 2. enterInterRoundPhase puis startNextRound
        engine.resetGame();
        const { shooter: shooter2 } = setupFlatCombat();
        expect(
          engine.fireProjectile(
            shooter2.tank.position,
            { angle: 45, power: 50, weaponId },
            shooter2.id,
          ),
        ).toBe(true);
        stopFlightAlert.mockClear();
        engine.enterInterRoundPhase();
        expect(stopFlightAlert).toHaveBeenCalled();
        expect(playImpact).not.toHaveBeenCalled();

        // 3. Fermeture du moteur en plein vol
        engine.resetGame();
        const { shooter: shooter3 } = setupFlatCombat();
        expect(
          engine.fireProjectile(
            shooter3.tank.position,
            { angle: 45, power: 50, weaponId },
            shooter3.id,
          ),
        ).toBe(true);
        dispose.mockClear();
        playImpact.mockClear();
        engine.stop();
        expect(dispose).toHaveBeenCalledOnce();
        expect(playImpact).not.toHaveBeenCalled();
      },
    );

    it("laisse un tir refusé silencieux et un tir sans contexte Web Audio se dérouler normalement", () => {
      const { shooter } = setupFlatCombat();

      // Tir refusé : arme inconnue
      expect(
        engine.fireProjectile(
          shooter.tank.position,
          { angle: 45, power: 50, weaponId: "UNKNOWN" as "NUKE" },
          shooter.id,
        ),
      ).toBe(false);
      expect(playFire).not.toHaveBeenCalled();

      // Tir refusé par observateur
      engine.combatObserver = { emit: () => false };
      expect(
        engine.fireProjectile(
          shooter.tank.position,
          { angle: 45, power: 50, weaponId: "NUKE" },
          shooter.id,
        ),
      ).toBe(false);
      expect(playFire).not.toHaveBeenCalled();
      engine.combatObserver = undefined;

      // Sans window.AudioContext, le tir nucléaire s'exécute et impacte normalement
      expect(
        engine.fireProjectile(
          shooter.tank.position,
          { angle: 45, power: 50, weaponId: "THERMONUCLEAR" },
          shooter.id,
        ),
      ).toBe(true);
      // Second tir refusé pendant qu'un tir est actif : silencieux
      expect(
        engine.fireProjectile(
          shooter.tank.position,
          { angle: 45, power: 50, weaponId: "NUKE" },
          shooter.id,
        ),
      ).toBe(false);
      expect(playFire).toHaveBeenCalledTimes(1);

      const shell = engine.getActiveProjectiles()[0];
      shell.x = 300;
      shell.y = 360;
      shell.vy = 20;
      const stepUpdate = getUpdateFn(engine);
      expect(() => stepUpdate.call(engine, 1 / 120)).not.toThrow();
      expect(engine.getActiveProjectiles()).toHaveLength(0);
      expect(playImpact).toHaveBeenCalledTimes(1);
    });

    it("en ligne, garde l'intention FIRE silencieuse et ne démarre l'alerte qu'au SHOT confirmé", () => {
      const { shooter } = setupFlatCombat();
      const sentIntents: unknown[] = [];
      const tm = engine.getTurnManager();
      tm.setLocalPlayerId(shooter.id);
      tm.setFireIntentHandler((command) => {
        sentIntents.push(command);
      });

      // Intention FIRE locale -> aucun tir ni alerte sonore
      expect(tm.selectWeapon("NUKE")).toBe(true);
      expect(tm.tryFire()).toBe(true);
      expect(sentIntents).toHaveLength(1);
      expect(playFire).not.toHaveBeenCalled();
      expect(engine.getActiveProjectiles()).toHaveLength(0);

      // Confirmation serveur SHOT -> une seule alerte
      tm.executeRemoteFire(
        { angle: 45, power: 50, weaponId: "NUKE" },
        {
          fromSlot: 0,
          ownerId: shooter.id,
          identity: { shotId: 1, isFirstShotOfRound: true },
          mode: "LIVE_LOCAL",
        },
      );
      expect(playFire).toHaveBeenCalledTimes(1);
      expect(playFire).toHaveBeenCalledWith("NUKE");
    });

    describe("suspension et reprise selon la visibilité de l'onglet", () => {
      function stubVisibilityEnvironment(initialState: DocumentVisibilityState = "visible") {
        let state: DocumentVisibilityState = initialState;
        const listeners = new Set<() => void>();
        const addEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
          if (type === "visibilitychange" && typeof listener === "function") {
            listeners.add(listener as () => void);
          }
        });
        const removeEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
          if (type === "visibilitychange" && typeof listener === "function") {
            listeners.delete(listener as () => void);
          }
        });
        vi.stubGlobal("document", {
          get visibilityState() {
            return state;
          },
          addEventListener,
          removeEventListener,
        });
        vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
        vi.stubGlobal("cancelAnimationFrame", vi.fn());
        return {
          setVisibility(next: DocumentVisibilityState) {
            state = next;
            for (const listener of [...listeners]) {
              listener();
            }
          },
          listenerCount: () => listeners.size,
          addEventListener,
          removeEventListener,
        };
      }

      it.each(["NUKE", "THERMONUCLEAR"] as const)(
        "suspend l'alerte de %s quand l'onglet est masqué et la reprend au retour si le projectile vole encore",
        (weaponId) => {
          const vis = stubVisibilityEnvironment("visible");
          const { shooter } = setupFlatCombat();
          engine.start();
          expect(vis.listenerCount()).toBe(1);

          expect(
            engine.fireProjectile(
              shooter.tank.position,
              { angle: 45, power: 50, weaponId },
              shooter.id,
            ),
          ).toBe(true);
          expect(playFire).toHaveBeenCalledTimes(1);
          stopFlightAlert.mockClear();
          resumeFlightAlert.mockClear();

          vis.setVisibility("hidden");
          expect(stopFlightAlert).toHaveBeenCalledTimes(1);
          expect(resumeFlightAlert).not.toHaveBeenCalled();

          // Retour tant que le projectile est toujours actif
          expect(engine.getActiveProjectiles()).toHaveLength(1);
          vis.setVisibility("visible");
          expect(resumeFlightAlert).toHaveBeenCalledTimes(1);
          expect(resumeFlightAlert).toHaveBeenCalledWith(weaponId, expect.any(Function));
          expect(playFire).toHaveBeenCalledTimes(1);

          // L'impact final coupe l'alerte reprise avant l'explosion
          const order: string[] = [];
          stopFlightAlert.mockImplementation(() => order.push("stop"));
          playImpact.mockImplementation(() => order.push("impact"));
          const shell = engine.getActiveProjectiles()[0]!;
          shell.x = 300;
          shell.y = 360;
          shell.vy = 20;
          getUpdateFn(engine).call(engine, 1 / 120);

          expect(order).toEqual(["stop", "impact"]);
          engine.stop();
          expect(vis.listenerCount()).toBe(0);
        },
      );

      it.each(["NUKE", "THERMONUCLEAR"] as const)(
        "ne crée aucune sirène en double lors de changements de visibilité répétés ou redondants (%s)",
        (weaponId) => {
          const vis = stubVisibilityEnvironment("visible");
          const { shooter } = setupFlatCombat();
          engine.start();

          engine.fireProjectile(
            shooter.tank.position,
            { angle: 45, power: 50, weaponId },
            shooter.id,
          );
          stopFlightAlert.mockClear();
          resumeFlightAlert.mockClear();

          vis.setVisibility("visible");
          expect(resumeFlightAlert).not.toHaveBeenCalled();

          vis.setVisibility("hidden");
          vis.setVisibility("hidden");
          expect(stopFlightAlert).toHaveBeenCalledTimes(1);

          vis.setVisibility("visible");
          vis.setVisibility("visible");
          expect(resumeFlightAlert).toHaveBeenCalledTimes(1);

          vis.setVisibility("hidden");
          vis.setVisibility("visible");
          expect(stopFlightAlert).toHaveBeenCalledTimes(2);
          expect(resumeFlightAlert).toHaveBeenCalledTimes(2);

          engine.stop();
        },
      );

      it.each(["NUKE", "THERMONUCLEAR"] as const)(
        "ne reprend pas l'alerte si le projectile est retiré pendant que l'onglet est masqué (%s)",
        (weaponId) => {
          const vis = stubVisibilityEnvironment("visible");
          const { shooter } = setupFlatCombat();
          engine.start();

          // 1. Sortie hors limites pendant hidden
          engine.fireProjectile(
            shooter.tank.position,
            { angle: 20, power: 100, weaponId },
            shooter.id,
          );
          vis.setVisibility("hidden");
          resumeFlightAlert.mockClear();

          const shell = engine.getActiveProjectiles()[0]!;
          shell.x = 5000;
          getUpdateFn(engine).call(engine, 1 / 120);
          expect(engine.getActiveProjectiles()).toHaveLength(0);

          vis.setVisibility("visible");
          expect(resumeFlightAlert).not.toHaveBeenCalled();

          // 2. clear(false) pendant hidden
          engine.resetGame();
          const { shooter: shooter2 } = setupFlatCombat();
          engine.fireProjectile(
            shooter2.tank.position,
            { angle: 45, power: 50, weaponId },
            shooter2.id,
          );
          vis.setVisibility("hidden");
          resumeFlightAlert.mockClear();
          engine.getPhysicsEngine().clear(false);
          vis.setVisibility("visible");
          expect(resumeFlightAlert).not.toHaveBeenCalled();

          // 3. Impact pendant hidden
          engine.resetGame();
          const { shooter: shooter3 } = setupFlatCombat();
          engine.fireProjectile(
            shooter3.tank.position,
            { angle: 45, power: 25, weaponId },
            shooter3.id,
          );
          vis.setVisibility("hidden");
          resumeFlightAlert.mockClear();
          const shell3 = engine.getActiveProjectiles()[0]!;
          shell3.x = 300;
          shell3.y = 360;
          shell3.vy = 20;
          getUpdateFn(engine).call(engine, 1 / 120);
          vis.setVisibility("visible");
          expect(resumeFlightAlert).not.toHaveBeenCalled();

          engine.stop();
        },
      );

      it.each(["NUKE", "THERMONUCLEAR"] as const)(
        "ne reprend pas l'alerte après fin de manche, fin de partie ou arrêt pendant hidden (%s)",
        (weaponId) => {
          const vis = stubVisibilityEnvironment("visible");

          const transitions: Array<() => void> = [
            () => engine.enterInterRoundPhase(),
            () => engine.syncRoundEndFromRemote([...engine.getTankManager().getPlayers()], "a", false),
            () => {
              engine.startNextRound();
            },
            () => engine.resetGame(),
            () => engine.declareMatchWinner(engine.getTankManager().getPlayers()[0]!),
            () => engine.declareMatchDraw(),
          ];

          for (const finish of transitions) {
            engine.resetGame();
            const { shooter } = setupFlatCombat();
            engine.fireProjectile(
              shooter.tank.position,
              { angle: 45, power: 50, weaponId },
              shooter.id,
            );
            engine.start();
            vis.setVisibility("hidden");
            resumeFlightAlert.mockClear();
            finish();
            vis.setVisibility("visible");
            expect(resumeFlightAlert).not.toHaveBeenCalled();
          }

          // Arrêt complet du moteur pendant hidden : retire aussi l'écouteur
          engine.resetGame();
          const { shooter: lastShooter } = setupFlatCombat();
          engine.fireProjectile(
            lastShooter.tank.position,
            { angle: 45, power: 50, weaponId },
            lastShooter.id,
          );
          engine.start();
          expect(vis.listenerCount()).toBe(1);
          vis.setVisibility("hidden");
          resumeFlightAlert.mockClear();
          engine.stop();
          expect(vis.listenerCount()).toBe(0);
          vis.setVisibility("visible");
          expect(resumeFlightAlert).not.toHaveBeenCalled();
        },
      );

      it("n'émet pas d'alerte en arrière-plan lors d'un tir déclenché onglet masqué, et gère associateActiveShotId et MISSILE", () => {
        const vis = stubVisibilityEnvironment("hidden");
        const { shooter } = setupFlatCombat();
        engine.start();

        // Tir NUKE alors que l'onglet est déjà masqué
        expect(
          engine.fireProjectile(
            shooter.tank.position,
            { angle: 45, power: 50, weaponId: "NUKE" },
            shooter.id,
            { shotId: 1, isFirstShotOfRound: true },
          ),
        ).toBe(true);
        expect(playFire).not.toHaveBeenCalled();
        expect(engine.associateActiveShotId(42, true)).toBe(true);

        resumeFlightAlert.mockClear();
        vis.setVisibility("visible");
        expect(resumeFlightAlert).toHaveBeenCalledTimes(1);
        expect(resumeFlightAlert).toHaveBeenCalledWith("NUKE", expect.any(Function));

        // Retrait puis tir MISSILE : aucune reprise sur changement de visibilité
        engine.resetGame();
        const { shooter: shooter2 } = setupFlatCombat();
        resumeFlightAlert.mockClear();
        expect(
          engine.fireProjectile(
            shooter2.tank.position,
            { angle: 45, power: 50, weaponId: "MISSILE" },
            shooter2.id,
            { shotId: 43, isFirstShotOfRound: false },
          ),
        ).toBe(true);
        vis.setVisibility("hidden");
        vis.setVisibility("visible");
        expect(resumeFlightAlert).not.toHaveBeenCalled();

        engine.stop();
      });
    });

    describe("intégration Web Audio : interruption du contexte et alignement impact/fondu", () => {
      function createWebAudioEngineHarness(initialVisibility: DocumentVisibilityState = "visible") {
        vi.restoreAllMocks();
        let visibilityState: DocumentVisibilityState = initialVisibility;
        const visibilityListeners = new Set<() => void>();
        const fakeAudio = {
          state: "running" as AudioContextState,
          currentTime: 0,
          onCreateBuffer: () => {},
          oscillators: [] as Array<{
            type: OscillatorType;
            start: ReturnType<typeof vi.fn>;
            stop: ReturnType<typeof vi.fn>;
            frequency: Record<string, unknown>;
            connect: ReturnType<typeof vi.fn>;
            addEventListener: ReturnType<typeof vi.fn>;
            removeEventListener: ReturnType<typeof vi.fn>;
          }>,
          gains: [] as Array<{
            gain: Record<string, unknown>;
            connect: ReturnType<typeof vi.fn>;
            disconnect: ReturnType<typeof vi.fn>;
          }>,
          bufferSources: [] as Array<{
            buffer: AudioBuffer | null;
            connect: ReturnType<typeof vi.fn>;
            start: ReturnType<typeof vi.fn>;
          }>,
          resumeResolvers: [] as Array<() => void>,
          setState(next: AudioContextState) {
            fakeAudio.state = next;
            for (const listener of [...stateListeners]) {
              listener();
            }
          },
          resolveNextResume(targetState: AudioContextState = "running") {
            const resolve = fakeAudio.resumeResolvers.shift();
            if (!resolve) throw new Error("Missing pending AudioContext.resume()");
            fakeAudio.setState(targetState);
            resolve();
          },
          resolveAllResumes(targetState: AudioContextState = "running") {
            while (fakeAudio.resumeResolvers.length > 0) {
              fakeAudio.resolveNextResume(targetState);
            }
          },
        };
        const stateListeners = new Set<() => void>();
        const makeParam = () => ({
          value: 0,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
          cancelScheduledValues: vi.fn(),
          cancelAndHoldAtTime: vi.fn(),
        });
        const resumeMock = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              fakeAudio.resumeResolvers.push(resolve);
            }),
        );
        const FakeAudioContext = vi.fn(function MockAudioContext() {
          return {
            get state() {
              return fakeAudio.state;
            },
            get currentTime() {
              return fakeAudio.currentTime;
            },
            sampleRate: 48_000,
            destination: {},
            addEventListener: vi.fn((type: string, cb: () => void) => {
              if (type === "statechange") stateListeners.add(cb);
            }),
            removeEventListener: vi.fn((type: string, cb: () => void) => {
              if (type === "statechange") stateListeners.delete(cb);
            }),
            resume: resumeMock,
            close: vi.fn(() => {
              fakeAudio.state = "closed";
              return Promise.resolve();
            }),
            createOscillator: vi.fn(() => {
              const osc = {
                type: "sine" as OscillatorType,
                start: vi.fn(),
                stop: vi.fn(),
                frequency: makeParam(),
                connect: vi.fn(),
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
              };
              fakeAudio.oscillators.push(osc);
              return osc;
            }),
            createGain: vi.fn(() => {
              const gainNode = {
                gain: makeParam(),
                connect: vi.fn(),
                disconnect: vi.fn(),
              };
              fakeAudio.gains.push(gainNode);
              return gainNode;
            }),
            createBiquadFilter: vi.fn(() => ({
              type: "lowpass",
              frequency: makeParam(),
              connect: vi.fn(),
            })),
            createBuffer: vi.fn((_c: number, length: number) => {
              fakeAudio.onCreateBuffer();
              return { getChannelData: () => new Float32Array(length) };
            }),
            createBufferSource: vi.fn(() => {
              const src = {
                buffer: null,
                connect: vi.fn(),
                start: vi.fn(),
              };
              fakeAudio.bufferSources.push(src);
              return src;
            }),
          };
        });

        vi.stubGlobal("window", {
          AudioContext: FakeAudioContext,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        });
        vi.stubGlobal("document", {
          get visibilityState() {
            return visibilityState;
          },
          addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
            if (type === "visibilitychange" && typeof listener === "function") {
              visibilityListeners.add(listener as () => void);
            }
          }),
          removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
            if (type === "visibilitychange" && typeof listener === "function") {
              visibilityListeners.delete(listener as () => void);
            }
          }),
        });
        vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
        vi.stubGlobal("cancelAnimationFrame", vi.fn());

        const integratedEngine = new GameEngine(800, 480, { headless: true });
        const players = [
          makePlayer({
            id: "a",
            name: "Alice",
            inventory: { NUKE: 2, THERMONUCLEAR: 2 },
            tank: makeTank("tank-a", 120, 360),
          }),
          makePlayer({
            id: "b",
            name: "Bob",
            inventory: { NUKE: 2, THERMONUCLEAR: 2 },
            tank: makeTank("tank-b", 680, 360),
          }),
        ];
        integratedEngine.setPlayers(players);
        integratedEngine.setWindForce(0);
        integratedEngine
          .getTerrain()
          .loadHeights(
            new Array<number>(800).fill(360),
            new Array<TerrainMaterial>(800).fill(TERRAIN_MATERIAL.DIRT),
          );
        const shooter = integratedEngine.getTankManager().getPlayerById("a")!;
        shooter.tank.position = { x: 120, y: 360 };
        integratedEngine.getTankManager().getPlayerById("b")!.tank.position = { x: 680, y: 360 };

        return {
          integratedEngine,
          shooter,
          fakeAudio,
          resumeMock,
          setVisibility(next: DocumentVisibilityState) {
            visibilityState = next;
            for (const listener of [...visibilityListeners]) {
              listener();
            }
          },
        };
      }

      it.each(["NUKE", "THERMONUCLEAR"] as const)(
        "neutralise l'ancienne sirène et attend la reprise effective du contexte audio au retour à l'onglet (%s)",
        async (weaponId) => {
          const harness = createWebAudioEngineHarness("visible");
          const { integratedEngine, shooter, fakeAudio, resumeMock } = harness;
          integratedEngine.start();

          expect(
            integratedEngine.fireProjectile(
              shooter.tank.position,
              { angle: 45, power: 50, weaponId },
              shooter.id,
            ),
          ).toBe(true);
          const initialStopGain = fakeAudio.gains.at(-1)!;
          const initialOscs = [...fakeAudio.oscillators];

          // Passage en arrière-plan et suspension du contexte à t = 2,000 s
          fakeAudio.currentTime = 2;
          fakeAudio.setState("suspended");
          harness.setVisibility("hidden");

          expect(initialStopGain.disconnect).toHaveBeenCalledOnce();
          expect(initialStopGain.gain.value).toBe(0);
          for (const osc of initialOscs) {
            expect(osc.stop).toHaveBeenCalledExactlyOnceWith(2);
          }

          // Retour à l'onglet : appelle resume(), reste muet jusqu'à résolution en running
          harness.setVisibility("visible");
          expect(resumeMock).toHaveBeenCalledOnce();
          expect(fakeAudio.oscillators).toHaveLength(initialOscs.length);

          fakeAudio.resolveNextResume("running");
          await Promise.resolve();
          await Promise.resolve();

          const resumedOscs = fakeAudio.oscillators.slice(initialOscs.length);
          expect(resumedOscs.length).toBeGreaterThanOrEqual(3);
          for (const osc of resumedOscs) {
            expect(osc.start).toHaveBeenCalledExactlyOnceWith(2);
          }

          integratedEngine.stop();
        },
      );

      it.each(["NUKE", "THERMONUCLEAR"] as const)(
        "gère les bascules rapides de visibilité et la disparition du projectile pendant AudioContext.resume() (%s)",
        async (weaponId) => {
          // 1. Bascule rapide visible -> hidden avant résolution de resume() : aucune sirène en arrière-plan
          const harnessA = createWebAudioEngineHarness("visible");
          harnessA.integratedEngine.start();
          harnessA.integratedEngine.fireProjectile(
            harnessA.shooter.tank.position,
            { angle: 45, power: 50, weaponId },
            harnessA.shooter.id,
          );
          const oscCountAfterFireA = harnessA.fakeAudio.oscillators.length;
          harnessA.fakeAudio.currentTime = 2;
          harnessA.fakeAudio.setState("suspended");
          harnessA.setVisibility("hidden");
          harnessA.setVisibility("visible");
          harnessA.setVisibility("hidden");

          harnessA.fakeAudio.resolveAllResumes("running");
          await Promise.resolve();
          await Promise.resolve();
          expect(harnessA.fakeAudio.oscillators).toHaveLength(oscCountAfterFireA);

          // Puis second retour visible tandis que le projectile vole encore : une seule sirène créée
          harnessA.setVisibility("visible");
          harnessA.fakeAudio.resolveAllResumes("running");
          await Promise.resolve();
          await Promise.resolve();
          expect(harnessA.fakeAudio.oscillators.length).toBeGreaterThan(oscCountAfterFireA);
          const expectedAlertOscCount =
            harnessA.fakeAudio.oscillators.length - oscCountAfterFireA;
          harnessA.integratedEngine.stop();

          // 2. Bascule hidden -> visible -> hidden -> visible avant toute résolution : pas de doublon
          const harnessB = createWebAudioEngineHarness("visible");
          harnessB.integratedEngine.start();
          harnessB.integratedEngine.fireProjectile(
            harnessB.shooter.tank.position,
            { angle: 45, power: 50, weaponId },
            harnessB.shooter.id,
          );
          const oscCountAfterFireB = harnessB.fakeAudio.oscillators.length;
          harnessB.fakeAudio.currentTime = 2;
          harnessB.fakeAudio.setState("suspended");
          harnessB.setVisibility("hidden");
          harnessB.setVisibility("visible");
          harnessB.setVisibility("hidden");
          harnessB.setVisibility("visible");

          harnessB.fakeAudio.resolveAllResumes("running");
          await Promise.resolve();
          await Promise.resolve();
          expect(harnessB.fakeAudio.oscillators).toHaveLength(
            oscCountAfterFireB + expectedAlertOscCount,
          );
          harnessB.integratedEngine.stop();

          // 3. Impact terrain pendant que resume() est en attente : aucune sirène relancée après déblocage
          const harnessC = createWebAudioEngineHarness("visible");
          harnessC.integratedEngine.start();
          harnessC.integratedEngine.fireProjectile(
            harnessC.shooter.tank.position,
            { angle: 45, power: 25, weaponId },
            harnessC.shooter.id,
          );
          harnessC.fakeAudio.currentTime = 2;
          harnessC.fakeAudio.setState("suspended");
          harnessC.setVisibility("hidden");
          harnessC.setVisibility("visible");

          const shellC = harnessC.integratedEngine.getActiveProjectiles()[0]!;
          shellC.x = 300;
          shellC.y = 360;
          shellC.vy = 20;
          getUpdateFn(harnessC.integratedEngine).call(harnessC.integratedEngine, 1 / 120);
          expect(harnessC.integratedEngine.getActiveProjectiles()).toHaveLength(0);
          const oscCountAfterImpactC = harnessC.fakeAudio.oscillators.length;

          harnessC.fakeAudio.resolveAllResumes("running");
          await Promise.resolve();
          await Promise.resolve();
          expect(harnessC.fakeAudio.oscillators).toHaveLength(oscCountAfterImpactC);
          harnessC.integratedEngine.stop();

          // 4. Sortie hors limites pendant que resume() est en attente : aucune sirène relancée
          const harnessD = createWebAudioEngineHarness("visible");
          harnessD.integratedEngine.start();
          harnessD.integratedEngine.fireProjectile(
            harnessD.shooter.tank.position,
            { angle: 20, power: 100, weaponId },
            harnessD.shooter.id,
          );
          harnessD.fakeAudio.currentTime = 2;
          harnessD.fakeAudio.setState("suspended");
          harnessD.setVisibility("hidden");
          harnessD.setVisibility("visible");

          const shellD = harnessD.integratedEngine.getActiveProjectiles()[0]!;
          shellD.x = 5000;
          getUpdateFn(harnessD.integratedEngine).call(harnessD.integratedEngine, 1 / 120);
          expect(harnessD.integratedEngine.getActiveProjectiles()).toHaveLength(0);
          const oscCountAfterOobD = harnessD.fakeAudio.oscillators.length;

          harnessD.fakeAudio.resolveAllResumes("running");
          await Promise.resolve();
          await Promise.resolve();
          expect(harnessD.fakeAudio.oscillators).toHaveLength(oscCountAfterOobD);
          harnessD.integratedEngine.stop();
        },
      );

      it.each([
        { weaponId: "NUKE", scenario: "active", startTime: 2.025 },
        { weaponId: "THERMONUCLEAR", scenario: "active", startTime: 2.025 },
        { weaponId: "NUKE", scenario: "hidden", startTime: 2 + 0.01 },
        { weaponId: "THERMONUCLEAR", scenario: "hidden", startTime: 2 + 0.01 },
        { weaponId: "NUKE", scenario: "fin du fondu pendant l'impact", startTime: 2.004 + 0.01 },
        { weaponId: "THERMONUCLEAR", scenario: "fin du fondu pendant l'impact", startTime: 2.004 + 0.01 },
        { weaponId: "NUKE", scenario: "fin du fondu pendant la préparation audio", startTime: 2.028 + 0.01 },
        { weaponId: "THERMONUCLEAR", scenario: "fin du fondu pendant la préparation audio", startTime: 2.028 + 0.01 },
      ] as const)(
        "synchronise la destruction d'un tank et la détonation ($weaponId, $scenario)",
        ({ weaponId, scenario, startTime }) => {
          const visibility = scenario === "hidden" ? "hidden" : "visible";
          const { integratedEngine, shooter, fakeAudio, setVisibility } = createWebAudioEngineHarness(visibility);
          integratedEngine.start();
          try {
            expect(integratedEngine.fireProjectile(
              shooter.tank.position,
              { angle: 45, power: 25, weaponId },
              shooter.id,
            )).toBe(true);
            const tanks = integratedEngine.getTankManager();
            const target = tanks.getPlayerById("b")!;
            const shell = integratedEngine.getActiveProjectiles()[0]!;
            shell.x = target.tank.position.x;
            shell.y = target.tank.position.y - 5;
            shell.vx = 0;
            shell.vy = 0;
            if (scenario === "fin du fondu pendant l'impact") {
              fakeAudio.currentTime = 1.976;
              setVisibility("hidden");
              const checkTankBurial = tanks.checkTankBurial.bind(tanks);
              vi.spyOn(tanks, "checkTankBurial").mockImplementation((terrain) => {
                expect(target.tank.isDead).toBe(true);
                fakeAudio.currentTime = 2.004;
                checkTankBurial(terrain);
              });
            }
            fakeAudio.currentTime = 2;
            if (scenario === "fin du fondu pendant l'impact") setVisibility("visible");
            const oscillatorsBeforeImpact = fakeAudio.oscillators.length;
            const buffersBeforeImpact = fakeAudio.bufferSources.length;
            if (scenario === "fin du fondu pendant la préparation audio") {
              fakeAudio.onCreateBuffer = () => {
                for (const node of fakeAudio.oscillators.slice(oscillatorsBeforeImpact)) {
                  expect(node.start).not.toHaveBeenCalled();
                }
                for (const node of fakeAudio.bufferSources.slice(buffersBeforeImpact)) {
                  expect(node.start).not.toHaveBeenCalled();
                }
                fakeAudio.currentTime = 2.028;
              };
            }

            getUpdateFn(integratedEngine).call(integratedEngine, 1 / 120);

            expect(target.tank.isDead).toBe(true);
            expect(integratedEngine.getActiveProjectiles()).toHaveLength(0);
            const weaponOscillatorOffsets = weaponId === "NUKE" ? [0, 0] : [0, 0.1];
            const weaponNoiseOffsets = weaponId === "NUKE" ? [0, 0.16] : [0, 0.22, 0.52];
            expect(fakeAudio.oscillators.slice(oscillatorsBeforeImpact)
              .map((oscillator) => oscillator.start.mock.calls[0]?.[0]))
              .toEqual([0, ...weaponOscillatorOffsets].map((offset) => startTime + offset));
            expect(fakeAudio.bufferSources.slice(buffersBeforeImpact)
              .map((source) => source.start.mock.calls[0]?.[0]))
              .toEqual([0, ...weaponNoiseOffsets].map((offset) => startTime + offset));
          } finally {
            integratedEngine.stop();
          }
        },
      );

      it.each([
        {
          weaponId: "NUKE" as const,
          expectedNoiseOffsets: [0, 0.16],
          expectedOscOffsets: [0, 0],
        },
        {
          weaponId: "THERMONUCLEAR" as const,
          expectedNoiseOffsets: [0, 0.22, 0.52],
          expectedOscOffsets: [0, 0.1],
        },
      ])(
        "décale la détonation à 2,025 s si une sirène est active à l'impact, ou 2,000 s sans sirène, sans retarder la physique (%s)",
        ({ weaponId, expectedNoiseOffsets, expectedOscOffsets }) => {
          // Cas 1 : sirène active à l'impact à t = 2,000 s
          const withAlert = createWebAudioEngineHarness("visible");
          withAlert.integratedEngine.start();
          withAlert.integratedEngine.fireProjectile(
            withAlert.shooter.tank.position,
            { angle: 45, power: 25, weaponId },
            withAlert.shooter.id,
          );
          withAlert.fakeAudio.currentTime = 2;
          const oscBeforeImpact = withAlert.fakeAudio.oscillators.length;
          const srcBeforeImpact = withAlert.fakeAudio.bufferSources.length;

          const shellA = withAlert.integratedEngine.getActiveProjectiles()[0]!;
          shellA.x = 300;
          shellA.y = 360;
          shellA.vy = 20;
          getUpdateFn(withAlert.integratedEngine).call(withAlert.integratedEngine, 1 / 120);

          // La physique retire le projectile immédiatement sans attendre la fin du fondu audio
          expect(withAlert.integratedEngine.getActiveProjectiles()).toHaveLength(0);
          expect(
            withAlert.fakeAudio.oscillators
              .slice(oscBeforeImpact)
              .map((osc) => osc.start.mock.calls[0]?.[0]),
          ).toEqual(expectedOscOffsets.map((offset) => 2.025 + offset));
          expect(
            withAlert.fakeAudio.bufferSources
              .slice(srcBeforeImpact)
              .map((src) => src.start.mock.calls[0]?.[0]),
          ).toEqual(expectedNoiseOffsets.map((offset) => 2.025 + offset));
          withAlert.integratedEngine.stop();

          // Cas 2 : tir déclenché onglet masqué (aucune sirène active) puis impact à t = 2,000 s
          const withoutAlert = createWebAudioEngineHarness("hidden");
          withoutAlert.integratedEngine.start();
          withoutAlert.integratedEngine.fireProjectile(
            withoutAlert.shooter.tank.position,
            { angle: 45, power: 25, weaponId },
            withoutAlert.shooter.id,
          );
          withoutAlert.fakeAudio.currentTime = 2;
          const oscBeforeNoAlert = withoutAlert.fakeAudio.oscillators.length;
          const srcBeforeNoAlert = withoutAlert.fakeAudio.bufferSources.length;

          const shellB = withoutAlert.integratedEngine.getActiveProjectiles()[0]!;
          shellB.x = 300;
          shellB.y = 360;
          shellB.vy = 20;
          getUpdateFn(withoutAlert.integratedEngine).call(withoutAlert.integratedEngine, 1 / 120);

          expect(withoutAlert.integratedEngine.getActiveProjectiles()).toHaveLength(0);
          expect(
            withoutAlert.fakeAudio.oscillators
              .slice(oscBeforeNoAlert)
              .map((osc) => osc.start.mock.calls[0]?.[0]),
          ).toEqual(expectedOscOffsets.map((offset) => 2 + offset));
          expect(
            withoutAlert.fakeAudio.bufferSources
              .slice(srcBeforeNoAlert)
              .map((src) => src.start.mock.calls[0]?.[0]),
          ).toEqual(expectedNoiseOffsets.map((offset) => 2 + offset));
          withoutAlert.integratedEngine.stop();
        },
      );

      it.each(["NUKE", "THERMONUCLEAR"] as const)(
        "attend la fin du fondu sur retour rapide (contexte toujours running) et revalide visibilité et projectile (%s)",
        (weaponId) => {
          vi.useFakeTimers();

          // 1. Retour rapide 3,000 s -> 3,010 s : pas de doublon ni chevauchement, reprise à >= 3,030 s
          const harnessA = createWebAudioEngineHarness("visible");
          harnessA.integratedEngine.start();
          expect(
            harnessA.integratedEngine.fireProjectile(
              harnessA.shooter.tank.position,
              { angle: 45, power: 50, weaponId },
              harnessA.shooter.id,
            ),
          ).toBe(true);
          const countAfterFireA = harnessA.fakeAudio.oscillators.length;

          harnessA.fakeAudio.currentTime = 3;
          harnessA.setVisibility("hidden");
          harnessA.fakeAudio.currentTime = 3.01;
          harnessA.setVisibility("visible");

          expect(harnessA.resumeMock).not.toHaveBeenCalled();
          expect(harnessA.fakeAudio.oscillators).toHaveLength(countAfterFireA);

          vi.advanceTimersByTime(19);
          expect(harnessA.fakeAudio.oscillators).toHaveLength(countAfterFireA);

          harnessA.fakeAudio.currentTime = 3.03;
          vi.advanceTimersByTime(1);
          const resumedOscs = harnessA.fakeAudio.oscillators.slice(countAfterFireA);
          expect(resumedOscs.length).toBeGreaterThanOrEqual(3);
          for (const osc of resumedOscs) {
            expect(osc.start).toHaveBeenCalledExactlyOnceWith(3.03);
          }
          harnessA.integratedEngine.stop();

          // 2. Bascule rapide hidden (3,000) -> visible (3,010) -> hidden (3,015) sur contexte running :
          // annule la reprise et conserve le suivi du premier fondu
          const harnessB = createWebAudioEngineHarness("visible");
          harnessB.integratedEngine.start();
          harnessB.integratedEngine.fireProjectile(
            harnessB.shooter.tank.position,
            { angle: 45, power: 50, weaponId },
            harnessB.shooter.id,
          );
          const firstStopGainB = harnessB.fakeAudio.gains.at(-1)!;
          const countAfterFireB = harnessB.fakeAudio.oscillators.length;

          harnessB.fakeAudio.currentTime = 3;
          harnessB.setVisibility("hidden");
          harnessB.fakeAudio.currentTime = 3.01;
          harnessB.setVisibility("visible");
          harnessB.fakeAudio.currentTime = 3.015;
          harnessB.setVisibility("hidden");

          harnessB.fakeAudio.currentTime = 3.018;
          harnessB.fakeAudio.setState("suspended");
          expect(firstStopGainB.disconnect).toHaveBeenCalledOnce();
          expect(firstStopGainB.gain.value).toBe(0);

          vi.advanceTimersByTime(60);
          expect(harnessB.fakeAudio.oscillators).toHaveLength(countAfterFireB);
          harnessB.integratedEngine.stop();

          // 3. Impact pendant l'attente à 3,015 s : pas de reprise tardive, détonation à 3,025 s
          const harnessC = createWebAudioEngineHarness("visible");
          harnessC.integratedEngine.start();
          harnessC.integratedEngine.fireProjectile(
            harnessC.shooter.tank.position,
            { angle: 45, power: 25, weaponId },
            harnessC.shooter.id,
          );
          const countAfterFireC = harnessC.fakeAudio.oscillators.length;
          const srcAfterFireC = harnessC.fakeAudio.bufferSources.length;

          harnessC.fakeAudio.currentTime = 3;
          harnessC.setVisibility("hidden");
          harnessC.fakeAudio.currentTime = 3.01;
          harnessC.setVisibility("visible");

          harnessC.fakeAudio.currentTime = 3.015;
          const shellC = harnessC.integratedEngine.getActiveProjectiles()[0]!;
          shellC.x = 300;
          shellC.y = 360;
          shellC.vy = 20;
          getUpdateFn(harnessC.integratedEngine).call(harnessC.integratedEngine, 1 / 120);

          expect(harnessC.integratedEngine.getActiveProjectiles()).toHaveLength(0);
          const countAtImpactC = harnessC.fakeAudio.oscillators.length;
          expect(
            harnessC.fakeAudio.oscillators
              .slice(countAfterFireC)
              .map((o) => o.start.mock.calls[0]?.[0]),
          ).toEqual(weaponId === "NUKE" ? [3.025, 3.025] : [3.025, 3.125]);
          expect(
            harnessC.fakeAudio.bufferSources
              .slice(srcAfterFireC)
              .map((s) => s.start.mock.calls[0]?.[0]),
          ).toEqual(weaponId === "NUKE" ? [3.025, 3.185] : [3.025, 3.245, 3.545]);

          harnessC.fakeAudio.currentTime = 3.04;
          vi.advanceTimersByTime(60);
          expect(harnessC.fakeAudio.oscillators).toHaveLength(countAtImpactC);
          harnessC.integratedEngine.stop();

          // 4. Sortie hors limites, transition de manche et stop() pendant l'attente : zéro reprise tardive
          const removals: Array<(harness: ReturnType<typeof createWebAudioEngineHarness>) => void> = [
            (h) => {
              const shell = h.integratedEngine.getActiveProjectiles()[0]!;
              shell.x = 5000;
              getUpdateFn(h.integratedEngine).call(h.integratedEngine, 1 / 120);
            },
            (h) => h.integratedEngine.enterInterRoundPhase(),
            (h) => h.integratedEngine.stop(),
          ];
          for (const removeProjectile of removals) {
            const harnessR = createWebAudioEngineHarness("visible");
            harnessR.integratedEngine.start();
            harnessR.integratedEngine.fireProjectile(
              harnessR.shooter.tank.position,
              { angle: 45, power: 50, weaponId },
              harnessR.shooter.id,
            );
            const countAfterFireR = harnessR.fakeAudio.oscillators.length;
            harnessR.fakeAudio.currentTime = 3;
            harnessR.setVisibility("hidden");
            harnessR.fakeAudio.currentTime = 3.01;
            harnessR.setVisibility("visible");
            harnessR.fakeAudio.currentTime = 3.015;
            removeProjectile(harnessR);

            harnessR.fakeAudio.currentTime = 3.05;
            vi.advanceTimersByTime(60);
            expect(harnessR.fakeAudio.oscillators).toHaveLength(countAfterFireR);
            harnessR.integratedEngine.stop();
          }
        },
      );
    });
  });
});
