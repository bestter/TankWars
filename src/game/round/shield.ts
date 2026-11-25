import type { Tank } from "../../types/player";

export const SHIELD_METAL_COLOR = "#B8BCC4";

type ShieldState = Pick<Tank, "maxHealth" | "maxShield" | "shield">;

export function standardShieldCapacity(tank: Pick<Tank, "maxHealth" | "maxShield">): number {
  return tank.maxShield ?? Math.floor(tank.maxHealth * 0.4);
}

export function reinforcedShieldCapacity(standard: number): number {
  return standard * 4;
}

export function hasReinforcedShield(tank: ShieldState): boolean {
  return tank.shield > standardShieldCapacity(tank);
}

export function displayedShieldCapacity(tank: ShieldState): number {
  const standard = standardShieldCapacity(tank);
  return tank.shield > standard ? reinforcedShieldCapacity(standard) : standard;
}

export function shieldAtRoundStart(tank: Tank, pending: boolean, carryShield: boolean): number {
  const standard = standardShieldCapacity(tank);
  const base = carryShield && !tank.isDead && tank.health > 0 && standard > 0
    ? Math.max(standard, tank.shield)
    : standard;
  return carryShield && pending ? reinforcedShieldCapacity(standard) : base;
}
