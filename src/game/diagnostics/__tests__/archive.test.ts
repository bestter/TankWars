import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { GameEngine } from "../../engine/GameEngine";
import { makePlayer, makeTank, makeRoundMap } from "../../__tests__/helpers";
import { ShotRecorder, byteSize, fingerprint, sealArchive, recordTerrainId } from "../archive";
import { replayShot } from "../replay";
import { validateArchive } from "../validate";
import { filterArchive, exportStoredArchive } from "../export";
import { IndexedEnduranceStorage } from "../../endurance/storage";
import { EnduranceJournal } from "../../endurance/journal";
import type { ArchiveRecord, ArchiveWrite, ShotArchive, TerrainRecord } from "../types";
import type { WeaponId } from "../../../types/weapon";
import { EnduranceSession } from "../../endurance/session";
import { fixture } from "../../endurance/__tests__/helpers";
import { createSeededRNG, getRNG, setRNG } from "../../../utils/random";
import { AISimpleStrategy } from "../../entities/ai/AISimpleStrategy";
import { AIHeuristicStrategy } from "../../entities/ai/AIHeuristicStrategy";
import { AISniperStrategy } from "../../entities/ai/AISniperStrategy";
import { AISmartStrategy } from "../../entities/ai/AISmartStrategy";
import { flatTerrain } from "../../__tests__/helpers";

beforeEach(() => {
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function realShot(weapon: WeaponId = "MISSILE", collect = true, rock = false, direct = false) {
  const engine = new GameEngine(800, 480, { headless: true });
  const recorder = new ShotRecorder("test-session");
  const map = makeRoundMap(); if (rock) map.materials.fill("ROCK");
  engine.setPlayers([makePlayer({ id: "a", tank: makeTank("ta", 120, 300), inventory: { [weapon]: weapon === "NUKE" || weapon === "THERMONUCLEAR" ? 1 : 3 } }),
    makePlayer({ id: "b", tank: makeTank("tb", direct ? 240 : 420, 300) })], map);
  if (collect) {
    engine.diagnosticSink = input => recorder.record(input);
    const observer = { emit: (event: import("../../endurance/types").EnduranceEvent) => { recorder.record({ kind: "combat", event }); return true; } };
    engine.combatObserver = observer; engine.getTurnManager().combatObserver = observer;
    engine.getPhysicsEngine().onPhysicalObserved = observation => { observer.emit({ kind: "physical", observation }); };
  }
  const actor = engine.getTankManager().getPlayers()[0];
  actor.tank.angle = direct ? 0 : 50; actor.tank.power = direct ? 99 : 55; actor.tank.currentWeapon = weapon;
  const previous = getRNG(), seeded = createSeededRNG(88), draws: number[] = [];
  setRNG({ next: () => { const value = seeded.next(); draws.push(value); return value; } });
  expect(engine.getTurnManager().tryFire()).toBe(true);
  const update = Reflect.get(engine, "update") as (dt: number) => void;
  for (let step = 0; step < 10000 && !engine.getPendingShotResult(); step++) update.call(engine, 1 / 120);
  expect(engine.getPendingShotResult()).not.toBeNull();
  const result = { players: structuredClone(engine.getTankManager().getPlayers()), heights: [...engine.getTerrain().getHeightmap()] };
  const archive = recorder.export(); engine.stop(); setRNG(previous);
  return { archive, result, recorder, draws };
}
function resign(archive: ShotArchive): void {
  for (const r of archive.records) r.integrity = fingerprint({ ...r, integrity: undefined });
  archive.integrity = sealArchive(archive).integrity;
}

describe("single-shot archives against the real local engine", () => {
  it.each([null, undefined, 42, "broken", [], {}, { terrainId: 42 }])("ignores corrupt snapshot terrain references: %j", snapshot => {
    const record = { input: { kind: "pre-shot", snapshot } } as unknown as ArchiveRecord;
    expect(recordTerrainId(record)).toBeUndefined();
  });
  it("retains initial terrain dependencies through pruning and filtering", () => {
    const recorder = new ShotRecorder("initial-terrain");
    const terrain = { id: "initial", width: 800, height: 480, heights: Array<number>(800).fill(300), materials: Array<"DIRT">(800).fill("DIRT") };
    recorder.record({ kind: "boundary", status: "initial-scenario", detail: { terrainId: terrain.id } }, terrain);
    const archive = recorder.export();
    expect(archive.terrains).toEqual([terrain]);
    expect(filterArchive(archive).terrains).toEqual([terrain]);
    expect(recordTerrainId({ input: { snapshot: { terrainId: "current" } } } as unknown as ArchiveRecord)).toBe("current");
  });
  it("captures the owning UI phase for a current snapshot outside combat", () => {
    const engine = new GameEngine(800, 480, { headless: true });
    engine.diagnosticPhase = () => "SHOP";
    expect(engine.captureDiagnosticState().state.phase).toBe("SHOP"); engine.stop();
  });
  it("exports a real SNIPER fallback with self-damage after later terrain changes", async () => {
    const previous = getRNG(); setRNG({ next: () => 0.01 });
    const engine = new GameEngine(800, 480, { headless: true }); const recorder = new ShotRecorder("sniper-regression");
    try {
      const map = makeRoundMap(); for (let x = 141; x <= 170; x++) map.heights[x] = 100;
      engine.setPlayers([makePlayer({ id: "s", inventory: {}, tank: makeTank("ts", 120, 300) }), makePlayer({ id: "b", tank: makeTank("tb", 420, 300) })], map);
      const actor = engine.getTankManager().getPlayers()[0]; actor.isHuman = false; actor.aiProfile = "v3-sniper"; actor.tank.hitReaction = { wasDirectHit: true, fallDistance: 120 };
      const observer = { emit: (event: import("../../endurance/types").EnduranceEvent) => { recorder.record({ kind: "combat", event }); return true; } };
      engine.combatObserver = observer; engine.getTurnManager().combatObserver = observer;
      engine.diagnosticSink = input => recorder.record(input);
      const strategy = new AISniperStrategy(); strategy.onDecisionObserved = observation => { observer.emit({ kind: "ai-detail", observation }); };
      observer.emit({ kind: "decision-start", playerId: "s" });
      const state = engine.getTurnManager().captureDiagnosticContext(); state.roundNumber = 12;
      const command = await strategy.executeTurn("ts", state, engine.getTerrain());
      expect(command.weaponId).toBe("MISSILE");
      engine.getTurnManager().executeRemoteFire({ ...command, weaponId: "MISSILE" }, { ownerId: "s" });
      const update = Reflect.get(engine, "update") as (dt: number) => void;
      for (let step = 0; step < 10000 && !engine.getPendingShotResult(); step++) update.call(engine, 1 / 120);
      const original = recorder.export(); const key = original.records.find(r => r.input.kind === "pre-shot")!.shotKey!;
      expect(original.records.some(r => r.input.kind === "combat" && r.input.event.kind === "damage" &&
        r.input.event.event.victimId === "s" && r.input.event.event.healthDamageMilli + r.input.event.event.shieldLostMilli > 0), JSON.stringify({command, events: original.records.filter(r => r.input.kind === "impact" || (r.input.kind === "combat" && r.input.event.kind === "damage"))})).toBe(true);
      engine.getTerrain().loadHeights(Array<number>(800).fill(450), Array(800).fill("SOFT"));
      recorder.record({ kind: "current", snapshot: engine.captureDiagnosticState() });
      const late = filterArchive(recorder.export(), { shotKey: key });
      const replay = replayShot(late, key); expect(replay.complete).toBe(true); expect(replay.physicalDivergence).toBeNull();
      expect(replay.economicDivergence).toBeNull();
      expect(late.records.some(r => r.input.kind === "combat" && r.input.event.kind === "ai-detail" &&
        r.input.event.observation.target?.playerId === "b")).toBe(true);
    } finally { engine.stop(); setRNG(previous); }
  });
  it.each(["MISSILE", "BULLET", "GRENADE", "CLUSTER", "DRILLER", "BULLDOZER", "NUKE", "THERMONUCLEAR"] as const)("replays %s with identical physical and economic results", weapon => {
    const { archive } = realShot(weapon, true, weapon === "NUKE" || weapon === "THERMONUCLEAR");
    const key = archive.records.find(r => r.input.kind === "pre-shot")!.shotKey!;
    const replay = replayShot(archive, key);
    expect(replay.complete).toBe(true);
    expect(replay.physicalDivergence).toBeNull(); expect(replay.economicDivergence).toBeNull();
  });
  it.each(["BULLET", "DRILLER", "BULLDOZER", "NUKE", "THERMONUCLEAR"] as const)("matches direct %s impacts, displacement and local ROCK consequences", weapon => {
    const { archive } = realShot(weapon, true, weapon === "NUKE" || weapon === "THERMONUCLEAR", true);
    const key = archive.records.find(r => r.input.kind === "pre-shot")!.shotKey!;
    const result = replayShot(archive, key);
    expect(result.hits.some(hit => hit.directTargetId === "b")).toBe(true);
    expect(result.physicalDivergence).toBeNull(); expect(result.economicDivergence).toBeNull();
    if (weapon === "BULLDOZER") expect(result.players.find(p => p.id === "b")!.tank.position.x).not.toBe(240);
    if (weapon === "DRILLER") expect(result.damage.some(event => event.source === "fall")).toBe(true);
  });
  it("replays GRENADE's real ROCK rebounds with every physical draw", () => {
    const { archive } = realShot("GRENADE", true, true); const key = archive.records.find(r => r.input.kind === "pre-shot")!.shotKey!;
    expect(archive.records.filter(r => r.input.kind === "combat" && r.input.event.kind === "physical").length).toBeGreaterThan(1);
    expect(replayShot(archive, key).physicalDivergence).toBeNull();
  });
  it("keeps original terrain after later mutations and alternatives do not mutate the archive", () => {
    const { archive, recorder } = realShot(); const original = JSON.stringify(archive);
    const key = archive.records.find(r => r.input.kind === "pre-shot")!.shotKey!;
    const alternative = replayShot(archive, key, { angle: 70, power: 40, weaponId: "MISSILE" });
    expect(alternative.random).toBe("fixed-0.5"); expect(alternative.complete).toBe(true);
    expect(JSON.stringify(archive)).toBe(original);
    const selected = filterArchive(recorder.export(), { shotKey: key }); expect(validateArchive(selected).terrains.length).toBeGreaterThan(0);
    expect(replayShot(archive, key, { angle: 70, power: 40, weaponId: "MISSILE" }, 1).complete).toBe(false);
  });
  it("uses the recorded initial velocity instead of recalculating browser trigonometry", () => {
    const { archive } = realShot(); const key = archive.records.find(r => r.input.kind === "pre-shot")!.shotKey!;
    vi.spyOn(Math, "cos").mockReturnValue(0);
    const replay = replayShot(archive, key);
    expect(replay.launchSource).toBe("recorded-projectile"); expect(replay.physicalDivergence).toBeNull();
  });
  it("restores recorded CLUSTER split states across last-bit transcendental differences", () => {
    const { archive } = realShot("CLUSTER"), originalSin = Math.sin;
    const key = archive.records.find(r => r.input.kind === "pre-shot")!.shotKey!;
    vi.spyOn(Math, "sin").mockImplementation(angle => originalSin(angle) * (1 + Number.EPSILON));
    const replay = replayShot(archive, key);
    expect(replay.restoredClusterStates).toBeGreaterThan(0);
    expect(replay.complete).toBe(true); expect(replay.physicalDivergence).toBeNull(); expect(replay.economicDivergence).toBeNull();
  });
  it("refuses CLUSTER state changes beyond the floating-point bound", () => {
    const { archive } = realShot("CLUSTER"), key = archive.records.find(r => r.input.kind === "pre-shot")!.shotKey!;
    const row = archive.records.find(r => r.input.kind === "combat" && r.input.event.kind === "physical")!;
    if (row.input.kind === "combat" && row.input.event.kind === "physical") row.input.event.observation.parameters.vy = Number(row.input.event.observation.parameters.vy) + 0.001;
    resign(archive); expect(() => replayShot(archive, key)).toThrow("PHYSICAL_TAPE_MISALIGNED");
  });
  it("detects a deleted otherwise valid record through the export checksum", () => {
    const { archive } = realShot();
    archive.records = archive.records.filter(r => r.input.kind !== "projectile-launched");
    expect(() => validateArchive(archive)).toThrow("ARCHIVE_INTEGRITY_FAILED");
  });
  it.each(["MISSILE", "GRENADE", "CLUSTER"] as const)("does not change %s results, ammunition or RNG consumption", weapon => {
    const observed = realShot(weapon, true), ordinary = realShot(weapon, false);
    expect(observed.result).toEqual(ordinary.result); expect(observed.draws).toEqual(ordinary.draws);
  });
  it("refuses incomplete/corrupt dependencies and incompatible schemas before replay", () => {
    const { archive } = realShot();
    const missing = structuredClone(archive); missing.terrains = []; expect(() => validateArchive(missing)).toThrow("MISSING_TERRAIN");
    const corrupt = structuredClone(archive); corrupt.terrains[0].materials.pop(); expect(() => validateArchive(corrupt)).toThrow("INVALID_TERRAIN");
    const bad = structuredClone(archive); bad.terrains[0].heights[0]++; expect(() => validateArchive(bad)).toThrow("INTEGRITY");
    expect(() => validateArchive({ ...archive, schemaVersion: 99 })).toThrow("UNSUPPORTED");
    expect(() => validateArchive({ ...archive, rules: "old" })).toThrow("INCOMPATIBLE");
  });
  it("detects missing, surplus and reordered physical consumption", () => {
    const { archive } = realShot("CLUSTER"); const key = archive.records.find(r => r.input.kind === "pre-shot")!.shotKey!;
    const entries = archive.records.filter(r => r.input.kind === "combat" && r.input.event.kind === "physical");
    expect(entries.length).toBeGreaterThan(1);
    const missing = structuredClone(archive); missing.records = missing.records.filter(r => r.sequence !== entries[0].sequence);
    resign(missing);
    expect(() => replayShot(missing, key)).toThrow(/TAPE/);
    const surplus = structuredClone(archive);
    const row = structuredClone(entries[0]); row.sequence = ++surplus.lastSequence; surplus.records.push(row); resign(surplus);
    expect(() => replayShot(surplus, key)).toThrow("SURPLUS");
    const reordered = structuredClone(archive);
    const a = reordered.records.find(r => r.sequence === entries[0].sequence)!, b = reordered.records.find(r => r.sequence === entries[1].sequence)!;
    [a.input, b.input] = [b.input, a.input]; resign(reordered);
    expect(() => replayShot(reordered, key)).toThrow("MISALIGNED");
  });
  it("distinguishes an economic discrepancy from a physical discrepancy", () => {
    const { archive } = realShot(); const key = archive.records.find(r => r.input.kind === "pre-shot")!.shotKey!;
    const settled = archive.records.find(r => r.input.kind === "settled")!.input;
    if (settled.kind !== "settled") throw new Error("fixture");
    settled.snapshot.state.players[0].money++; resign(archive);
    const replay = replayShot(archive, key); expect(replay.physicalDivergence).toBeNull(); expect(replay.economicDivergence).toBe("balances[0]");
    settled.snapshot.state.players[0].tank.health--; resign(archive);
    expect(replayShot(archive, key).physicalDivergence).toBe("players[0].tank.health");
  });
  it("retains no launch capture when the observer refuses admission", () => {
    const engine = new GameEngine(800, 480, { headless: true }); const recorder = new ShotRecorder("refused");
    engine.setPlayers([makePlayer({ id: "a" }), makePlayer({ id: "b", tank: makeTank("tb", 450, 300) })], makeRoundMap());
    engine.diagnosticSink = input => recorder.record(input); engine.combatObserver = { emit: event => event.kind !== "shot" };
    expect(engine.fireProjectile(engine.getTankManager().getPlayers()[0].tank.position, { angle: 45, power: 50, weaponId: "MISSILE" }, "a")).toBe(false);
    expect(recorder.export().records.filter(r => r.input.kind !== "boundary").map(r => r.input.kind)).toEqual(["combat"]); engine.stop();
  });
});

describe("durable, content-addressed captures", () => {
  it("pages shot metadata and exports one middle turn with only its dependencies at a stable upper boundary", async () => {
    const template = realShot().archive, archive = structuredClone(template), storage = new IndexedEnduranceStorage();
    archive.records = [structuredClone(template.records[0])]; let sequence = 1;
    for (let turn = 1; turn <= 41; turn++) for (const original of template.records.slice(1)) {
      const record = structuredClone(original); record.sequence = ++sequence; record.turn = turn; record.round = 1;
      record.shotKey = `${archive.sessionId}:1:${turn}`;
      const input = record.input;
      if ("snapshot" in input) input.snapshot.state.turn = turn;
      if (input.kind === "pre-shot") input.shot.shotId = turn;
      if (input.kind === "projectile-launched") input.projectile.shotId = turn;
      if (input.kind === "impact") input.hit.shotId = turn;
      if (input.kind === "combat" && "shotId" in input.event) input.event.shotId = turn;
      archive.records.push(record);
    }
    archive.lastSequence = sequence; resign(archive);
    const journal = new EnduranceJournal(archive.sessionId, (entries, status) => storage.appendJournal(entries, status), error => { throw error; });
    for (const [i, record] of archive.records.entries()) journal.append({ at: "test", atMs: 0, blockId: null, blockIndex: 1, seed: 1,
      round: 1, turn: record.turn, phase: "COMBAT", decisionId: null, context: null, contextError: null,
      event: { kind: "archive", write: { record, terrains: i === 0 ? archive.terrains : [] } } });
    await journal.finish();
    const first = await storage.listShots(archive.sessionId, journal.status.persisted, "", 0);
    expect(first.rows).toHaveLength(20); expect(first.total).toBe(41); expect(first.rows[0].key).toBe(`${archive.sessionId}:1:41`);
    expect(first.rows.every(row => row.status === "settled")).toBe(true);
    expect(first.captureInProgress).toBe(false);
    const last = await storage.listShots(archive.sessionId, journal.status.persisted, "", 2);
    expect(last.rows).toHaveLength(1); expect(last.rows[0].key).toBe(`${archive.sessionId}:1:1`);
    const filtered = await exportStoredArchive(storage, archive.sessionId, undefined, { shotKey: `${archive.sessionId}:1:21` });
    expect(filtered.lastSequence).toBe(archive.lastSequence);
    expect(filtered.records).toHaveLength(template.records.length - 1);
    expect(filtered.records.every(r => r.turn === 21)).toBe(true); expect(validateArchive(filtered).terrains.length).toBeGreaterThan(0);
    storage.close();
  });
  it("confirms a just-requested current capture before returning its panel indicators", async () => {
    const f = fixture(), storage = new IndexedEnduranceStorage();
    const run = new EnduranceSession(f.config, storage); await run.start(); run.attach(f.host);
    const { archive } = realShot(), before = archive.records.find(r => r.input.kind === "pre-shot")!.input;
    if (before.kind !== "pre-shot") throw new Error("MISSING_TEST_CAPTURE");
    const terrain = archive.terrains.find(t => t.id === before.snapshot.terrainId)!;
    const snapshot = { ...before.snapshot, heights: terrain.heights, materials: terrain.materials, inProgress: true };
    run.diagnostic({ kind: "current", snapshot });
    expect(await run.listShots("", 0)).toMatchObject({ captureInProgress: true, incomplete: true, rows: [] });
    run.diagnostic({ kind: "current", snapshot: { ...snapshot, inProgress: false } });
    await run.stop();
    expect(await run.listShots("", 0)).toMatchObject({ captureInProgress: false, incomplete: false }); storage.close();
  });
  it("freezes diagnostic duration once the session has stopped", async () => {
    const f = fixture(); await f.run.start(); f.advance(1000); await f.run.stop();
    const duration = f.run.archiveMetrics.durationMs; f.advance(10000);
    expect(f.run.archiveMetrics.durationMs).toBe(duration);
  });
  it("rejects malformed IndexedDB captures without an unhandled cursor exception", async () => {
    const storage = new IndexedEnduranceStorage(); await storage.journalStatus("corrupt");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("tankwars-endurance", 3); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("captures", "readwrite"); tx.objectStore("captures").put({ sessionId: "corrupt", sequence: 1, record: { input: null } });
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    await expect(storage.readArchive("corrupt", 1)).rejects.toThrow("INVALID_STORED_CAPTURE"); db.close(); storage.close();
  });
  it("separates a timed-out decision from its fallback without inventing a launch", () => {
    const recorder = new ShotRecorder("timeout");
    recorder.record({ kind: "combat", event: { kind: "decision-start", playerId: "a" } });
    recorder.record({ kind: "combat", event: { kind: "recovery", reason: "decision-timeout" } });
    const rows = recorder.export().records;
    expect(rows.some(r => r.input.kind === "boundary" && r.input.status === "decision-cancelled")).toBe(true);
    expect(rows.at(-1)?.decisionId).toContain(":fallback:");
    expect(rows.some(r => r.input.kind === "pre-shot")).toBe(false);
  });
  it("exports queued captures explicitly as partial when browser quota fails before confirmation", async () => {
    const f = fixture(), storage = new IndexedEnduranceStorage();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(storage, "appendJournal").mockRejectedValue(new DOMException("quota-test", "QuotaExceededError"));
    const run = new EnduranceSession(f.config, storage);
    await run.start();
    await vi.waitFor(() => expect(run.running).toBe(false));
    const archive = await run.exportArchive();
    expect(archive.complete).toBe(false); expect(archive.error).toContain("quota-test");
    expect(archive.records.some(r => r.input.kind === "boundary" && r.input.status === "archive-manifest")).toBe(true);
    expect(validateArchive(archive).lastSequence).toBeGreaterThan(0); storage.close();
  });
  it("bounds the complete DEV group in bytes, including shared terrain dependencies", () => {
    const recorder = new ShotRecorder("small-dev", undefined, 128, 1024);
    recorder.record({ kind: "boundary", status: "large", detail: "x".repeat(2048) });
    expect(recorder.stats.bytes).toBeLessThanOrEqual(1024); expect(recorder.export().records).toHaveLength(0);
    recorder.record({ kind: "combat", event: { kind: "turn", playerId: "a", turn: 2 } });
    expect(recorder.export().records).toHaveLength(1);
  });
  it("exports a manual incident even before a shot was accepted", () => {
    const recorder = new ShotRecorder("incident");
    recorder.record({ kind: "combat", event: { kind: "turn", playerId: "a", turn: 1 } });
    recorder.record({ kind: "boundary", status: "manual-incident", detail: null });
    const exported = filterArchive(recorder.export(), { incidents: true });
    expect(exported.records.some(r => r.input.kind === "boundary" && r.input.status === "manual-incident")).toBe(true);
  });
  it("retains events without a shot in either open-ended sequence range", () => {
    const recorder = new ShotRecorder("no-shot");
    recorder.record({ kind: "boundary", status: "cancelled", detail: null });
    const archive = recorder.export(), sequence = archive.lastSequence;
    for (const filter of [{ from: sequence }, { to: sequence }]) {
      expect(filterArchive(archive, filter).records.some(r => r.sequence === sequence)).toBe(true);
    }
  });
  it("reserves the last admitted action, closes before the next decision and reopens the first shot", async () => {
    const f = fixture(), storage = new IndexedEnduranceStorage();
    const run = new EnduranceSession(f.config, storage); await run.start(); run.attach(f.host);
    expect(run.emit({ kind: "decision-start", playerId: f.players[0].id })).toBe(true);
    const { archive } = realShot();
    // Limit falls below the next admission while the current reservation remains valid.
    Reflect.set(run, "archiveLimit", run.archiveMetrics.totalBytes + run.archiveMetrics.reserve + 1024);
    for (const record of archive.records) {
      const input = record.input;
      if ("snapshot" in input) {
        const terrain = archive.terrains.find(t => t.id === input.snapshot.terrainId)!;
        run.diagnostic({ ...input, snapshot: { ...input.snapshot, heights: terrain.heights, materials: terrain.materials } });
      } else run.diagnostic(input);
    }
    expect(run.running).toBe(true);
    run.emit({ kind: "shot-result", shotId: 1, awards: [] });
    expect(run.emit({ kind: "decision-start", playerId: f.players[0].id })).toBe(false);
    await vi.waitFor(() => expect(run.busy).toBe(false));
    expect(run.session.reason).toBe("archive-budget");
    const saved = await run.exportArchive(); expect(saved.records.some(r => r.input.kind === "settled")).toBe(true);
    storage.close(); const reopened = new IndexedEnduranceStorage();
    expect((await exportStoredArchive(reopened, run.session.id)).records.some(r => r.input.kind === "pre-shot")).toBe(true); reopened.close();
  });
  it("persists dependencies atomically and reopens a confirmed stable export", async () => {
    const { archive } = realShot("GRENADE"); const storage = new IndexedEnduranceStorage();
    const writes: ArchiveWrite[] = archive.records.map((record, i) => ({ record, terrains: i === 0 ? archive.terrains : [] }));
    const journal = new EnduranceJournal(archive.sessionId, (entries, status) => storage.appendJournal(entries, status), error => { throw error; });
    for (const write of writes) journal.append({ at: "test", atMs: 0, blockId: null, blockIndex: 1, seed: 1, round: 1, turn: 1, phase: "COMBAT", decisionId: null, context: null, contextError: null, event: { kind: "archive", write } });
    await journal.finish(); storage.close();
    const reopened = new IndexedEnduranceStorage(); const exported = await exportStoredArchive(reopened, archive.sessionId);
    expect(exported.complete).toBe(true); expect(validateArchive(exported).records).toHaveLength(archive.records.length);
    const key = exported.records.find(r => r.input.kind === "pre-shot")!.shotKey!;
    expect(replayShot(exported, key).physicalDivergence).toBeNull(); reopened.close();
    expect(byteSize(exported)).toBeGreaterThan(1000);
  });
  it("evicts whole turns with their dependencies at a small DEV limit", () => {
    const recorder = new ShotRecorder("bounded", undefined, 2);
    for (let turn = 1; turn <= 5; turn++) recorder.record({ kind: "combat", event: { kind: "turn", turn, playerId: "a" } });
    expect(recorder.export().records).toHaveLength(2); expect(recorder.stats.evicted).toBe(4);
  });
  it("retains the initial scenario terrain across evictions before and after firing", () => {
    const recorder = new ShotRecorder("initial-terrain-test", undefined, 2);
    const initialTerrain: TerrainRecord = { id: "initial-id", width: 800, height: 480, heights: Array(800).fill(300), materials: Array(800).fill("DIRT") };
    recorder.record({ kind: "boundary", status: "initial-scenario", detail: { mode: "custom", terrainId: "initial-id" } }, initialTerrain);
    expect(recorder.export().terrains.map(t => t.id)).toEqual(["initial-id"]);
    for (let turn = 1; turn <= 5; turn++) recorder.record({ kind: "combat", event: { kind: "turn", turn, playerId: "a" } });
    expect(recorder.export().terrains.map(t => t.id)).toContain("initial-id");
  });
});

describe("decision entry capture without gameplay perturbation", () => {
  it.each([
    ["v1-random", AISimpleStrategy], ["v2-heuristic", AIHeuristicStrategy],
    ["v3-sniper", AISniperStrategy], ["v4-smart", AISmartStrategy],
  ] as const)("preserves %s commands and every RNG draw with DEV false", async (profile, Strategy) => {
    const previous = getRNG(); vi.stubEnv("DEV", false);
    try {
      const results = [];
      for (const collect of [false, true]) {
        const rng = createSeededRNG(12453), draws: number[] = [];
        setRNG({ next: () => { const value = rng.next(); draws.push(value); return value; } });
        const self = makePlayer({ id: "s", isHuman: false, aiProfile: profile, inventory: { BULLET: 2, DRILLER: 1 }, tank: makeTank("ts", 100, 336) });
        const target = makePlayer({ id: "b", tank: makeTank("tb", 400, 336), inventory: { NUKE: 2, THERMONUCLEAR: 1 } });
        const state = { phase: "COMBAT" as const, players: [self, target], currentPlayerIndex: 0, turn: 1, roundNumber: 12, windForce: 0, gravity: 260 };
        const strategy = new Strategy(); const observed: import("../../observation").AIObservation[] = [];
        if (collect) strategy.onDecisionObserved = o => observed.push(o);
        const command = await strategy.executeTurn("ts", state, flatTerrain(800, 480));
        results.push({ command, draws });
        if (collect) {
          expect(observed).toHaveLength(1); expect(observed[0].initial?.memory).toBeNull();
          expect(observed[0].initial?.state.players[1].inventory).toEqual({ NUKE: 2, THERMONUCLEAR: 1 });
          expect(observed[0].initial?.opponentNuclearStocks).toBe("archived-only-never-known");
          if (profile === "v4-smart") expect(observed[0].diagnostics).toEqual(expect.objectContaining({
            exploration: expect.objectContaining({ proposals: expect.arrayContaining([
              expect.objectContaining({ shooterId: "s", searchComplete: expect.any(Boolean), status: expect.any(String) }),
            ]) }),
          }));
        }
      }
      expect(results[0]).toEqual(results[1]);
    } finally { setRNG(previous); vi.unstubAllEnvs(); }
  });
});
