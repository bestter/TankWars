import type { AiProfile } from "../types/player";
import { DEFAULT_AI_PROFILE } from "./playerControllerUi";

export interface NamedPlayerConfig {
  id: string;
  name: string;
  isHuman: boolean;
  aiProfile?: AiProfile;
}

export const normalizePlayerName = (name: string): string =>
  name.trim().toLocaleLowerCase();

export const getNameConflictIds = (
  configs: readonly NamedPlayerConfig[],
  playerId: string,
): string[] => {
  const player = configs.find((cfg) => cfg.id === playerId);
  if (!player) return [];

  const normalizedName = normalizePlayerName(player.name);
  if (normalizedName.length === 0) return [];

  const conflictIds: string[] = [];
  for (const cfg of configs) {
    if (
      cfg.id !== playerId &&
      normalizePlayerName(cfg.name) === normalizedName
    ) {
      conflictIds.push(cfg.id);
    }
  }
  return conflictIds;
};

export const getDuplicateNameGroups = (
  configs: readonly NamedPlayerConfig[],
): NamedPlayerConfig[][] => {
  const groups = new Map<string, NamedPlayerConfig[]>();
  for (const cfg of configs) {
    const normalizedName = normalizePlayerName(cfg.name);
    if (normalizedName.length === 0) continue;
    const group = groups.get(normalizedName) ?? [];
    group.push(cfg);
    groups.set(normalizedName, group);
  }

  const duplicateGroups: NamedPlayerConfig[][] = [];
  for (const group of groups.values()) {
    if (group.length > 1) duplicateGroups.push(group);
  }
  return duplicateGroups;
};

export const getUniqueAiName = (
  baseName: string,
  profile: AiProfile,
  configs: readonly NamedPlayerConfig[],
  index: number,
): string => {
  let matchingProfileCount = 0;
  const usedNames = new Set<string>();
  for (let configIndex = 0; configIndex < configs.length; configIndex += 1) {
    if (configIndex === index) continue;
    const cfg = configs[configIndex];
    if (!cfg) continue;
    usedNames.add(normalizePlayerName(cfg.name));
    if (
      !cfg.isHuman &&
      (cfg.aiProfile ?? DEFAULT_AI_PROFILE) === profile
    ) {
      matchingProfileCount += 1;
    }
  }

  let suffix = matchingProfileCount;
  let candidate = suffix === 0 ? baseName : `${baseName}-${suffix}`;
  while (usedNames.has(normalizePlayerName(candidate))) {
    suffix += 1;
    candidate = `${baseName}-${suffix}`;
  }
  return candidate;
};
