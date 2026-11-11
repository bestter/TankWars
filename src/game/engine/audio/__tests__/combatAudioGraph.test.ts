import { afterEach, describe, expect, it, vi } from "vitest";
import { GameEngine } from "../../GameEngine";
import { ALL_WEAPON_IDS, type WeaponId } from "../../../../types/weapon";
import * as random from "../../../../utils/random";
import { createRecordingSession } from "./recordingAudioContext";

/**
 * Caractérisation du graphe Web Audio avant l'extraction (#413).
 * L'accès aux méthodes privées disparaît quand le harnais vise CombatAudio.
 * Ne régénérer ces instantanés que si le son change volontairement.
 */

const WIDTH = 200;

type EngineAudio = {
  playFireSound(weaponId: WeaponId): void;
  playImpactSound(weaponId: WeaponId): void;
  playZeusAppointmentSound(): void;
  playZeusStrikeSound(): void;
  playTankDestroyedByExplosionSound(): void;
  playTankSadBurialSound(): void;
  playTankTouchLowestFloorSound(): void;
  playTankSlidingSound(playerId: string): void;
  playFireworkPop(x: number): void;
  playVictoryFanfare(): void;
};

const POP_POSITIONS = [
  ["0", 0],
  ["mid", WIDTH / 2],
  ["width", WIDTH],
  ["below", -40],
  ["above", WIDTH + 80],
] as const;

const CRACKLE_ABSENT = [0.5, 0.5];
const CRACKLE_PRESENT = [0, 0, 0];

function engineAudio(engine: GameEngine): EngineAudio {
  return engine as unknown as EngineAudio;
}

async function expectEngineGraph(
  name: string,
  play: (audio: EngineAudio) => void,
  options: { stereoPanner?: boolean; random?: readonly number[] } = {},
): Promise<void> {
  const session = createRecordingSession({
    stereoPanner: options.stereoPanner ?? true,
  });
  vi.stubGlobal("window", { AudioContext: session.AudioContext });
  let draws = 0;
  if (options.random) {
    const values = options.random;
    vi.spyOn(random, "secureRandom").mockImplementation(() => {
      const value = values[draws];
      draws += 1;
      return value ?? Number.NaN;
    });
  }
  const engine = new GameEngine(WIDTH, WIDTH);
  play(engineAudio(engine));
  if (options.random) expect(draws).toBe(options.random.length);
  await expect(session.render()).toMatchFileSnapshot(`../__snapshots__/${name}.txt`);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("combat audio graph", () => {
  it.each(ALL_WEAPON_IDS)("records the fire graph for %s", async (weaponId) => {
    await expectEngineGraph(`fire-${weaponId}`, (audio) => {
      audio.playFireSound(weaponId);
    });
  });

  it.each(ALL_WEAPON_IDS)("records the impact graph for %s", async (weaponId) => {
    await expectEngineGraph(`impact-${weaponId}`, (audio) => {
      audio.playImpactSound(weaponId);
    });
  });

  it("records the Zeus appointment", async () => {
    await expectEngineGraph("zeus-appointment", (audio) => {
      audio.playZeusAppointmentSound();
    });
  });

  it("records the Zeus strike", async () => {
    await expectEngineGraph("zeus-strike", (audio) => {
      audio.playZeusStrikeSound();
    });
  });

  it("records a tank destroyed by an explosion", async () => {
    await expectEngineGraph("tank-destroyed", (audio) => {
      audio.playTankDestroyedByExplosionSound();
    });
  });

  it("records a burial", async () => {
    await expectEngineGraph("tank-burial", (audio) => {
      audio.playTankSadBurialSound();
    });
  });

  it("records the floor contact", async () => {
    await expectEngineGraph("tank-floor", (audio) => {
      audio.playTankTouchLowestFloorSound();
    });
  });

  it("records one slide", async () => {
    await expectEngineGraph("tank-slide", (audio) => {
      audio.playTankSlidingSound("tank-a");
    });
  });

  describe("firework pop", () => {
    it.each(POP_POSITIONS)(
      "records a pop without crackle and with a panner at %s",
      async (label, x) => {
        await expectEngineGraph(
          `pop-absent-panner-${label}`,
          (audio) => {
            audio.playFireworkPop(x);
          },
          { random: CRACKLE_ABSENT },
        );
      },
    );

    it.each(POP_POSITIONS)(
      "records a pop with crackle and a panner at %s",
      async (label, x) => {
        await expectEngineGraph(
          `pop-present-panner-${label}`,
          (audio) => {
            audio.playFireworkPop(x);
          },
          { random: CRACKLE_PRESENT },
        );
      },
    );

    it("records a pop without crackle and without a panner", async () => {
      await expectEngineGraph(
        "pop-absent-no-panner-mid",
        (audio) => {
          audio.playFireworkPop(WIDTH / 2);
        },
        { stereoPanner: false, random: CRACKLE_ABSENT },
      );
    });

    it("records a pop with crackle and without a panner", async () => {
      await expectEngineGraph(
        "pop-present-no-panner-mid",
        (audio) => {
          audio.playFireworkPop(WIDTH / 2);
        },
        { stereoPanner: false, random: CRACKLE_PRESENT },
      );
    });
  });

  it("records the full victory fanfare, including the final chord", async () => {
    const session = createRecordingSession({ stereoPanner: true });
    vi.stubGlobal("window", { AudioContext: session.AudioContext });
    const engine = new GameEngine(WIDTH, WIDTH);
    vi.useFakeTimers();
    engineAudio(engine).playVictoryFanfare();
    await vi.advanceTimersByTimeAsync(1100);
    await expect(session.render()).toMatchFileSnapshot("../__snapshots__/fanfare.txt");
  });
});
