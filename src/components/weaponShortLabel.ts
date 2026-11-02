import type { WeaponId } from "../types/weapon";

const SHORT_LABELS = {
  MISSILE: "MIS",
  GRENADE: "GRE",
  CLUSTER: "CLS",
  NUKE: "NUK",
  THERMONUCLEAR: "THM",
  DRILLER: "DRL",
  BULLET: "BLT",
  BULLDOZER: "BLD",
} as const satisfies Record<WeaponId, string>;

export const WEAPON_I18N_KEYS = {
  MISSILE: "weapons.MISSILE",
  GRENADE: "weapons.GRENADE",
  CLUSTER: "weapons.CLUSTER",
  NUKE: "weapons.NUKE",
  THERMONUCLEAR: "weapons.THERMONUCLEAR",
  DRILLER: "weapons.DRILLER",
  BULLET: "weapons.BULLET",
  BULLDOZER: "weapons.BULLDOZER",
} as const satisfies Record<WeaponId, `weapons.${WeaponId}`>;

export function weaponShortLabel(id: WeaponId): string {
  return SHORT_LABELS[id];
}
