import type { Player } from "../../types/player";
import { generateTerrain, type GeneratedTerrain } from "./generateTerrain";
import { hasSafeRockBase, resetPlayersForSpawn, selectSpawnPositions, type SpawnTerrain } from "./spawnPlacement";
import { rollRoundWind, WIND_ACCEL_MIN, WIND_ACCEL_MAX } from "../wind";
import { TANK_SPAWN_MARGIN_RATIO, TANK_SPAWN_MIN_DISTANCE } from "../../types/terrain";

export const ROUND_WIDTH = 800;
export const ROUND_HEIGHT = 480;
export const MAX_ROUND_MAP_CANDIDATES = 16;

export interface RoundMap extends GeneratedTerrain {
  width: number;
  height: number;
  roundNumber: number;
  wind: number;
}

export type PreparedRound = { ok: true; map: RoundMap; players: Player[] } |
  { ok: false; reason: "ROUND_PREPARATION_FAILED" };

export function spawnTerrain(width: number, data: GeneratedTerrain): SpawnTerrain {
  return {
    width,
    getHeightAt: (x) => data.heights[Math.max(0, Math.min(width - 1, Math.floor(x)))],
    getMaterialAt: (x) => data.materials[Math.max(0, Math.min(width - 1, Math.floor(x)))],
  };
}

export function prepareRound(
  players: readonly Player[], width: number, height: number, roundNumber: number,
  localMode: boolean, rng: () => number,
  generate: typeof generateTerrain = generateTerrain,
): PreparedRound {
  for (let attempt = 0; attempt < MAX_ROUND_MAP_CANDIDATES; attempt++) {
    const data = generate(width, height, rng);
    const terrain = spawnTerrain(width, data);
    const xs = selectSpawnPositions(players, terrain, localMode, rng);
    if (xs === null) continue;
    return {
      ok: true,
      map: { ...data, width, height, roundNumber, wind: rollRoundWind(rng) },
      players: resetPlayersForSpawn(players, xs, terrain),
    };
  }
  return { ok: false, reason: "ROUND_PREPARATION_FAILED" };
}

export function isRoundMap(value: unknown): value is RoundMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const map = value as Record<string, unknown>;
  return map.width === ROUND_WIDTH && map.height === ROUND_HEIGHT &&
    typeof map.roundNumber === "number" && Number.isSafeInteger(map.roundNumber) && map.roundNumber > 0 &&
    typeof map.wind === "number" && Number.isFinite(map.wind) && map.wind >= WIND_ACCEL_MIN && map.wind <= WIND_ACCEL_MAX &&
    Array.isArray(map.heights) && map.heights.length === map.width &&
    Array.from(map.heights).every((h: unknown) => typeof h === "number" && Number.isFinite(h) && h >= 0 && h <= ROUND_HEIGHT) &&
    Array.isArray(map.materials) && map.materials.length === map.width &&
    Array.from(map.materials).every((m: unknown) => m === "DIRT" || m === "SOFT" || m === "ROCK");
}

/** Initial placement validation only. Never use it to relocate tanks during recovery. */
export function hasValidSpawnRoster(map: RoundMap, players: readonly Player[]): boolean {
  if (players.length < 2 || players.length > 4 ||
    new Set(players.map((p) => p.id)).size !== players.length ||
    new Set(players.map((p) => p.tank.id)).size !== players.length) return false;
  const terrain = spawnTerrain(map.width, map);
  const margin = map.width * TANK_SPAWN_MARGIN_RATIO;
  return players.every((player, index) => {
    const { x, y } = player.tank.position;
    return Number.isFinite(x) && Number.isFinite(y) && x >= margin && x <= map.width - margin &&
      y === terrain.getHeightAt(x) && hasSafeRockBase(x, terrain) &&
      players.slice(0, index).every((other) => Math.abs(other.tank.position.x - x) >= TANK_SPAWN_MIN_DISTANCE);
  });
}

export function hasValidCombatRoster(map: RoundMap, players: readonly Player[]): boolean {
  return players.length >= 2 && players.length <= 4 &&
    new Set(players.map((p) => p.id)).size === players.length &&
    new Set(players.map((p) => p.tank.id)).size === players.length &&
    players.every(({ tank }) => Number.isFinite(tank.position.x) && Number.isFinite(tank.position.y) &&
      tank.position.x >= 0 && tank.position.x <= map.width && tank.position.y >= 0 && tank.position.y <= map.height);
}
