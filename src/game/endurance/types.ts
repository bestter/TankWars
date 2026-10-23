import type { Player } from "../../types/player";
import type { FireCommand } from "../../types/game";
import type { CombatDamageEvent, CombatDestructionEvent } from "../economy/shotRewards";
import type { ZeusStrikeResult } from "../zeus/zeusDomain";
import type { WEAPON_REGISTRY } from "../../types/weapon";
import type { AIObservation, CreditObservation, PhysicalObservation } from "../observation";

export interface EnduranceConfig {
  players: Player[];
  roundsPerBlock: number;
  maxBlocks: number | null;
  maxDurationMs: number | null;
  stopOnIncident: boolean;
  limits: { turns: number; roundMs: number; actionMs: number; transitionMs: number };
}

export const DEFAULT_LIMITS = { turns: 1000, roundMs: 1_800_000, actionMs: 120_000, transitionMs: 30_000 };
export type EnduranceEvent =
  | { kind: "ammo-consumed"; playerId: string; weaponId: import("../../types/weapon").WeaponId; before: number; after: number }
  | { kind: "ai-detail"; observation: AIObservation }
  | { kind: "credit"; credit: CreditObservation }
  | { kind: "shot-result"; shotId: number; awards: readonly import("../economy/shotRewards").PlayerShotReward[] }
  | { kind: "physical"; observation: PhysicalObservation }
  | { kind: "shot-intent"; playerId: string; command: FireCommand }
  | { kind: "shot-launched"; shotId: number; playerId: string; command: FireCommand; position: { x: number; y: number }; launch: { x: number; y: number } }
  | { kind: "shot-refused"; playerId: string; command: FireCommand; reason: string }
  | { kind: "turn"; playerId: string; turn: number }
  | { kind: "decision-start"; playerId: string }
  | { kind: "target"; playerId: string; targetId: string }
  | { kind: "decision"; playerId: string; durationMs: number; command: FireCommand }
  | { kind: "shot"; shotId: number; playerId: string; command: FireCommand }
  | { kind: "resolved"; shotId: number }
  | { kind: "damage"; event: CombatDamageEvent }
  | { kind: "destruction"; event: CombatDestructionEvent }
  | { kind: "death"; playerId: string; cause: string }
  | { kind: "displacement"; playerId: string; distance: number; recoil: boolean }
  | { kind: "zeus"; result: ZeusStrikeResult }
  | { kind: "recovery"; reason: string }
  | { kind: "failure"; reason: string; error?: string };

/** Additive observer. A false result stops the current endurance action synchronously. */
export interface CombatObserver {
  emit(event: EnduranceEvent): boolean;
}

export interface Metrics {
  decisions: number; decisionMs: number; commands: number; shots: number; resolved: number;
  offensiveShots: number; healthLostMilli: number; shieldLostMilli: number;
  healthDealtMilli: number; shieldDealtMilli: number; selfHealthMilli: number; selfShieldMilli: number;
  kills: number; suicides: number; unattributedDeaths: number; displacement: number; recoil: number;
  zeusActions: number; zeusResults: number; failed: number; recoveries: number; skipped: number;
  participations: number; wins: number; survivals: number; draws: number;
}
export type MetricGroups = { players: Record<string, Metrics>; profiles: Record<string, Metrics>; weapons: Record<string, Metrics>; total: Metrics };
export interface RoundRecord {
  number: number; startedAt: string; durationMs: number; turns: number;
  completed: boolean; survivors: string[]; winnerId: string | null; draw: boolean; metrics: MetricGroups;
}
export interface RecentEvent { sequence: number; atMs: number; round: number; event: EnduranceEvent }
export interface Incident {
  id: string; sessionId: string; blockId: string; seed: number; round: number; turn: number;
  kind: "exception" | "invariant" | "limit" | "warning" | "external" | "storage";
  reason: string; at: string; phase: string; observedMs: number; lastProgress: RecentEvent | null;
  recent: RecentEvent[]; context: unknown;
}
export interface BlockRecord {
  id: string; sessionId: string; index: number; seed: number; config: EnduranceConfig;
  gameVersion: string; build: string; schemaVersion: 1; physics: "local";
  startedAt: string; durationMs: number; status: "running" | "completed" | "abandoned" | "interrupted";
  reason: string | null; suspect: boolean; roundsStarted: number; roundsCompleted: number;
  completedMetrics: MetricGroups; partialMetrics: MetricGroups;
}
export interface SessionRecord {
  runtime: { width: 800; height: 480; gravity: 260; baseShotSpeed: 420; localMatch: true; weapons: typeof WEAPON_REGISTRY };
  schemaVersion: 1; id: string; gameVersion: string; build: string; config: EnduranceConfig;
  startedAt: string; durationMs: number; status: "running" | "stopped"; reason: string | null;
  attempted: number; completed: number; abandoned: number; interrupted: number; suspect: number;
  roundsStarted: number; roundsCompleted: number; incidents: number;
  collection: "complete" | "incomplete"; storageError: string | null;
  completedMetrics: MetricGroups; partialMetrics: MetricGroups;
  retention: { recentEvents: 256; checkpointMs: 15000; fullEventHistory: false };
}
export interface EnduranceExport {
  schemaVersion: 1; session: SessionRecord; blocks: BlockRecord[];
  rounds: Array<RoundRecord & { blockId: string }>; incidents: Incident[];
  diagnostics: { evaluatedCommand: "unavailable"; perturbations: "unavailable"; deterministicReplay: false; combatResume: false };
}
