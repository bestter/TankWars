import type { AiProfile, Player } from "../types/player";
import type { Color } from "../types/game";
import { DEFAULT_INVENTORY } from "../types/weapon";

/** Shared initial local roster construction; spawning remains the engine's responsibility. */
export function createLocalPlayers(configs: readonly { name: string; isHuman: boolean; aiProfile?: AiProfile; color: Color }[]): Player[] {
  return configs.map((cfg, i) => ({
    id: `player-${i + 1}`, name: cfg.name.trim(), isHuman: cfg.isHuman,
    aiProfile: cfg.isHuman ? undefined : (cfg.aiProfile ?? "v1-random"),
    tank: { id: `tank-${i + 1}`, position: { x: 80 + i * 160, y: 280 },
      angle: i < Math.ceil(configs.length / 2) ? -32 : 32, power: 50, health: 100, maxHealth: 100,
      shield: 40, maxShield: 40, isDead: false, color: cfg.color, currentWeapon: "MISSILE" },
    money: 250, inventory: { ...DEFAULT_INVENTORY },
  }));
}
