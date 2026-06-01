/**
 * TankWars - Phase 1 AI Strategy (src/game/entities/ai/RandomAIStrategy.ts)
 *
 * Deliberately simple / "stupid" random trajectory injector.
 * This satisfies the project requirement that Phase 1 AI must NOT block the architecture.
 *
 * Future strategies (heuristic, trajectory solver, minimax, etc.) will implement the same AIStrategy interface.
 */

import type { Player } from '../../../types/player';
import type { FireCommand, AngleDegrees, Power } from '../../../types/game';
import type { AIStrategy } from './AIStrategy';
import { WEAPON_REGISTRY, type WeaponId } from '../../../types/weapon';

export class RandomAIStrategy implements AIStrategy {
  public readonly name = 'v1-random';

  decideShot(self: Player, /* _world: AIWorldView */): FireCommand | null {
    // Very naive: pick a random angle in a safe upward-ish cone
    const angle: AngleDegrees = -30 + Math.random() * 120; // -30° (slightly down right) to +90° (straight up)

    // Random power in a reasonable range
    const power: Power = 35 + Math.random() * 55;

    // Prefer weapons the AI actually has ammo for
    const availableWeapons = Object.keys(self.inventory).filter(
      (id) => (self.inventory[id as WeaponId] ?? 0) > 0
    ) as WeaponId[];

    let weaponId: WeaponId = self.tank.currentWeapon;

    if (availableWeapons.length > 0 && !availableWeapons.includes(weaponId)) {
      weaponId = availableWeapons[Math.floor(Math.random() * availableWeapons.length)];
    }

    // Safety: fall back to MISSILE if nothing available
    if (!WEAPON_REGISTRY[weaponId]) {
      weaponId = 'MISSILE';
    }

    return {
      angle: Math.max(-85, Math.min(85, angle)),
      power: Math.max(20, Math.min(95, power)),
      weaponId,
    };
  }
}
