import { TANK_HITBOX_WIDTH } from "../combatConstants";
import type { Player } from "../../types/player";
import {
  TERRAIN_MATERIAL, spawnAcceptsMaterial,
  TANK_SPAWN_MARGIN_RATIO, TANK_SPAWN_MIN_DISTANCE,
  TANK_SPAWN_MAX_ATTEMPTS, TANK_SPAWN_PER_POS_ATTEMPTS,
  type TerrainMaterial,
} from "../../types/terrain";

export interface SpawnTerrain {
  readonly width: number;
  getHeightAt(x: number): number;
  getMaterialAt(x: number): TerrainMaterial;
}

/** Every positively intersected column counts; exact edge contact does not. */
export function hasSafeRockBase(x: number, terrain: SpawnTerrain): boolean {
  const left = Math.floor(x - TANK_HITBOX_WIDTH / 2);
  const right = Math.ceil(x + TANK_HITBOX_WIDTH / 2) - 1;
  if (!Number.isFinite(x) || left < 0 || right >= terrain.width) return false;
  let rock = 0;
  for (let column = left; column <= right; column++) {
    if (terrain.getMaterialAt(column) === TERRAIN_MATERIAL.ROCK) rock++;
  }
  return rock === 0 || rock === right - left + 1;
}

/** Closed continuous intervals of centers whose entire base stays in one ROCK class. */
function admissibleIntervals(terrain: SpawnTerrain): Array<readonly [number, number]> {
  const half = TANK_HITBOX_WIDTH / 2;
  const margin = terrain.width * TANK_SPAWN_MARGIN_RATIO;
  const intervals: Array<readonly [number, number]> = [];
  let start = 0;
  for (let end = 1; end <= terrain.width; end++) {
    if (end < terrain.width &&
      (terrain.getMaterialAt(start) === TERRAIN_MATERIAL.ROCK) ===
      (terrain.getMaterialAt(end) === TERRAIN_MATERIAL.ROCK)) continue;
    const left = Math.max(margin, start + half);
    const right = Math.min(terrain.width - margin, end - half);
    if (left <= right) intervals.push([left, right]);
    start = end;
  }
  return intervals;
}

function nextSeparatedCenter(x: number): number {
  const next = x + TANK_SPAWN_MIN_DISTANCE;
  if (next - x >= TANK_SPAWN_MIN_DISTANCE) return next;
  // Fractional additions can round the separation just below 100. Advance one representable center.
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, next);
  bits.setBigUint64(0, bits.getBigUint64(0) + 1n);
  return bits.getFloat64(0);
}

/** Selects all positions before mutating any player. Preferences are soft, safety is mandatory. */
export function selectSpawnPositions(
  players: readonly Player[], terrain: SpawnTerrain, localMode: boolean, rng: () => number,
): number[] | null {
  const margin = terrain.width * TANK_SPAWN_MARGIN_RATIO;
  const minX = margin;
  const maxX = terrain.width - margin;
  const order = players.map((_, index) => index);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const placed: number[] = [];
  const xs: number[] = new Array(players.length);
  for (const index of order) {
    let selected: number | null = null;
    for (let attempt = 0; attempt < TANK_SPAWN_MAX_ATTEMPTS && selected === null; attempt++) {
      let bestHeight = -Infinity;
      for (let sample = 0; sample < TANK_SPAWN_PER_POS_ATTEMPTS; sample++) {
        const x = minX + rng() * (maxX - minX);
        if (!placed.every((other) => Math.abs(other - x) >= TANK_SPAWN_MIN_DISTANCE)) continue;
        if (!hasSafeRockBase(x, terrain)) continue;
        if (!spawnAcceptsMaterial(terrain.getMaterialAt(x), players[index].isHuman, localMode, rng)) continue;
        const height = terrain.getHeightAt(x);
        if (height > bestHeight) {
          bestHeight = height;
          selected = x;
        }
      }
    }
    if (selected === null) {
      // Greedy leftmost packing is complete in one dimension. Restart the whole roster.
      const fallback: number[] = [];
      let next = minX;
      for (const [left, right] of admissibleIntervals(terrain)) {
        let x = Math.max(left, next);
        while (x <= right && fallback.length < players.length) {
          fallback.push(x);
          next = nextSeparatedCenter(x);
          x = next;
        }
        if (fallback.length === players.length) break;
      }
      if (fallback.length !== players.length) return null;
      order.forEach((slot, i) => { xs[slot] = fallback[i]; });
      return xs;
    }
    placed.push(selected);
    xs[index] = selected;
  }
  return xs;
}

/** Produces a fresh round roster; identities, money and inventory are preserved. */
export function resetPlayersForSpawn(players: readonly Player[], xs: readonly number[], terrain: SpawnTerrain): Player[] {
  return players.map((player, index) => {
    const x = xs[index];
    const maxShield = player.tank.maxShield ?? Math.floor(player.tank.maxHealth * 0.4);
    return {
      ...player,
      inventory: { ...player.inventory },
      tank: {
        ...player.tank,
        position: { x, y: terrain.getHeightAt(x) },
        health: player.tank.maxHealth, shield: maxShield, maxShield, isDead: false,
        angle: x < terrain.width / 2 ? 45 : 135, power: 50, currentWeapon: "MISSILE",
        lastHitBy: undefined, lastDirectAttackerId: undefined, hitReaction: undefined,
      },
    };
  });
}
