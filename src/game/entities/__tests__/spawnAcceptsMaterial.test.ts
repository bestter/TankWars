import { describe, it, expect } from "vitest";
import { spawnAcceptsMaterial, TERRAIN_MATERIAL } from "../../../types/terrain";

describe("spawnAcceptsMaterial", () => {
  it("always accepts dirt", () => {
    expect(spawnAcceptsMaterial(TERRAIN_MATERIAL.DIRT, true, true, () => 0)).toBe(true);
    expect(spawnAcceptsMaterial(TERRAIN_MATERIAL.DIRT, false, false, () => 0)).toBe(true);
  });

  it("rejects 25% of SOFT samples for local humans only", () => {
    expect(spawnAcceptsMaterial(TERRAIN_MATERIAL.SOFT, true, true, () => 0)).toBe(false);
    expect(spawnAcceptsMaterial(TERRAIN_MATERIAL.SOFT, true, true, () => 0.24)).toBe(false);
    expect(spawnAcceptsMaterial(TERRAIN_MATERIAL.SOFT, true, true, () => 0.25)).toBe(true);
    expect(spawnAcceptsMaterial(TERRAIN_MATERIAL.SOFT, true, false, () => 0)).toBe(true);
    expect(spawnAcceptsMaterial(TERRAIN_MATERIAL.SOFT, false, true, () => 0)).toBe(true);
  });

  it("rejects 25% of ROCK samples for AI in every mode", () => {
    expect(spawnAcceptsMaterial(TERRAIN_MATERIAL.ROCK, false, true, () => 0)).toBe(false);
    expect(spawnAcceptsMaterial(TERRAIN_MATERIAL.ROCK, false, false, () => 0)).toBe(false);
    expect(spawnAcceptsMaterial(TERRAIN_MATERIAL.ROCK, false, false, () => 0.25)).toBe(true);
    expect(spawnAcceptsMaterial(TERRAIN_MATERIAL.ROCK, true, true, () => 0)).toBe(true);
    expect(spawnAcceptsMaterial(TERRAIN_MATERIAL.ROCK, true, false, () => 0)).toBe(true);
  });
});
