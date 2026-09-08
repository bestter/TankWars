import type { Player } from "../../../types/player";
import { WEAPON_REGISTRY } from "../../../types/weapon";
import { TANK_HITBOX_WIDTH, THERMONUCLEAR_INSTANT_KILL_RADIUS } from "../../combatConstants";
import type { AimMemory } from "./aimMemory";

type HeavyWeapon = "NUKE" | "THERMONUCLEAR";

export interface HeavyCandidate {
  readonly weaponId: HeavyWeapon;
  readonly primaryTargetId: string;
  readonly point: Readonly<{ x: number; y: number }>;
  readonly memberIndices: readonly number[];
  readonly healthTotal: number;
  readonly selfDistance: number;
  readonly virtualAttempts: number;
}

interface ExpertTacticalEvaluation {
  readonly ordinaryTarget: Player | undefined;
  readonly nuke: HeavyCandidate | undefined;
  readonly thermonuclear: HeavyCandidate | undefined;
  readonly preparation: HeavyCandidate | undefined;
  readonly candidates: readonly HeavyCandidate[];
}

/** Ordre total stable, indépendant de l'arme et de l'ordre d'énumération. */
export function compareHeavyCandidates(a: HeavyCandidate, b: HeavyCandidate): number {
  const rank = b.memberIndices.length - a.memberIndices.length ||
    b.healthTotal - a.healthTotal || b.selfDistance - a.selfDistance;
  if (rank !== 0) return rank;
  for (let i = 0; i < Math.min(a.memberIndices.length, b.memberIndices.length); i++) {
    const difference = a.memberIndices[i] - b.memberIndices[i];
    if (difference !== 0) return difference;
  }
  return a.memberIndices.length - b.memberIndices.length;
}

/** Géométrie seulement : aucun terrain, RNG ou état mutable n'est consulté. */
export function evaluateExpertTactics(
  self: Player,
  players: readonly Player[],
  memory: Readonly<AimMemory>,
): ExpertTacticalEvaluation {
  const enemies = players.map((player, index) => ({ player, index }))
    .filter(({ player }) => player.id !== self.id && !player.tank.isDead);
  const ordinaryTarget = enemies.find(({ player }) => player.id === memory.currentTargetId)?.player ??
    [...enemies].sort((a, b) => Number(a.player.isHuman) - Number(b.player.isHuman) ||
      a.player.tank.health - b.player.tank.health || a.index - b.index)[0]?.player;
  const candidates: HeavyCandidate[] = [];
  // Une partie contient au plus trois adversaires : trois paires et un triplet.
  for (let mask = 1; mask < 2 ** enemies.length; mask++) {
    const members = enemies.filter((_, index) => (mask & (1 << index)) !== 0);
    if (members.length < 2) continue;
    const hasClosePair = members.some((a, i) => members.slice(i + 1).some((b) =>
      Math.abs(a.player.tank.position.x - b.player.tank.position.x) < 80));
    if (!hasClosePair) continue;
    const point = {
      x: members.reduce((sum, { player }) => sum + player.tank.position.x, 0) / members.length,
      y: members.reduce((sum, { player }) => sum + player.tank.position.y, 0) / members.length,
    };
    const total = (player: Player) => player.tank.health + player.tank.shield;
    const primary = [...members].sort((a, b) => total(a.player) - total(b.player) || a.index - b.index)[0].player;
    const selfDistance = Math.hypot(self.tank.position.x - point.x, self.tank.position.y - point.y);
    for (const weaponId of ["NUKE", "THERMONUCLEAR"] as const) {
      const radius = WEAPON_REGISTRY[weaponId].blastRadius;
      if ((self.inventory[weaponId] ?? 0) <= 0 || selfDistance <= radius + TANK_HITBOX_WIDTH) continue;
      if (weaponId === "THERMONUCLEAR" && selfDistance <= THERMONUCLEAR_INSTANT_KILL_RADIUS) continue;
      if (members.some(({ player }) => Math.hypot(player.tank.position.x - point.x,
        player.tank.position.y - point.y) >= radius)) continue;
      candidates.push({
        weaponId, primaryTargetId: primary.id, point,
        memberIndices: members.map(({ index }) => index),
        healthTotal: members.reduce((sum, { player }) => sum + total(player), 0),
        selfDistance,
        virtualAttempts: memory.currentTargetId === primary.id ? memory.currentTargetAttempts + 1 : 1,
      });
    }
  }
  const best = (weaponId: HeavyWeapon): HeavyCandidate | undefined => candidates
    .filter((candidate) => candidate.weaponId === weaponId && candidate.virtualAttempts > 1)
    .sort(compareHeavyCandidates)[0];
  return {
    ordinaryTarget,
    nuke: best("NUKE"),
    thermonuclear: best("THERMONUCLEAR"),
    preparation: [...candidates].sort(compareHeavyCandidates)[0],
    candidates,
  };
}
