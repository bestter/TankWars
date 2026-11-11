import type { CurrentTurnInfo } from "../game/engine/TurnManager";
import type { GamePhase } from "../types/game";
import type { AiProfile, Player } from "../types/player";
import { ALL_WEAPON_IDS, type WeaponId } from "../types/weapon";

export interface PlayerStatusCard {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly isHuman: boolean;
  readonly aiProfile: AiProfile | null;
  readonly health: number;
  readonly maxHealth: number;
  readonly shield: number;
  readonly maxShield: number;
  readonly inventory: Partial<Record<WeaponId, number>>;
}

interface VisibleStatusWeapon {
  readonly id: WeaponId;
  /** `null` means the unlimited MISSILE stock. */
  readonly quantity: number | null;
}

const PROFILE_KEYS = {
  "v1-random": "controller_ai_simple",
  "v2-heuristic": "controller_ai_ok",
  "v3-sniper": "controller_ai_sniper",
  "v4-smart": "controller_ai_expert",
} as const satisfies Record<AiProfile, string>;

type PlayerStatusProfileKey = (typeof PROFILE_KEYS)[AiProfile] | "controller_human";

export function isAimingInspectionVisible(input: {
  readonly gamePhase: GamePhase;
  readonly turnInfo: CurrentTurnInfo | null;
}): boolean {
  const { gamePhase, turnInfo } = input;
  return (
    gamePhase === "COMBAT" &&
    turnInfo !== null &&
    turnInfo.isHuman &&
    !turnInfo.isInputLocked &&
    !turnInfo.tanksAreFalling
  );
}

export function isOutOfPlayerStatus(player: Player): boolean {
  return player.tank.isDead || player.tank.health <= 0;
}

export function deadStatusPlayerIds(players: readonly Player[]): string[] {
  const ids: string[] = [];
  for (const player of players) {
    if (isOutOfPlayerStatus(player)) ids.push(player.id);
  }
  return ids;
}

export function copyLivingPlayerStatus(players: readonly Player[]): PlayerStatusCard[] {
  const cards: PlayerStatusCard[] = [];
  for (const player of players) {
    if (isOutOfPlayerStatus(player)) continue;
    const inventory: Partial<Record<WeaponId, number>> = {};
    for (const id of ALL_WEAPON_IDS) {
      const value = player.inventory[id];
      if (typeof value === "number" && Number.isFinite(value)) {
        inventory[id] = value;
      }
    }
    cards.push({
      id: player.id,
      name: player.name,
      color: player.tank.color,
      isHuman: player.isHuman,
      aiProfile: player.aiProfile ?? null,
      health: player.tank.health,
      maxHealth: player.tank.maxHealth,
      shield: player.tank.shield,
      maxShield: player.tank.maxShield,
      inventory,
    });
  }
  return cards;
}

function sameInventory(
  left: Partial<Record<WeaponId, number>>,
  right: Partial<Record<WeaponId, number>>,
): boolean {
  for (const id of ALL_WEAPON_IDS) {
    if (left[id] !== right[id]) return false;
  }
  return true;
}

export function playerStatusEqual(
  left: readonly PlayerStatusCard[] | null,
  right: readonly PlayerStatusCard[] | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a.id !== b.id ||
      a.name !== b.name ||
      a.color !== b.color ||
      a.isHuman !== b.isHuman ||
      a.aiProfile !== b.aiProfile ||
      a.health !== b.health ||
      a.maxHealth !== b.maxHealth ||
      a.shield !== b.shield ||
      a.maxShield !== b.maxShield ||
      !sameInventory(a.inventory, b.inventory)
    ) {
      return false;
    }
  }
  return true;
}

export function visibleStatusWeapons(
  inventory: Partial<Record<WeaponId, number>>,
): VisibleStatusWeapon[] {
  const weapons: VisibleStatusWeapon[] = [];
  for (const id of ALL_WEAPON_IDS) {
    if (id === "MISSILE") {
      weapons.push({ id, quantity: null });
      continue;
    }
    const stock = inventory[id];
    if (typeof stock !== "number" || !Number.isFinite(stock) || stock <= 0) continue;
    const quantity = Math.trunc(stock);
    if (quantity > 0) weapons.push({ id, quantity });
  }
  return weapons;
}

export function playerStatusProfileKey(
  card: Pick<PlayerStatusCard, "isHuman" | "aiProfile">,
): PlayerStatusProfileKey {
  if (card.isHuman) return "controller_human";
  if (card.aiProfile !== null && card.aiProfile in PROFILE_KEYS) {
    return PROFILE_KEYS[card.aiProfile];
  }
  return "controller_ai_simple";
}

export function formatStatusNumber(
  value: number,
  language: string | null | undefined,
  role: "current" | "max",
  kind: "health" | "shield",
): string {
  let rounded = Math.round(value * 10) / 10;
  if (role === "current" && kind === "health" && rounded === 0) {
    rounded = 0.1;
  }
  const text = role === "max" && Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  const tag = typeof language === "string" ? language : "fr";
  return tag.toLowerCase().startsWith("fr") ? text.replace(".", ",") : text;
}
