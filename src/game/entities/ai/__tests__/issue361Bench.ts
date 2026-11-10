/** Offline decision bench only. Never imported by the client or the Worker. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FireCommand, GameState } from "../../../../types/game";
import type { AIObservation } from "../../../observation";
import { canonical } from "../../../diagnostics/archive";
import { object, validateArchive } from "../../../diagnostics/validate";
import { replayShot } from "../../../diagnostics/replay";
import { isPlayers } from "../../../online/protocol";
import { TerrainManager } from "../../../engine/Terrain";
import { createSeededRNG, getRNG, setRNG } from "../../../../utils/random";
import { AISmartStrategy } from "../AISmartStrategy";
import type { AimMemory } from "../aimMemory";
import { resolvePhysicalShot, type PhysicalResolution } from "../physicalShotForecast";
import { searchBallisticSolution } from "../BallisticsSimulator";
import { finalizeAdvancedAim } from "../aimCorruption";
import { aimCone, type AimVariant } from "../aimSearch";

export const CASE_IDS = ["a-to-d-99", "d-to-a-99", "a-to-c-95", "d-to-b-95", "no-witness-d-to-a"] as const;
export const DEFAULT_SEED = 0x361;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const integer = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v) && v >= 0;
function requireValue(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(`INVALID_361_FIXTURE: ${reason}`);
}
function command(value: unknown): FireCommand {
  requireValue(object(value) && finite(value.angle) && value.angle >= 0 && value.angle <= 180 &&
    integer(value.power) && value.power >= 1 && value.power <= 99 && value.weaponId === "MISSILE", "MISSILE command");
  return { angle: value.angle, power: value.power, weaponId: "MISSILE" };
}
function memory(value: unknown): AimMemory | null {
  if (value === null) return null;
  requireValue(object(value) && integer(value.currentTargetAttempts) &&
    (value.currentTargetId === undefined || typeof value.currentTargetId === "string") &&
    (value.lastRoundNumber === undefined || integer(value.lastRoundNumber)), "aim memory");
  return { currentTargetAttempts: value.currentTargetAttempts,
    ...(typeof value.currentTargetId === "string" && { currentTargetId: value.currentTargetId }),
    ...(typeof value.lastRoundNumber === "number" && { lastRoundNumber: value.lastRoundNumber }) };
}
function initialState(value: unknown): GameState {
  requireValue(object(value) && value.phase === "COMBAT" && isPlayers(value.players) &&
    integer(value.currentPlayerIndex) && value.currentPlayerIndex < value.players.length && integer(value.turn) &&
    finite(value.gravity) && value.gravity > 0 && finite(value.windForce) && integer(value.roundNumber) &&
    object(value.localShotContext) && integer(value.localShotContext.playerCountAtMatchStart) &&
    value.localShotContext.playerCountAtMatchStart >= 2 && value.localShotContext.playerCountAtMatchStart <= 4 &&
    typeof value.localShotContext.isFirstShotOfRound === "boolean", "initial combat state");
  return { phase: "COMBAT", players: structuredClone(value.players), currentPlayerIndex: value.currentPlayerIndex,
    turn: value.turn, gravity: value.gravity, windForce: value.windForce, roundNumber: value.roundNumber,
    localShotContext: { playerCountAtMatchStart: value.localShotContext.playerCountAtMatchStart,
      isFirstShotOfRound: value.localShotContext.isFirstShotOfRound } };
}
function physicalState(state: GameState) {
  return { gravity: state.gravity, wind: state.windForce, players: state.players.map(p => ({ id: p.id,
    position: p.tank.position, health: p.tank.health, shield: p.tank.shield, dead: p.tank.isDead })) };
}

export function parseFixture(value: unknown) {
  requireValue(object(value) && value.schemaVersion === 1 && typeof value.id === "string" &&
    object(value.source) && typeof value.source.shotKey === "string" && object(value.initial) &&
    object(value.historical) && object(value.historical.target) && typeof value.historical.target.playerId === "string" &&
    typeof value.historical.playerId === "string" && typeof value.historical.reason === "string", "envelope");
  for (const field of ["archiveSha256", "decisionSha256"])
    requireValue(typeof value.source[field] === "string" && /^[a-f0-9]{64}$/.test(value.source[field]), "source SHA-256");
  const archive = validateArchive(value.archive);
  const shotKey = value.source.shotKey, targetId = value.historical.target.playerId;
  const before = archive.records.find(r => r.shotKey === shotKey && r.input.kind === "pre-shot");
  requireValue(before?.input.kind === "pre-shot" && before.input.shot.playerId === value.historical.playerId, "shot identity");
  const state = initialState(value.initial.state);
  requireValue(canonical(physicalState(state)) === canonical(physicalState(before.input.snapshot.state)), "decision/pre-shot physics mismatch");
  const terrainId = before.input.snapshot.terrainId;
  const terrain = archive.terrains.find(t => t.id === terrainId);
  requireValue(terrain && state.players.some(p => p.id === targetId && !p.tank.isDead), "terrain/target");
  const final = command(value.historical.final);
  requireValue(canonical(final) === canonical(before.input.shot.command), "recorded command mismatch");
  return { id: value.id, archive, shotKey: value.source.shotKey, state, terrain,
    memory: memory(value.initial.memory), shooterId: value.historical.playerId, targetId: value.historical.target.playerId,
    historical: { evaluated: command(value.historical.evaluated), final, reason: value.historical.reason },
    witness: value.witness === null ? null : command({ ...(object(value.witness) ? value.witness : {}), weaponId: "MISSILE" }) };
}
export type DecisionFixture = ReturnType<typeof parseFixture>;
export function loadFixtures(directory = join(process.cwd(), "src/game/entities/ai/__tests__/fixtures/issue361")) {
  return CASE_IDS.map(id => parseFixture(JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8")) as unknown));
}
export function restore(fixture: DecisionFixture, wind = fixture.state.windForce) {
  const state = structuredClone(fixture.state); state.windForce = wind;
  const terrain = new TerrainManager(fixture.terrain.width, fixture.terrain.height);
  terrain.loadHeights([...fixture.terrain.heights], [...fixture.terrain.materials]);
  const shooter = state.players.find(p => p.id === fixture.shooterId);
  const target = state.players.find(p => p.id === fixture.targetId);
  requireValue(shooter && target, "restored roster");
  return { state, terrain, shooter, target };
}
export function useful(result: PhysicalResolution, playerId: string): boolean {
  return result.complete && (result.damage.some(d => d.victimId === playerId && (d.healthDamageMilli > 0 || d.shieldLostMilli > 0)) ||
    result.destruction.some(d => d.victimId === playerId));
}
function forecast(fixture: DecisionFixture, shot: FireCommand, wind: number) {
  const f = restore(fixture, wind);
  return resolvePhysicalShot(f.state, f.terrain, f.shooter, shot.weaponId, shot, { localMatch: true });
}

/** Full real strategy, including real planner, offsets, reaction and gaffe. Only RNG is injected. */
export async function runDecision(fixture: DecisionFixture, seed = DEFAULT_SEED, wind = fixture.state.windForce) {
  const f = restore(fixture, wind), strategy = new AISmartStrategy();
  // Test-only access, same seam as expertDecisionAim.test.ts. No production setter is introduced.
  const memories = (strategy as unknown as { memories: Map<string, AimMemory> }).memories;
  if (fixture.memory) memories.set(f.shooter.id, structuredClone(fixture.memory));
  const previous = getRNG(), rng = createSeededRNG(seed), draws: number[] = [], observations: AIObservation[] = [];
  const selectedTargets: string[] = [];
  strategy.onDecisionObserved = value => observations.push(value);
  strategy.onTargetSelected = (_player, target) => selectedTargets.push(target);
  const started = performance.now();
  let shot: FireCommand;
  try {
    setRNG({ next() {
      if (draws.length >= 64) throw new Error("361_DECISION_RNG_BUDGET");
      const value = rng.next(); draws.push(value); return value;
    } });
    const result = await strategy.executeTurn(f.shooter.tank.id, f.state, f.terrain);
    shot = { ...result, weaponId: result.weaponId ?? "MISSILE" };
  } finally { setRNG(previous); }
  const elapsedMs = performance.now() - started;
  requireValue(observations.length === 1 && selectedTargets.length === 1, "decision callbacks must occur once");
  const observation = observations[0];
  const evaluated = observation.evaluated;
  requireValue(evaluated, "evaluated command missing");
  // Forecast from the untouched initial state, not the strategy-mutated weapon/reaction state.
  const evaluatedPhysics = forecast(fixture, evaluated, wind), finalPhysics = forecast(fixture, shot, wind);
  const witnessPhysics = fixture.witness ? forecast(fixture, fixture.witness, wind) : null;
  const diagnostics = object(observation.diagnostics) ? observation.diagnostics : {};
  const trace = object(diagnostics.planner) ? diagnostics.planner : {};
  return { id: fixture.id, shotKey: fixture.shotKey, rng: { kind: "controlled-seeded-not-historical", seed, draws }, wind,
    command: shot, observation, selectedTargets, memoryAfter: structuredClone(memories.get(f.shooter.id)),
    phase: trace.phase, candidateCount: trace.candidateCount, elapsedMs,
    evaluatedPhysics, finalPhysics, witnessPhysics,
    usefulOnHistoricalTarget: useful(evaluatedPhysics, fixture.targetId),
    witnessUseful: witnessPhysics !== null && useful(witnessPhysics, fixture.targetId),
    nearbyRock: evaluatedPhysics.hits.some(h => f.terrain.getMaterialAt(h.x) === "ROCK" && Math.abs(h.x - f.shooter.tank.position.x) <= 45) };
}

/** Isolated solver experiment; never changes EXPERT's actual 95 ceiling or ranking. */
export function probeSolver(fixture: DecisionFixture, powerHi: 95 | 99, variant: AimVariant) {
  const f = restore(fixture), right = f.target.tank.position.x > f.shooter.tank.position.x;
  const result = searchBallisticSolution({ sx: f.shooter.tank.position.x, sy: f.shooter.tank.position.y,
    tx: f.target.tank.position.x, ty: f.target.tank.position.y - 7.5, gravity: f.state.gravity, wind: f.state.windForce,
    terrain: f.terrain, isRight: right, ...aimCone(right, right ? 15 : 95, right ? 85 : 165, variant),
    projectFallbackToCone: variant !== "full", coarseStep: 5, fineStep: 1.5, fineWindow: 4,
    powerLo: 20, powerHi, powerIterations: 10, weaponId: "MISSILE", obstaclePenaltyHigh: 10000,
    obstaclePenaltyLow: 20, earlyExitError: 4 });
  const shot = { ...finalizeAdvancedAim({ angle: result.angle, power: Math.max(25, Math.min(powerHi, result.power)) }), weaponId: "MISSILE" as const };
  const physics = forecast(fixture, shot, f.state.windForce);
  return { powerHi, variant, command: shot, solverComplete: result.complete, error: result.err,
    physics, useful: useful(physics, fixture.targetId) };
}
export function historicalReplay(fixture: DecisionFixture) { return replayShot(fixture.archive, fixture.shotKey); }
