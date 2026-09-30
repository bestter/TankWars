import type { GameState } from "../../../types/game";
import type { Player } from "../../../types/player";
import { TERRAIN_MATERIAL } from "../../../types/terrain";
import type { WeaponId } from "../../../types/weapon";
import type { TerrainManager } from "../../engine/Terrain";
import { finalizeAdvancedAim, type AimCommand } from "./aimCorruption";
import type { AimVariant } from "./aimSearch";
import { localMaterialPoints, type TacticalPoint } from "./materialCandidates";
import { resolvePhysicalShot, FORECAST_SHOT_ID, type PhysicalResolution } from "./physicalShotForecast";

export const LOCAL_MATERIAL_MAX_PROPOSALS = 12;
export type MaterialSolver = (point: TacticalPoint, weapon: WeaponId, variant: AimVariant) => {
  command: AimCommand; complete: boolean;
};
export interface LocalMaterialChoice {
  readonly weaponId: WeaponId;
  readonly point: TacticalPoint;
  readonly variant: AimVariant;
  readonly reason: "useful" | "surviving" | "ordinary";
}

export function hasPhysicalEffect(forecast: PhysicalResolution, shooter: Player, victimIds: ReadonlySet<string>): boolean {
  return forecast.complete && (forecast.damage.some((event) =>
    event.shotId === FORECAST_SHOT_ID && event.shooterId === shooter.id && victimIds.has(event.victimId) &&
    event.shieldLostMilli + event.healthDamageMilli > 0) || forecast.destruction.some((event) =>
    event.shotId === FORECAST_SHOT_ID && event.shooterId === shooter.id && victimIds.has(event.victimId)));
}

/** Fixed-order local tactics; no rewards, memory mutation, or live RNG. */
export function chooseLocalMaterialShot(
  profile: "v2-heuristic" | "v3-sniper", self: Player, target: Player, state: GameState,
  terrain: TerrainManager, ordinaryWeapon: WeaponId, attempts: number, solve: MaterialSolver,
): LocalMaterialChoice {
  const material = terrain.getMaterialAt(target.tank.position.x);
  const has = (weapon: WeaponId) => weapon === "MISSILE" || (self.inventory[weapon] ?? 0) > 0;
  const ordinary = ordinaryWeapon === "DRILLER" && material === TERRAIN_MATERIAL.ROCK ? "MISSILE" : ordinaryWeapon;
  const firstSniper = profile === "v3-sniper" && attempts === 1;
  const promote = !firstSniper && ordinary === "MISSILE" && material === TERRAIN_MATERIAL.SOFT && has("DRILLER");
  const weapons: WeaponId[] = firstSniper ? ["MISSILE"] : [ordinary];
  if (!firstSniper && has("DRILLER") && (profile === "v3-sniper"
    ? material !== TERRAIN_MATERIAL.ROCK : material === TERRAIN_MATERIAL.SOFT)) {
    if (promote) weapons.unshift("DRILLER");
    else weapons.push("DRILLER");
  }
  weapons.push("MISSILE");
  const cache = new Map<string, PhysicalResolution>();
  let surviving: LocalMaterialChoice | undefined;
  let selected: LocalMaterialChoice | undefined;
  const diagnostics = import.meta.env.DEV ? { proposals: 0, searches: 0, forecasts: 0, rejections: [] as string[] } : undefined;
  let usefulForecast: PhysicalResolution | undefined;
  let survivingForecast: PhysicalResolution | undefined;
  outer: for (const weaponId of [...new Set(weapons)].filter(has)) {
    for (const point of localMaterialPoints(self, target, weaponId, terrain)) {
      for (const variant of ["full", "high"] as const) {
        if (diagnostics) { diagnostics.proposals++; diagnostics.searches++; }
        const solution = solve(point, weaponId, variant);
        if (!solution.complete) { diagnostics?.rejections.push("recherche incomplète"); continue; }
        const command = finalizeAdvancedAim(solution.command);
        const key = JSON.stringify([weaponId, command.angle, command.power]);
        let forecast = cache.get(key);
        if (!forecast) {
          if (diagnostics) diagnostics.forecasts++;
          forecast = resolvePhysicalShot(state, terrain, self, weaponId, command);
          cache.set(key, forecast);
        }
        if (!forecast.complete) { diagnostics?.rejections.push("prévision incomplète"); continue; }
        const safe = forecast.survivors.includes(self.id);
        const useful = hasPhysicalEffect(forecast, self, new Set([target.id])) &&
          (weaponId !== "BULLET" || forecast.hits.some((hit) => hit.directTargetId === target.id));
        if (promote && weaponId === "DRILLER" && (!safe || !useful ||
          !forecast.support.some((support) => support.playerId === target.id && support.after > support.before))) {
          diagnostics?.rejections.push("promotion SOFT non démontrée"); continue;
        }
        if (!safe) { diagnostics?.rejections.push("tireur détruit"); continue; }
        const candidate: LocalMaterialChoice = { weaponId, point, variant, reason: useful ? "useful" : "surviving" };
        if (!surviving) {
          surviving = candidate;
          if (import.meta.env.DEV) survivingForecast = forecast;
        }
        if (useful) {
          selected = candidate;
          if (import.meta.env.DEV) usefulForecast = forecast;
          break outer;
        }
      }
    }
  }
  const choice = selected ?? surviving ?? {
    weaponId: ordinary, point: { x: target.tank.position.x, y: target.tank.position.y - 6, kind: "tank" as const },
    variant: "full" as const, reason: "ordinary" as const,
  };
  if (import.meta.env.DEV) {
    console.info("[AI matériaux] Décision", { profile, shooterId: self.id, targetId: target.id,
      ordinaryWeapon, material, choice, ...diagnostics,
      support: (usefulForecast ?? survivingForecast)?.support,
      impacts: (usefulForecast ?? survivingForecast)?.hits.map((hit) => ({ ...hit, material: terrain.getMaterialAt(hit.x) })),
    });
  }
  return choice;
}
