import type { AiProfile, Player } from "../../types/player";
import type { WeaponId } from "../../types/weapon";
import type { InitialPlayerCount } from "../entities/ai/aiShopHelper";

export const HUMAN_FREE_WEAPONS_TARGETS = {
  BULLET: 12,
  GRENADE: 12,
  CLUSTER: 12,
  DRILLER: 12,
  BULLDOZER: 12,
  NUKE: 2,
  THERMONUCLEAR: 1,
} as const satisfies Partial<Record<WeaponId, number>>;

export const HUMAN_FREE_WEAPON_IDS: readonly WeaponId[] = [
  "BULLET",
  "GRENADE",
  "CLUSTER",
  "DRILLER",
  "BULLDOZER",
  "NUKE",
  "THERMONUCLEAR",
];

const DEFAULT_AI_FREE_WEAPONS_PROFILE: AiProfile = "v2-heuristic";

export function resolveAiProfileForFreeWeapons(value: unknown): AiProfile {
  switch (value) {
    case "v1-random":
    case "v2-heuristic":
    case "v3-sniper":
    case "v4-smart":
      return value;
    default:
      return DEFAULT_AI_FREE_WEAPONS_PROFILE;
  }
}

export function getAiFreeWeaponsTargets(
  profile: AiProfile,
  initialPlayerCount: InitialPlayerCount,
): Partial<Record<WeaponId, number>> {
  switch (profile) {
    case "v1-random":
      return {
        GRENADE: initialPlayerCount - 1,
        CLUSTER: initialPlayerCount - 1,
      };
    case "v2-heuristic":
      return {
        GRENADE: initialPlayerCount * 3,
        CLUSTER: initialPlayerCount * 3,
        DRILLER: initialPlayerCount,
        BULLDOZER: initialPlayerCount,
        NUKE: 1,
      };
    case "v3-sniper":
      return {
        BULLET: initialPlayerCount * 3,
        DRILLER: initialPlayerCount * 2,
        BULLDOZER: initialPlayerCount * 2,
      };
    case "v4-smart":
      return {
        GRENADE: initialPlayerCount * 3,
        CLUSTER: initialPlayerCount * 3,
        DRILLER: initialPlayerCount * 3,
        BULLDOZER: initialPlayerCount * 3,
        NUKE: 2,
        THERMONUCLEAR: 1,
      };
  }
}

/**
 * Réapprovisionne un joueur selon les règles du mode armes gratuites (#355) :
 * 1. Normalisation stricte : NUKE ramené à 2 max, THERMONUCLEAR à 1 max, sans crédit d'argent.
 * 2. Complément jusqu'au stock cible : pour chaque arme de la politique, applique `max(existant, cible)`.
 * 3. Conservation des surplus ordinaires et des armes déjà présentes hors politique.
 * 4. Aucun débit ou crédit d'argent, aucun RNG, idempotence complète.
 */
export function replenishPlayerFreeWeapons(
  player: Player,
  initialPlayerCount: InitialPlayerCount,
): Player {
  const currentInventory = player.inventory ?? {};
  const nextInventory: Partial<Record<WeaponId, number>> = {
    ...currentInventory,
  };

  // 1. Plafonnements légaux nucléaires stricts
  if (
    nextInventory.NUKE !== undefined &&
    nextInventory.NUKE !== null &&
    nextInventory.NUKE > 2
  ) {
    nextInventory.NUKE = 2;
  }
  if (
    nextInventory.THERMONUCLEAR !== undefined &&
    nextInventory.THERMONUCLEAR !== null &&
    nextInventory.THERMONUCLEAR > 1
  ) {
    nextInventory.THERMONUCLEAR = 1;
  }

  // 2. Détermination des cibles selon la politique (humain vs profil IA)
  const targets = player.isHuman
    ? HUMAN_FREE_WEAPONS_TARGETS
    : getAiFreeWeaponsTargets(
        resolveAiProfileForFreeWeapons(player.aiProfile),
        initialPlayerCount,
      );

  // 3. Complément par arme prévue
  for (const [weaponKey, targetQty] of Object.entries(targets)) {
    const weaponId = weaponKey as WeaponId;
    if (typeof targetQty !== "number") continue;
    const existing = nextInventory[weaponId] ?? 0;
    nextInventory[weaponId] = Math.max(existing, targetQty);
  }

  return {
    ...player,
    inventory: nextInventory,
  };
}

/**
 * Réapprovisionne l'ensemble du roster pour le mode armes gratuites.
 */
export function replenishRosterFreeWeapons(
  roster: ReadonlyArray<Player>,
  initialPlayerCount: InitialPlayerCount,
): Player[] {
  return roster.map((player) =>
    replenishPlayerFreeWeapons(player, initialPlayerCount),
  );
}
