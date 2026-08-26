import { useRef, useState } from "react";
import {
  getDuplicateNameGroups,
  getEmptyNamePlayerIds,
  getNameConflictIds,
  normalizePlayerName,
  type NamedPlayerConfig,
} from "./playerNameUi";

interface PlayerNameValidation {
  beginNameEdit: (player: NamedPlayerConfig) => void;
  focusName: (playerId: string) => void;
  pendingPlayerId: () => string | undefined;
  validateNames: (
    preferredPlayerId?: string,
    overrideConfigs?: readonly NamedPlayerConfig[],
  ) => boolean;
  visibleErrorIds: ReadonlySet<string>;
  emptyNameErrorIds: ReadonlySet<string>;
  conflictSourceIds: ReadonlySet<string>;
}

export function usePlayerNameValidation(
  configs: readonly NamedPlayerConfig[],
): PlayerNameValidation {
  const pendingPlayerIdRef = useRef<string | null>(null);
  const [errorIds, setErrorIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const configById = new Map<string, NamedPlayerConfig>();
  for (const config of configs) {
    configById.set(config.id, config);
  }

  const beginNameEdit = (player: NamedPlayerConfig): void => {
    const previousNormalizedName = normalizePlayerName(player.name);
    pendingPlayerIdRef.current = player.id;
    setErrorIds((prev) => {
      const next = new Set<string>();
      for (const errorId of prev) {
        const errorPlayer = configById.get(errorId);
        if (
          errorPlayer &&
          normalizePlayerName(errorPlayer.name) !== previousNormalizedName
        ) {
          next.add(errorId);
        }
      }
      next.delete(player.id);
      return next;
    });
  };

  const focusName = (playerId: string): void => {
    pendingPlayerIdRef.current = playerId;
  };

  const pendingPlayerId = (): string | undefined =>
    pendingPlayerIdRef.current ?? undefined;

  const validateNames = (
    preferredPlayerId?: string,
    overrideConfigs?: readonly NamedPlayerConfig[],
  ): boolean => {
    const activeConfigs = overrideConfigs ?? configs;
    const duplicateGroups = getDuplicateNameGroups(activeConfigs);
    const emptyIds = getEmptyNamePlayerIds(activeConfigs);

    setErrorIds((prev) => {
      const next = new Set<string>();
      for (const group of duplicateGroups) {
        const preferredPlayer = group.find(
          (cfg) => cfg.id === preferredPlayerId,
        );
        const existingError = group.find((cfg) => prev.has(cfg.id));
        const errorPlayer =
          preferredPlayer ?? existingError ?? group[group.length - 1];
        if (errorPlayer) next.add(errorPlayer.id);
      }
      for (const id of emptyIds) {
        if (
          preferredPlayerId === undefined ||
          preferredPlayerId === id ||
          prev.has(id)
        ) {
          next.add(id);
        }
      }
      return next;
    });
    pendingPlayerIdRef.current = null;
    return duplicateGroups.length === 0 && emptyIds.length === 0;
  };

  const visibleErrorIds = new Set<string>();
  const emptyNameErrorIds = new Set<string>();
  const conflictSourceIds = new Set<string>();
  for (const playerId of errorIds) {
    const player = configById.get(playerId);
    if (!player) continue;
    if (normalizePlayerName(player.name).length === 0) {
      visibleErrorIds.add(playerId);
      emptyNameErrorIds.add(playerId);
      continue;
    }
    const conflictIds = getNameConflictIds(configs, playerId);
    if (conflictIds.length === 0) continue;
    visibleErrorIds.add(playerId);
    for (const conflictId of conflictIds) {
      conflictSourceIds.add(conflictId);
    }
  }

  return {
    beginNameEdit,
    focusName,
    pendingPlayerId,
    validateNames,
    visibleErrorIds,
    emptyNameErrorIds,
    conflictSourceIds,
  };
}
