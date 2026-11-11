import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_WEAPON_IDS } from "../../../../types/weapon";
import * as random from "../../../../utils/random";
import { CombatAudio } from "../CombatAudio";

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
});
