import { getDuplicateNameGroups, type NamedPlayerConfig } from "./src/components/playerNameUi.js";
import { performance } from "perf_hooks";

// Create mock configs
const generateConfigs = (numGroups: number, groupSize: number): NamedPlayerConfig[] => {
  const configs: NamedPlayerConfig[] = [];
  let idCounter = 0;
  for (let i = 0; i < numGroups; i++) {
    for (let j = 0; j < groupSize; j++) {
      configs.push({
        id: `p${idCounter++}`,
        name: `Name${i}`,
        isHuman: true,
      });
    }
  }
  return configs;
};

const configs = generateConfigs(1000, 10);
const duplicateGroups = getDuplicateNameGroups(configs);

const prev = new Set<string>();
for (let i = 0; i < 1000; i++) {
  prev.add(`p${i * 10 + 5}`); // Add some existing errors
}
const preferredPlayerId = 'p9999';

// Baseline measurement
const measureOptimized = () => {
  const start = performance.now();
  const next = new Set<string>();

  for (let iter = 0; iter < 1000; iter++) {
    for (const group of duplicateGroups) {
      let preferredPlayer: NamedPlayerConfig | undefined;
      let existingError: NamedPlayerConfig | undefined;

      for (const cfg of group) {
        if (cfg.id === preferredPlayerId) {
          preferredPlayer = cfg;
        }
        if (existingError === undefined && prev.has(cfg.id)) {
          existingError = cfg;
        }
        if (preferredPlayer !== undefined && existingError !== undefined) {
           break;
        }
      }

      const errorPlayer =
        preferredPlayer ?? existingError ?? group[group.length - 1];
      if (errorPlayer) next.add(errorPlayer.id);
    }
  }

  const end = performance.now();
  return end - start;
};

console.log(`Optimized time: ${measureOptimized().toFixed(2)} ms`);
