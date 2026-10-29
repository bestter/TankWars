import type { GameState } from "../../../types/game";
import type { Player } from "../../../types/player";
import { BULLDOZER_PUSH_FACTOR, MAX_BULLDOZER_PUSH, WEAPON_REGISTRY, type WeaponId } from "../../../types/weapon";
import type { TerrainManager } from "../../engine/Terrain";
import { finalizeAdvancedAim } from "./aimCorruption";
import { searchDirectBulldozerSolutions } from "./BallisticsSimulator";
import { canThreatenWithBulldozer, isBulldozerCorridorSafe } from "./bulldozerThreat";
import { solveExpertAim } from "./expertAim";
import { expertTacticalPoints } from "./expertShotEvaluator";
import { possibleExpertThreatWeapons } from "./expertThreatWeapons";
import { FORECAST_SHOT_ID, getForecastAfterState, resolveBulldozerImpact, resolvePhysicalShot, type PhysicalResolution } from "./physicalShotForecast";

export interface ThreatSearchResult {
  readonly status: "found" | "absent" | "unknown";
  readonly cause?: string;
  readonly weaponId?: WeaponId;
  readonly weapons: readonly WeaponId[];
  readonly stock: Readonly<Partial<Record<WeaponId, number>>>;
  readonly searches: number;
  readonly forecasts: number;
  readonly elapsedMs: number;
  readonly bulldozer?: "not-run" | "not-eligible" | "safe-corridor" | "searched";
}

/** Physical possibility only: neither economics nor the actor's real strategy is consulted. */
export function searchLethalThreat(state: GameState, terrain: TerrainManager, actor: Player, target: Player): ThreatSearchResult {
  const started = performance.now();
  const weapons = possibleExpertThreatWeapons(actor);
  const stock = Object.fromEntries(weapons.map((id) => [id, actor.inventory[id] ?? 0]));
  let searches = 0, forecasts = 0;
  let bulldozer: ThreatSearchResult["bulldozer"] = "not-run";
  let cause: string | undefined;
  const result = (status: ThreatSearchResult["status"], weaponId?: WeaponId): ThreatSearchResult => ({
    status, cause: status === "unknown" ? cause : undefined, weaponId, weapons, stock,
    searches, forecasts, bulldozer, elapsedMs: performance.now() - started,
  });
  for (const weaponId of weapons) {
    const commands = new Map<string, ReturnType<typeof resolvePhysicalShot>>();
    for (const point of expertTacticalPoints(actor, [target], weaponId, terrain, state.players, "adverse")) {
      searches++;
      const solution = solveExpertAim(actor, point.x, point.y, state.windForce, state.gravity, terrain, weaponId);
      if (!solution.complete) { cause = "search-incomplete"; continue; }
      const command = finalizeAdvancedAim(solution.command);
      const key = JSON.stringify(command);
      let forecast = commands.get(key);
      if (!forecast) {
        forecasts++;
        forecast = resolvePhysicalShot(state, terrain, actor, weaponId, command);
        commands.set(key, forecast);
      }
      if (!forecast.complete) { cause = "forecast-incomplete"; continue; }
      const destroyed = forecast.destruction.some((event) => event.shotId === FORECAST_SHOT_ID &&
        event.shooterId === actor.id && event.victimId === target.id);
      // Destruction attribution proves enemy effect and the tank-point match.
      const matches = point.kind === "tank" || forecast.hits.some((hit) =>
        Math.hypot(hit.x - point.x, hit.y - point.y) <= Math.max(24, WEAPON_REGISTRY[weaponId].blastRadius));
      if (destroyed && matches) return result("found", weaponId);
    }
  }
  bulldozer = "not-eligible";
  if (canThreatenWithBulldozer(actor)) {
    weapons.push("BULLDOZER");
    stock.BULLDOZER = actor.inventory.BULLDOZER ?? 0;
    if (isBulldozerCorridorSafe(target, state.players, terrain)) {
      bulldozer = "safe-corridor";
      return result(cause ? "unknown" : "absent");
    }
    bulldozer = "searched";
    for (const { trajectory } of searchDirectBulldozerSolutions({ shooter: actor, target,
      players: state.players, terrain, wind: state.windForce, gravity: state.gravity })) {
      searches++;
      if (trajectory.terminal !== "tank" || trajectory.targetId !== target.id ||
        Math.min(Math.abs(trajectory.vx) * BULLDOZER_PUSH_FACTOR, MAX_BULLDOZER_PUSH) <= 0) continue;
      forecasts++;
      const forecast = resolveBulldozerImpact(state, terrain, actor, trajectory);
      if (!forecast.complete) { cause = "bulldozer-fall-incomplete"; continue; }
      if (!forecast.survivors.includes(target.id)) return result("found", "BULLDOZER");
    }
  }
  return result(cause ? "unknown" : "absent");
}

export interface TransitionAnalysis {
  readonly status: "safe" | "risk" | "unknown";
  readonly reason: string;
  readonly initial: ThreatSearchResult | null;
  readonly after: ThreatSearchResult | null;
  readonly reply: ThreatSearchResult | null;
}
export interface TransitionCandidate {
  readonly primaryTargetId: string;
  readonly weaponId: WeaponId;
  readonly command: { readonly angle: number; readonly power: number };
  readonly certified?: boolean;
  readonly result?: {
    readonly forecast?: PhysicalResolution;
    readonly rawCommand?: { readonly angle: number; readonly power: number };
  };
}
export interface TransitionSelectionTrace {
  readonly reason: string;
  readonly initialTargetId?: string;
  readonly finalTargetId?: string;
  readonly round?: number;
  readonly turn: number;
  readonly initialWeaponId?: WeaponId;
  readonly finalWeaponId?: WeaponId;
  readonly initialCommand?: TransitionCandidate["command"];
  readonly finalCommand?: TransitionCandidate["command"];
  readonly initialRawCommand?: TransitionCandidate["command"];
  readonly finalRawCommand?: TransitionCandidate["command"];
  readonly analysis?: TransitionAnalysis;
  readonly alternatives: readonly { targetId: string; accepted: boolean; analysis: TransitionAnalysis }[];
}

/** State identity and oriented pair are both part of this decision-local cache. */
export class LethalTransitionDetector {
  private readonly cache = new WeakMap<GameState, WeakMap<TerrainManager, Map<string, ThreatSearchResult>>>();
  readonly counters = { searches: 0, forecasts: 0, cacheHits: 0 };
  private readonly search: typeof searchLethalThreat;
  constructor(search = searchLethalThreat) { this.search = search; }
  private threat(state: GameState, terrain: TerrainManager, actor: Player, target: Player): ThreatSearchResult {
    let terrains = this.cache.get(state);
    if (!terrains) { terrains = new WeakMap(); this.cache.set(state, terrains); }
    let pairs = terrains.get(terrain);
    if (!pairs) { pairs = new Map(); terrains.set(terrain, pairs); }
    const key = JSON.stringify([actor.id, target.id]);
    let value = pairs.get(key);
    if (!value) {
      value = this.search(state, terrain, actor, target); pairs.set(key, value);
      this.counters.searches += value.searches;
      this.counters.forecasts += value.forecasts;
    } else this.counters.cacheHits++;
    return value;
  }
  analyze(candidate: TransitionCandidate, self: Player, state: GameState, terrain: TerrainManager): TransitionAnalysis {
    let initial: ThreatSearchResult | null = null, after: ThreatSearchResult | null = null, reply: ThreatSearchResult | null = null;
    const conclude = (status: TransitionAnalysis["status"], reason: string): TransitionAnalysis => ({ status, reason, initial, after, reply });
    const forecast = candidate.result?.forecast;
    if (candidate.certified === false || !forecast?.complete) return conclude("unknown", "uncertified");
    const target = state.players.find((player) => player.id === candidate.primaryTargetId);
    if (!target || (!target.isHuman && target.aiProfile !== "v4-smart")) return conclude("safe", "target-type");
    if (!forecast.survivors.includes(target.id)) return conclude("safe", "target-destroyed");
    if (!forecast.survivors.includes(self.id)) return conclude("safe", "shooter-destroyed");
    initial = this.threat(state, terrain, self, target);
    if (initial.status === "found") return conclude("safe", "existing-threat");
    if (initial.status === "unknown") return conclude("unknown", initial.cause ?? "initial-unknown");
    const stabilized = getForecastAfterState(forecast);
    if (!stabilized) return conclude("unknown", "after-state-missing");
    const actor = stabilized.state.players.find((player) => player.id === self.id);
    const victim = stabilized.state.players.find((player) => player.id === target.id);
    if (!actor || !victim) return conclude("unknown", "after-state-missing");
    after = this.threat(stabilized.state, stabilized.terrain, actor, victim);
    if (after.status === "absent") return conclude("safe", "no-new-threat");
    if (after.status === "unknown") return conclude("unknown", after.cause ?? "after-unknown");
    reply = this.threat(stabilized.state, stabilized.terrain, victim, actor);
    if (reply.status === "unknown") return conclude("unknown", reply.cause ?? "reply-unknown");
    return reply.status === "found" ? conclude("risk", "lethal-reply") : conclude("safe", "no-lethal-reply");
  }
}

/** Candidates arrive in their existing ranking. Never search a fallback or a lesser variant. */
export function chooseTransitionSafePlan<T extends TransitionCandidate>(candidates: readonly T[], self: Player,
  state: GameState, terrain: TerrainManager, applicable: boolean, detector = new LethalTransitionDetector(),
): { choice: T | undefined; trace: TransitionSelectionTrace } {
  const initial = candidates[0];
  const alternatives: { targetId: string; accepted: boolean; analysis: TransitionAnalysis }[] = [];
  const finish = (choice: T | undefined, reason: string, analysis?: TransitionAnalysis) => ({ choice, trace: {
    reason, round: state.roundNumber, turn: state.turn,
    initialWeaponId: initial?.weaponId, finalWeaponId: choice?.weaponId,
    initialTargetId: initial?.primaryTargetId, finalTargetId: choice?.primaryTargetId,
    initialCommand: initial?.command, finalCommand: choice?.command, analysis, alternatives,
    initialRawCommand: initial?.result?.rawCommand, finalRawCommand: choice?.result?.rawCommand,
  } });
  if (!applicable || !initial) return finish(initial, "not-applicable");
  const analysis = detector.analyze(initial, self, state, terrain);
  if (analysis.status !== "risk") return finish(initial, "initial-retained", analysis);
  const seen = new Set([initial.primaryTargetId]);
  for (const candidate of candidates) {
    if (seen.has(candidate.primaryTargetId)) continue;
    seen.add(candidate.primaryTargetId);
    if (!state.players.some((player) => player.id === candidate.primaryTargetId && !player.tank.isDead)) continue;
    const evaluated = detector.analyze(candidate, self, state, terrain);
    const accepted = evaluated.status === "safe";
    alternatives.push({ targetId: candidate.primaryTargetId, accepted, analysis: evaluated });
    if (accepted) return finish(candidate, "alternative-accepted", analysis);
  }
  return finish(initial, "initial-retained-no-alternative", analysis);
}
