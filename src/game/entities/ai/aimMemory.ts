import { normalizeAimRound } from "./fallibleAim";

/**
 * Mémoire de convergence limitée à une séquence consécutive sur la même cible.
 */
export interface AimMemory {
  currentTargetId?: string;
  currentTargetAttempts: number;
  lastRoundNumber?: number;
}

/**
 * À appeler avant de sélectionner la cible : la cible collée ne survit jamais
 * à un changement de manche.
 */
export function resetAimMemoryForRound(
  memory: AimMemory,
  roundNumber: number | undefined,
): boolean {
  const normalizedRound = normalizeAimRound(roundNumber);
  if (memory.lastRoundNumber === normalizedRound) return false;

  memory.lastRoundNumber = normalizedRound;
  memory.currentTargetId = undefined;
  memory.currentTargetAttempts = 0;
  return true;
}

/**
 * À appeler après la sélection : A -> B -> A commence toujours une nouvelle
 * séquence au tir 1.
 */
export function recordAimAttempt(memory: AimMemory, targetId: string): number {
  if (memory.currentTargetId !== targetId) {
    memory.currentTargetId = targetId;
    memory.currentTargetAttempts = 0;
  }
  memory.currentTargetAttempts += 1;
  return memory.currentTargetAttempts;
}
