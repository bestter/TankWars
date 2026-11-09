import { TANK_HITBOX_WIDTH } from "../combatConstants";
import { fingerprint } from "../diagnostics/archive";
import { spawnTerrain, type RoundMap } from "../round/prepareRound";
import { hasSafeRockBase, resetPlayersForSpawn } from "../round/spawnPlacement";
import type { Player } from "../../types/player";
import type { TerrainMaterial } from "../../types/terrain";

export interface EnduranceScenario {
  schemaVersion: 1;
  id: string;
  name: string;
  width: 800;
  height: 480;
  heights: number[];
  materials: TerrainMaterial[];
  wind: number;
  spawnXs: number[];
  terrainId: string;
}

function requireScenario(condition: unknown, cause: string): asserts condition {
  if (!condition) throw new Error(`INVALID_SCENARIO: ${cause}`);
}
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The single validator shared by the browser, converter and Python preflight. Never mutates input. */
export function validateScenario(value: unknown): EnduranceScenario {
  requireScenario(typeof value === "object" && value !== null && !Array.isArray(value), "object required");
  const s = value as Record<string, unknown>;
  requireScenario(s.schemaVersion === 1, "schemaVersion must be 1");
  requireScenario(typeof s.id === "string" && s.id.trim() && typeof s.name === "string" && s.name.trim(), "id/name required");
  requireScenario(s.width === 800 && s.height === 480, "dimensions must be 800 × 480");
  requireScenario(Array.isArray(s.heights) && s.heights.length === 800, "800 heights required");
  const heights = Array.from(s.heights, (h: unknown, x) => {
    requireScenario(finite(h) && h >= 0 && h <= 479, `height column ${x}: expected [0, 479]`); return h;
  });
  requireScenario(Array.isArray(s.materials) && s.materials.length === 800, "800 materials required");
  const materials = Array.from(s.materials, (m: unknown, x): TerrainMaterial => {
    requireScenario(m === "DIRT" || m === "SOFT" || m === "ROCK", `material column ${x}`); return m;
  });
  requireScenario(finite(s.wind) && s.wind >= -60 && s.wind <= 60, "wind expected [-60, 60]");
  requireScenario(Array.isArray(s.spawnXs) && s.spawnXs.length >= 2 && s.spawnXs.length <= 4, "2–4 spawnXs required");
  const terrain = spawnTerrain(800, { heights, materials });
  const spawnXs = Array.from(s.spawnXs, (x: unknown, i) => {
    requireScenario(finite(x) && x >= 104 && x <= 696, `spawn ${i + 1}: X expected [104, 696]`);
    const left = Math.floor(x - TANK_HITBOX_WIDTH / 2);
    const right = Math.ceil(x + TANK_HITBOX_WIDTH / 2) - 1;
    requireScenario(
      heights.slice(left, right + 1).every(h => h < 474),
      `spawn ${i + 1}: lava (Y must be < 474 in every column of inclusive base [${left}, ${right}] = [floor(X - 12), ceil(X + 12) - 1], X=${x})`,
    );
    requireScenario(hasSafeRockBase(x, terrain), `spawn ${i + 1}: mixed ROCK base`);
    return x;
  });
  requireScenario(spawnXs.every((x, i) => spawnXs.slice(0, i).every(other => Math.abs(other - x) >= 100)), "spawns must be at least 100 px apart");
  const content = { width: 800 as const, height: 480 as const, heights, materials };
  const terrainId = fingerprint(content);
  requireScenario(s.terrainId === undefined || s.terrainId === terrainId, "terrainId mismatch");
  return { schemaVersion: 1, id: s.id.trim(), name: s.name.trim(), ...content, wind: s.wind, spawnXs, terrainId };
}

export function prepareScenarioRound(scenario: EnduranceScenario, players: readonly Player[], roundNumber: number): { map: RoundMap; players: Player[] } {
  requireScenario(players.length === scenario.spawnXs.length, "profile count differs from spawn count");
  const map: RoundMap = { width: 800, height: 480, heights: [...scenario.heights], materials: [...scenario.materials], wind: scenario.wind, roundNumber };
  return { map, players: resetPlayersForSpawn(players, scenario.spawnXs, spawnTerrain(800, map)) };
}

export function scenarioProvenance(scenario?: EnduranceScenario | null) {
  return scenario ? { mode: "custom" as const, id: scenario.id, name: scenario.name, schemaVersion: scenario.schemaVersion,
    terrainId: scenario.terrainId, wind: scenario.wind, spawnXs: [...scenario.spawnXs] } : { mode: "generated" as const };
}

const SKETCH_MATERIALS = { d: "DIRT", s: "SOFT", r: "ROCK" } as const;

/** First line JSON metadata, followed by a rectangular, top-to-bottom silhouette. */
export function convertScenarioSketch(text: string): EnduranceScenario {
  const [header, ...rows] = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  let metadata: unknown;
  try {
    metadata = JSON.parse(header) as unknown;
  } catch {
    throw new Error("INVALID_SCENARIO: header must be valid JSON metadata");
  }
  requireScenario(typeof metadata === "object" && metadata !== null && !Array.isArray(metadata), "metadata required");
  const width = rows[0]?.length ?? 0;
  requireScenario(width > 0 && width <= 800 && rows.length > 0 && rows.length <= 480, "sketch dimensions expected 1–800 × 1–480");
  rows.forEach((row, y) => {
    requireScenario(row.length === width, `line ${y + 2}: inconsistent width`);
    for (let x = 0; x < width; x++) requireScenario(".dsr".includes(row[x]), `line ${y + 2}, column ${x + 1}: unknown character`);
  });
  const columns = Array.from({ length: width }, (_, x) => {
    // The first solid row sets Y = floor(row * 480 / H); everything below must stay solid and uniform.
    const top = rows.findIndex(row => row[x] !== ".");
    requireScenario(top >= 0, `column ${x + 1}: empty`);
    const material = rows[top][x] as keyof typeof SKETCH_MATERIALS;
    for (let y = top; y < rows.length; y++) requireScenario(rows[y][x] === material, `line ${y + 2}, column ${x + 1}: tunnel, overhang or layered materials`);
    return { height: Math.floor(top * 480 / rows.length), material: SKETCH_MATERIALS[material] };
  });
  const cleanMetadata = typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : {};
  delete cleanMetadata.terrainId;
  // Each game column x copies source column floor(x * W / 800), without interpolation.
  return validateScenario({ ...cleanMetadata, schemaVersion: 1, width: 800, height: 480,
    heights: Array.from({ length: 800 }, (_, x) => columns[Math.floor(x * width / 800)].height),
    materials: Array.from({ length: 800 }, (_, x) => columns[Math.floor(x * width / 800)].material) });
}
