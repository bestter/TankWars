import type { Player } from "../../../types/player";
import { ALL_WEAPON_IDS, type WeaponId } from "../../../types/weapon";

export function possibleExpertThreatWeapons(player: Player): WeaponId[] {
  let ids: readonly WeaponId[];
  if (player.isHuman || player.aiProfile === "v4-smart") {
    ids = ALL_WEAPON_IDS;
  } else if (player.aiProfile === "v3-sniper") {
    ids = ["MISSILE", "BULLET", "DRILLER"];
  } else if (player.aiProfile === "v2-heuristic") {
    ids = ["MISSILE", "GRENADE", "CLUSTER", "NUKE", "DRILLER"];
  } else {
    ids = [player.tank.currentWeapon || "MISSILE"];
  }
  // Nuclear stock stays unknown even after an opponent selects or fires it.
  return ids.filter((id) => id !== "BULLDOZER" && id !== "NUKE" && id !== "THERMONUCLEAR" &&
    (id === "MISSILE" || (player.inventory[id] ?? 0) > 0));
}
