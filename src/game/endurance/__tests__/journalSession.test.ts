import { describe, expect, it, vi } from "vitest";
import { EnduranceSession } from "../session";
import { MemoryStorage, fixture } from "./helpers";
import type { JournalEntry, JournalStatus } from "../journal";
import { autoBuyForAI } from "../../entities/ai/aiShopHelper";

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
