import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VGA_PALETTE } from "../../../../types/game";
import { TERRAIN_MATERIAL } from "../../../../types/terrain";
import * as random from "../../../../utils/random";
import { createRecordingCanvasContext } from "../../__tests__/recordingCanvasContext";
import { TerrainImpactParticles } from "../terrainImpactParticles";

describe("TerrainImpactParticles", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("contains no static import or reference to utils/random, secureRandom, or Math.random", () => {
    const source = readFileSync(
      new URL("../terrainImpactParticles.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/utils\/random/);
    expect(source).not.toMatch(/\bsecureRandom\b/);
    expect(source).not.toMatch(/\bMath\.random\b/);
  });

  it("spawns exact counts, kinds, lifetimes, and VGA palettes per material without secureRandom or Math.random", () => {
    const secureSpy = vi.spyOn(random, "secureRandom");
    const mathSpy = vi.spyOn(Math, "random");

    const dirt = new TerrainImpactParticles();
    dirt.spawn(100, 120, TERRAIN_MATERIAL.DIRT);
    expect(dirt.getParticles()).toHaveLength(8);
    for (const pt of dirt.getParticles()) {
      expect(pt.kind).toBe("dust");
      expect(pt.life).toBe(16);
      expect(pt.maxLife).toBe(16);
      expect([VGA_PALETTE.BROWN, VGA_PALETTE.GREEN]).toContain(pt.color);
    }

    const soft = new TerrainImpactParticles();
    soft.spawn(100, 120, TERRAIN_MATERIAL.SOFT);
    expect(soft.getParticles()).toHaveLength(18);
    expect(soft.getParticles().filter((pt) => pt.kind === "dust")).toHaveLength(12);
    expect(soft.getParticles().filter((pt) => pt.kind === "grain")).toHaveLength(6);
    for (const pt of soft.getParticles()) {
      expect(pt.life).toBe(24);
      expect(pt.maxLife).toBe(24);
      expect([VGA_PALETTE.YELLOW, VGA_PALETTE.BROWN]).toContain(pt.color);
    }

    const rock = new TerrainImpactParticles();
    rock.spawn(100, 120, TERRAIN_MATERIAL.ROCK);
    expect(rock.getParticles()).toHaveLength(6);
    for (const pt of rock.getParticles()) {
      expect(pt.kind).toBe("shard");
      expect(pt.life).toBe(12);
      expect(pt.maxLife).toBe(12);
      expect([VGA_PALETTE.DARK_GRAY, VGA_PALETTE.GRAY]).toContain(pt.color);
    }

    expect(secureSpy).not.toHaveBeenCalled();
    expect(mathSpy).not.toHaveBeenCalled();
  });

  it("is deterministic across fresh instances and preserves private PRNG seed continuity across clear()", () => {
    const a = new TerrainImpactParticles();
    const b = new TerrainImpactParticles();

    a.spawn(100, 120, TERRAIN_MATERIAL.DIRT);
    b.spawn(100, 120, TERRAIN_MATERIAL.DIRT);

    const aFirstSpeeds = a.getParticles().map((p) => p.vx);
    const bFirstSpeeds = b.getParticles().map((p) => p.vx);
    expect(aFirstSpeeds).toEqual(bFirstSpeeds);

    a.clear();
    expect(a.getParticles()).toHaveLength(0);

    a.spawn(100, 120, TERRAIN_MATERIAL.DIRT);
    b.spawn(100, 120, TERRAIN_MATERIAL.DIRT);

    const aSecondSpeeds = a.getParticles().map((p) => p.vx);
    const bSecondSpeeds = b.getParticles().slice(8).map((p) => p.vx);
    expect(aSecondSpeeds).not.toEqual(aFirstSpeeds);
    expect(aSecondSpeeds).toEqual(bSecondSpeeds);
  });

  it("advances and compacts in place only inside drawAndAdvance(ctx) and restores globalAlpha", () => {
    const particles = new TerrainImpactParticles();
    const initialRef = particles.getParticles();

    particles.spawn(100, 120, TERRAIN_MATERIAL.ROCK);
    expect(particles.hasParticles).toBe(true);
    expect(particles.getParticles()).toHaveLength(6);

    const recorder = createRecordingCanvasContext();
    particles.drawAndAdvance(recorder.ctx);
    expect(recorder.getGlobalAlpha()).toBe(1);
    expect(particles.getParticles()).toBe(initialRef);
    expect(particles.getParticles()[0].life).toBe(11);

    for (let i = 1; i < 12; i++) {
      particles.drawAndAdvance(recorder.ctx);
      expect(particles.getParticles()).toBe(initialRef);
      expect(recorder.getGlobalAlpha()).toBe(1);
    }

    expect(particles.getParticles()).toHaveLength(0);
    expect(particles.hasParticles).toBe(false);
  });
});
