import { describe, expect, it, vi } from "vitest";
import { makePlayer, makeRoundMap, makeTank } from "../../__tests__/helpers";
import { createSeededRNG, resetRNG, setRNG } from "../../../utils/random";
import { generateTerrain } from "../generateTerrain";
import { hasSafeRockBase, selectSpawnPositions } from "../spawnPlacement";
import { prepareRound, spawnTerrain, hasValidSpawnRoster, MAX_ROUND_MAP_CANDIDATES } from "../prepareRound";
import type { AiProfile } from "../../../types/player";

function roster(count = 4, profile: AiProfile = "v1-random") {
  return Array.from({ length: count }, (_, i) => makePlayer({
    id: `p${i}`, isHuman: i === 0, aiProfile: i === 0 ? undefined : profile,
    tank: makeTank(`t${i}`, 120 + i * 120, 300, { health: 35, lastHitBy: "p1" }),
  }));
}

describe("ROCK base geometry", () => {
  it("a 24 px base at 212.5 touches 25 columns, including both half columns", () => {
    const map = makeRoundMap();
    const terrain = spawnTerrain(800, map);
    const material = vi.spyOn(terrain, 'getMaterialAt');
    expect(hasSafeRockBase(212.5, terrain)).toBe(true); // [200.5, 224.5)
    expect(material.mock.calls.map(([column]) => column)).toEqual(
      Array.from({ length: 25 }, (_, i) => 200 + i),
    );
    for (const edge of [200, 224]) {
      map.materials.fill('DIRT');
      map.materials[edge] = 'ROCK';
      expect(hasSafeRockBase(212.5, terrain)).toBe(false);
      map.materials.fill('ROCK');
      map.materials[edge] = 'DIRT';
      expect(hasSafeRockBase(212.5, terrain)).toBe(false);
    }
    map.materials.fill('DIRT');
    map.materials[199] = 'ROCK';
    map.materials[224] = 'ROCK';
    expect(hasSafeRockBase(212, terrain)).toBe(true); // [200, 224): no overlap with either ROCK column
  });

  it("counts positive overlap only, including fractions, both edges and an interior island", () => {
    const map = makeRoundMap();
    map.materials.fill("ROCK", 200, 240);
    const terrain = spawnTerrain(800, map);
    expect(hasSafeRockBase(188, terrain)).toBe(true); // exactly touches ROCK
    expect(hasSafeRockBase(188.01, terrain)).toBe(false);
    expect(hasSafeRockBase(212, terrain)).toBe(true);
    expect(hasSafeRockBase(211.99, terrain)).toBe(false);
    expect(hasSafeRockBase(228, terrain)).toBe(true);
    expect(hasSafeRockBase(228.01, terrain)).toBe(false);
    expect(hasSafeRockBase(252, terrain)).toBe(true);
    expect(hasSafeRockBase(251.99, terrain)).toBe(false);
    map.materials.fill("DIRT");
    map.materials[215] = "ROCK";
    expect(hasSafeRockBase(212.5, terrain)).toBe(false);
    expect(hasSafeRockBase(12, terrain)).toBe(true);
    expect(hasSafeRockBase(788, terrain)).toBe(true);
    expect(hasSafeRockBase(11.99, terrain)).toBe(false);
    expect(hasSafeRockBase(788.01, terrain)).toBe(false);
  });

  it("accepts DIRT/SOFT transitions and never draws RNG or mutates terrain", () => {
    const map = makeRoundMap();
    map.materials.fill("SOFT", 200, 400);
    const before = structuredClone(map);
    setRNG({ next: () => { throw new Error("Unexpected RNG"); } });
    try { expect(hasSafeRockBase(200.5, spawnTerrain(800, map))).toBe(true); }
    finally { resetRNG(); }
    expect(map).toEqual(before);
  });
});

describe("complete bounded round preparation", () => {
  it("preserves the extracted generator's values and draw order", () => {
    const rng = createSeededRNG(18);
    const next = vi.fn(() => rng.next());
    const generated = generateTerrain(800, 480, next);
    // Captured from the original generator at HEAD before extracting it.
    const expected = [395.54320652352953, 395.9045232420469, 395.77738569744804,
      409.399283088983, 338.9212844243617, 253.94883633601503];
    [0, 1, 2, 100, 400, 799].forEach((x, i) => expect(generated.heights[x]).toBeCloseTo(expected[i], 10));
    expect(next).toHaveBeenCalledTimes(33);
  });

  it.each(["v1-random", "v2-heuristic", "v3-sniper", "v4-smart"] as const)("seed 18: all counts and both modes with %s", (profile) => {
    for (const local of [true, false]) for (const count of [2, 3, 4]) {
      const players = roster(count, profile);
      const before = structuredClone(players);
      const rng = createSeededRNG(18);
      const result = prepareRound(players, 800, 480, 1, local, () => rng.next());
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      expect(hasValidSpawnRoster(result.map, result.players)).toBe(true);
      expect(players).toEqual(before);
      expect(result.players.map((p) => p.money)).toEqual(players.map((p) => p.money));
      expect(result.players.map((p) => p.inventory)).toEqual(players.map((p) => p.inventory));
      expect(result.players.every((p) => p.tank.health === p.tank.maxHealth && p.tank.lastHitBy === undefined)).toBe(true);
    }
  });

  it("constant 0.5: fallback restarts a bad partial placement and avoids the old mixed base at 104", () => {
    const map = makeRoundMap();
    map.materials.fill("ROCK", 100, 111);
    const terrain = spawnTerrain(800, map);
    const xs = selectSpawnPositions(roster(), terrain, true, () => 0.5);
    expect(xs).not.toBeNull();
    expect(xs?.every((x) => hasSafeRockBase(x, terrain))).toBe(true);
    expect([...xs!].sort((a, b) => a - b)).toEqual([123, 223, 323, 423]);
  });

  it("fallback includes the fractional leftmost admissible centers", () => {
    const map = { heights: new Array<number>(401).fill(300), materials: new Array<"DIRT">(401).fill("DIRT") };
    const xs = selectSpawnPositions(roster(3), spawnTerrain(401, map), true, () => 0.5);
    expect([...xs!].sort((a, b) => a - b)).toEqual([52.13, 152.13, 252.13]);
  });

  it("matches an independent exhaustive search on fragmented maps", () => {
    // Width 400 gives integer margins (52, 348). Material boundaries and the 100 px
    // separation are integers, so any feasible continuous packing has an integer packing.
    const widths = [15, 35, 25, 75, 20, 80, 60, 90];
    let feasible = 0;
    let impossible = 0;
    for (let mask = 0; mask < 2 ** widths.length; mask++) {
      const materials: Array<'ROCK' | 'DIRT'> = widths.flatMap((width, i) =>
        new Array<'ROCK' | 'DIRT'>(width).fill(mask & (1 << i) ? 'ROCK' : 'DIRT'),
      );
      const map = { heights: new Array<number>(400).fill(300), materials };
      // Oracle enumerates column intersections directly, without the production predicate or intervals.
      const candidates = Array.from({ length: 297 }, (_, i) => 52 + i).filter((x) => {
        const touched = materials.filter((_, column) =>
          Math.min(column + 1, x + 12) - Math.max(column, x - 12) > 0,
        );
        return touched.every((value) => value === 'ROCK') || touched.every((value) => value !== 'ROCK');
      });
      for (const count of [2, 3, 4]) {
        const cache = new Map<string, boolean>();
        const search = (start: number, remaining: number): boolean => {
          if (remaining === 0) return true;
          const key = `${start}:${remaining}`;
          const cached = cache.get(key);
          if (cached !== undefined) return cached;
          for (let i = start; i < candidates.length; i++) {
            let next = i + 1;
            while (next < candidates.length && candidates[next] - candidates[i] < 100) next++;
            if (search(next, remaining - 1)) {
              cache.set(key, true);
              return true;
            }
          }
          cache.set(key, false);
          return false;
        };
        const expected = search(0, count);
        if (expected) feasible++; else impossible++;
        const actual = selectSpawnPositions(roster(count), spawnTerrain(400, map), true, () => 0.5);
        expect(actual !== null, `mask=${mask}, count=${count}`).toBe(expected);
        if (actual) {
          const sorted = [...actual].sort((a, b) => a - b);
          expect(sorted.every((x) => candidates.includes(x))).toBe(true);
          expect(sorted.slice(1).every((x, i) => x - sorted[i] >= 100)).toBe(true);
        }
      }
    }
    expect(feasible).toBeGreaterThan(0);
    expect(impossible).toBeGreaterThan(0);
  });

  it("keeps the exact minimum distance when fractional addition rounds downward", () => {
    const map = { heights: new Array<number>(801).fill(300), materials: new Array<"DIRT">(801).fill("DIRT") };
    const xs = selectSpawnPositions(roster(4), spawnTerrain(801, map), true, () => 0.5)!;
    const sorted = [...xs].sort((a, b) => a - b);
    expect(sorted[0]).toBe(801 * 0.13);
    expect(sorted.slice(1).every((x, i) => x - sorted[i] >= 100)).toBe(true);
  });

  it("discards an impossible candidate, applies no partial reset and succeeds on the next", () => {
    const players = roster();
    const before = structuredClone(players);
    const impossible = makeRoundMap();
    impossible.materials = impossible.materials.map((_, x) => x % 2 === 0 ? "ROCK" : "DIRT");
    const generate = vi.fn().mockReturnValueOnce(impossible).mockReturnValue(makeRoundMap());
    const result = prepareRound(players, 800, 480, 3, true, () => 0.5, generate);
    expect(result.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(players).toEqual(before);
  });

  it("stops at 16 total candidates and preserves every input on failure", () => {
    const players = roster();
    const before = structuredClone(players);
    const impossible = makeRoundMap();
    impossible.materials = impossible.materials.map((_, x) => x % 2 === 0 ? "ROCK" : "DIRT");
    const generate = vi.fn().mockReturnValue(impossible);
    expect(prepareRound(players, 800, 480, 1, false, () => 0.5, generate)).toEqual({ ok: false, reason: "ROUND_PREPARATION_FAILED" });
    expect(generate).toHaveBeenCalledTimes(MAX_ROUND_MAP_CANDIDATES);
    expect(players).toEqual(before);
  });

  it("is deterministic with a private RNG independently of global draws", () => {
    const run = () => { const rng = createSeededRNG(18); return prepareRound(roster(), 800, 480, 2, false, () => rng.next()); };
    const first = run();
    setRNG({ next: () => { throw new Error("Global RNG used"); } });
    try { expect(run()).toEqual(first); } finally { resetRNG(); }
  });
});
