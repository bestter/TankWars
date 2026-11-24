import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_WEAPON_IDS } from "../../../../types/weapon";
import * as random from "../../../../utils/random";
import { CombatAudio, defaultAudioContext } from "../CombatAudio";

interface FakeOscillator {
  type: OscillatorType;
  stop: ReturnType<typeof vi.fn>;
  frequency: AudioParam;
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  addEventListener?: ReturnType<typeof vi.fn>;
  removeEventListener?: ReturnType<typeof vi.fn>;
  emitEnded?: () => void;
}

interface FakeGainNode {
  gain: AudioParam;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface FakeBufferSource {
  buffer: AudioBuffer | null;
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

interface FakeContext {
  context: AudioContext;
  oscillators: FakeOscillator[];
  gains: FakeGainNode[];
  bufferSources: FakeBufferSource[];
  close: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  buffers: number;
  setState: (next: AudioContextState) => void;
  setCurrentTime: (next: number) => void;
}

function audioParam(options?: { withCancelAndHold?: boolean }): AudioParam {
  const param: Record<string, unknown> = {
    value: 0,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
    setTargetAtTime: vi.fn(),
    setValueCurveAtTime: vi.fn(),
    defaultValue: 0,
    automationRate: "a-rate",
    minValue: 0,
    maxValue: 1,
  };
  if (options?.withCancelAndHold ?? true) {
    param.cancelAndHoldAtTime = vi.fn();
  }
  return param as unknown as AudioParam;
}

function createFakeContext(options?: {
  createBufferThrows?: boolean;
  closeRejects?: boolean;
  state?: AudioContextState;
  currentTime?: number;
  withCancelAndHold?: boolean;
  withEventTarget?: boolean;
  resumeImplementation?: (fake: FakeContext) => Promise<void>;
}): FakeContext {
  const oscillators: FakeOscillator[] = [];
  const gains: FakeGainNode[] = [];
  const bufferSources: FakeBufferSource[] = [];
  const buffers = { count: 0 };
  const contextStateListeners = new Set<() => void>();
  const close = vi.fn(() => (
    options?.closeRejects ? Promise.reject(new Error("close")) : Promise.resolve()
  ));
  const paramOptions = { withCancelAndHold: options?.withCancelAndHold ?? true };
  const contextObj: Record<string, unknown> = {
    state: options?.state ?? "running",
    sampleRate: 44_100,
    currentTime: options?.currentTime ?? 0,
    destination: {},
    createOscillator: vi.fn(() => {
      const endedListeners = new Set<() => void>();
      const oscillator: FakeOscillator = {
        type: "sine",
        stop: vi.fn(),
        frequency: audioParam(paramOptions),
        connect: vi.fn(),
        start: vi.fn(),
      };
      if (options?.withEventTarget) {
        oscillator.addEventListener = vi.fn((type: string, cb: () => void) => {
          if (type === "ended") endedListeners.add(cb);
        });
        oscillator.removeEventListener = vi.fn((type: string, cb: () => void) => {
          if (type === "ended") endedListeners.delete(cb);
        });
        oscillator.emitEnded = () => {
          for (const cb of [...endedListeners]) {
            endedListeners.delete(cb);
            cb();
          }
        };
      }
      oscillators.push(oscillator);
      return oscillator;
    }),
    createGain: vi.fn(() => {
      const gainNode: FakeGainNode = {
        gain: audioParam(paramOptions),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(gainNode);
      return gainNode;
    }),
    createBiquadFilter: vi.fn(() => ({
      type: "lowpass",
      frequency: audioParam(paramOptions),
      connect: vi.fn(),
    })),
    createStereoPanner: vi.fn(() => ({ pan: audioParam(paramOptions), connect: vi.fn() })),
    createBuffer: vi.fn((_channels: number, length: number) => {
      if (options?.createBufferThrows) throw new Error("buffer");
      buffers.count += 1;
      return { getChannelData: () => new Float32Array(length) };
    }),
    createBufferSource: vi.fn(() => {
      const source: FakeBufferSource = {
        buffer: null,
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      bufferSources.push(source);
      return source;
    }),
    close,
  };
  if (options?.withEventTarget) {
    contextObj.addEventListener = vi.fn((type: string, cb: () => void) => {
      if (type === "statechange") contextStateListeners.add(cb);
    });
    contextObj.removeEventListener = vi.fn((type: string, cb: () => void) => {
      if (type === "statechange") contextStateListeners.delete(cb);
    });
  }
  const resume = vi.fn(() =>
    options?.resumeImplementation ? options.resumeImplementation(fakeContext) : Promise.resolve(),
  );
  contextObj.resume = resume;
  const fakeContext: FakeContext = {
    context: contextObj as unknown as AudioContext,
    oscillators,
    gains,
    bufferSources,
    close,
    resume,
    get buffers() {
      return buffers.count;
    },
    setState(next: AudioContextState) {
      contextObj.state = next;
      for (const cb of [...contextStateListeners]) {
        cb();
      }
    },
    setCurrentTime(next: number) {
      contextObj.currentTime = next;
    },
  };
  return fakeContext;
}

function createAudio(
  createContext: () => AudioContext | null,
  now: () => number = () => 0,
): CombatAudio {
  return new CombatAudio({ getWidth: () => 200, createContext, now });
}

describe("CombatAudio", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("ne crée pas de contexte avant le premier son, puis le réutilise", () => {
    const fake = createFakeContext();
    const factory = vi.fn(() => fake.context);
    const audio = createAudio(factory);

    expect(factory).not.toHaveBeenCalled();
    audio.playFire("BULLET");
    audio.playImpact("GRENADE");
    audio.playZeusAppointment();

    expect(factory).toHaveBeenCalledOnce();
  });

  it("réessaie la fabrique au son suivant si elle retourne null ou lève", () => {
    const ready = createFakeContext();
    const factory = vi.fn()
      .mockReturnValueOnce(null)
      .mockImplementationOnce(() => {
        throw new Error("audio");
      })
      .mockReturnValue(ready.context);
    const audio = createAudio(factory);

    expect(() => audio.playFire("MISSILE")).not.toThrow();
    expect(() => audio.playImpact("GRENADE")).not.toThrow();
    expect(factory).toHaveBeenCalledTimes(2);

    expect(() => audio.playZeusStrike()).not.toThrow();
    expect(factory).toHaveBeenCalledTimes(3);
    audio.playZeusAppointment();
    expect(factory).toHaveBeenCalledTimes(3);
    expect(ready.oscillators.length).toBeGreaterThan(0);
  });

  it("aucune méthode publique ne lève quand la fabrique échoue", () => {
    const audio = createAudio(() => {
      throw new Error("audio");
    });

    expect(() => {
      for (const weaponId of ALL_WEAPON_IDS) {
        audio.playFire(weaponId);
        audio.playImpact(weaponId);
      }
      audio.playZeusAppointment();
      audio.playZeusStrike();
      audio.playTankDestroyedByExplosion();
      audio.playTankSadBurial();
      audio.playTankSliding("tank");
      audio.playTankTouchLowestFloor();
      audio.playVictoryFanfare();
      audio.stopVictoryMusic();
      audio.playFireworkPop(0);
      audio.resetSlideThrottle();
      audio.dispose();
    }).not.toThrow();
  });

  it("joue l'oscillateur du tir MISSILE même si le bruit échoue", () => {
    const fake = createFakeContext({ createBufferThrows: true });
    const audio = createAudio(() => fake.context);

    expect(() => audio.playFire("MISSILE")).not.toThrow();
    expect(fake.oscillators).toHaveLength(1);
    expect(fake.oscillators[0]?.type).toBe("triangle");
  });

  it("avale l'erreur de stop et ne rappelle pas les oscillateurs déjà arrêtés", () => {
    vi.useFakeTimers();
    const fake = createFakeContext();
    const audio = createAudio(() => fake.context);
    audio.playVictoryFanfare();

    expect(fake.oscillators).toHaveLength(7);
    fake.oscillators[0]?.stop.mockImplementation(() => {
      throw new Error("Invalid state");
    });

    expect(() => audio.stopVictoryMusic()).not.toThrow();
    for (const oscillator of fake.oscillators) {
      expect(oscillator.stop).toHaveBeenCalledTimes(2);
    }

    expect(() => audio.stopVictoryMusic()).not.toThrow();
    for (const oscillator of fake.oscillators) {
      expect(oscillator.stop).toHaveBeenCalledTimes(2);
    }
  });

  it("ferme le contexte une seule fois, avale le rejet et en recrée un après dispose", async () => {
    const first = createFakeContext({ closeRejects: true });
    const second = createFakeContext();
    const factory = vi.fn()
      .mockReturnValueOnce(first.context)
      .mockReturnValueOnce(second.context);
    const audio = createAudio(factory);

    audio.playFire("BULLET");
    audio.dispose();
    await Promise.resolve();
    expect(first.close).toHaveBeenCalledOnce();

    audio.dispose();
    expect(first.close).toHaveBeenCalledOnce();

    audio.playImpact("BULLET");
    expect(factory).toHaveBeenCalledTimes(2);
    expect(second.oscillators.length).toBeGreaterThan(0);
  });

  it("joue l'accord final à 1,1 s sur le même contexte", () => {
    vi.useFakeTimers();
    const fake = createFakeContext();
    const factory = vi.fn(() => fake.context);
    const audio = createAudio(factory);

    audio.playVictoryFanfare();
    expect(fake.oscillators).toHaveLength(7);
    expect(factory).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1100);
    expect(factory).toHaveBeenCalledOnce();
    expect(fake.oscillators).toHaveLength(11);
  });

  it("n'ouvre pas de contexte pour l'accord après dispose", () => {
    vi.useFakeTimers();
    const fake = createFakeContext();
    const factory = vi.fn(() => fake.context);
    const audio = createAudio(factory);

    audio.playVictoryFanfare();
    audio.dispose();
    vi.advanceTimersByTime(1100);

    expect(factory).toHaveBeenCalledOnce();
    expect(fake.oscillators).toHaveLength(7);
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("annule l'accord sans fermer le contexte", () => {
    vi.useFakeTimers();
    const fake = createFakeContext();
    const factory = vi.fn(() => fake.context);
    const audio = createAudio(factory);

    audio.playVictoryFanfare();
    audio.stopVictoryMusic();
    vi.advanceTimersByTime(1100);

    expect(fake.oscillators).toHaveLength(7);
    expect(fake.close).not.toHaveBeenCalled();

    audio.playFire("BULLET");
    expect(factory).toHaveBeenCalledOnce();
  });

  it("arrête les oscillateurs de l'accord final si stopVictoryMusic est appelé après 1,1 s", () => {
    vi.useFakeTimers();
    const fake = createFakeContext();
    const audio = createAudio(() => fake.context);

    audio.playVictoryFanfare();
    vi.advanceTimersByTime(1100);
    expect(fake.oscillators).toHaveLength(11);

    audio.stopVictoryMusic();
    for (const oscillator of fake.oscillators) {
      expect(oscillator.stop).toHaveBeenCalledTimes(2);
    }
  });

  it("ne joue qu'un accord si la fanfare est relancée", () => {
    vi.useFakeTimers();
    const fake = createFakeContext();
    const audio = createAudio(() => fake.context);

    audio.playVictoryFanfare();
    audio.playVictoryFanfare();
    vi.advanceTimersByTime(1100);

    expect(fake.oscillators).toHaveLength(18);
  });

  it("ne ferme pas un contexte déjà fermé", () => {
    const fake = createFakeContext({ state: "closed" });
    const audio = createAudio(() => fake.context);

    audio.playFire("BULLET");
    audio.dispose();

    expect(fake.close).not.toHaveBeenCalled();
  });

  it("limite la glissade à 82 ms par joueur, même sans audio", () => {
    let now = 1_000;
    const factory = vi.fn(() => null);
    const audio = createAudio(factory, () => now);

    audio.playTankSliding("a");
    expect(factory).toHaveBeenCalledOnce();

    now = 1_081;
    audio.playTankSliding("a");
    expect(factory).toHaveBeenCalledOnce();

    now = 1_082;
    audio.playTankSliding("a");
    expect(factory).toHaveBeenCalledTimes(2);

    audio.playTankSliding("b");
    expect(factory).toHaveBeenCalledTimes(3);

    audio.resetSlideThrottle();
    audio.playTankSliding("a");
    expect(factory).toHaveBeenCalledTimes(4);
  });

  it("rejoue la glissade exactement 82 ms plus tard", () => {
    let now = 1_000;
    const fake = createFakeContext();
    const audio = createAudio(() => fake.context, () => now);

    audio.playTankSliding("a");
    expect(fake.buffers).toBe(1);

    now = 1_081;
    audio.playTankSliding("a");
    expect(fake.buffers).toBe(1);

    now = 1_082;
    audio.playTankSliding("a");
    expect(fake.buffers).toBe(2);
  });

  it("tire secureRandom pour le pop seulement quand un contexte existe", () => {
    const draws = vi.spyOn(random, "secureRandom").mockReturnValue(0.5);
    const silent = createAudio(() => null);
    silent.playFireworkPop(10);
    expect(draws).not.toHaveBeenCalled();

    const absent = createAudio(() => createFakeContext().context);
    absent.playFireworkPop(100);
    expect(draws).toHaveBeenCalledTimes(2);

    draws.mockReturnValue(0);
    const present = createAudio(() => createFakeContext().context);
    present.playFireworkPop(100);
    expect(draws).toHaveBeenCalledTimes(5);
  });

  it("reste silencieux sans window", () => {
    const draws = vi.spyOn(random, "secureRandom");
    const audio = new CombatAudio({ getWidth: () => 200 });

    expect(() => audio.playFireworkPop(0)).not.toThrow();
    expect(draws).not.toHaveBeenCalled();
  });

  it("retourne null quand window est absent", () => {
    expect(typeof window).toBe("undefined");
    expect(defaultAudioContext()).toBeNull();
  });

  it("instancie window.AudioContext sans recourir à webkitAudioContext", () => {
    const fake = createFakeContext();
    const AudioContextSpy = vi.fn(function FakeAudioContext() {
      return fake.context;
    });
    const webkitAudioContextSpy = vi.fn(function FakeWebkitAudioContext() {
      return fake.context;
    });

    vi.stubGlobal("window", { AudioContext: AudioContextSpy });
    expect(defaultAudioContext()).toBe(fake.context);
    expect(AudioContextSpy).toHaveBeenCalledOnce();

    vi.stubGlobal("window", { webkitAudioContext: webkitAudioContextSpy });
    expect(defaultAudioContext()).toBeNull();
    expect(webkitAudioContextSpy).not.toHaveBeenCalled();
  });

  it.each(["NUKE", "THERMONUCLEAR"] as const)(
    "maintient une alerte continue en vol pour %s jusqu'à stopFlightAlert, impact ou dispose",
    (weaponId) => {
      const fake = createFakeContext();
      const audio = createAudio(() => fake.context);

      audio.playFire(weaponId);
      const alertOscs = [...fake.oscillators];
      expect(alertOscs.length).toBeGreaterThanOrEqual(3);
      for (const osc of alertOscs) {
        expect(osc.start).toHaveBeenCalledOnce();
        expect(osc.stop).not.toHaveBeenCalled();
      }

      // Arrêt explicite idempotent (ex. hors limites ou nettoyage de manche)
      alertOscs[0]?.stop.mockImplementationOnce(() => {
        throw new Error("Invalid state");
      });
      expect(() => audio.stopFlightAlert()).not.toThrow();
      for (const osc of alertOscs) {
        expect(osc.stop).toHaveBeenCalledOnce();
      }
      expect(() => audio.stopFlightAlert()).not.toThrow();
      for (const osc of alertOscs) {
        expect(osc.stop).toHaveBeenCalledOnce();
      }

      // L'impact coupe l'alerte active avant de jouer l'explosion
      const beforeSecond = fake.oscillators.length;
      audio.playFire(weaponId);
      const secondAlertOscs = fake.oscillators.slice(beforeSecond);
      expect(secondAlertOscs.every((osc) => osc.stop.mock.calls.length === 0)).toBe(true);

      audio.playImpact(weaponId);
      for (const osc of secondAlertOscs) {
        expect(osc.stop).toHaveBeenCalledOnce();
      }
      // Des oscillateurs d'explosion ont été créés et programmés pour s'arrêter
      const impactOscs = fake.oscillators.slice(beforeSecond + secondAlertOscs.length);
      expect(impactOscs.length).toBeGreaterThanOrEqual(2);
      for (const osc of impactOscs) {
        expect(osc.stop).toHaveBeenCalledOnce();
      }

      // Un tir ultérieur et dispose libèrent aussi une alerte encore active
      const beforeThird = fake.oscillators.length;
      audio.playFire(weaponId);
      const thirdAlertOscs = fake.oscillators.slice(beforeThird);
      audio.playFire("MISSILE");
      for (const osc of thirdAlertOscs) {
        expect(osc.stop).toHaveBeenCalledOnce();
      }

      const beforeFourth = fake.oscillators.length;
      audio.playFire(weaponId);
      const fourthAlertOscs = fake.oscillators.slice(beforeFourth);
      audio.dispose();
      for (const osc of fourthAlertOscs) {
        expect(osc.stop).toHaveBeenCalledOnce();
      }
    },
  );

  it("distingue l'alerte en vol et la détonation de NUKE et THERMONUCLEAR", () => {
    const nukeCtx = createFakeContext();
    const thermoCtx = createFakeContext();
    const nukeAudio = createAudio(() => nukeCtx.context);
    const thermoAudio = createAudio(() => thermoCtx.context);

    nukeAudio.playFire("NUKE");
    thermoAudio.playFire("THERMONUCLEAR");

    const nukeFreqs = nukeCtx.oscillators.map((osc) => osc.frequency.value);
    const thermoFreqs = thermoCtx.oscillators.map((osc) => osc.frequency.value);
    expect(nukeFreqs).not.toEqual(thermoFreqs);

    const nukeBeforeImpact = nukeCtx.oscillators.length;
    const thermoBeforeImpact = thermoCtx.oscillators.length;
    nukeAudio.playImpact("NUKE");
    thermoAudio.playImpact("THERMONUCLEAR");

    const nukeImpactFreqs = nukeCtx.oscillators
      .slice(nukeBeforeImpact)
      .map((osc) => osc.frequency.value);
    const thermoImpactFreqs = thermoCtx.oscillators
      .slice(thermoBeforeImpact)
      .map((osc) => osc.frequency.value);
    expect(nukeImpactFreqs).not.toEqual(thermoImpactFreqs);
    expect(thermoCtx.buffers).toBeGreaterThan(nukeCtx.buffers);
  });

  it.each(["NUKE", "THERMONUCLEAR"] as const)(
    "reprend l'alerte de vol pour %s sans bruit de mise à feu ni doublon",
    (weaponId) => {
      const fake = createFakeContext();
      const audio = createAudio(() => fake.context);

      // Armes non nucléaires ignorées
      audio.resumeFlightAlert("MISSILE");
      expect(fake.oscillators).toHaveLength(0);

      audio.resumeFlightAlert(weaponId);
      const initialCount = fake.oscillators.length;
      expect(initialCount).toBeGreaterThanOrEqual(3);
      expect(fake.buffers).toBe(0);

      // Appels répétés pour la même arme : aucun doublon créé
      audio.resumeFlightAlert(weaponId);
      expect(fake.oscillators).toHaveLength(initialCount);

      // Remplacement par l'autre arme nucléaire : coupe la précédente d'abord
      const otherWeapon = weaponId === "NUKE" ? "THERMONUCLEAR" : "NUKE";
      audio.resumeFlightAlert(otherWeapon);
      for (const osc of fake.oscillators.slice(0, initialCount)) {
        expect(osc.stop).toHaveBeenCalledOnce();
      }
      const secondOscs = fake.oscillators.slice(initialCount);
      expect(secondOscs.length).toBeGreaterThanOrEqual(3);
      for (const osc of secondOscs) {
        expect(osc.stop).not.toHaveBeenCalled();
      }

      audio.stopFlightAlert();
      for (const osc of secondOscs) {
        expect(osc.stop).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(["NUKE", "THERMONUCLEAR"] as const)(
    "rampe stopGain de 1 à 0 même si cancelAndHoldAtTime est absent ou lève (%s)",
    (weaponId) => {
      // 1. Navigateur sans cancelAndHoldAtTime (ex. Firefox)
      const withoutHold = createFakeContext({ withCancelAndHold: false });
      const audioWithoutHold = createAudio(() => withoutHold.context);
      audioWithoutHold.playFire(weaponId);
      const stopGainWithoutHold = withoutHold.gains.at(-1)!;
      expect(stopGainWithoutHold.gain.value).toBe(1);

      expect(() => audioWithoutHold.stopFlightAlert()).not.toThrow();
      expect(stopGainWithoutHold.gain.setValueAtTime).toHaveBeenCalledWith(1, 0);
      expect(stopGainWithoutHold.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 0.025);
      for (const osc of withoutHold.oscillators) {
        expect(osc.stop).toHaveBeenCalledWith(0.03);
      }

      // 2. cancelAndHoldAtTime présent mais qui lève une exception
      const throwingHold = createFakeContext({ withCancelAndHold: true });
      const audioThrowingHold = createAudio(() => throwingHold.context);
      audioThrowingHold.playFire(weaponId);
      const masterGain = throwingHold.gains.at(-2)!;
      const stopGainThrowing = throwingHold.gains.at(-1)!;
      (
        masterGain.gain as unknown as {
          cancelAndHoldAtTime: ReturnType<typeof vi.fn>;
        }
      ).cancelAndHoldAtTime.mockImplementationOnce(() => {
        throw new Error("unsupported");
      });

      expect(() => audioThrowingHold.stopFlightAlert()).not.toThrow();
      expect(stopGainThrowing.gain.setValueAtTime).toHaveBeenCalledWith(1, 0);
      expect(stopGainThrowing.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 0.025);
      for (const osc of throwingHold.oscillators) {
        expect(osc.stop).toHaveBeenCalledWith(0.03);
      }
    },
  );

  describe("fermeture différée de l'AudioContext après fondu de sortie", () => {
    it.each(["NUKE", "THERMONUCLEAR"] as const)(
      "attend ended puis la marge de vidange (20 ms) avant de fermer le contexte (%s)",
      (weaponId) => {
        vi.useFakeTimers();
        const fake = createFakeContext({ withEventTarget: true });
        const audio = createAudio(() => fake.context);

        audio.playFire(weaponId);
        audio.dispose();

        expect(fake.close).not.toHaveBeenCalled();
        vi.advanceTimersByTime(30);
        expect(fake.close).not.toHaveBeenCalled();

        fake.oscillators[0]?.emitEnded?.();
        expect(fake.close).not.toHaveBeenCalled();

        vi.advanceTimersByTime(19);
        expect(fake.close).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(fake.close).toHaveBeenCalledOnce();
      },
    );

    it.each(["NUKE", "THERMONUCLEAR"] as const)(
      "utilise le délai de repli (55 ms) si addEventListener('ended') est absent (%s)",
      (weaponId) => {
        vi.useFakeTimers();
        const fake = createFakeContext({ withEventTarget: false });
        const audio = createAudio(() => fake.context);

        audio.playFire(weaponId);
        audio.dispose();

        expect(fake.close).not.toHaveBeenCalled();
        vi.advanceTimersByTime(54);
        expect(fake.close).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(fake.close).toHaveBeenCalledOnce();
      },
    );

    it("borne la fermeture à 120 ms si ended ne survient jamais sur un contexte actif", () => {
      vi.useFakeTimers();
      const fake = createFakeContext({ withEventTarget: true });
      const audio = createAudio(() => fake.context);

      audio.playFire("NUKE");
      audio.dispose();

      vi.advanceTimersByTime(119);
      expect(fake.close).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(fake.close).toHaveBeenCalledOnce();
    });

    it("ferme immédiatement un contexte déjà suspendu ou qui devient suspendu pendant le fondu", () => {
      vi.useFakeTimers();
      const alreadySuspended = createFakeContext({
        state: "suspended",
        withEventTarget: true,
      });
      const audioSuspended = createAudio(() => alreadySuspended.context);
      audioSuspended.playFire("NUKE");
      audioSuspended.dispose();

      for (const osc of alreadySuspended.oscillators) {
        expect(osc.stop).toHaveBeenCalledOnce();
      }
      expect(alreadySuspended.close).toHaveBeenCalledOnce();

      const transitionsToSuspended = createFakeContext({
        state: "running",
        withEventTarget: true,
      });
      const audioDynamic = createAudio(() => transitionsToSuspended.context);
      audioDynamic.playFire("THERMONUCLEAR");
      audioDynamic.dispose();
      expect(transitionsToSuspended.close).not.toHaveBeenCalled();

      vi.advanceTimersByTime(10);
      transitionsToSuspended.setState("suspended");
      expect(transitionsToSuspended.close).toHaveBeenCalledOnce();

      vi.advanceTimersByTime(200);
      expect(transitionsToSuspended.close).toHaveBeenCalledOnce();
    });

    it("reste sécuritaire sur dispose() répété et n'interfère pas avec une nouvelle partie", () => {
      vi.useFakeTimers();
      const first = createFakeContext({ withEventTarget: true });
      const second = createFakeContext({ withEventTarget: true });
      const factory = vi.fn()
        .mockReturnValueOnce(first.context)
        .mockReturnValueOnce(second.context);
      const audio = createAudio(factory);

      audio.playFire("NUKE");
      audio.dispose();
      audio.dispose();

      // Relance immédiate avant la fin du fondu de l'ancien contexte
      audio.playFire("MISSILE");
      expect(factory).toHaveBeenCalledTimes(2);
      expect(second.oscillators.length).toBeGreaterThan(0);

      vi.advanceTimersByTime(150);
      expect(first.close).toHaveBeenCalledOnce();
      expect(second.close).not.toHaveBeenCalled();
    });

    it("diffère si stopFlightAlert() vient juste d'être appelé, mais ferme tout de suite si le fondu est déjà terminé", () => {
      vi.useFakeTimers();

      // 1. stopFlightAlert() appelé 5 ms avant dispose() -> attend le reste du fondu
      let nowA = 1_000;
      const fakeA = createFakeContext({ withEventTarget: true });
      const audioA = createAudio(() => fakeA.context, () => nowA);
      audioA.playFire("NUKE");
      audioA.stopFlightAlert();
      nowA = 1_005;
      audioA.dispose();
      expect(fakeA.close).not.toHaveBeenCalled();
      fakeA.oscillators[0]?.emitEnded?.();
      vi.advanceTimersByTime(20);
      expect(fakeA.close).toHaveBeenCalledOnce();

      // 2. ended déjà émis avant dispose() -> ferme immédiatement
      const fakeB = createFakeContext({ withEventTarget: true });
      const audioB = createAudio(() => fakeB.context);
      audioB.playFire("NUKE");
      audioB.stopFlightAlert();
      fakeB.oscillators[0]?.emitEnded?.();
      audioB.dispose();
      expect(fakeB.close).toHaveBeenCalledOnce();

      // 3. >= 120 ms écoulés depuis stopFlightAlert() -> ferme immédiatement
      let nowC = 2_000;
      const fakeC = createFakeContext({ withEventTarget: false });
      const audioC = createAudio(() => fakeC.context, () => nowC);
      audioC.playFire("THERMONUCLEAR");
      audioC.stopFlightAlert();
      nowC = 2_120;
      audioC.dispose();
      expect(fakeC.close).toHaveBeenCalledOnce();
    });
  });

  describe("neutralisation hors running, reprise asynchrone et alignement de détonation", () => {
    it.each(["NUKE", "THERMONUCLEAR"] as const)(
      "neutralise immédiatement la sirène lors de stopFlightAlert() sur contexte suspendu (%s)",
      (weaponId) => {
        const fake = createFakeContext({ withEventTarget: true });
        const audio = createAudio(() => fake.context);

        audio.playFire(weaponId);
        const stopGain = fake.gains.at(-1)!;
        const alertOscs = [...fake.oscillators];

        fake.setCurrentTime(2);
        fake.setState("suspended");
        audio.stopFlightAlert();

        expect(stopGain.gain.cancelScheduledValues).toHaveBeenCalledWith(0);
        expect(stopGain.gain.value).toBe(0);
        expect(stopGain.gain.setValueAtTime).toHaveBeenCalledWith(0, 2);
        expect(stopGain.disconnect).toHaveBeenCalledOnce();
        expect(stopGain.gain.linearRampToValueAtTime).not.toHaveBeenCalled();
        for (const osc of alertOscs) {
          expect(osc.stop).toHaveBeenCalledWith(2);
        }

        // Aucun fondu pendant n'empêche dispose() de fermer tout de suite
        audio.dispose();
        expect(fake.close).toHaveBeenCalledOnce();
      },
    );

    it.each(["NUKE", "THERMONUCLEAR"] as const)(
      "neutralise un fondu en cours si le contexte devient suspendu via statechange ou avant resumeFlightAlert (%s)",
      (weaponId) => {
        // 1. Suspension notifiée par statechange pendant le fondu
        const fakeA = createFakeContext({ withEventTarget: true });
        const audioA = createAudio(() => fakeA.context);
        audioA.playFire(weaponId);
        const stopGainA = fakeA.gains.at(-1)!;
        const alertOscsA = [...fakeA.oscillators];
        fakeA.setCurrentTime(2);
        audioA.stopFlightAlert();

        fakeA.setState("suspended");
        expect(stopGainA.gain.cancelScheduledValues).toHaveBeenCalledWith(0);
        expect(stopGainA.gain.value).toBe(0);
        expect(stopGainA.gain.setValueAtTime).toHaveBeenCalledWith(0, 2);
        expect(stopGainA.disconnect).toHaveBeenCalledOnce();
        // L'oscillateur avait déjà reçu stop(2.03) : pas de second stop() risquant InvalidStateError
        for (const osc of alertOscsA) {
          expect(osc.stop).toHaveBeenCalledOnce();
          expect(osc.stop).toHaveBeenCalledWith(2.03);
        }

        // 2. Suspension sans événement statechange, détectée lors de resumeFlightAlert
        let resolveResume!: () => void;
        const fakeB = createFakeContext({
          withEventTarget: false,
          resumeImplementation: () =>
            new Promise<void>((resolve) => {
              resolveResume = resolve;
            }),
        });
        const audioB = createAudio(() => fakeB.context);
        audioB.playFire(weaponId);
        const stopGainB = fakeB.gains.at(-1)!;
        fakeB.setCurrentTime(2);
        audioB.stopFlightAlert();
        const beforeResumeCount = fakeB.oscillators.length;

        // Simule un contexte suspendu en silence avant la reprise d'onglet
        fakeB.setState("suspended");
        audioB.resumeFlightAlert(weaponId, () => true);

        expect(stopGainB.gain.cancelScheduledValues).toHaveBeenCalledWith(0);
        expect(stopGainB.gain.value).toBe(0);
        expect(stopGainB.disconnect).toHaveBeenCalledOnce();
        expect(fakeB.oscillators).toHaveLength(beforeResumeCount);
        void resolveResume;
      },
    );

    it.each(["NUKE", "THERMONUCLEAR"] as const)(
      "appelle resume() sans chevauchement ni doublon quand le contexte est suspendu (%s)",
      async (weaponId) => {
        let resolveResume!: () => void;
        const fake = createFakeContext({
          withEventTarget: true,
          resumeImplementation: (ctx) =>
            new Promise<void>((resolve) => {
              resolveResume = () => {
                ctx.setState("running");
                resolve();
              };
            }),
        });
        const audio = createAudio(() => fake.context);

        audio.playFire(weaponId);
        const oldStopGain = fake.gains.at(-1)!;
        fake.setCurrentTime(2);
        fake.setState("suspended");
        audio.stopFlightAlert();
        const oscCountAfterStop = fake.oscillators.length;
        const buffersAfterFire = fake.buffers;

        audio.resumeFlightAlert(weaponId, () => true);
        expect(fake.resume).toHaveBeenCalledOnce();
        expect(fake.oscillators).toHaveLength(oscCountAfterStop);
        expect(oldStopGain.disconnect).toHaveBeenCalledOnce();

        // La résolution du resume() déclenche statechange puis .then(): une seule sirène est créée
        resolveResume();
        await Promise.resolve();
        await Promise.resolve();

        const resumedOscs = fake.oscillators.slice(oscCountAfterStop);
        expect(resumedOscs.length).toBeGreaterThanOrEqual(3);
        for (const osc of resumedOscs) {
          expect(osc.start).toHaveBeenCalledExactlyOnceWith(2);
        }
        expect(fake.buffers).toBe(buffersAfterFire);
      },
    );

    it.each(["NUKE", "THERMONUCLEAR"] as const)(
      "reste muet si resume() rejette puis démarre plus tard via statechange lorsque le navigateur autorise l'audio (%s)",
      async (weaponId) => {
        const fake = createFakeContext({
          withEventTarget: true,
          state: "suspended",
          resumeImplementation: () => Promise.reject(new Error("autoplay blocked")),
        });
        const audio = createAudio(() => fake.context);
        fake.setCurrentTime(2);

        audio.resumeFlightAlert(weaponId, () => true);
        await Promise.resolve();
        await Promise.resolve();
        expect(fake.oscillators).toHaveLength(0);

        // Le navigateur débloque ensuite le contexte (statechange -> running)
        fake.setState("running");
        expect(fake.oscillators.length).toBeGreaterThanOrEqual(3);
        for (const osc of fake.oscillators) {
          expect(osc.start).toHaveBeenCalledExactlyOnceWith(2);
        }
      },
    );

    it("annule toute reprise en attente si shouldResume devient faux, sur stop, impact, dispose ou appels répétés", async () => {
      // 1. shouldResume() devient faux avant la résolution
      let allowResume = true;
      let resolveA!: () => void;
      const fakeA = createFakeContext({
        withEventTarget: true,
        state: "suspended",
        resumeImplementation: (ctx) =>
          new Promise<void>((resolve) => {
            resolveA = () => {
              ctx.setState("running");
              resolve();
            };
          }),
      });
      const audioA = createAudio(() => fakeA.context);
      audioA.resumeFlightAlert("NUKE", () => allowResume);
      allowResume = false;
      resolveA();
      await Promise.resolve();
      expect(fakeA.oscillators).toHaveLength(0);

      // 2. stopFlightAlert() pendant l'attente
      let resolveB!: () => void;
      const fakeB = createFakeContext({
        withEventTarget: true,
        state: "suspended",
        resumeImplementation: (ctx) =>
          new Promise<void>((resolve) => {
            resolveB = () => {
              ctx.setState("running");
              resolve();
            };
          }),
      });
      const audioB = createAudio(() => fakeB.context);
      audioB.resumeFlightAlert("NUKE", () => true);
      audioB.stopFlightAlert();
      resolveB();
      await Promise.resolve();
      expect(fakeB.oscillators).toHaveLength(0);

      // 3. playImpact() pendant l'attente : ne crée aucune nouvelle sirène au déblocage
      let resolveC!: () => void;
      const fakeC = createFakeContext({
        withEventTarget: true,
        state: "suspended",
        resumeImplementation: (ctx) =>
          new Promise<void>((resolve) => {
            resolveC = () => {
              ctx.setState("running");
              resolve();
            };
          }),
      });
      const audioC = createAudio(() => fakeC.context);
      audioC.resumeFlightAlert("THERMONUCLEAR", () => true);
      audioC.playImpact("THERMONUCLEAR");
      const oscCountAfterImpact = fakeC.oscillators.length;
      resolveC();
      await Promise.resolve();
      expect(fakeC.oscillators).toHaveLength(oscCountAfterImpact);

      // 4. dispose() pendant l'attente
      let resolveD!: () => void;
      const fakeD = createFakeContext({
        withEventTarget: true,
        state: "suspended",
        resumeImplementation: (ctx) =>
          new Promise<void>((resolve) => {
            resolveD = () => {
              ctx.setState("running");
              resolve();
            };
          }),
      });
      const audioD = createAudio(() => fakeD.context);
      audioD.resumeFlightAlert("NUKE", () => true);
      audioD.dispose();
      expect(fakeD.close).toHaveBeenCalledOnce();
      resolveD();
      await Promise.resolve();
      expect(fakeD.oscillators).toHaveLength(0);

      // 5. Appels répétés pendant l'attente : seul le dernier demande prévaut
      const resolversE: Array<() => void> = [];
      const fakeE = createFakeContext({
        withEventTarget: true,
        state: "suspended",
        resumeImplementation: () =>
          new Promise<void>((resolve) => {
            resolversE.push(resolve);
          }),
      });
      const audioE = createAudio(() => fakeE.context);
      audioE.resumeFlightAlert("NUKE", () => true);
      audioE.resumeFlightAlert("THERMONUCLEAR", () => true);
      fakeE.setState("running");
      for (const resolve of resolversE) {
        resolve();
      }
      await Promise.resolve();
      expect(fakeE.oscillators).toHaveLength(4); // THERMONUCLEAR uniquement (4 oscillateurs)
    });

    it.each([
      {
        weaponId: "NUKE" as const,
        expectedNoiseStarts: [2.025, 2.025 + 0.16],
        expectedOscStarts: [2.025, 2.025],
      },
      {
        weaponId: "THERMONUCLEAR" as const,
        expectedNoiseStarts: [2.025, 2.025 + 0.22, 2.025 + 0.52],
        expectedOscStarts: [2.025, 2.025 + 0.1],
      },
    ])(
      "planifie toutes les couches de détonation après la fin du fondu (2,025 s) si une sirène est active (%s)",
      ({ weaponId, expectedNoiseStarts, expectedOscStarts }) => {
        // Cas A : stopFlightAlert() puis playImpact() comme dans GameEngine.onProjectileHit
        const fakeEnginePath = createFakeContext({ withEventTarget: true });
        const audioA = createAudio(() => fakeEnginePath.context);
        audioA.playFire(weaponId);
        fakeEnginePath.setCurrentTime(2);
        const oscBeforeA = fakeEnginePath.oscillators.length;
        const srcBeforeA = fakeEnginePath.bufferSources.length;

        audioA.stopFlightAlert();
        audioA.playImpact(weaponId);

        const impactOscStartsA = fakeEnginePath.oscillators
          .slice(oscBeforeA)
          .map((osc) => osc.start.mock.calls[0]?.[0] as number);
        const impactNoiseStartsA = fakeEnginePath.bufferSources
          .slice(srcBeforeA)
          .map((src) => src.start.mock.calls[0]?.[0] as number);

        expect(impactOscStartsA).toEqual(expectedOscStarts);
        expect(impactNoiseStartsA).toEqual(expectedNoiseStarts);
        expect(Math.min(...impactOscStartsA, ...impactNoiseStartsA)).toBe(2.025);

        // Si dispose() survient 5 ms après l'impact, le contexte attend encore le fondu de sirène
        vi.useFakeTimers();
        audioA.dispose();
        expect(fakeEnginePath.close).not.toHaveBeenCalled();
        fakeEnginePath.oscillators[0]?.emitEnded?.();
        vi.advanceTimersByTime(20);
        expect(fakeEnginePath.close).toHaveBeenCalledOnce();
        vi.useRealTimers();

        // Cas B : playImpact() seul alors que l'alerte est active
        const fakeDirectPath = createFakeContext({ withEventTarget: true });
        const audioB = createAudio(() => fakeDirectPath.context);
        audioB.playFire(weaponId);
        fakeDirectPath.setCurrentTime(2);
        const oscBeforeB = fakeDirectPath.oscillators.length;
        const srcBeforeB = fakeDirectPath.bufferSources.length;

        audioB.playImpact(weaponId);

        expect(
          fakeDirectPath.oscillators.slice(oscBeforeB).map((o) => o.start.mock.calls[0]?.[0]),
        ).toEqual(expectedOscStarts);
        expect(
          fakeDirectPath.bufferSources.slice(srcBeforeB).map((s) => s.start.mock.calls[0]?.[0]),
        ).toEqual(expectedNoiseStarts);
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
      "démarre la détonation sans délai ajouté lorsqu'aucune sirène ni fondu actif ne joue (%s)",
      ({ weaponId, expectedNoiseOffsets, expectedOscOffsets }) => {
        // 1. Aucun tir / alerte préalable
        const fakeDirect = createFakeContext();
        fakeDirect.setCurrentTime(2);
        const audioDirect = createAudio(() => fakeDirect.context);
        audioDirect.playImpact(weaponId);

        expect(fakeDirect.oscillators.map((o) => o.start.mock.calls[0]?.[0])).toEqual(
          expectedOscOffsets.map((offset) => 2 + offset),
        );
        expect(fakeDirect.bufferSources.map((s) => s.start.mock.calls[0]?.[0])).toEqual(
          expectedNoiseOffsets.map((offset) => 2 + offset),
        );

        // 2. Fondu déjà achevé (stopFlightAlert à 1.000 -> fadeEndTime 1.025, impact à 2.000)
        const fakeFinished = createFakeContext({ withEventTarget: true });
        const audioFinished = createAudio(() => fakeFinished.context);
        audioFinished.playFire(weaponId);
        fakeFinished.setCurrentTime(1);
        audioFinished.stopFlightAlert();

        fakeFinished.setCurrentTime(2);
        const oscBefore = fakeFinished.oscillators.length;
        const srcBefore = fakeFinished.bufferSources.length;
        audioFinished.playImpact(weaponId);

        expect(
          fakeFinished.oscillators.slice(oscBefore).map((o) => o.start.mock.calls[0]?.[0]),
        ).toEqual(expectedOscOffsets.map((offset) => 2 + offset));
        expect(
          fakeFinished.bufferSources.slice(srcBefore).map((s) => s.start.mock.calls[0]?.[0]),
        ).toEqual(expectedNoiseOffsets.map((offset) => 2 + offset));

        // 3. Sirène neutralisée sur contexte suspendu puis reprise avant impact à 2.000
        const fakeSuspended = createFakeContext({ withEventTarget: true });
        const audioSuspended = createAudio(() => fakeSuspended.context);
        audioSuspended.playFire(weaponId);
        fakeSuspended.setCurrentTime(2);
        fakeSuspended.setState("suspended");
        audioSuspended.stopFlightAlert();
        fakeSuspended.setState("running");

        const oscBeforeSusp = fakeSuspended.oscillators.length;
        const srcBeforeSusp = fakeSuspended.bufferSources.length;
        audioSuspended.playImpact(weaponId);

        expect(
          fakeSuspended.oscillators.slice(oscBeforeSusp).map((o) => o.start.mock.calls[0]?.[0]),
        ).toEqual(expectedOscOffsets.map((offset) => 2 + offset));
        expect(
          fakeSuspended.bufferSources.slice(srcBeforeSusp).map((s) => s.start.mock.calls[0]?.[0]),
        ).toEqual(expectedNoiseOffsets.map((offset) => 2 + offset));
      },
    );
  });
});
