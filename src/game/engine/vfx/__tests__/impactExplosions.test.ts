import { afterEach, describe, expect, it, vi } from "vitest";
import { VGA_PALETTE } from "../../../../types/game";
import * as random from "../../../../utils/random";
import { createRecordingCanvasContext } from "../../__tests__/recordingCanvasContext";
import { ImpactExplosions } from "../impactExplosions";

describe("ImpactExplosions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spawns 42 particles and arms the red flash for 13 frames", () => {
    const rng = random.createSeededRNG(13);
    vi.spyOn(random, "secureRandom").mockImplementation(() => rng.next());

    const explosions = new ImpactExplosions({ width: 200, height: 200 });
    explosions.spawnThermonuclear(100, 120);

    expect(explosions.getExplosions()).toHaveLength(42);
    expect(explosions.hasActiveVisuals).toBe(true);

    const recorder = createRecordingCanvasContext();
    const flashLine = `fillRect x=0.000000 y=0.000000 w=200.000000 h=200.000000 fill=${VGA_PALETTE.RED} alpha=0.240000`;
    let flashFrames = 0;

    for (let i = 0; i < 14; i++) {
      recorder.clearLines();
      explosions.draw(recorder.ctx);
      expect(recorder.getGlobalAlpha()).toBe(1);
      if (recorder.getLines().includes(flashLine)) {
        flashFrames += 1;
      }
    }

    expect(flashFrames).toBe(13);
  });

  it("draws flash first, then particles with size > 4 and size > 7 halos, restoring globalAlpha", () => {
    // 0.9 sets size = 2.5 + 0.9 * 8.5 = 10.15 (> 7, triggers both halo layers)
    vi.spyOn(random, "secureRandom").mockReturnValue(0.9);

    const explosions = new ImpactExplosions({ width: 200, height: 200 });
    explosions.spawnThermonuclear(100, 120);

    const recorder = createRecordingCanvasContext();
    explosions.draw(recorder.ctx);
    expect(recorder.getGlobalAlpha()).toBe(1);

    const lines = recorder.getLines();
    // 1 flash + 42 * 3 rects (base + >4 halo + >7 halo)
    expect(lines).toHaveLength(1 + 42 * 3);
    expect(lines[0]).toBe(
      `fillRect x=0.000000 y=0.000000 w=200.000000 h=200.000000 fill=${VGA_PALETTE.RED} alpha=0.240000`,
    );
  });

  it("expands only in first half of life and compacts dead particles in place without reallocating", () => {
    const explosions = new ImpactExplosions({ width: 200, height: 200 });
    const initialRef = explosions.getExplosions();

    // 1. Short-circuit when empty
    explosions.update();
    expect(explosions.getExplosions()).toBe(initialRef);
    expect(explosions.getExplosions()).toHaveLength(0);

    // 2. Deterministic spawn: particle 0 long life (0.9 -> 67.2), particle 1 short life (0.0 -> 42),
    // particle 2 long life (0.9 -> 67.2), remaining particles short life (0.0 -> 42)
    let drawIndex = 0;
    vi.spyOn(random, "secureRandom").mockImplementation(() => {
      const particleIdx = Math.floor(drawIndex / 5);
      const fieldIdx = drawIndex % 5;
      drawIndex += 1;
      if (fieldIdx === 3) {
        // life draw
        return particleIdx === 0 || particleIdx === 2 ? 0.9 : 0.0;
      }
      return 0.5;
    });

    explosions.spawnThermonuclear(100, 120);
    expect(explosions.getExplosions()).toBe(initialRef);
    expect(initialRef).toHaveLength(42);

    const survivor0 = initialRef[0];
    const survivor2 = initialRef[2];
    const sizeBeforeFirstHalf = survivor0.size;

    // First tick: life 67.2 -> 66.2 (> 35), expands
    explosions.update();
    expect(survivor0.size).toBeGreaterThan(sizeBeforeFirstHalf);

    // Advance until tick 42: particle 1 (between 0 and 2) expires along with 3..41
    for (let i = 1; i < 42; i++) {
      explosions.update();
    }

    expect(explosions.getExplosions()).toBe(initialRef);
    expect(initialRef).toHaveLength(2);
    expect(initialRef[0]).toBe(survivor0);
    expect(initialRef[1]).toBe(survivor2);

    // Past half life (life <= 35), size stops expanding
    const sizeAtHalfLife = survivor0.size;
    explosions.update();
    expect(survivor0.size).toBe(sizeAtHalfLife);

    // Advance until remaining 2 particles expire -> length 0, same array reference
    for (let i = 0; i < 30; i++) {
      explosions.update();
    }
    expect(explosions.getExplosions()).toBe(initialRef);
    expect(initialRef).toHaveLength(0);
  });

  it("clears explosions in place and resets flash life", () => {
    vi.spyOn(random, "secureRandom").mockReturnValue(0.5);
    const explosions = new ImpactExplosions({ width: 200, height: 200 });
    const initialRef = explosions.getExplosions();

    explosions.spawnThermonuclear(100, 120);
    expect(explosions.hasActiveVisuals).toBe(true);

    explosions.clear();
    expect(explosions.getExplosions()).toBe(initialRef);
    expect(explosions.getExplosions()).toHaveLength(0);
    expect(explosions.hasActiveVisuals).toBe(false);

    const recorder = createRecordingCanvasContext();
    explosions.draw(recorder.ctx);
    expect(recorder.getLines()).toHaveLength(0);
  });
});
