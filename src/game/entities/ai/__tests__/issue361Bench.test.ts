import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonical } from "../../../diagnostics/archive";
import { getRNG, setRNG } from "../../../../utils/random";
import { object } from "../../../diagnostics/validate";
import { historicalReplay, loadFixtures, parseFixture, probeSolver, restore, runDecision, useful } from "./issue361Bench";
import type { DecisionFixture } from "./issue361Bench";
import { BALLISTICS_MAX_STEPS, EXPERT_OWN_OPEN_FLIGHT_MAX_STEPS, simulateShot } from "../BallisticsSimulator";
import { solveExpertAim } from "../expertAim";
import { resolvePhysicalShot } from "../physicalShotForecast";

const fixtures = loadFixtures();
const previous = getRNG();
beforeEach(() => vi.stubEnv("DEV", false));
afterEach(() => { setRNG(previous); vi.unstubAllEnvs(); });

describe("#361 archived physical certificates (real physics)", () => {
  it.each(fixtures)("replays $id without divergence and checks its retained certificate", fixture => {
    const result = historicalReplay(fixture);
    expect(result).toMatchObject({ complete: true, random: "recorded-strict", physicalDivergence: null, economicDivergence: null });
    expect(result.damage.filter(d => d.victimId !== fixture.shooterId)).toEqual([]);
    const f = restore(fixture);
    expect(result.hits.some(h => f.terrain.getMaterialAt(h.x) === "ROCK" && Math.abs(h.x - f.shooter.tank.position.x) <= 45)).toBe(true);
    if (fixture.witness) {
      const witness = runWitness(fixture);
      expect(witness.complete).toBe(true);
      expect(witness.hits.some(h => h.directTargetId === fixture.targetId)).toBe(true);
      expect(useful(witness, fixture.targetId)).toBe(true);
      expect(witness.survivors).toContain(fixture.shooterId);
    }
  });
});

// Kept outside runDecision so this certificate test does not depend on AI selection.
function runWitness(fixture: DecisionFixture) {
  const f = restore(fixture);
  if (!fixture.witness) throw new Error("Witness required");
  return resolvePhysicalShot(f.state, f.terrain, f.shooter, "MISSILE", fixture.witness, { localMatch: true });
}

describe("#361 real decision isolation and diagnostics", () => {
  it.each(fixtures)("executes $id deterministically, with fresh state and restored RNG", async fixture => {
    const input = canonical(fixture), rng = getRNG();
    const first = await runDecision(fixture), second = await runDecision(fixture);
    expect(getRNG()).toBe(rng);
    expect(canonical(fixture)).toBe(input);
    expect(first.rng.kind).toBe("controlled-seeded-not-historical");
    expect(first.rng.draws.length).toBeGreaterThanOrEqual(3);
    expect(first.rng.draws.length).toBeLessThan(64);
    expect(first.observation.initial?.memory).toEqual(fixture.memory);
    expect(first.observation.initial?.state).toEqual(fixture.state);
    expect(first.selectedTargets).toEqual([first.observation.target?.playerId]);
    expect(first.memoryAfter?.currentTargetId).toBe(first.observation.target?.playerId);
    expect(first.evaluatedPhysics.complete).toBe(true);
    expect(first.finalPhysics.complete).toBe(true);
    const comparable = (r: typeof first) => ({ command: r.command, evaluated: r.observation.evaluated,
      target: r.observation.target, phase: r.phase, candidateCount: r.candidateCount,
      memory: r.memoryAfter, draws: r.rng.draws, physics: r.evaluatedPhysics });
    expect(comparable(second)).toEqual(comparable(first));
    expect(first.witnessUseful).toBe(fixture.witness !== null);
  }, 15_000);

  it("isolates solver ceiling/arc probes without RNG or input mutation", () => {
    const fixture = fixtures.find(f => f.id === "d-to-b-95")!;
    const input = canonical(fixture);
    setRNG({ next() { throw new Error("Solver probe consumed game RNG"); } });
    for (const power of [95, 99] as const) for (const variant of ["full", "low", "high"] as const) {
      const probe = probeSolver(fixture, power, variant);
      expect(probe.command.power).toBeGreaterThanOrEqual(25);
      expect(probe.command.power).toBeLessThanOrEqual(power);
      expect(probe.physics.complete).toBe(true);
    }
    expect(canonical(fixture)).toBe(input);
  });

  it("treats a missing witness as unknown, not as proof of inaccessibility", async () => {
    const fixture = fixtures.find(f => f.id === "no-witness-d-to-a")!;
    const result = await runDecision(fixture);
    expect(result.witnessPhysics).toBeNull();
    expect(result.witnessUseful).toBe(false);
    expect(result.rng.draws.length).toBeLessThan(64);
    expect(result.evaluatedPhysics.complete).toBe(true);
  });

  it("can run a controlled wind variant without reusing its original witness as a certificate", async () => {
    const fixture = fixtures[0];
    const variant = await runDecision(fixture, 0x362, 20);
    expect(variant.observation.environment?.windForce).toBe(20);
    expect(fixture.state.windForce).toBe(0);
    expect(variant.rng.seed).toBe(0x362);
    expect(variant.witnessPhysics).not.toBeNull(); // Re-evaluated on the changed wind, not assumed useful.
  });

  it("rejects corrupted terrain and a mismatched decision state before strategy execution", () => {
    const raw: unknown = JSON.parse(readFileSync(join(process.cwd(), "src/game/entities/ai/__tests__/fixtures/issue361/a-to-c-95.json"), "utf8"));
    if (!object(raw)) throw new Error("Fixture object required");
    const fixture = fixtures.find(f => f.id === "a-to-c-95")!;
    const badArchive = structuredClone(fixture.archive); badArchive.terrains[0].heights[0] += 1;
    expect(() => parseFixture({ ...raw, archive: badArchive })).toThrow("TERRAIN_INTEGRITY_FAILED");
    expect(() => parseFixture({ ...raw, initial: { state: { ...fixture.state, windForce: 1 }, memory: fixture.memory } }))
      .toThrow("decision/pre-shot physics mismatch");
    expect(() => parseFixture({ ...raw, initial: { state: fixture.state, memory: { currentTargetAttempts: -1 } } }))
      .toThrow("aim memory");
  });
});

const OPEN_HORIZON_CASES = new Set(["a-to-c-95", "d-to-b-95"]);
const RESIDUAL_WITNESS_CASES = new Set(["a-to-d-99", "d-to-a-99"]);

describe("#361 open-flight horizon for local EXPERT own shots", () => {
  it.each(fixtures.filter(f => OPEN_HORIZON_CASES.has(f.id)))(
    "keeps the $id witness in flight at 420 steps and resolves it by 600",
    fixture => {
      const f = restore(fixture);
      const witness = fixture.witness;
      if (!witness) throw new Error("Witness required");
      const origin = { x: f.shooter.tank.position.x, y: f.shooter.tank.position.y };
      const truncated = simulateShot(origin.x, origin.y, witness.angle, witness.power,
        f.state.windForce, f.state.gravity, f.terrain, BALLISTICS_MAX_STEPS);
      const extended = simulateShot(origin.x, origin.y, witness.angle, witness.power,
        f.state.windForce, f.state.gravity, f.terrain, EXPERT_OWN_OPEN_FLIGHT_MAX_STEPS);
      const settled = resolvePhysicalShot(f.state, f.terrain, f.shooter, "MISSILE", witness, { localMatch: true });

      expect(truncated).toMatchObject({ complete: false, steps: BALLISTICS_MAX_STEPS });
      expect(extended.complete).toBe(true);
      expect(extended.steps).toBeGreaterThan(BALLISTICS_MAX_STEPS);
      expect(extended.steps).toBeLessThanOrEqual(EXPERT_OWN_OPEN_FLIGHT_MAX_STEPS);
      expect(settled.complete).toBe(true);
      if (settled.complete) expect(settled.steps).not.toBe(extended.steps);
    },
  );

  it.each(fixtures.filter(f => OPEN_HORIZON_CASES.has(f.id)))(
    "finds a useful power<=95 solver proposal for $id",
    fixture => {
      const f = restore(fixture);
      const solution = solveExpertAim(
        f.shooter, f.target.tank.position.x, f.target.tank.position.y - 7.5,
        f.state.windForce, f.state.gravity, f.terrain, "MISSILE",
        { variant: "high", penalizeProximity: false, extendOpenFlight: true },
      );
      const command = { ...solution.command, weaponId: "MISSILE" as const };
      const physics = resolvePhysicalShot(f.state, f.terrain, f.shooter, "MISSILE", command, { localMatch: true });

      expect(solution.complete).toBe(true);
      expect(solution.command.power).toBeLessThanOrEqual(95);
      expect(useful(physics, fixture.targetId)).toBe(true);
      expect(physics.survivors).toContain(fixture.shooterId);
    },
  );

  it.each(fixtures.filter(f => OPEN_HORIZON_CASES.has(f.id)))(
    "finds a useful evaluated shot for $id",
    async fixture => {
      const result = await runDecision(fixture);
      const opponents = fixture.state.players.filter(p => p.id !== fixture.shooterId && !p.tank.isDead);
      expect(result.observation.evaluated?.power).toBeLessThanOrEqual(95);
      expect(opponents.some(p => useful(result.evaluatedPhysics, p.id))).toBe(true);
    },
    15_000,
  );

  it("ends no-witness-d-to-a with an unsuccessful search", async () => {
    const fixture = fixtures.find(f => f.id === "no-witness-d-to-a");
    if (!fixture) throw new Error("Fixture required");
    const result = await runDecision(fixture);
    const opponents = fixture.state.players.filter(p => p.id !== fixture.shooterId && !p.tank.isDead);
    expect(opponents.some(p => useful(result.evaluatedPhysics, p.id))).toBe(false);
    expect(result.usefulOnHistoricalTarget).toBe(false);
    expect(result.phase).toBe("REPLI");
    expect(result.candidateCount).toBe(0);
    expect(result.observation.reason).toBe("ordre stable des armes, des points ou des arcs");
  }, 15_000);
});

describe("#400 residual witnesses — expected failures, not an approved game rule", () => {
  // Power-99 witnesses stay out of #361. An unexpected pass must be promoted only with #400.
  it.fails.each(fixtures.filter(f => RESIDUAL_WITNESS_CASES.has(f.id)))(
    "finds a useful evaluated shot for $id",
    async fixture => {
      const result = await runDecision(fixture);
      const opponents = fixture.state.players.filter(p => p.id !== fixture.shooterId && !p.tank.isDead);
      expect(opponents.some(p => useful(result.evaluatedPhysics, p.id))).toBe(true);
    },
  );
});
