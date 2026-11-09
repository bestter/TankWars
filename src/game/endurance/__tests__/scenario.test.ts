import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertScenarioSketch, prepareScenarioRound, validateScenario } from "../scenario";
import reference from "../../../../Scripts/endurance/scenarios/issue-361-rock-cliff.json";
import { fixture } from "./helpers";
import { hasValidSpawnRoster } from "../../round/prepareRound";
import { getRNG, setRNG } from "../../../utils/random";
import { resolvePhysicalShot } from "../../entities/ai/physicalShotForecast";
import { TerrainManager } from "../../engine/Terrain";
import { GameEngine } from "../../engine/GameEngine";
import { EnduranceSession } from "../session";

const previous = getRNG();
afterEach(() => { setRNG(previous); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("custom endurance scenario", () => {
  it.each(["", "\n..\ndd", "{\n..\ndd", "{invalid}\n..\ndd"])("standardizes malformed sketch headers: %j", text => {
    expect(() => convertScenarioSketch(text)).toThrow("INVALID_SCENARIO: header must be valid JSON metadata");
  });
  it("converts the complete sketch deterministically with exact fractional spawns and orientation", () => {
    const text = readFileSync("Scripts/endurance/scenarios/issue-361-rock-cliff.txt", "utf8");
    expect(convertScenarioSketch(text)).toEqual(reference);
    expect(convertScenarioSketch(text)).toEqual(convertScenarioSketch(text));
    const s = validateScenario(reference);
    expect(s.heights[126]).toBe(412); expect(s.heights[695]).toBe(339);
    expect(s.heights[675]).toBeLessThanOrEqual(314); expect(s.heights[676]).toBeLessThanOrEqual(314);
    expect(s.materials[675]).toBe("ROCK"); expect(s.materials[126]).toBe("DIRT");
    expect(s.materials[695]).toBe("DIRT"); expect(new Set(s.materials).size).toBe(3);
  });
  it.each(["..\ndd\nd", ".x\ndd", "dd\n.d\ndd", "..\ndr\ndd", "..\n.d\n.d"])("rejects impossible drawings without modifying them: %s", drawing => {
    const source = JSON.stringify({ id: "x", name: "x", spawnXs: [104, 696], wind: 0 }) + "\n" + drawing;
    expect(() => convertScenarioSketch(source)).toThrow(/line|column/);
  });
  it("ignores a stale terrainId in sketch metadata and computes the correct new fingerprint", () => {
    const header = JSON.stringify({ id: "custom", name: "Custom", wind: 0, spawnXs: [104, 696], terrainId: "stale-or-wrong" });
    const drawing = "..\n" + "dd\n".repeat(479);
    const converted = convertScenarioSketch(header + "\n" + drawing);
    expect(converted.terrainId).not.toBe("stale-or-wrong");
    expect(converted.terrainId).toMatch(/^[0-9a-f]{16}$/);
    expect(validateScenario(converted)).toEqual(converted);
  });
  it.each([
    { schemaVersion: 2 }, { id: " " }, { name: " " }, { width: 801 }, { height: 479 },
    { heights: Array(799).fill(300) }, { heights: Array(800).fill(NaN) }, { heights: Array(800).fill(480) },
    { materials: Array(800).fill("VOID") }, { materials: [] }, { wind: 61 }, { wind: Infinity },
    { spawnXs: [103.999, 696] }, { spawnXs: [104, 696.001] }, { spawnXs: [104, 203.999] },
    { spawnXs: [104] }, { spawnXs: [104, 204, 304, 404, 504] }, { spawnXs: [NaN, 696] }, { terrainId: "wrong" },
  ])("rejects invalid schema fields %j", patch => { expect(() => validateScenario({ ...reference, ...patch })).toThrow("INVALID_SCENARIO"); });
  it("accepts schema boundaries, 2–4 slots, manual edits and safe all-ROCK bases; rejects mixed bases and lava", () => {
    for (const spawnXs of [[104, 696], [104, 300.25, 696], [104, 204, 400.5, 696]]) {
      const s = validateScenario({ ...reference, terrainId: undefined, heights: Array(800).fill(0), materials: Array(800).fill("ROCK"), spawnXs, wind: -60 });
      expect(s.spawnXs).toEqual(spawnXs);
    }
    const source = { ...reference, terrainId: undefined, heights: Array(800).fill(479), materials: Array(800).fill("DIRT") };
    expect(() => validateScenario(source)).toThrow("lava");
    source.heights[126] = 473.999; source.heights[695] = 0;
    expect(() => validateScenario(source)).toThrow("lava");
    for (let c = 114; c <= 138; c++) source.heights[c] = 473.999;
    for (let c = 683; c <= 707; c++) source.heights[c] = 0;
    expect(validateScenario(source).heights[0]).toBe(479);
    source.materials[126] = "ROCK";
    expect(() => validateScenario(source)).toThrow("mixed ROCK");
    expect(source.materials[126]).toBe("ROCK");
  });
  it.each([114, 138])("checks the fractional spawn footprint's boundary column %i at the lava threshold", column => {
    const heights = Array<number>(800).fill(300);
    const source = { ...reference, terrainId: undefined, heights, materials: Array(800).fill("DIRT"), spawnXs: [126.5, 600] };
    heights[113] = 474; heights[139] = 474; // Immediately outside the inclusive footprint [114, 138].
    heights[114] = 473.999; heights[138] = 473.999;
    expect(validateScenario(source).spawnXs[0]).toBe(126.5);
    heights[column] = 474; // Only one of the two boundary columns now touches lava.
    expect(() => validateScenario(source)).toThrow("inclusive base [114, 138]");
    heights[column] = 473.999;
    expect(validateScenario(source).heights[column]).toBe(473.999);
  });
  it("requires removing a stale terrainId after a manual terrain edit", () => {
    const heights = [...reference.heights]; heights[0] += 1;
    expect(() => validateScenario({ ...reference, heights })).toThrow("terrainId mismatch");
    const edited = validateScenario({ ...reference, heights, terrainId: undefined });
    expect(edited.terrainId).not.toBe(reference.terrainId);
    expect(validateScenario(edited)).toEqual(edited);
  });
  it("prepares fresh rounds without random draws, resetting combat while preserving session economics", () => {
    const f = fixture(), scenario = validateScenario(reference);
    const rng = vi.fn(() => { throw new Error("unexpected random draw"); }); setRNG({ next: rng });
    const before = structuredClone(f.players);
    f.players[0].tank.health = 1; f.players[0].tank.isDead = true; f.players[0].money = 789;
    const first = prepareScenarioRound(scenario, f.players, 1);
    expect(hasValidSpawnRoster(first.map, first.players)).toBe(true);
    first.map.heights[126] = 460; first.players[0].inventory.NUKE = 0;
    const next = prepareScenarioRound(scenario, f.players, 8);
    expect(next.map.heights[126]).toBe(412); expect(next.map.roundNumber).toBe(8);
    expect(next.players[0]).toMatchObject({ money: 789, tank: { health: 100, shield: 40, currentWeapon: "MISSILE", isDead: false, position: { x: 126.483, y: 412 } } });
    expect(next.players[0].inventory).toEqual(before[0].inventory); expect(rng).not.toHaveBeenCalled();
  });
  it("does not count or journal failed preparation twice on retry", async () => {
    const f = fixture(); const run = new EnduranceSession({ ...f.config, scenario: validateScenario(reference) }, f.storage);
    expect(run.session.config.players[0].tank).not.toHaveProperty("lastHitBy");
    expect(run.session.config.players[0].tank).not.toHaveProperty("lastDirectAttackerId");
    expect(run.session.config.players[0].tank).not.toHaveProperty("hitReaction");
    await run.start(); run.attach(f.host);
    expect(run.session.roundsStarted).toBe(0); run.cancelRoundPreparation();
    run.beginRound(1); run.confirmRoundPreparation(); run.confirmRoundPreparation();
    expect(run.session.roundsStarted).toBe(1); await run.stop();
  });
  it("measures the reconstructed cliff with the journal command and a normalized high shot", () => {
    const scenario = validateScenario(reference), f = fixture();
    const { players, map } = prepareScenarioRound(scenario, f.players, 1);
    const terrain = new TerrainManager(800, 480); terrain.loadHeights(map.heights, map.materials);
    const state = { phase: "COMBAT" as const, players, currentPlayerIndex: 1, turn: 1, gravity: 260, windForce: 48.2 };
    const blocked = resolvePhysicalShot(state, terrain, players[1], "MISSILE", { angle: 149.5, power: 57 });
    expect(blocked.complete).toBe(true); expect(blocked.damage).toEqual([]);
    expect(terrain.getMaterialAt(blocked.hits[0].x)).toBe("ROCK");
    expect(Math.abs(blocked.hits[0].x - 695.675)).toBeLessThan(20);
    // Measured by the same authoritative physical resolver; no claim about EXPERT selection.
    const high = resolvePhysicalShot(state, terrain, players[1], "MISSILE", { angle: 127.5, power: 96 });
    expect(high.hits[0].directTargetId).toBe(players[0].id);
    expect(high.damage.length).toBeGreaterThan(0);
    expect(high.complete).toBe(true); expect(high.hits[0].x).toBeLessThan(240);
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const engine = new GameEngine(800, 480); engine.setPlayers(players, map);
    engine.getTurnManager().removeInputListeners(); engine.stop();
  });
});
