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
}

interface FakeContext {
  context: AudioContext;
  oscillators: FakeOscillator[];
  close: ReturnType<typeof vi.fn>;
  buffers: number;
}

function audioParam(): AudioParam {
  return {
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
  } as unknown as AudioParam;
}

function createFakeContext(options?: {
  createBufferThrows?: boolean;
  closeRejects?: boolean;
  state?: AudioContextState;
}): FakeContext {
  const oscillators: FakeOscillator[] = [];
  const buffers = { count: 0 };
  const close = vi.fn(() => (
    options?.closeRejects ? Promise.reject(new Error("close")) : Promise.resolve()
  ));
  const context = {
    state: options?.state ?? "running",
    sampleRate: 44_100,
    currentTime: 0,
    destination: {},
    createOscillator: vi.fn(() => {
      const oscillator: FakeOscillator = {
        type: "sine",
        stop: vi.fn(),
        frequency: audioParam(),
        connect: vi.fn(),
        start: vi.fn(),
      };
      oscillators.push(oscillator);
      return oscillator;
    }),
    createGain: vi.fn(() => ({ gain: audioParam(), connect: vi.fn() })),
    createBiquadFilter: vi.fn(() => ({
      type: "lowpass",
      frequency: audioParam(),
      connect: vi.fn(),
    })),
    createStereoPanner: vi.fn(() => ({ pan: audioParam(), connect: vi.fn() })),
    createBuffer: vi.fn((_channels: number, length: number) => {
      if (options?.createBufferThrows) throw new Error("buffer");
      buffers.count += 1;
      return { getChannelData: () => new Float32Array(length) };
    }),
    createBufferSource: vi.fn(() => ({
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(),
    })),
    close,
  };
  return {
    context: context as unknown as AudioContext,
    oscillators,
    close,
    get buffers() {
      return buffers.count;
    },
  };
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
});
