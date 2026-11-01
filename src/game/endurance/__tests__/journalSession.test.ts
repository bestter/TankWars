import { describe, expect, it, vi } from "vitest";
import { EnduranceSession } from "../session";
import { MemoryStorage, fixture } from "./helpers";
import type { JournalEntry, JournalStatus } from "../journal";
import { autoBuyForAI } from "../../entities/ai/aiShopHelper";
import { AISmartStrategy } from "../../entities/ai/AISmartStrategy";
import { flatTerrain, makePlayer, makeTank } from "../../__tests__/helpers";
import { createSeededRNG, getRNG, setRNG } from "../../../utils/random";

class JournalMemory extends MemoryStorage {
  entries: JournalEntry[] = [];
  meta: JournalStatus | null = null;
  async appendJournal(rows: readonly JournalEntry[], status: JournalStatus) { this.entries.push(...structuredClone(rows)); this.meta = structuredClone(status); }
  async readJournal(sessionId: string, after: number, limit: number) { return this.entries.filter(e => e.sessionId === sessionId && e.sequence > after).slice(0, limit); }
  async journalStatus() { return this.meta; }
}
async function settled() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
describe("session journal lifecycle and reconciliation", () => {
  it("reconciles 20 rounds of applied credits and unit purchases, skips the final shop and resets the next block", async () => {
    const f = fixture(), storage = new JournalMemory(); const players = f.players;
    const run = new EnduranceSession({ ...f.config, roundsPerBlock: 20 }, storage);
    await run.start(); run.attach(f.host);
    const initial = structuredClone(players);
    for (let round = 1; round <= 20; round++) {
      if (round > 1) { players.forEach(p => { p.tank.isDead = false; }); run.beginRound(round); }
      for (const p of players) {
        const before = p.money; p.money += 100;
        run.emit({ kind: "credit", credit: { source: "shot", causalId: round, playerId: p.id, before, after: p.money, amount: 100, components: [] } });
      }
      players[1].tank.isDead = true; run.completeRound([players[0].id]);
      if (round < 20) {
        run.setPhase("SHOP");
        for (let i = 0; i < players.length; i++) {
          const visit = run.beginShopVisit(players[i])!;
          const result = autoBuyForAI(players[i], 2, {}, true);
          players[i] = result.player; run.endShopVisit(visit, players[i], result.purchases ?? []);
        }
      }
    }
    const final = structuredClone(players); run.finishPresentation(); await settled();
    expect(run.block?.index).toBe(2);
    expect(run.block?.config.players).toEqual(initial);
    await run.stop();
    const rows = storage.entries;
    expect(rows.filter(e => e.event.kind === "shop-start")).toHaveLength(38);
    expect(rows.filter(e => e.event.kind === "shop-start" && e.round === 20)).toHaveLength(0);
    for (const player of final) {
      const purchases = rows.flatMap(e => e.event.kind === "purchase" && e.event.purchase.playerId === player.id ? [e.event.purchase] : []);
      const origin = initial.find(p => p.id === player.id)!;
      expect(player.money).toBe(origin.money + 2000 - purchases.reduce((sum, p) => sum + p.price, 0));
      for (const purchase of purchases) {
        expect(purchase.moneyAfter).toBe(purchase.moneyBefore - purchase.price);
        expect(purchase.stockAfter).toBe(purchase.stockBefore + 1);
      }
      for (const [weapon, stock] of Object.entries(player.inventory)) {
        expect(stock).toBe((origin.inventory[weapon as keyof typeof origin.inventory] ?? 0) + purchases.filter(p => p.weaponId === weapon).length);
      }
    }
    const lines = (await run.journalJSONL()).trim().split("\n").map(line => JSON.parse(line) as unknown);
    expect(lines[0]).toMatchObject({ kind: "journal-status", status: { complete: true } });
    expect(lines.slice(1)).toEqual(rows);
    expect(rows.map(e => e.sequence)).toEqual(rows.map((_e, i) => i + 1));
  });
  it("cancels superseded and stopped decisions and never attaches late events to the next block", async () => {
    const f = fixture(), storage = new JournalMemory(), run = new EnduranceSession(f.config, storage);
    await run.start(); run.attach(f.host);
    run.emit({ kind: "decision-start", playerId: f.players[0].id });
    run.emit({ kind: "turn", playerId: f.players[1].id, turn: 1 });
    run.emit({ kind: "decision-start", playerId: f.players[1].id });
    await run.stop();
    expect(run.emit({ kind: "decision", playerId: f.players[1].id, durationMs: 1, command: { angle: 45, power: 50, weaponId: "MISSILE" } })).toBe(false);
    expect(storage.entries.filter(e => e.event.kind === "decision-cancelled").map(e => e.decisionId)).toHaveLength(2);
    expect(storage.entries.some(e => e.event.kind === "combat" && e.event.event.kind === "shot-launched")).toBe(false);
  });
  it("stops visibly on a journal error without reapplying the economic mutation, and exports retained entries", async () => {
    const f = fixture(), storage = new JournalMemory(), run = new EnduranceSession(f.config, storage);
    await run.start(); run.attach(f.host);
    vi.spyOn(storage, "appendJournal").mockRejectedValue(new Error("quota"));
    const before = f.players[0].money;
    f.players[0].money += 10;
    run.emit({ kind: "credit", credit: { source: "shot", causalId: 1, playerId: f.players[0].id, amount: 10, before: f.players[0].money - 10, after: f.players[0].money, components: [] } });
    await run.journalPage(); await settled();
    expect(run.session).toMatchObject({ status: "stopped", reason: "journal-failure", collection: "incomplete" });
    expect(run.journalStatus?.complete).toBe(false);
    expect(f.players[0].money).toBe(before + 10);
    expect(await run.journalJSONL()).toContain('"kind":"credit"');
  });
});


it("persists #352 reasons with DEV false through ai-detail and JSONL without altering RNG or commands", async () => {
  vi.stubEnv("DEV", false);
  const previous = getRNG();
  try {
    const self = makePlayer({ id: "s", isHuman: false, aiProfile: "v4-smart", inventory: {}, tank: makeTank("s", 100, 336) });
    const target = makePlayer({ id: "c", inventory: {}, tank: makeTank("c", 400, 336, { health: 60 }) });
    const state = { phase: "COMBAT" as const, players: [self, target], currentPlayerIndex: 0, turn: 4, roundNumber: 12,
      windForce: 0, gravity: 260, localShotContext: { playerCountAtMatchStart: 2, isFirstShotOfRound: false } };
    const f = fixture(), storage = new JournalMemory(), run = new EnduranceSession(f.config, storage);
    await run.start(); run.attach(f.host);
    run.emit({ kind: "decision-start", playerId: self.id });
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const results = [];
    for (const observe of [false, true]) {
      const rng = createSeededRNG(12453), draws: number[] = [], targets: string[] = [];
      setRNG({ next: () => { const value = rng.next(); draws.push(value); return value; } });
      const strategy = new AISmartStrategy();
      await strategy.executeTurn("s", structuredClone(state), flatTerrain(800, 480));
      draws.length = 0;
      strategy.onTargetSelected = (_id, targetId) => targets.push(targetId);
      if (observe) strategy.onDecisionObserved = observation => { run.emit({ kind: "ai-detail", observation }); };
      const snapshot = structuredClone(state);
      const command = await strategy.executeTurn("s", snapshot, flatTerrain(800, 480));
      results.push({ command, draws, targets, snapshot });
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0].targets).toHaveLength(1);
    await run.stop();
    const jsonl = await run.journalJSONL();
    const rows = jsonl.trim().split("\n").map(line => JSON.parse(line) as JournalEntry);
    const details = rows.filter(row => row.event?.kind === "combat" && row.event.event.kind === "ai-detail");
    expect(details).toHaveLength(1);
    expect(JSON.stringify(details)).toContain('"lethalTransition"');
    expect(JSON.stringify(details)).toContain('"initialTargetId":"c"');
    expect(JSON.stringify(details)).toContain('"targets":[{"playerId":"c","profile":"human"');
    expect(JSON.stringify(details)).toContain('"targetSelection":{"source":"main-plan"');
    expect(JSON.stringify(details)).not.toContain('"offscreenCanvas"');
    expect(details[0].decisionId).not.toBeNull();
    expect(log).not.toHaveBeenCalled();
  } finally { setRNG(previous); vi.unstubAllEnvs(); vi.restoreAllMocks(); }
});


it("exports fallback target and weapon reasons through the endurance JSONL with DEV false", async () => {
  vi.stubEnv("DEV", false);
  const previous = getRNG();
  try {
    const self = makePlayer({ id: "s", isHuman: false, aiProfile: "v4-smart", inventory: {}, tank: makeTank("s", 100, 336) });
    const target = makePlayer({ id: "c", inventory: {}, tank: makeTank("c", 400, 336) });
    const state = { phase: "COMBAT" as const, players: [self, target], currentPlayerIndex: 0, turn: 4, roundNumber: 12,
      windForce: 0, gravity: 260 };
    const f = fixture(), storage = new JournalMemory(), run = new EnduranceSession(f.config, storage);
    await run.start(); run.attach(f.host); run.emit({ kind: "decision-start", playerId: self.id });
    const strategy = new AISmartStrategy();
    strategy.onDecisionObserved = observation => { run.emit({ kind: "ai-detail", observation }); };
    setRNG(createSeededRNG(12453));
    await strategy.executeTurn("s", state, flatTerrain(800, 480));
    await run.stop();
    const rows = (await run.journalJSONL()).trim().split("\n").map(line => JSON.parse(line) as JournalEntry);
    const detail = rows.find(row => row.event?.kind === "combat" && row.event.event.kind === "ai-detail");
    expect(detail).toMatchObject({ event: { kind: "combat", event: { kind: "ai-detail", observation: { diagnostics: {
      planner: { phase: "REPLI" }, targetSelection: { source: "fallback", reason: "ordinary-target-order", targetId: "c" },
      fallbackChoice: { selectionReason: expect.any(String), rawCommand: expect.any(Object), evaluatedCommand: expect.any(Object) },
    } } } } });
  } finally { setRNG(previous); vi.unstubAllEnvs(); }
});
