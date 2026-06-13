import type { GameState } from "../../types/game";
import { VGA_PALETTE } from "../../types/game";
import type { Player } from "../../types/player";
import type { WeaponId } from "../../types/weapon";
import { TerrainManager } from "../engine/Terrain";

export function makeTank(
  id: string,
  x: number,
  y: number,
  overrides: Partial<Player["tank"]> = {},
): Player["tank"] {
  return {
    id,
    position: { x, y },
    angle: 45,
    power: 55,
    health: 100,
    maxHealth: 100,
    shield: 0,
    maxShield: 0,
    isDead: false,
    color: VGA_PALETTE.CYAN,
    currentWeapon: "MISSILE",
    ...overrides,
  };
}

export function makePlayer(overrides: Partial<Player> = {}): Player {
  const tank = overrides.tank ?? makeTank("tank-1", 120, 300);
  return {
    id: "player-1",
    name: "Player 1",
    isHuman: true,
    money: 1000,
    inventory: { MISSILE: 99, GRENADE: 3 },
    tank,
    ...overrides,
  };
}

export function makeGameState(
  shooter: Player,
  target: Player,
  aiProfile: Player["aiProfile"] = "v1-random",
): GameState {
  const aiPlayer: Player = {
    ...shooter,
    isHuman: false,
    aiProfile,
    tank: { ...shooter.tank, id: shooter.tank.id },
  };
  return {
    phase: "COMBAT",
    players: [aiPlayer, target],
    currentPlayerIndex: 0,
    turn: 1,
    windForce: 0,
    gravity: 260,
  };
}

export function flatTerrain(width: number, height: number, surfaceRatio = 0.7): TerrainManager {
  const terrain = new TerrainManager(width, height);
  const heights = (terrain as unknown as { heights: number[] }).heights;
  const surfaceY = height * surfaceRatio;
  for (let x = 0; x < width; x++) {
    heights[x] = surfaceY;
  }
  return terrain;
}

export function terrainWithMidObstacle(
  width: number,
  height: number,
  obstacleStart: number,
  obstacleEnd: number,
  peakY: number,
): TerrainManager {
  const terrain = flatTerrain(width, height);
  const heights = (terrain as unknown as { heights: number[] }).heights;
  for (let x = obstacleStart; x <= obstacleEnd; x++) {
    heights[x] = peakY;
  }
  return terrain;
}

export function terrainInternals(terrain: TerrainManager): {
  needsFullRedraw: boolean;
  isDirty: boolean;
  dirtyStartX: number;
  dirtyEndX: number;
} {
  return terrain as unknown as {
    needsFullRedraw: boolean;
    isDirty: boolean;
    dirtyStartX: number;
    dirtyEndX: number;
  };
}

export const ALL_WEAPONS: WeaponId[] = [
  "MISSILE",
  "GRENADE",
  "CLUSTER",
  "NUKE",
  "THERMONUCLEAR",
  "DRILLER",
  "BULLET",
];