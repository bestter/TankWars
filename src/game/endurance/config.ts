import { DEFAULT_LIMITS, type EnduranceConfig } from "./types";
import { ALL_WEAPON_IDS } from "../../types/weapon";
import type { Player } from "../../types/player";

function positive(n: number): boolean { return Number.isSafeInteger(n) && n > 0; }
export function validateConfig(config: EnduranceConfig): EnduranceConfig {
  if (!positive(config.roundsPerBlock) || (config.maxBlocks === null && config.maxDurationMs === null) ||
    (config.maxBlocks !== null && !positive(config.maxBlocks)) ||
    (config.maxDurationMs !== null && !positive(config.maxDurationMs)) ||
    !Object.values(config.limits).every(positive) || config.players.length < 2 || config.players.length > 4 ||
    config.players.some(p => p.isHuman || !["v1-random", "v2-heuristic", "v3-sniper", "v4-smart"].includes(p.aiProfile ?? ""))) {
    throw new Error("INVALID_ENDURANCE_CONFIG");
  }
  assertRoster(config.players);
  const clone = structuredClone(config);
  const freeze = (value: object): void => {
    for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
    Object.freeze(value);
  };
  freeze(clone);
  return clone;
}

export function assertRoster(players: readonly Player[]): void {
  if (players.length < 2 || players.length > 4 || new Set(players.map(p => p.id)).size !== players.length ||
    new Set(players.map(p => p.tank.id)).size !== players.length) throw new Error("INVALID_ROSTER_IDS");
  for (const p of players) {
    const t = p.tank;
    if (!p.id || !t.id || !p.name.trim() || !Number.isSafeInteger(p.money) || p.money < 0 ||
      ![t.health, t.maxHealth, t.shield, t.maxShield, t.position.x, t.position.y, t.angle, t.power].every(Number.isFinite) ||
      t.health < 0 || t.health > t.maxHealth || t.maxHealth <= 0 || t.shield < 0 || t.shield > t.maxShield || t.maxShield < 0 ||
      Object.entries(p.inventory).some(([id, n]) => !ALL_WEAPON_IDS.includes(id as typeof ALL_WEAPON_IDS[number]) || !Number.isSafeInteger(n) || n < 0)) {
      throw new Error("INVALID_PLAYER_STATE");
    }
  }
}

export function defaultConfig(players: Player[]): EnduranceConfig {
  return { players, roundsPerBlock: 2, maxBlocks: null, maxDurationMs: 14_400_000, stopOnIncident: false, limits: { ...DEFAULT_LIMITS } };
}
