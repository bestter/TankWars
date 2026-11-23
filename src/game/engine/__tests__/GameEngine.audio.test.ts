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
        expect(playImpact).toHaveBeenCalledWith(weaponId);
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
          expect(resumeFlightAlert).toHaveBeenCalledWith(weaponId);
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
          const stepUpdate = getUpdateFn(engine);

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
            void stepUpdate;
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
        expect(resumeFlightAlert).toHaveBeenCalledWith("NUKE");

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
  });
});
