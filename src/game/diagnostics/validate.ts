import { isPlayers } from "../online/protocol";
import { ALL_WEAPON_IDS } from "../../types/weapon";
import { canonical, fingerprint, RULES_ID, sealArchive } from "./archive";
import type { ShotArchive, StoredState } from "./types";

const PROJECTILE_KEYS = new Set(["shotId", "munitionId", "x", "y", "vx", "vy", "weaponId", "ownerId", "ownerColor", "isSubmunition", "lastVy", "initialAngle", "initialPower", "bounceCount", "hasLeftOwnerHitbox"]);
const EVENT_KINDS = new Set(["pre-shot", "projectile-launched", "settled", "current", "interrupted", "impact", "combat", "advisor", "boundary"]);

export function object(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }
function requireValue(ok: unknown, code: string): asserts ok { if (!ok) throw new Error(code); }
function finite(v: unknown): v is number { return typeof v === "number" && Number.isFinite(v); }
function integer(v: unknown): v is number { return finite(v) && Number.isSafeInteger(v) && v >= 0; }
function point(v: unknown): boolean { return object(v) && finite(v.x) && finite(v.y); }
function projectile(p: unknown): boolean {
  if (!object(p) || !integer(p.shotId) || !integer(p.munitionId) || !point(p) || !finite(p.vx) || !finite(p.vy) ||
    Math.abs(p.vx) > 100000 || Math.abs(p.vy) > 100000 || !ALL_WEAPON_IDS.includes(p.weaponId as typeof ALL_WEAPON_IDS[number])) return false;
  return ["lastVy", "initialAngle", "initialPower", "bounceCount"].every(k => p[k] === undefined || finite(p[k])) &&
    ["isSubmunition", "hasLeftOwnerHitbox"].every(k => p[k] === undefined || typeof p[k] === "boolean") &&
    ["ownerId", "ownerColor"].every(k => p[k] === undefined || typeof p[k] === "string") &&
    Object.keys(p).every(k => PROJECTILE_KEYS.has(k));
}
function command(v: unknown): boolean {
  return object(v) && ALL_WEAPON_IDS.includes(v.weaponId as typeof ALL_WEAPON_IDS[number]) &&
    finite(v.angle) && v.angle >= 0 && v.angle <= 180 && finite(v.power) && v.power >= 0 && v.power <= 100;
}
function finiteTree(v: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.length <= 1_000_000 && v.every(x => finiteTree(x, depth + 1));
  if (object(v)) return Object.values(v).every(x => finiteTree(x, depth + 1));
  return v === null || v === undefined || typeof v === "boolean" || typeof v === "string";
}
function state(v: unknown): asserts v is StoredState {
  requireValue(object(v) && object(v.state) && isPlayers(v.state.players) && finite(v.state.gravity) && finite(v.state.windForce) &&
    integer(v.state.currentPlayerIndex) && v.state.currentPlayerIndex < v.state.players.length && integer(v.state.turn) &&
    (v.state.roundNumber === undefined || integer(v.state.roundNumber)) &&
    integer(v.width) && v.width > 0 && v.width <= 16384 && integer(v.height) && v.height > 0 && v.height <= 16384 &&
    typeof v.terrainId === "string" && typeof v.localMatch === "boolean" && typeof v.freeWeapons === "boolean" &&
    integer(v.initialPlayerCount) && v.initialPlayerCount >= 2 && v.initialPlayerCount <= 4 &&
    integer(v.step) && typeof v.inProgress === "boolean" && Array.isArray(v.projectiles) && object(v.motion), "INVALID_CAPTURE_STATE");
  const tankIds = new Set(v.state.players.map(p => p.tank.id));
  const playerIds = new Set(v.state.players.map(p => p.id));
  requireValue(v.state.players.length >= 2 && v.state.players.length <= 4 && tankIds.size === v.state.players.length && playerIds.size === v.state.players.length, "INVALID_CAPTURE_ROSTER");
  requireValue(v.projectiles.length <= 256 && v.projectiles.every(projectile), "INVALID_CAPTURE_PROJECTILES");
  for (const key of ["velocities", "fallenDistances", "isVoidFall", "fallAttributions"]) {
    const rows = v.motion[key as keyof typeof v.motion];
    requireValue(Array.isArray(rows) && rows.length <= 4 && new Set(rows.map(row => Array.isArray(row) ? row[0] : null)).size === rows.length,
      "INVALID_MOTION_MAP");
    for (const row of rows) {
      requireValue(Array.isArray(row) && row.length === 2 && typeof row[0] === "string" &&
        (key === "fallAttributions" ? playerIds : tankIds).has(row[0]), "INVALID_MOTION_ID");
      const entry: unknown = row[1];
      if (key === "isVoidFall") requireValue(typeof entry === "boolean", "INVALID_VOID_FALL");
      else if (key === "fallAttributions") requireValue(object(entry) && integer(entry.shotId) && integer(entry.munitionId) &&
        typeof entry.shooterId === "string" && playerIds.has(entry.shooterId) &&
        ALL_WEAPON_IDS.includes(entry.weaponId as typeof ALL_WEAPON_IDS[number]) &&
        ["direct", "indirect"].includes(String(entry.classification)), "INVALID_FALL_ATTRIBUTION");
      else requireValue(finite(entry) && entry >= 0, "INVALID_MOTION_VALUE");
    }
  }
}

/** Validate all dependencies before any TerrainManager is constructed. */
export function validateArchive(value: unknown): ShotArchive {
  requireValue(object(value) && value.format === "tankwars-shot-archive" && value.schemaVersion === 1, "UNSUPPORTED_ARCHIVE_SCHEMA");
  requireValue(value.rules === RULES_ID, "INCOMPATIBLE_PHYSICS_RULES");
  requireValue(typeof value.gameVersion === "string" && typeof value.build === "string" && typeof value.sessionId === "string" &&
    integer(value.firstSequence) && integer(value.lastSequence) && integer(value.evicted) && typeof value.complete === "boolean" &&
    (value.error === null || typeof value.error === "string") && Array.isArray(value.records) && Array.isArray(value.terrains) && finiteTree(value), "INVALID_ARCHIVE_MANIFEST");
  const terrains = new Map<string, { width: number; height: number }>();
  for (const t of value.terrains) {
    requireValue(object(t) && typeof t.id === "string" && integer(t.width) && t.width > 0 && t.width <= 16384 &&
      integer(t.height) && t.height > 0 && t.height <= 16384 && Array.isArray(t.heights) && t.heights.length === t.width &&
      t.heights.every(y => finite(y) && y >= 0 && y <= Number(t.height) - 1) && Array.isArray(t.materials) && t.materials.length === t.width &&
      t.materials.every(m => ["DIRT", "SOFT", "ROCK"].includes(String(m))), "INVALID_TERRAIN_DATA");
    requireValue(t.id === fingerprint({ width: t.width, height: t.height, heights: t.heights, materials: t.materials }), "TERRAIN_INTEGRITY_FAILED");
    requireValue(!terrains.has(t.id), "DUPLICATE_TERRAIN_ID"); terrains.set(t.id, { width: t.width, height: t.height });
  }
  let previous = 0;
  const starts = new Set<string>();
  for (const record of value.records) {
    requireValue(object(record) && integer(record.sequence) && record.sequence > previous && record.sequence <= value.lastSequence &&
      finite(record.atMs) && record.atMs >= 0 && integer(record.round) && integer(record.turn) &&
      (record.blockId === null || typeof record.blockId === "string") && (record.decisionId === null || typeof record.decisionId === "string") &&
      (record.shotKey === null || typeof record.shotKey === "string") && object(record.input), "INVALID_ARCHIVE_RECORD");
    requireValue(record.integrity === fingerprint({ ...record, integrity: undefined }), "RECORD_INTEGRITY_FAILED");
    previous = record.sequence;
    const input = record.input;
    requireValue(EVENT_KINDS.has(String(input.kind)), "UNKNOWN_ARCHIVE_EVENT");
    if (input.kind === "projectile-launched") {
      const p = input.projectile;
      requireValue(projectile(p) && object(p) && p.munitionId === 0 && typeof p.ownerId === "string" && integer(input.step), "INVALID_LAUNCHED_PROJECTILE");
    }
    if (input.kind === "boundary") requireValue(typeof input.status === "string", "INVALID_BOUNDARY_EVENT");
    if (["pre-shot", "settled", "current", "interrupted"].includes(String(input.kind))) {
      requireValue(input.requestId === undefined || integer(input.requestId), "INVALID_CAPTURE_REQUEST_ID");
      state(input.snapshot);
      const terrain = terrains.get(input.snapshot.terrainId);
      requireValue(terrain && terrain.width === input.snapshot.width && terrain.height === input.snapshot.height, "MISSING_TERRAIN_REFERENCE");
      if (input.kind === "pre-shot") {
        const shot = input.shot;
        requireValue(object(shot) && integer(shot.shotId) && typeof shot.playerId === "string" &&
          input.snapshot.state.players.some(p => p.id === shot.playerId) && command(shot.command) && point(shot.origin) &&
          typeof shot.isFirstShotOfRound === "boolean" && typeof record.shotKey === "string" && !starts.has(record.shotKey), "INVALID_SHOT_IDENTITY");
        starts.add(record.shotKey);
      }
    }
    if (input.kind === "impact") requireValue(object(input.hit) && integer(input.hit.shotId) && integer(input.hit.munitionId) &&
      point(input.hit) && ALL_WEAPON_IDS.includes(input.hit.weaponId as typeof ALL_WEAPON_IDS[number]) && integer(input.step) && ["DIRT", "SOFT", "ROCK"].includes(String(input.material)), "INVALID_IMPACT");
    if (input.kind === "advisor") requireValue(integer(input.requestId) && typeof input.status === "string", "INVALID_ADVISOR_EVENT");
    if (input.kind === "combat") {
      requireValue(object(input.event) && typeof input.event.kind === "string", "INVALID_COMBAT_EVENT");
      if (input.event.kind === "physical") {
        const o = input.event.observation;
        requireValue(object(o) && ["cluster", "grenade"].includes(String(o.kind)) && integer(o.shotId) && integer(o.munitionId) &&
          Array.isArray(o.draws) && o.draws.length <= 4 && o.draws.every(d => finite(d) && d >= 0 && d < 1) && object(o.parameters), "INVALID_PHYSICAL_TAPE");
      }
    }
  }
  requireValue(value.firstSequence === (value.records[0]?.sequence ?? 0), "INVALID_SEQUENCE_RANGE");
  if (value.integrity !== undefined) requireValue(typeof value.integrity === "string" &&
    sealArchive(value as unknown as ShotArchive).integrity === value.integrity, "ARCHIVE_INTEGRITY_FAILED");
  // JSON round-trip removes optional undefined fields; callers receive independent data.
  return JSON.parse(canonical(value)) as ShotArchive;
}
