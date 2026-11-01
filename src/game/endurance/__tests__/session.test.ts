import { describe, expect, it, vi } from "vitest";
import { validateConfig } from "../config";
import { EnduranceSession } from "../session";
import { markdownReport } from "../report";
import { fixture } from "./helpers";

async function settled() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

describe("endurance session contracts", () => {
  it("validates limits, roster and immutable deep initial configuration", () => {
    const f = fixture();
    const frozen = validateConfig(f.config);
    f.players[0].inventory.NUKE = 99;
    expect(frozen.players[0].inventory.NUKE).not.toBe(99);
    expect(Object.isFrozen(frozen.players[0].tank)).toBe(true);
    expect(() => validateConfig({ ...f.config, maxBlocks: null, maxDurationMs: null })).toThrow();
    expect(() => validateConfig({ ...f.config, roundsPerBlock: 0 })).toThrow();
    expect(() => validateConfig({ ...f.config, players: [f.players[0]] })).toThrow();
    expect(() => validateConfig({ ...f.config, players: [{ ...f.players[0], isHuman: true }, f.players[1]] })).toThrow();
  });
  it("persists metadata and uint32 seed before exposing a runnable block", async () => {
    const f = fixture();
    expect(f.run.ready).toBe(false);
    await f.run.start();
    expect(f.storage.writes.at(-1)?.block).toMatchObject({ seed: 4294967295, build: "test-build", physics: "local" });
    expect(f.run.ready).toBe(true);
    expect(f.run.session.attempted).toBe(1);
  });
  it("completes two rounds and resets the next block without a campaign champion", async () => {
    const f = fixture(); await f.run.start(); f.run.attach(f.host);
    f.players[1].tank.isDead = true;
    f.run.completeRound([f.players[0].id]); f.run.completeRound([f.players[0].id]);
    expect(f.run.session.roundsCompleted).toBe(1);
    expect(f.run.beginRound(2)).toBe(true);
    f.players.forEach(p => { p.tank.isDead = true; });
    f.run.completeRound([]); f.run.finishPresentation(); await settled();
    expect(f.host.stop).toHaveBeenCalledOnce();
    expect(f.run.session).toMatchObject({ attempted: 2, completed: 1, roundsCompleted: 2 });
    expect(f.run.block?.config.players.every(p => !p.isHuman && !p.tank.isDead)).toBe(true);
    const data = await f.run.export();
    expect(data.rounds.filter(r => r.completed).map(r => r.draw)).toEqual([false, true]);
    expect(data.session.completedMetrics.players[f.players[0].id]).toMatchObject({ wins: 1, participations: 2, draws: 1 });
  });
  it.each(["turns", "roundMs", "actionMs", "transitionMs"] as const)("abandons once on %s, counts the attempt and continues", async limit => {
    const f = fixture(); await f.run.start(); f.run.attach(f.host);
    if (limit === "turns") f.run.emit({ kind: "turn", playerId: f.players[0].id, turn: 1001 });
    else {
      if (limit === "actionMs") f.run.emit({ kind: "turn", playerId: f.players[0].id, turn: 1 });
      if (limit === "transitionMs") f.run.setPhase("SUMMARY");
      f.advance(f.config.limits[limit]); f.run.tick(); f.run.tick();
    }
    await settled();
    expect(f.run.session).toMatchObject({ attempted: 2, abandoned: 1, incidents: 1 });
    expect(f.host.stop).toHaveBeenCalledOnce();
    expect(f.run.latestIncident).toMatchObject({ kind: "limit", reason: limit, seed: 4294967295 });
    await f.run.stop();
    expect(f.run.session.attempted).toBe(f.run.session.completed + f.run.session.abandoned + f.run.session.interrupted);
  });
  it("does not reset the transition deadline on repeated HUD-equivalent phase observations", async () => {
    const f = fixture(); await f.run.start(); f.run.attach(f.host); f.run.setPhase("SUMMARY");
    f.advance(20000); f.run.setPhase("SUMMARY"); f.advance(10000); f.run.tick(); await settled();
    expect(f.run.latestIncident?.reason).toBe("transitionMs");
  });
  it("records warning recoveries without aborting or classifying a suicide as an incident", async () => {
    const f = fixture(); await f.run.start(); f.run.attach(f.host);
    f.run.emit({ kind: "recovery", reason: "decision-timeout" });
    expect(f.run.ready).toBe(true);
    expect(f.run.session).toMatchObject({ suspect: 1, abandoned: 0 });
    f.run.emit({ kind: "shot", shotId: 1, playerId: f.players[0].id, command: { angle: 80, power: 30, weaponId: "MISSILE" } });
    f.run.emit({ kind: "destruction", event: { shotId: 1, shooterId: f.players[0].id, victimId: f.players[0].id, weaponId: "MISSILE", cause: "lava" } });
    expect(f.run.session.incidents).toBe(1);
  });
  it("interrupts synchronously on manual/environment/duration stop and rejects late events", async () => {
    for (const reason of ["manual", "environment-hidden", "duration"]) {
      const f = fixture(); await f.run.start(); f.run.attach(f.host);
      const stopping = f.run.stop(reason);
      expect(f.run.emit({ kind: "turn", playerId: f.players[0].id, turn: 1 })).toBe(false);
      await stopping;
      expect(f.run.session).toMatchObject({ reason, interrupted: 1, abandoned: 0, collection: "complete" });
      expect(f.host.stop).toHaveBeenCalledOnce();
    }
  });
  it("preserves burial deaths with remaining health but rejects invalid explicit targets", async () => {
    const f = fixture(); await f.run.start(); f.run.attach(f.host);
    f.players[1].tank.isDead = true;
    f.run.completeRound([f.players[0].id]);
    expect(f.run.session.incidents).toBe(0);
    f.run.beginRound(2);
    expect(f.run.emit({ kind: "target", playerId: f.players[0].id, targetId: f.players[1].id })).toBe(false);
    expect(f.run.latestIncident?.reason).toBe("INVALID_EXPLICIT_TARGET");
  });
  it("stops on first incident when configured and keeps bounded recent history", async () => {
    const f = fixture(); f.config.stopOnIncident = true;
    const run = new EnduranceSession(f.config, f.storage);
    await run.start(); run.attach(f.host);
    for (let i = 0; i < 300; i++) run.emit({ kind: "decision-start", playerId: f.players[0].id });
    run.emit({ kind: "failure", reason: "ROUND_PREPARATION_FAILED" }); await settled();
    expect(run.latestIncident?.recent).toHaveLength(256);
    expect(run.session).toMatchObject({ status: "stopped", reason: "incident", attempted: 1, abandoned: 1 });
  });
  it("stops explicitly on cleanup and storage failures", async () => {
    const f = fixture(); await f.run.start(); f.run.attach({ ...f.host, stop: () => { throw new Error("cleanup"); } });
    await f.run.stop();
    expect(f.run.session.collection).toBe("incomplete");
    const g = fixture(); vi.spyOn(g.storage, "save").mockRejectedValue(new Error("quota"));
    await g.run.start(); await settled();
    expect(g.run.session).toMatchObject({ status: "stopped", reason: "storage-failure", collection: "incomplete", attempted: 0 });
  });
  it("serializes writes and exports coherent Markdown/JSON with physical metrics and limits", async () => {
    const f = fixture(); await f.run.start(); f.run.attach(f.host);
    f.advance(15000); f.run.tick(); await f.run.stop();
    const data = await f.run.export();
    expect(f.storage.writes.at(-1)?.session).toEqual(data.session);
    expect(data.rounds).toHaveLength(1);
    expect(markdownReport(data)).toContain("Codex — GPT-6");
    expect(markdownReport(data)).toContain("non applicable (0)");
    expect(markdownReport(data)).toContain(data.session.id);
  });
  it("prevents a new action after the duration limit and preserves partial shot metrics", async () => {
    const f = fixture(); await f.run.start(); f.run.attach(f.host);
    f.run.emit({ kind: "shot", shotId: 1, playerId: f.players[0].id, command: { angle: 60, power: 60, weaponId: "MISSILE" } });
    const active = await f.run.export(); expect(active.session.partialMetrics.total.shots).toBe(1);
    f.advance(f.config.maxDurationMs!);
    expect(f.run.emit({ kind: "turn", playerId: f.players[1].id, turn: 2 })).toBe(false);
    await settled();
    expect(f.run.session).toMatchObject({ status: "stopped", reason: "duration", interrupted: 1 });
    expect((await f.run.export()).session.partialMetrics.total).toMatchObject({ shots: 1, resolved: 0, participations: 0 });
  });
  it("preserves the current in-memory record when a checkpoint fails but older storage is readable", async () => {
    const f = fixture(); await f.run.start(); f.run.attach(f.host);
    vi.spyOn(f.storage, "save").mockRejectedValue(new Error("quota"));
    f.run.emit({ kind: "failure", reason: "AI_DECISION_FAILED" }); await settled();
    const data = await f.run.export();
    expect(data.session).toMatchObject({ collection: "incomplete", reason: "storage-failure", abandoned: 1 });
    expect(data.blocks.at(-1)?.status).toBe("abandoned");
    expect(data.incidents).toHaveLength(1);
  });
  it("keeps the action watchdog armed if the result resolves but the turn never advances", async () => {
    const f = fixture(); await f.run.start(); f.run.attach(f.host);
    f.run.emit({ kind: "turn", playerId: f.players[0].id, turn: 1 });
    f.run.emit({ kind: "shot", shotId: 1, playerId: f.players[0].id, command: { angle: 60, power: 60, weaponId: "MISSILE" } });
    f.run.emit({ kind: "resolved", shotId: 1 });
    f.advance(120000); f.run.tick(); await settled();
    expect(f.run.latestIncident?.reason).toBe("actionMs");
  });
  it("validates freeWeapons configuration: accepts boolean or absent, rejects non-boolean", () => {
    const f = fixture();
    expect(() => new EnduranceSession({ ...f.config, freeWeapons: true }, f.storage)).not.toThrow();
    expect(() => new EnduranceSession({ ...f.config, freeWeapons: false }, f.storage)).not.toThrow();
    expect(() => new EnduranceSession({ ...f.config, freeWeapons: undefined }, f.storage)).not.toThrow();
    expect(() => new EnduranceSession({ ...f.config, freeWeapons: "true" as unknown as boolean }, f.storage))
      .toThrow("INVALID_ENDURANCE_CONFIG");
    expect(() => new EnduranceSession({ ...f.config, freeWeapons: 1 as unknown as boolean }, f.storage))
      .toThrow("INVALID_ENDURANCE_CONFIG");
  });
});
