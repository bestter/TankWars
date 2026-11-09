import reference from "../../../Scripts/endurance/scenarios/issue-361-rock-cliff.json";
import { validateScenario } from "../../game/endurance/scenario";
// @vitest-environment jsdom
import { StrictMode, useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGameSession } from "../useGameSession";
import { fixture, MemoryStorage } from "../../game/endurance/__tests__/helpers";
import { createSeededRNG, getRNG, secureRandom, setRNG } from "../../utils/random";
import { GameEngine } from "../../game/engine/GameEngine";
import { AIByProfileStrategy } from "../../game/entities/ai/AIByProfileStrategy";
import { EnduranceSession } from "../../game/endurance/session";
import type { JournalEntry } from "../../game/endurance/journal";
import type { Player } from "../../types/player";
import { trackEvent } from "../../utils/analytics";

vi.mock("../../utils/analytics", () => ({ trackEvent: vi.fn() }));

class JournalStorage extends MemoryStorage {
  entries: JournalEntry[] = [];
  async appendJournal(entries: readonly JournalEntry[]) {
    this.entries.push(...structuredClone(entries));
  }
  async readJournal(_sessionId: string, after: number, limit: number) {
    return this.entries.filter(entry => entry.sequence > after).slice(0, limit);
  }
}

function Harness({ run, players, sessionRef }: { run?: EnduranceSession; players: Player[]; sessionRef: { current: ReturnType<typeof useGameSession> | null } }) {
  const session = useGameSession({ endurance: run, initialPlayers: players });
  useEffect(() => { sessionRef.current = session; });
  const { canvasRef } = session;
  return <canvas ref={canvasRef} />;
}
describe("real local endurance session integration", () => {
  const previous = getRNG();
  beforeEach(() => {
    vi.mocked(trackEvent).mockClear();
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => new Proxy({}, { get: () => () => undefined }) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(AIByProfileStrategy.prototype, "executeTurn").mockImplementation(() => new Promise(() => {}));
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); setRNG(previous); });
  it.each([false, true])("restores the custom map across two rounds and two blocks (free=%s)", async freeWeapons => {
    const f = fixture(), storage = new JournalStorage();
    const run = new EnduranceSession({ ...f.config, scenario: validateScenario(reference), freeWeapons }, storage);
    await run.start();
    const setPlayers = vi.spyOn(GameEngine.prototype, "setPlayers");
    for (let block = 0; block < 2; block++) {
      const ref = { current: null as ReturnType<typeof useGameSession> | null };
      const view = render(<Harness run={run} players={structuredClone(run.block!.config.players)} sessionRef={ref} />);
      await act(async () => { vi.advanceTimersByTime(1); });
      const engine = setPlayers.mock.instances.at(-1) as GameEngine;
      for (let round = 1; round <= 2; round++) {
        expect(engine.getCombatMap(round)).toMatchObject({ heights: reference.heights, materials: reference.materials, wind: 48.2 });
        const roster = engine.getTankManager().getPlayers();
        expect(roster.map(p => p.tank.position)).toEqual([{ x: 126.483, y: 412 }, { x: 695.675, y: 339 }]);
        expect(roster.every(p => p.tank.health === 100 && p.tank.shield === 40)).toBe(true);
        // A live recovery retains deformation; the next actual round restores the initial map.
        const damaged = engine.getCombatMap(round); damaged.heights[126] = 460;
        engine.restoreRoundTerrain(damaged, engine.getInitialRoundMap()!);
        expect(engine.getCombatMap(round).heights[126]).toBe(460);
        roster[0].money = 777; roster[1].tank.isDead = true;
        await act(async () => { engine.onRoundEnded?.({ survivors: [roster[0]], roundWinner: roster[0], isDraw: false }); });
        await act(async () => { vi.advanceTimersByTime(10000); });
        await act(async () => { vi.advanceTimersByTime(3000); });
        if (round === 1) {
          if (!freeWeapons) await act(async () => { vi.advanceTimersByTime(600); });
          expect(ref.current?.state.gamePhase).toBe("COMBAT");
          if (freeWeapons) expect(engine.getTankManager().getPlayers()[0].money).toBe(777);
        }
      }
      view.unmount();
    }
    expect(run.session).toMatchObject({ completed: 2, attempted: 2, roundsStarted: 4, roundsCompleted: 4 });
    expect(storage.entries.filter(e => e.event.kind === "round-start")).toHaveLength(4);
    expect(storage.entries.filter(e => e.event.kind === "block-start").every(e => e.event.kind === "block-start" && e.event.players[1].tank.position.x === 695.675)).toBe(true);
    if (freeWeapons) expect(storage.entries.some(e => e.event.kind === "purchase" || e.event.kind === "shop-start")).toBe(false);
    await run.stop();
  });
  it("initializes once in StrictMode, restores the exact prior RNG and cancels the hung decision", async () => {
    const f = fixture(); await f.run.start();
    const stop = vi.spyOn(GameEngine.prototype, "stop");
    const sessionRef = { current: null as ReturnType<typeof useGameSession> | null };
    render(<StrictMode><Harness run={f.run} players={structuredClone(f.players)} sessionRef={sessionRef} /></StrictMode>);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(f.run.session.roundsStarted).toBe(1);
    expect(getRNG()).not.toBe(previous);
    await act(async () => { await f.run.stop(); });
    expect(stop).toHaveBeenCalledOnce(); expect(getRNG()).toBe(previous);
    expect(f.run.emit({ kind: "decision-start", playerId: "player-1" })).toBe(false);
  });
  // Manual stop above does not exercise React disposal or incident-driven block abandonment.
  it.each(["unmount", "incident"] as const)("restores an injected RNG without advancing it after %s cleanup", async reason => {
    const injected = createSeededRNG(123);
    const control = createSeededRNG(123);
    setRNG(injected);
    expect(secureRandom()).toBe(control.next());
    const f = fixture(); await f.run.start();
    const stop = vi.spyOn(GameEngine.prototype, "stop");
    const sessionRef = { current: null as ReturnType<typeof useGameSession> | null };
    const view = render(<Harness run={f.run} players={structuredClone(f.players)} sessionRef={sessionRef} />);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(f.run.session.roundsStarted).toBe(1);
    expect(getRNG()).not.toBe(injected);

    if (reason === "unmount") view.unmount();
    else {
      await act(async () => { f.run.incident("exception", "AI_DECISION_FAILED"); });
      expect(f.run.session.abandoned).toBe(1);
    }

    expect(stop).toHaveBeenCalledOnce();
    expect(getRNG()).toBe(injected);
    expect(secureRandom()).toBe(control.next());
    view.unmount();
    await act(async () => { await f.run.stop(); });
    expect(stop).toHaveBeenCalledOnce();
    expect(getRNG()).toBe(injected);
    expect(secureRandom()).toBe(control.next());
  });
  it("automates celebration, three-second summary and AI shop; finishes without final purchases", async () => {
    const f = fixture(); await f.run.start();
    const setPlayers = vi.spyOn(GameEngine.prototype, "setPlayers");
    const sessionRef = { current: null as ReturnType<typeof useGameSession> | null };
    render(<Harness run={f.run} players={structuredClone(f.players)} sessionRef={sessionRef} />);
    await act(async () => { vi.advanceTimersByTime(1); });
    const engine = setPlayers.mock.instances[0] as GameEngine;
    const finish = async () => {
      const roster = engine.getTankManager().getPlayers(); roster[1].tank.isDead = true;
      await act(async () => { engine.onRoundEnded?.({ survivors: [roster[0]], roundWinner: roster[0], isDraw: false }); });
      expect(sessionRef.current?.state.gamePhase).toBe("CELEBRATION");
      await act(async () => { vi.advanceTimersByTime(10000); });
      expect(sessionRef.current?.state.gamePhase).toBe("SUMMARY");
      await act(async () => { vi.advanceTimersByTime(3000); });
    };
    await finish();
    expect(sessionRef.current?.state.gamePhase).toBe("SHOP");
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    expect(f.run.session.roundsStarted).toBe(2);
    const roster = engine.getTankManager().getPlayers();
    expect(roster.every(p => !p.isHuman)).toBe(true);
    expect(roster.some(p => p.money < 250)).toBe(true);
    await finish();
    expect(f.run.session.completed).toBe(1);
    expect(trackEvent).not.toHaveBeenCalled();
    const data = await f.run.export();
    expect(data.rounds.filter(r => r.completed)).toHaveLength(2);
  });
  it.each([250, 0])("journals and reconciles the real four-AI shop with %i starting money", async money => {
    const f = fixture();
    const profiles = ["v1-random", "v2-heuristic", "v3-sniper", "v4-smart"] as const;
    const players: Player[] = profiles.map((aiProfile, index) => ({
      ...structuredClone(f.players[index % 2]), id: `ai-${index}`, name: `AI ${index}`,
      aiProfile, money, tank: { ...structuredClone(f.players[index % 2].tank), id: `tank-${index}` },
    }));
    const storage = new JournalStorage();
    const run = new EnduranceSession({ ...f.config, players, roundsPerBlock: 2, maxBlocks: 1 }, storage);
    await run.start();
    const setPlayers = vi.spyOn(GameEngine.prototype, "setPlayers");
    const sessionRef = { current: null as ReturnType<typeof useGameSession> | null };
    render(<Harness run={run} players={structuredClone(players)} sessionRef={sessionRef} />);
    await act(async () => { vi.advanceTimersByTime(1); });
    const engine = setPlayers.mock.instances[0] as GameEngine;
    const finish = async () => {
      const roster = engine.getTankManager().getPlayers();
      roster.forEach((player, index) => { player.tank.isDead = index !== 0; });
      await act(async () => { engine.onRoundEnded?.({ survivors: [roster[0]], roundWinner: roster[0], isDraw: false }); });
      await act(async () => { vi.advanceTimersByTime(10000); });
      expect(sessionRef.current?.state.gamePhase).toBe("SUMMARY");
      await act(async () => { vi.advanceTimersByTime(3000); });
    };
    await finish();
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(sessionRef.current?.state.gamePhase).toBe("COMBAT");
    expect(run.session.roundsStarted).toBe(2);
    await run.journalPage();
    const visits = storage.entries.filter(row => row.event.kind === "shop-start");
    expect(visits).toHaveLength(4);
    expect(visits.map(row => row.event.kind === "shop-start" && row.event.player.id)).toEqual(players.map(player => player.id));
    const purchases = storage.entries.filter(row => row.event.kind === "purchase");
    if (money > 0) expect(purchases.length).toBeGreaterThan(0);
    else expect(purchases).toHaveLength(0);

    const ledger = new Map(players.map(player => [player.id, structuredClone(player)]));
    for (const row of storage.entries) {
      const event = row.event;
      if (event.kind === "purchase") {
        const purchase = event.purchase, account = ledger.get(purchase.playerId)!;
        expect(account.money).toBe(purchase.moneyBefore);
        expect(account.inventory[purchase.weaponId] ?? 0).toBe(purchase.stockBefore);
        expect(purchase.moneyAfter).toBe(purchase.moneyBefore - purchase.price);
        expect(purchase.stockAfter).toBe(purchase.stockBefore + 1);
        account.money = purchase.moneyAfter;
        account.inventory[purchase.weaponId] = purchase.stockAfter;
      }
      const snapshots = event.kind === "shop-start" || event.kind === "shop-end"
        ? [event.player] : row.context?.players ?? [];
      for (const player of snapshots) {
        const account = ledger.get(player.id)!;
        expect(player.money).toBe(account.money);
        expect(player.inventory).toEqual(account.inventory);
      }
    }
    expect(storage.entries.filter(row => row.event.kind === "shop-end")).toHaveLength(4);
    const applied = structuredClone(engine.getTankManager().getPlayers());
    for (const player of applied) {
      expect(player.money).toBe(ledger.get(player.id)!.money);
      expect(player.inventory).toEqual(ledger.get(player.id)!.inventory);
    }
    await finish();
    await act(async () => { await run.journalPage(); });
    expect(run.session.completed).toBe(1);
    expect(run.running).toBe(false);
    expect(storage.entries.filter(row => ["shop-start", "shop-end", "purchase"].includes(row.event.kind) && row.round === 2)).toHaveLength(0);
    expect(engine.getTankManager().getPlayers().map(player => ({ money: player.money, inventory: player.inventory })))
      .toEqual(applied.map(player => ({ money: player.money, inventory: player.inventory })));
    expect(trackEvent).not.toHaveBeenCalled();
  });
  it("turns explicit initial preparation failure into one abandonment", async () => {
    const f = fixture(); await f.run.start();
    vi.spyOn(GameEngine.prototype, "setPlayers").mockImplementation(() => { throw new Error("ROUND_PREPARATION_FAILED"); });
    const sessionRef = { current: null as ReturnType<typeof useGameSession> | null };
    render(<Harness run={f.run} players={structuredClone(f.players)} sessionRef={sessionRef} />);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(f.run.session.abandoned).toBe(1); expect(f.run.latestIncident?.reason).toBe("ROUND_PREPARATION_FAILED");
    await f.run.stop();
  });
  it("preserves start and round-end analytics for ordinary matches", async () => {
    const f = fixture();
    const setPlayers = vi.spyOn(GameEngine.prototype, "setPlayers");
    const sessionRef = { current: null as ReturnType<typeof useGameSession> | null };
    render(<Harness players={structuredClone(f.players)} sessionRef={sessionRef} />);
    expect(trackEvent).toHaveBeenCalledWith("game_start", expect.objectContaining({ playerCount: 2 }));
    const engine = setPlayers.mock.instances[0] as GameEngine;
    const roster = engine.getTankManager().getPlayers();
    roster[1].tank.isDead = true;
    await act(async () => { engine.onRoundEnded?.({ survivors: [roster[0]], roundWinner: roster[0], isDraw: false }); });
    expect(trackEvent).toHaveBeenCalledWith("round_end", expect.objectContaining({ roundNumber: 1 }));
  });
});
