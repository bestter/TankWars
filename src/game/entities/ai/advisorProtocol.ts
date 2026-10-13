import type { FireCommand } from "../../../types/game";
import { ALL_WEAPON_IDS } from "../../../types/weapon";
import type { AdvisorObjective } from "./expertPolicy";
import type { ShotAdvice } from "./shotAdvisor";

export interface AdvisorResult {
  objective: AdvisorObjective;
  command: FireCommand;
  targetIds: readonly string[];
  cost: number;
  gain: number;
  profit: number;
  shooterDestroyed: boolean;
  consequences: readonly { playerId: string; health: number; shield: number; destroyed: boolean }[];
}

export function summarizeAdvice(advice: ShotAdvice): AdvisorResult {
  const { objective, command, targetIds, cost, gain, profit, shooterDestroyed, forecast } = advice;
  const victims = new Map<string, { playerId: string; health: number; shield: number; destroyed: boolean }>();
  for (const event of forecast.damage) {
    const victim = victims.get(event.victimId) ?? { playerId: event.victimId, health: 0, shield: 0, destroyed: false };
    victim.health += event.healthDamageMilli / 1000;
    victim.shield += event.shieldLostMilli / 1000;
    victims.set(event.victimId, victim);
  }
  for (const event of forecast.destruction) {
    const victim = victims.get(event.victimId) ?? { playerId: event.victimId, health: 0, shield: 0, destroyed: false };
    victim.destroyed = true;
    victims.set(event.victimId, victim);
  }
  return { objective, command, targetIds, cost, gain, profit, shooterDestroyed, consequences: [...victims.values()] };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
/** The worker boundary receives unknown, even though this is our own local worker. */
export function isAdvisorResult(value: unknown): value is AdvisorResult {
  if (!record(value) || !record(value.command)) return false;
  const command = value.command;
  return (value.objective === "SURVIE" || value.objective === "OPTIMISER_PROFIT") &&
    ALL_WEAPON_IDS.some((id) => id === command.weaponId) &&
    typeof command.angle === "number" && Number.isFinite(command.angle) && Math.round(command.angle * 10) / 10 === command.angle && command.angle >= 0 && command.angle <= 180 &&
    typeof command.power === "number" && Number.isInteger(command.power) && command.power >= 1 && command.power <= 99 &&
    Array.isArray(value.targetIds) && value.targetIds.every((id: unknown) => typeof id === "string") &&
    nonnegative(value.cost) && Number.isSafeInteger(value.cost) &&
    nonnegative(value.gain) && Number.isSafeInteger(value.gain) &&
    typeof value.profit === "number" && Number.isSafeInteger(value.profit) && value.profit === value.gain - value.cost &&
    typeof value.shooterDestroyed === "boolean" &&
    Array.isArray(value.consequences) && value.consequences.every((row: unknown) =>
      record(row) && typeof row.playerId === "string" && nonnegative(row.health) && nonnegative(row.shield) && typeof row.destroyed === "boolean");
}
