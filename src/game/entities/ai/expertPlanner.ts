import type { GameState } from "../../../types/game";
import type { Player } from "../../../types/player";
import { ALL_WEAPON_IDS, WEAPON_REGISTRY, type WeaponId } from "../../../types/weapon";
import { secureRandom } from "../../../utils/random";
import type { TerrainManager } from "../../engine/Terrain";
import { nextLivingPlayerIndex } from "../../online/turnOrder";
import type { AimMemory } from "./aimMemory";
import { createExpertForecastCache, evaluateExpertShot, isValidExpertShot, type ValidExpertShotResult, type ExpertForecastCache, type ExpertEvaluatedAim } from "./expertShotEvaluator";
import type { ExpertDecisionAim } from "./expertDecisionAim";
import type { AimSearchPolicy } from "./aimSearch";
import { compareExpertConsequences, type ExpertConsequences } from "./expertConsequences";
import { evaluateBulldozerThreat } from "./bulldozerThreat";

export interface ExpertPlan extends ExpertEvaluatedAim {
  readonly weaponId: WeaponId;
  readonly point: { readonly x: number; readonly y: number };
}

interface RankedPlan extends ExpertPlan {
  readonly targetIds: readonly string[];
  readonly result: ValidExpertShotResult;
  readonly profileScore: number;
  readonly nextTurnDelay: number;
  readonly nextTurnIndex: number;
  readonly weaponOrder: number;
  readonly order: number;
}

interface ExpertCandidateTrace extends ExpertConsequences {
  readonly weaponId: WeaponId;
  readonly targetIds: readonly string[];
  readonly primaryTargetId: string;
  readonly point: ExpertPlan["point"];
  readonly policy?: AimSearchPolicy;
  readonly pointOrder: number;
  readonly profit: number;
  readonly ammunitionCost: number;
  readonly predictedShooterReward: number;
  readonly shooterDestroyed: boolean;
  readonly destroyedIds: readonly string[];
  readonly profileScore: number;
  readonly nextTurnDelay: number;
  readonly requestedPoint: ExpertEvaluatedAim["requestedPoint"];
  readonly attempts: number;
  readonly offset: number;
  readonly predictedCommand: ExpertEvaluatedAim["command"];
  readonly rawCommand: ExpertEvaluatedAim["rawCommand"];
  readonly predictedImpacts?: readonly { x: number; y: number; directTargetId?: string }[];
  readonly predictedDamage?: readonly {
    victimId: string;
    source: string;
    classification: string;
    shield: number;
    shieldAbsorbed: number;
    shieldLost: number;
    health: number;
  }[];
  readonly predictedDestructions?: readonly { victimId: string; cause: string }[];
}

export interface ExpertDecisionTrace {
  readonly phase: "SURVIE" | "OPTIMISER_PROFIT" | "REPLI";
  readonly transitionReason: string;
  readonly threats: readonly {
    playerId: string;
    weaponId: WeaponId;
    profileScore: number;
    turnsUntilShot: number;
    lethalProfit: number;
  }[];
  readonly selectedThreatId?: string;
  readonly survivalRoll?: number;
  readonly survivalCandidateCount: number;
  readonly availableWeapons: readonly WeaponId[];
  readonly candidateCount: number;
  readonly selected?: ExpertCandidateTrace;
  readonly selectionReason?: string;
  readonly runnerUp?: ExpertCandidateTrace;
  readonly bestByWeapon: readonly ExpertCandidateTrace[];
}

function traceCandidate(candidate: RankedPlan): ExpertCandidateTrace {
  const { result, weaponId } = candidate;
  const ammunitionCost = weaponId === "MISSILE" ? 0 : WEAPON_REGISTRY[weaponId].price;
  const forecast = result.forecast;
  return {
    weaponId,
    targetIds: candidate.targetIds,
    primaryTargetId: candidate.primaryTargetId,
    point: candidate.point,
    pointOrder: result.pointOrder,
    policy: result.policy,
    profit: result.profit,
    humanDestroyedCount: result.humanDestroyedCount,
    humanDamageMilli: result.humanDamageMilli,
    aiDestroyedCount: result.aiDestroyedCount,
    aiDamageMilli: result.aiDamageMilli,
    ammunitionCost,
    predictedShooterReward: result.profit + ammunitionCost,
    shooterDestroyed: result.shooterDestroyed,
    destroyedIds: [...result.destroyedIds],
    profileScore: candidate.profileScore,
    nextTurnDelay: candidate.nextTurnDelay,
    requestedPoint: candidate.requestedPoint,
    attempts: candidate.attempts,
    offset: candidate.offset,
    predictedCommand: candidate.command,
    rawCommand: candidate.rawCommand,
    predictedImpacts: forecast?.hits.map((hit) => ({
      x: hit.x, y: hit.y, directTargetId: hit.directTargetId,
    })),
    predictedDamage: forecast?.damage.map((event) => ({
      victimId: event.victimId,
      source: event.source,
      classification: event.classification,
      shield: event.shieldAbsorbedMilli / 1_000,
      shieldAbsorbed: event.shieldAbsorbedMilli / 1_000,
      shieldLost: event.shieldLostMilli / 1_000,
      health: event.healthDamageMilli / 1_000,
    })),
    predictedDestructions: forecast?.destruction.map((event) => ({
      victimId: event.victimId, cause: event.cause,
    })),
  };
}

function compareSurvivalPlans(a: RankedPlan, b: RankedPlan): number {
  return b.result.profit - a.result.profit ||
    compareExpertConsequences(a.result, b.result) ||
    a.weaponOrder - b.weaponOrder || a.order - b.order ||
    a.result.pointOrder - b.result.pointOrder;
}

function selectionReason(
  phase: ExpertDecisionTrace["phase"], winner: RankedPlan, runnerUp: RankedPlan | undefined,
): string {
  if (!runnerUp) return "seul candidat admissible";
  if (winner.result.shooterDestroyed !== runnerUp.result.shooterDestroyed) {
    return "EXPERT survit, contrairement au suivant";
  }
  if (winner.result.profit !== runnerUp.result.profit) return "profit net supérieur";
  if (winner.result.humanDestroyedCount !== runnerUp.result.humanDestroyedCount) return "moins d'humains détruits";
  if (winner.result.humanDamageMilli !== runnerUp.result.humanDamageMilli) return "moins de dégâts aux humains";
  if (winner.result.aiDestroyedCount !== runnerUp.result.aiDestroyedCount) return "davantage d'IA détruites";
  if (winner.result.aiDamageMilli !== runnerUp.result.aiDamageMilli) return "davantage de dégâts aux IA";
  if (phase === "OPTIMISER_PROFIT") {
    if (winner.profileScore !== runnerUp.profileScore) return "score de profil supérieur";
    if (winner.nextTurnDelay !== runnerUp.nextTurnDelay) return "adversaire jouant plus tôt";
    if (winner.nextTurnIndex !== runnerUp.nextTurnIndex) return "ordre du roster";
  }
  if (winner.weaponOrder !== runnerUp.weaponOrder) return "ordre stable des armes";
  return "ordre stable des groupes ou des points";
}

export function expertProfileScore(player: Player): number {
  if (player.isHuman) return 0.9;
  switch (player.aiProfile) {
    case "v4-smart": return 1;
    case "v3-sniper": return 0.8;
    case "v2-heuristic": return 0.5;
    case "v1-random": return 0.1;
    default: return 0.5;
  }
}

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
  return ids.filter((id) => id !== "BULLDOZER" &&
    (id === "MISSILE" || (player.inventory[id] ?? 0) > 0));
}

function nextDelay(state: GameState, player: Player): number {
  const targetIndex = state.players.indexOf(player);
  let index = state.currentPlayerIndex;
  for (let delay = 1; delay <= state.players.length; delay++) {
    index = nextLivingPlayerIndex(index, state.players.length,
      (candidate) => state.players[candidate].tank.isDead);
    if (index === targetIndex) return delay;
  }
  return Number.POSITIVE_INFINITY;
}

function primaryTarget(targets: readonly Player[], roster: readonly Player[]): Player {
  return [...targets].sort((a, b) =>
    a.tank.health + a.tank.shield - b.tank.health - b.tank.shield ||
    roster.indexOf(a) - roster.indexOf(b))[0];
}

export function ordinaryExpertTarget(
  self: Player,
  players: readonly Player[],
  memory: Readonly<AimMemory>,
): Player | undefined {
  const enemies = players.filter((player) => player.id !== self.id && !player.tank.isDead);
  return enemies.find((player) => player.id === memory.currentTargetId) ??
    [...enemies].sort((a, b) =>
      Number(a.isHuman) - Number(b.isHuman) ||
      a.tank.health - b.tank.health ||
      players.indexOf(a) - players.indexOf(b))[0];
}

/** Returns null when context or all physically valid tactical shots are unavailable. */
export function chooseExpertPlan(
  self: Player,
  state: GameState,
  terrain: TerrainManager,
  aim: ExpertDecisionAim,
  evaluate: typeof evaluateExpertShot = evaluateExpertShot,
  onDecision?: (trace: ExpertDecisionTrace) => void,
  cache: ExpertForecastCache = createExpertForecastCache(),
): ExpertPlan | null {
  if (!state.localShotContext) {
    onDecision?.({
      phase: "REPLI",
      transitionReason: "contexte économique absent : plan principal indisponible",
      threats: [], survivalCandidateCount: 0, availableWeapons: [],
      candidateCount: 0, bestByWeapon: [],
    });
    return null;
  }
  const enemies = state.players.filter((player) => player.id !== self.id && !player.tank.isDead);
  const shooterWeapons = ALL_WEAPON_IDS.filter((id) => id !== "BULLDOZER" &&
    (id === "MISSILE" || (self.inventory[id] ?? 0) > 0));

  const threats: { player: Player; weaponId: WeaponId; result: { readonly profit: number; readonly shooterDestroyed: boolean } }[] = [];
  for (const enemy of enemies) {
    let best: { readonly profit: number; readonly shooterDestroyed: boolean } | null = null;
    let bestWeapon: WeaponId | undefined;
    for (const weapon of possibleExpertThreatWeapons(enemy)) {
      const result = evaluate(state, terrain, enemy, weapon, [self], true, false, cache, { mode: "adverse" });
      if (!isValidExpertShot(result)) continue;
      if (!best ||
          Number(best.shooterDestroyed) > Number(result.shooterDestroyed) ||
          (best.shooterDestroyed === result.shooterDestroyed && result.profit > best.profit)) {
        best = result;
        bestWeapon = weapon;
      }
    }
    const bulldozer = evaluateBulldozerThreat(state, terrain, enemy, self, cache).best;
    if (bulldozer && (!best || Number(bulldozer.shooterDestroyed) < Number(best.shooterDestroyed) ||
      (bulldozer.shooterDestroyed === best.shooterDestroyed && bulldozer.profit > best.profit))) {
      best = bulldozer;
      bestWeapon = "BULLDOZER";
    }
    if (best && bestWeapon !== undefined) threats.push({ player: enemy, weaponId: bestWeapon, result: best });
  }
  threats.sort((a, b) =>
    nextDelay(state, a.player) - nextDelay(state, b.player) ||
    expertProfileScore(b.player) - expertProfileScore(a.player) ||
    b.result.profit - a.result.profit ||
    state.players.indexOf(a.player) - state.players.indexOf(b.player));

  const threat = threats[0]?.player;
  let survivalRoll: number | undefined;
  let survivalCandidateCount = 0;
  let profitTransition = threat
    ? "jet de SURVIE refusé : optimisation sur tous les adversaires"
    : "aucune menace létale prévue : optimisation sur tous les adversaires";
  const report = (
    phase: ExpertDecisionTrace["phase"],
    transitionReason: string,
    ranked: readonly RankedPlan[],
    selected?: RankedPlan,
  ): void => {
    if (!onDecision) return;
    const bestByWeapon: ExpertCandidateTrace[] = [];
    const seenWeapons = new Set<WeaponId>();
    for (const candidate of ranked) {
      if (seenWeapons.has(candidate.weaponId)) continue;
      seenWeapons.add(candidate.weaponId);
      bestByWeapon.push(traceCandidate(candidate));
    }
    const runnerUp = ranked.find((candidate) => candidate !== selected);
    onDecision({
      phase,
      transitionReason,
      threats: threats.map(({ player, weaponId, result }) => ({
        playerId: player.id,
        weaponId,
        profileScore: expertProfileScore(player),
        turnsUntilShot: nextDelay(state, player),
        lethalProfit: result.profit,
      })),
      selectedThreatId: threat?.id,
      survivalRoll,
      survivalCandidateCount,
      availableWeapons: shooterWeapons,
      candidateCount: ranked.length,
      selected: selected && traceCandidate(selected),
      selectionReason: selected && selectionReason(phase, selected, runnerUp),
      runnerUp: runnerUp && traceCandidate(runnerUp),
      bestByWeapon,
    });
  };
  let enterSurvival = false;
  if (threat) {
    const threatScore = expertProfileScore(threat);
    if (threatScore === 1) {
      enterSurvival = true;
    } else {
      survivalRoll = secureRandom();
      enterSurvival = survivalRoll < threatScore;
    }
  }
  if (enemies.length > 0) aim.reserve();
  if (enterSurvival) {
    let bestSurvival: RankedPlan | null = null;
    const survivalCandidates: RankedPlan[] | null = onDecision ? [] : null;
    let order = 0;
    for (const weapon of shooterWeapons) {
      const groups: Player[][] = [[threat], ...enemies
        .filter((enemy) => enemy.id !== threat.id)
        .map((enemy) => [threat, enemy])];
      for (const group of groups) {
        const targetAim = aim.forTarget(primaryTarget(group, state.players).id);
        const result = evaluate(state, terrain, self, weapon, group, true,
          state.localShotContext.isFirstShotOfRound, cache, { mode: "own", aim: targetAim });
        if (!isValidExpertShot(result) || result.shooterDestroyed) {
          order++;
          continue;
        }
        const candidate: RankedPlan = {
          kind: "evaluated", ...targetAim,
          requestedPoint: result.requestedPoint,
          rawCommand: result.rawCommand,
          command: result.command,
          weaponId: weapon,
          point: result.destination,
          policy: result.policy,
          targetIds: group.map((player) => player.id),
          result,
          profileScore: expertProfileScore(threat),
          nextTurnDelay: nextDelay(state, threat),
          nextTurnIndex: state.players.indexOf(threat),
          weaponOrder: ALL_WEAPON_IDS.indexOf(weapon),
          order: order++,
        };
        survivalCandidateCount++;
        survivalCandidates?.push(candidate);
        if (!bestSurvival || compareSurvivalPlans(candidate, bestSurvival) < 0) {
          bestSurvival = candidate;
        }
      }
    }
    if (bestSurvival) {
      if (survivalCandidates) {
        survivalCandidates.sort(compareSurvivalPlans);
        report("SURVIE", `menace ${threat.id} à neutraliser par un tir non suicidaire`,
          survivalCandidates, bestSurvival);
      }
      return bestSurvival;
    }
    profitTransition = `aucun tir sûr ne détruit la menace ${threat.id} : optimisation sur tous les adversaires`;
  }

  const groups: Player[][] = [...enemies.map((enemy) => [enemy])];
  for (let i = 0; i < enemies.length; i++) {
    for (let j = i + 1; j < enemies.length; j++) groups.push([enemies[i], enemies[j]]);
  }
  const candidates: RankedPlan[] = [];
  let order = 0;
  for (const group of groups) {
    const targetAim = aim.forTarget(primaryTarget(group, state.players).id);
    const earliest = [...group].sort((a, b) =>
      nextDelay(state, a) - nextDelay(state, b) ||
      state.players.indexOf(a) - state.players.indexOf(b))[0];
    for (const weapon of shooterWeapons) {
      const result = evaluate(state, terrain, self, weapon, group, false,
        state.localShotContext.isFirstShotOfRound, cache, { mode: "own", aim: targetAim });
      if (isValidExpertShot(result)) candidates.push({
        kind: "evaluated", ...targetAim,
        requestedPoint: result.requestedPoint,
        rawCommand: result.rawCommand,
        command: result.command,
        weaponId: weapon,
        point: result.destination,
        policy: result.policy,
        targetIds: group.map((player) => player.id),
        result,
        profileScore: group.reduce((sum, player) => sum + expertProfileScore(player), 0),
        nextTurnDelay: nextDelay(state, earliest),
        nextTurnIndex: state.players.indexOf(earliest),
        weaponOrder: ALL_WEAPON_IDS.indexOf(weapon),
        order: order++,
      });
    }
  }
  candidates.sort((a, b) =>
    Number(a.result.shooterDestroyed) - Number(b.result.shooterDestroyed) ||
    b.result.profit - a.result.profit ||
    compareExpertConsequences(a.result, b.result) ||
    b.profileScore - a.profileScore ||
    a.nextTurnDelay - b.nextTurnDelay ||
    a.nextTurnIndex - b.nextTurnIndex ||
    a.weaponOrder - b.weaponOrder ||
    a.order - b.order ||
    a.result.pointOrder - b.result.pointOrder);
  report(candidates.length > 0 ? "OPTIMISER_PROFIT" : "REPLI",
    candidates.length > 0 ? profitTransition : `${profitTransition}; aucun tir prévu admissible`,
    candidates, candidates[0]);
  return candidates[0] ?? null;
}
