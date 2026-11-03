import { TerrainManager } from "../engine/Terrain";
import { PhysicsEngine, type ProjectileHitEvent } from "../engine/PhysicsEngine";
import { BALLISTICS_DT, launchFromBarrel } from "../engine/projectileMotion";
import { TankManager } from "../entities/TankManager";
import { calculateShotRewards, type CombatDamageEvent, type CombatDestructionEvent } from "../economy/shotRewards";
import { consumeWeaponForFire } from "../shop/shopTransaction";
import type { PhysicalObservation } from "../observation";
import type { FireCommand } from "../../types/game";
import { ALL_WEAPON_IDS } from "../../types/weapon";
import { canonical } from "./archive";
import { validateArchive } from "./validate";
import type { ArchiveRecord } from "./types";

export interface ReplayResult {
  launchSource: "recorded-projectile" | "legacy-command-reconstruction" | "alternative-command";
  complete: boolean; mode: "original" | "alternative"; random: "recorded-strict" | "fixed-0.5";
  steps: number; drawsConsumed: number; physicalDivergence: string | null; economicDivergence: string | null;
  restoredClusterStates: number;
  hits: ProjectileHitEvent[]; damage: CombatDamageEvent[]; destruction: CombatDestructionEvent[];
  heights: number[]; materials: string[]; players: import("../../types/player").Player[];
}

/** Transcendental last bits can differ between browser and Node V8 builds.
 * Restore the recorded split state only after exact identity/draw/spread checks and an ULP-sized bound.
 * The real PhysicsEngine has already created this submunition when its observation is emitted.
 */
function restoreClusterState(actual: PhysicalObservation, expected: PhysicalObservation, physics: PhysicsEngine): boolean {
  if (actual.kind !== "cluster" || expected.kind !== "cluster") return false;
  const derived = new Set(["subSpeed", "vx", "vy", "x", "y"]);
  const core = (event: PhysicalObservation) => ({ ...event,
    parameters: Object.fromEntries(Object.entries(event.parameters).filter(([key]) => !derived.has(key))) });
  if (canonical(core(actual)) !== canonical(core(expected))) return false;
  const speed = Math.max(1, Number(actual.parameters.subSpeed), Number(expected.parameters.subSpeed));
  for (const key of derived) {
    const a = actual.parameters[key], b = expected.parameters[key];
    if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) return false;
    const scale = Math.max(1, Math.abs(a), Math.abs(b), key === "vx" || key === "vy" ? speed : 0);
    if (Math.abs(a - b) > 4 * Number.EPSILON * scale) return false;
  }
  const projectile = physics.getProjectiles().find(p => p.shotId === expected.shotId && p.munitionId === expected.munitionId && p.isSubmunition && p.weaponId === "CLUSTER");
  if (!projectile) return false;
  Object.assign(projectile, { x: expected.parameters.x, y: expected.parameters.y, vx: expected.parameters.vx, vy: expected.parameters.vy });
  return true;
}
function firstDifference(actual: unknown, expected: unknown, path: string): string | null {
  if (canonical(actual) === canonical(expected)) return null;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
      const difference = firstDifference(actual[i], expected[i], `${path}[${i}]`); if (difference) return difference;
    }
  }
  if (actual && expected && typeof actual === "object" && typeof expected === "object") {
    const a = actual as Record<string, unknown>, b = expected as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const difference = firstDifference(a[key], b[key], `${path}.${key}`); if (difference) return difference;
    }
  }
  return path;
}

/** A single isolated physical shot. Never runs a strategy or installs a global RNG. */
export function replayShot(value: unknown, shotKey: string, alternative?: FireCommand, maxSteps?: number): ReplayResult {
  const archive = validateArchive(value);
  const records = archive.records.filter(r => r.shotKey === shotKey);
  const before = records.find(r => r.input.kind === "pre-shot")?.input;
  if (before?.kind !== "pre-shot") throw new Error("SHOT_NOT_FOUND");
  const launched = records.some(r => r.input.kind === "combat" && r.input.event.kind === "shot-launched");
  if (!launched) throw new Error("SHOT_NOT_CONFIRMED");
  if (before.snapshot.inProgress || before.snapshot.projectiles.length) throw new Error("UNSTABLE_SHOT_ORIGIN");
  const command = alternative ?? before.shot.command;
  if (!ALL_WEAPON_IDS.includes(command.weaponId)) throw new Error("UNKNOWN_ALTERNATIVE_WEAPON");
  const players = structuredClone(before.snapshot.state.players);
  const playersById = new Map(players.map(p => [p.id, p]));
  const actor = playersById.get(before.shot.playerId);
  if (!actor || actor.tank.isDead) throw new Error("INVALID_REPLAY_ACTOR");
  if (!Number.isFinite(command.angle) || command.angle < 0 || command.angle > 180 || !Number.isInteger(command.power) || command.power < 1 || command.power > 99) throw new Error("INVALID_ALTERNATIVE_COMMAND");
  if (alternative) Object.assign(actor.tank, { angle: command.angle, power: command.power, currentWeapon: command.weaponId });
  const consumed = consumeWeaponForFire(actor, command.weaponId);
  if (!consumed.ok) throw new Error("WEAPON_UNAVAILABLE");
  const terrainData = archive.terrains.find(t => t.id === before.snapshot.terrainId)!;
  const terrain = new TerrainManager(terrainData.width, terrainData.height);
  terrain.loadHeights([...terrainData.heights], [...terrainData.materials]);
  const tanks = new TankManager(); tanks.setPlayers(players); tanks.restorePhysicsState(before.snapshot.motion);
  const shotId = before.shot.shotId;
  tanks.beginShotAttribution(shotId, actor.id, command.weaponId);
  // Consumption follows accepted launch in the real engine, before the first physical step.
  actor.inventory = consumed.player.inventory; actor.tank.currentWeapon = consumed.player.tank.currentWeapon;
  const tape = records.flatMap(r => r.input.kind === "combat" && r.input.event.kind === "physical" ? [r.input.event.observation] : []);
  const draws = tape.flatMap(o => o.draws);
  let drawIndex = 0, observationIndex = 0, restoredClusterStates = 0;
  const physics = new PhysicsEngine(alternative ? () => 0.5 : () => {
    if (drawIndex >= draws.length) throw new Error("PHYSICAL_TAPE_EXHAUSTED");
    return draws[drawIndex++];
  }, false);
  physics.setLocalMatch(before.snapshot.localMatch);
  physics.onPhysicalObserved = (observation: PhysicalObservation) => {
    if (alternative) return;
    const expected = tape[observationIndex++];
    if (!expected) throw new Error(`PHYSICAL_TAPE_MISALIGNED:${observationIndex}`);
    if (canonical(observation) !== canonical(expected)) {
      if (!restoreClusterState(observation, expected, physics)) throw new Error(`PHYSICAL_TAPE_MISALIGNED:${observationIndex}`);
      restoredClusterStates++;
    }
  };
  const hits: ProjectileHitEvent[] = [], damage: CombatDamageEvent[] = [], destruction: CombatDestructionEvent[] = [];
  const actualImpacts: Array<{ hit: ProjectileHitEvent; step: number; material: string }> = [];
  let steps = 0;
  physics.onProjectileHit = hit => { hits.push(structuredClone(hit)); actualImpacts.push({ hit: structuredClone(hit), step: before.snapshot.step + steps, material: terrain.getMaterialAt(hit.x) }); };
  tanks.onDamageApplied = event => damage.push(structuredClone(event));
  tanks.onTankDestroyed = event => destruction.push(structuredClone(event));
  const launch = launchFromBarrel(before.shot.origin.x, before.shot.origin.y, command.angle);
  physics.launchProjectile(launch.x, launch.y, command.angle, command.power, command.weaponId, actor.id, actor.tank.color, { shotId, munitionId: 0 });
  const actualLaunch = records.find(r => r.input.kind === "projectile-launched")?.input;
  if (!alternative && actualLaunch?.kind === "projectile-launched") {
    if (actualLaunch.projectile.shotId !== shotId || actualLaunch.projectile.ownerId !== actor.id ||
      actualLaunch.projectile.weaponId !== command.weaponId || actualLaunch.step !== before.snapshot.step) throw new Error("LAUNCH_IDENTITY_MISMATCH");
    Object.assign(physics.getProjectiles()[0], structuredClone(actualLaunch.projectile));
  }
  const expected = records.find(r => r.input.kind === "settled")?.input;
  const limit = maxSteps ?? (alternative ? 2400 : expected?.kind === "settled" ? Math.max(1, expected.snapshot.step - before.snapshot.step) : 2400);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) throw new Error("INVALID_REPLAY_STEP_LIMIT");
  let complete = false;
  for (steps = 1; steps <= limit; steps++) {
    physics.updateProjectiles(BALLISTICS_DT, before.snapshot.state.gravity, before.snapshot.state.windForce, terrain, tanks);
    tanks.applyGravity(BALLISTICS_DT, terrain); tanks.checkTankBurial(terrain);
    if (!physics.hasActiveProjectiles() && !tanks.anyTankIsFalling()) { complete = true; break; }
  }
  steps = Math.min(steps, limit);
  if (!alternative && complete && (drawIndex !== draws.length || observationIndex !== tape.length)) throw new Error("PHYSICAL_TAPE_SURPLUS");
  let physicalDivergence: string | null = null, economicDivergence: string | null = null;
  const heights = [...terrain.getHeightmap()], materials = [...terrain.getMaterials()];
  const rewards = complete ? calculateShotRewards({ shotId, shooterId: actor.id, weaponId: command.weaponId,
    playerCountAtMatchStart: before.snapshot.initialPlayerCount, isFirstShotOfRound: before.shot.isFirstShotOfRound,
    aliveBeforeShot: before.snapshot.state.players.filter(p => !p.tank.isDead).map(p => p.id),
    survivorsAfterShot: tanks.getAlivePlayers().map(p => p.id), damageEvents: damage, destructionEvents: destruction }) : null;
  if (rewards) for (const award of rewards.awards) {
    const player = playersById.get(award.playerId)!; player.money += award.amount;
  }
  if (!alternative && expected?.kind === "settled") {
    const expectedTerrain = archive.terrains.find(t => t.id === expected.snapshot.terrainId)!;
    const expectedImpacts = records.flatMap(r => r.input.kind === "impact" ? [{ hit: r.input.hit, step: r.input.step, material: r.input.material }] : []);
    const expectedDamage = combatDetails(records, "damage"), expectedDestruction = combatDetails(records, "destruction");
    physicalDivergence = firstDifference(actualImpacts, expectedImpacts, "impacts") ?? firstDifference(damage, expectedDamage, "damage") ??
      firstDifference(destruction, expectedDestruction, "destruction") ?? firstDifference(heights, expectedTerrain.heights, "terrain.heights") ??
      firstDifference(materials, expectedTerrain.materials, "terrain.materials") ??
      firstDifference(players.map(p => ({ ...p, money: undefined })), expected.snapshot.state.players.map(p => ({ ...p, money: undefined })), "players");
    const reported = records.find(r => r.input.kind === "combat" && r.input.event.kind === "shot-result")?.input;
    economicDivergence = firstDifference(players.map(p => p.money), expected.snapshot.state.players.map(p => p.money), "balances") ??
      (reported?.kind === "combat" && reported.event.kind === "shot-result" ? firstDifference(rewards?.awards, reported.event.awards, "awards") : "missing-economic-result");
  }
  return { launchSource: alternative ? "alternative-command" : actualLaunch?.kind === "projectile-launched" ? "recorded-projectile" : "legacy-command-reconstruction",
    complete: complete && (Boolean(alternative) || expected?.kind === "settled"), mode: alternative ? "alternative" : "original",
    random: alternative ? "fixed-0.5" : "recorded-strict", steps, drawsConsumed: drawIndex, restoredClusterStates,
    physicalDivergence, economicDivergence, hits, damage, destruction, heights, materials, players };
}
function combatDetails(records: ArchiveRecord[], kind: "damage" | "destruction"): unknown[] {
  return records.flatMap(r => r.input.kind === "combat" && r.input.event.kind === kind ? [r.input.event.event] : []);
}
