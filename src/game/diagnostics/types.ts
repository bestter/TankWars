import type { GameState, FireCommand, Vector2 } from "../../types/game";
import type { TankPhysicsState } from "../entities/TankManager";
import type { Projectile, ProjectileHitEvent } from "../engine/PhysicsEngine";
import type { TerrainMaterial } from "../../types/terrain";
import type { EnduranceEvent } from "../endurance/types";

export interface DiagnosticState {
  state: GameState;
  motion: TankPhysicsState;
  width: number; height: number; heights: number[]; materials: TerrainMaterial[];
  localMatch: boolean; freeWeapons: boolean; initialPlayerCount: number;
  projectiles: Projectile[]; step: number; inProgress: boolean;
}
export interface ShotIdentity {
  shotId: number; playerId: string; command: FireCommand; origin: Vector2;
  isFirstShotOfRound: boolean;
}
export type DiagnosticInput =
  | { kind: "projectile-launched"; projectile: Projectile; step: number }
  | { kind: "boundary"; status: string; detail: unknown }
  | { kind: "pre-shot"; snapshot: DiagnosticState; shot: ShotIdentity }
  | { kind: "settled" | "current" | "interrupted"; snapshot: DiagnosticState; requestId?: number }
  | { kind: "impact"; hit: ProjectileHitEvent; step: number; material: TerrainMaterial }
  | { kind: "combat"; event: EnduranceEvent }
  | { kind: "advisor"; requestId: number; status: string; detail: unknown };
export interface TerrainRecord { id: string; width: number; height: number; heights: number[]; materials: TerrainMaterial[] }
export type StoredState = Omit<DiagnosticState, "heights" | "materials"> & { terrainId: string };
export type ArchiveInput = Exclude<DiagnosticInput, { snapshot: DiagnosticState }> |
  { kind: "pre-shot"; snapshot: StoredState; shot: ShotIdentity } |
  { kind: "settled" | "current" | "interrupted"; snapshot: StoredState; requestId?: number };
export interface ArchiveRecord {
  integrity: string;
  sequence: number; atMs: number; blockId: string | null; round: number; turn: number;
  decisionId: string | null; shotKey: string | null; input: ArchiveInput;
}
export interface ShotArchive {
  integrity?: string;
  format: "tankwars-shot-archive"; schemaVersion: 1;
  gameVersion: string; build: string; rules: string; sessionId: string;
  firstSequence: number; lastSequence: number; evicted: number;
  complete: boolean; error: string | null;
  records: ArchiveRecord[]; terrains: TerrainRecord[];
}
export type ArchiveWrite = { record: ArchiveRecord; terrains: TerrainRecord[] };
export interface ShotListPage {
  rows: Array<{ key: string; label: string; status: string }>;
  total: number; firstSequence: number; lastSequence: number; evicted: number;
}
