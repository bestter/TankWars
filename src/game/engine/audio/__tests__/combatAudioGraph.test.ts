import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_WEAPON_IDS } from "../../../../types/weapon";
import * as random from "../../../../utils/random";
import { CombatAudio } from "../CombatAudio";
import { createRecordingSession } from "./recordingAudioContext";

/**
 * Instantané du graphe Web Audio (#413).
 * Le régénérer seulement quand un son change volontairement.
 */

const WIDTH = 200;

const POP_POSITIONS = [
  ["0", 0],
  ["mid", WIDTH / 2],
  ["width", WIDTH],
  ["below", -40],
  ["above", WIDTH + 80],
] as const;

const CRACKLE_ABSENT = [0.5, 0.5];
const CRACKLE_PRESENT = [0, 0, 0];

async function expectAudioGraph(
  name: string,
  play: (audio: CombatAudio) => void,
  options: { stereoPanner?: boolean; random?: readonly number[] } = {},
): Promise<void> {
  const session = createRecordingSession({
    stereoPanner: options.stereoPanner ?? true,
  });
  let draws = 0;
  if (options.random) {
    const values = options.random;
    vi.spyOn(random, "secureRandom").mockImplementation(() => {
      const value = values[draws];
      draws += 1;
      return value ?? Number.NaN;
    });
  }
  const audio = new CombatAudio({
    getWidth: () => WIDTH,
    createContext: () => session.borrowContext(),
  });
  play(audio);
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
    await expectAudioGraph(`fire-${weaponId}`, (audio) => {
      audio.playFire(weaponId);
    });
  });

  it.each(ALL_WEAPON_IDS)("records the impact graph for %s", async (weaponId) => {
    await expectAudioGraph(`impact-${weaponId}`, (audio) => {
      audio.playImpact(weaponId);
    });
  });

  it("records the Zeus appointment", async () => {
    await expectAudioGraph("zeus-appointment", (audio) => {
      audio.playZeusAppointment();
    });
  });

  it("records the Zeus strike", async () => {
    await expectAudioGraph("zeus-strike", (audio) => {
      audio.playZeusStrike();
    });
  });

  it("records a tank destroyed by an explosion", async () => {
    await expectAudioGraph("tank-destroyed", (audio) => {
      audio.playTankDestroyedByExplosion();
    });
  });

  it("records a burial", async () => {
    await expectAudioGraph("tank-burial", (audio) => {
      audio.playTankSadBurial();
    });
  });

  it("records the floor contact", async () => {
    await expectAudioGraph("tank-floor", (audio) => {
      audio.playTankTouchLowestFloor();
    });
  });

  it("records one slide", async () => {
    await expectAudioGraph("tank-slide", (audio) => {
      audio.playTankSliding("tank-a");
    });
  });

  describe("firework pop", () => {
    it.each(POP_POSITIONS)(
      "records a pop without crackle and with a panner at %s",
      async (label, x) => {
        await expectAudioGraph(
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
        await expectAudioGraph(
          `pop-present-panner-${label}`,
          (audio) => {
            audio.playFireworkPop(x);
          },
          { random: CRACKLE_PRESENT },
        );
      },
    );

    it("records a pop without crackle and without a panner", async () => {
      await expectAudioGraph(
        "pop-absent-no-panner-mid",
        (audio) => {
          audio.playFireworkPop(WIDTH / 2);
        },
        { stereoPanner: false, random: CRACKLE_ABSENT },
      );
    });

    it("records a pop with crackle and without a panner", async () => {
      await expectAudioGraph(
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
    const audio = new CombatAudio({
      getWidth: () => WIDTH,
      createContext: () => session.borrowContext(),
    });
    vi.useFakeTimers();
    audio.playVictoryFanfare();
    await vi.advanceTimersByTimeAsync(1100);
    await expect(session.render()).toMatchFileSnapshot("../__snapshots__/fanfare.txt");
  });
});
