import type { FireCommand, GameState } from "../../../types/game";
import { WEAPON_REGISTRY } from "../../../types/weapon";
import type { TerrainMaterial } from "../../../types/terrain";
import { TerrainManager } from "../../engine/Terrain";
import { chooseExpertPlan, ordinaryExpertTarget } from "./expertPlanner";
import { chooseExpertFallback, createExpertForecastCache } from "./expertShotEvaluator";
import { chooseExpertTacticalWeapon } from "./expertTacticalWeapon";
import { adjustWeaponForMaterial } from "./terrainMaterialTactics";
import type { ExpertDecisionAim } from "./expertDecisionAim";
import type { AdvisorObjective } from "./expertPolicy";
import type { PhysicalResolution } from "./physicalShotForecast";

export interface AdvisorSnapshot {
  readonly state: GameState;
  readonly width: number;
  readonly height: number;
  readonly heights: readonly number[];
  readonly materials: readonly TerrainMaterial[];
}

export interface ShotAdvice {
  readonly objective: AdvisorObjective;
  readonly command: FireCommand;
  readonly targetIds: readonly string[];
  readonly forecast: Extract<PhysicalResolution, { complete: true }>;
  readonly cost: number;
  readonly gain: number;
  readonly profit: number;
  readonly shooterDestroyed: boolean;
}

export function createIdealExpertAim(): ExpertDecisionAim {
  return { reserve() {}, forTarget: (primaryTargetId) => ({ primaryTargetId, offset: 0, attempts: 0 }) };
}

/** Runs in the browser's dedicated worker. No strategy instance, live memory or game RNG. */
export function calculateShotAdvice(snapshot: AdvisorSnapshot, objective: AdvisorObjective): ShotAdvice | null {
  const { state, width, height, heights, materials } = structuredClone(snapshot);
  const context = state.localShotContext;
  if (!context || !Number.isInteger(context.playerCountAtMatchStart) ||
      context.playerCountAtMatchStart < 2 || context.playerCountAtMatchStart > 4 ||
      typeof context.isFirstShotOfRound !== "boolean") throw new Error("INVALID_ADVISOR_ECONOMY");
  const self = state.players[state.currentPlayerIndex];
  if (state.phase !== "COMBAT" || !self?.isHuman || self.tank.isDead || self.tank.health <= 0) return null;
  const terrain = new TerrainManager(width, height);
  terrain.loadHeights([...heights], [...materials]);
  const cache = createExpertForecastCache();
  const aim = createIdealExpertAim();
  const plan = chooseExpertPlan(self, state, terrain, aim, undefined, undefined, cache, objective);
  const target = plan ? state.players.find((player) => player.id === plan.primaryTargetId) :
    ordinaryExpertTarget(self, state.players, { currentTargetAttempts: 0 }, true);
  if (!target) return null;
  const fallback = plan ? undefined : chooseExpertFallback(state, terrain, self, target,
    adjustWeaponForMaterial(chooseExpertTacticalWeapon(self, target, terrain, state),
      terrain.getMaterialAt(target.tank.position.x), (id) => (self.inventory[id] ?? 0) > 0),
    cache, aim.forTarget(target.id), { objective });
  const choice = plan ?? fallback;
  const forecast = plan?.result?.forecast ?? fallback?.forecast;
  if (!choice || choice.kind !== "evaluated" || !forecast?.complete || forecast.profit === null) return null;
  const shooterDestroyed = !forecast.survivors.includes(self.id);
  if (objective === "SURVIE" && shooterDestroyed) return null;
  const cost = choice.weaponId === "MISSILE" ? 0 : WEAPON_REGISTRY[choice.weaponId].price;
  return { objective, command: { ...choice.command, weaponId: choice.weaponId },
    targetIds: plan?.targetIds ?? [target.id], forecast, cost,
    gain: forecast.profit + cost, profit: forecast.profit, shooterDestroyed };
}
