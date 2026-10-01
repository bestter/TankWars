import type { Player } from "../../../types/player";
import { SOFT_TERRAIN_DESTRUCTION_MULTIPLIER } from "../../../types/terrain";
import { DRILLER_SHAFT_DEPTH, WEAPON_REGISTRY, type WeaponId } from "../../../types/weapon";
import { TANK_HITBOX_HEIGHT, TANK_HITBOX_WIDTH } from "../../combatConstants";
import type { TerrainManager } from "../../engine/Terrain";

export interface TacticalPoint {
  readonly x: number;
  readonly y: number;
  readonly origin?: "boundary";
  readonly kind: "tank" | "terrain" | "pair";
}

/** Two closest transitions; a duo reserves one distinct transition per roster member first. */
export function materialBoundaryPoints(
  targets: readonly Player[], weapon: WeaponId, terrain: TerrainManager, roster: readonly Player[],
): TacticalPoint[] {
  const radius = WEAPON_REGISTRY[weapon].blastRadius;
  const reach = TANK_HITBOX_WIDTH / 2 + SOFT_TERRAIN_DESTRUCTION_MULTIPLIER * radius +
    (weapon === "DRILLER" ? Math.max(0, DRILLER_SHAFT_DEPTH - radius) : 0);
  const materials = terrain.getMaterials();
  const ordered = [...targets].sort((a, b) => roster.indexOf(a) - roster.indexOf(b));
  const windows = ordered.map((target) => {
    const tx = target.tank.position.x;
    const boundaries: number[] = [];
    for (let b = Math.max(1, Math.ceil(tx - reach)); b <= Math.min(terrain.width - 1, Math.floor(tx + reach)); b++) {
      if (materials[b - 1] !== materials[b]) boundaries.push(b);
    }
    return boundaries.sort((a, b) => Math.abs(a - tx) - Math.abs(b - tx) || a - b);
  });
  const selected = new Set<number>();
  if (targets.length === 2) {
    for (const window of windows) {
      const boundary = window.find((b) => !selected.has(b));
      if (boundary !== undefined) selected.add(boundary);
    }
  }
  const distance = (b: number) => Math.min(...targets.map((target) => Math.abs(b - target.tank.position.x)));
  for (const boundary of [...new Set(windows.flat())].sort((a, b) => distance(a) - distance(b) || a - b)) {
    if (selected.size === 2) break;
    selected.add(boundary);
  }
  return [...selected].flatMap((b) => [b - 0.5, b + 0.5].map((x) => ({
    x, y: terrain.getHeightAt(x), kind: "terrain" as const, origin: "boundary" as const,
  })));
}

export function localMaterialPoints(
  self: Player, target: Player, weapon: WeaponId, terrain: TerrainManager,
): TacticalPoint[] {
  const tx = target.tank.position.x;
  const points: TacticalPoint[] = [{ x: tx, y: target.tank.position.y - 6, kind: "tank" }];
  if (weapon !== "BULLET" && weapon !== "BULLDOZER") {
    const side = self.tank.position.x <= tx ? -1 : 1;
    const x = tx + side * (TANK_HITBOX_WIDTH / 2 + WEAPON_REGISTRY[weapon].blastRadius / 2);
    points.push({ x, y: terrain.getHeightAt(x), kind: "terrain" });
  }
  return points.filter((point) => point.x >= 0 && point.x < terrain.width);
}

export function bulldozerPoint(target: Player): TacticalPoint {
  return { x: target.tank.position.x, y: target.tank.position.y - TANK_HITBOX_HEIGHT / 2, kind: "tank" };
}
