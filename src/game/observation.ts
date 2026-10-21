import type { FireCommand } from "../types/game";
import type { Player } from "../types/player";
import type { RewardComponent } from "./economy/shotRewards";
import type { WeaponId } from "../types/weapon";

export type Aim = Pick<FireCommand, "angle" | "power">;
export interface AIObservation {
  playerId: string | null; tankId: string; profile: Player["aiProfile"] | null;
  shooter: Player | null;
  target: { playerId: string; tankId: string; position: { x: number; y: number } } | null;
  point: { x: number; y: number } | null;
  nominal: FireCommand | null; evaluated: FireCommand | null; final: FireCommand;
  environment: { windForce: number; gravity: number } | null;
  steps: Array<{ kind: "offset" | "reaction" | "gaffe" | "direction-error" | "power-error" | "finalize";
    before: Aim | null; after: Aim | null; parameters: Record<string, unknown> }>;
  reason: string | null; diagnostics: unknown;
}
export type AIObserver = (observation: AIObservation) => void;
export interface CreditObservation {
  source: "shot" | "zeus"; causalId: number; playerId: string;
  amount: number; before: number; after: number; components: readonly RewardComponent[];
}
export interface PurchaseObservation {
  playerId: string; profile: Player["aiProfile"]; weaponId: WeaponId; quantity: 1; price: number;
  moneyBefore: number; moneyAfter: number; stockBefore: number; stockAfter: number;
}
export interface PhysicalObservation {
  kind: "cluster" | "grenade"; shotId: number; munitionId: number;
  draws: number[]; parameters: Record<string, unknown>;
}
