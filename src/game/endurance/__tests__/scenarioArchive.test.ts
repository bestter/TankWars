import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import reference from "../../../../Scripts/endurance/scenarios/issue-361-rock-cliff.json";
import { validateScenario, prepareScenarioRound } from "../scenario";
import { IndexedEnduranceStorage, validateSessionRecord } from "../storage";
import { EnduranceSession } from "../session";
import { fixture } from "./helpers";
import { GameEngine } from "../../engine/GameEngine";
import { fingerprint } from "../../diagnostics/archive";
import { validateArchive } from "../../diagnostics/validate";
import { replayShot } from "../../diagnostics/replay";
import { buildBundle } from "../bundle/build";
import { validateBundle, extractShot } from "../bundle/read";
import { MemoryDisk } from "./bundleMemory";

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("persists initial terrain before firing, deduplicates modified terrain, replays shot two and recovers the config", async () => {
  const f = fixture(), scenario = validateScenario(reference), storage = new IndexedEnduranceStorage();
  const run = new EnduranceSession({ ...f.config, scenario }, storage);
  await run.start();
  const initial = validateArchive(await run.exportArchive());
  expect(initial.terrains.map(t => t.id)).toEqual([scenario.terrainId]);
  const emptyDisk = new MemoryDisk();
  expect((await buildBundle(await run.bundleSource(), emptyDisk)).terrain).toMatchObject({ mode: "custom", terrainId: scenario.terrainId });
  await validateBundle(emptyDisk);
  const engine = new GameEngine(800, 480, { headless: true, gravity: 260, baseShotSpeed: 420 });
  try {
    const prepared = prepareScenarioRound(scenario, run.session.config.players, 1);
    engine.diagnosticSink = input => run.diagnostic(input);
    engine.combatObserver = run; engine.getTurnManager().combatObserver = run;
    run.attach({ stop: () => engine.stop(), context: () => ({ players: [...engine.getTankManager().getPlayers()],
      ...engine.getCombatMap(1), phase: "COMBAT", windForce: 48.2 }) });
    engine.setPlayers(prepared.players.map(p => ({ ...p, isHuman: true })), prepared.map);
    const update = Reflect.get(engine, "update") as (dt: number) => void;
    for (const [index, angle, power] of [[1, 127.5, 96], [0, 60, 40]]) {
      engine.getTurnManager().syncTurn(index);
      const actor = engine.getTankManager().getPlayers()[index]; actor.tank.angle = angle; actor.tank.power = power;
      expect(engine.getTurnManager().tryFire()).toBe(true);
      for (let step = 0; step < 10000 && !engine.getPendingShotResult(); step++) update.call(engine, 1 / 120);
      expect(engine.getPendingShotResult()).not.toBeNull();
      // Apply the ordinary economic settlement before permitting the next shot.

    }
    const archive = validateArchive(await run.exportArchive());
    const shots = archive.records.filter(r => r.input.kind === "pre-shot");
    expect(shots).toHaveLength(2);
    const second = shots[1];
    expect(second.input.kind === "pre-shot" && second.input.snapshot.terrainId).not.toBe(scenario.terrainId);
    expect(archive.terrains.length).toBe(new Set(archive.terrains.map(t => t.id)).size);
    const replay = replayShot(archive, second.shotKey!);
    expect(replay).toMatchObject({ complete: true, physicalDivergence: null, economicDivergence: null });
    const disk = new MemoryDisk(); await buildBundle(await run.bundleSource(), disk); await validateBundle(disk);
    const extracted = await extractShot(disk, second.shotKey!);
    expect(replayShot(extracted, second.shotKey!)).toMatchObject({ complete: true, physicalDivergence: null });
    await run.stop(); const saved = await storage.latest();
    expect(saved?.config.scenario).toEqual(scenario);
    expect(validateSessionRecord(saved).config.players[1].tank.position).toEqual({ x: 695.675, y: 339 });
    const legacy = structuredClone(saved!); delete legacy.config.scenario; delete legacy.terrain;
    expect(validateSessionRecord(legacy).config.scenario).toBeUndefined();
    expect(fingerprint({ width: 800, height: 480, heights: scenario.heights, materials: scenario.materials })).toBe(scenario.terrainId);
  } finally { engine.stop(); storage.close(); }
});
