import { flatTerrain, makePlayer, makeTank } from "../../src/game/__tests__/helpers";
import type { GameState } from "../../src/types/game";
import type { AIObservation } from "../../src/game/observation";
import { chooseSniperTransitionShot } from "../../src/game/entities/ai/sniperTransitionSelection";
import { AISniperStrategy } from "../../src/game/entities/ai/AISniperStrategy";
import { getRNG, setRNG } from "../../src/utils/random";
import { IndexedEnduranceStorage } from "../../src/game/endurance/storage";
import { EnduranceJournal } from "../../src/game/endurance/journal";

function fixture(count: number, scenario: string) {
  const self = makePlayer({ id: "s", isHuman: false, aiProfile: "v3-sniper", inventory: {},
    tank: makeTank("s", 100, 336, { health: scenario === "no-reply" ? 100 : 30 }) });
  const target = makePlayer({ id: "c", inventory: {},
    tank: makeTank("c", 400, 336, { health: scenario === "no-risk" ? 100 : 60 }) });
  const others = Array.from({ length: count - 2 }, (_, i) => makePlayer({ id: `a${i}`, inventory: {},
    isHuman: scenario === "exhausted", aiProfile: "v1-random",
    tank: makeTank(`a${i}`, 650 + i * 150, 336, { health: scenario === "exhausted" && i > 0 ? 45 : 60 }) }));
  const state: GameState = { phase: "COMBAT", players: [self, target, ...others], currentPlayerIndex: 0,
    turn: 5, roundNumber: 12, windForce: 0, gravity: 260,
    localShotContext: { playerCountAtMatchStart: count, isFirstShotOfRound: true } };
  return { self, target, state, terrain: flatTerrain(1600, 480) };
}

export async function benchmark() {
  const rows = [];
  for (const count of [2, 3, 4]) for (const scenario of ["no-risk", "no-reply", "reply", "exhausted", "plateau"]) {
    for (const observe of [false, true]) {
      const f = fixture(count, scenario);
      const previous = getRNG(); let draws = 0;
      setRNG({ next: () => { draws++; return 0.25; } });
      const frameStart = await new Promise<number>(resolve => requestAnimationFrame(resolve));
      const started = performance.now();
      try {
        const result = chooseSniperTransitionShot(f.self, f.target, f.state, f.terrain,
          scenario === "reply" ? 2 : 3, observe);
        const ms = performance.now() - started;
        const frameGapMs = await new Promise<number>(resolve => requestAnimationFrame(now => resolve(now - frameStart)));
        rows.push({ count, scenario, observe, ms, frameGapMs, draws, target: result.target.id,
          command: result.choice.command, reason: result.trace.reason, risk: result.trace.analysis,
          counters: { selection: result.trace.selectionCounters, detection: result.trace.detectionCounters },
          alternatives: result.trace.alternatives.map(value => ({ target: value.choice.targetId,
            accepted: value.accepted, reason: value.choice.reason, analysis: value.analysis })),
          extraAmplitude: result.trace.extraAmplitude });
      } finally { setRNG(previous); }
    }
  }
  return rows;
}

/** Run against a production/endurance build: DEV must be false. */
export async function verifyJournal() {
  const f = fixture(3, "plateau");
  const strategy = new AISniperStrategy();
  const previous = getRNG(); setRNG({ next: () => 0.99 });
  const storage = new IndexedEnduranceStorage(), sessionId = `validation-353-${Date.now()}`;
  const journal = new EnduranceJournal(sessionId, (entries, status) => storage.appendJournal(entries, status),
    error => { throw error; });
  const observations: AIObservation[] = [];
  try {
    // Memorize the human before introducing the alternatives, without private access.
    const initial = { ...f.state, players: f.state.players.slice(0, 2) };
    await strategy.executeTurn("s", initial, f.terrain);
    await strategy.executeTurn("s", initial, f.terrain);
    strategy.onDecisionObserved = observation => {
      observations.push(observation);
      journal.append({ at: new Date().toISOString(), atMs: 0, blockId: "353", blockIndex: 1,
        seed: 353, round: 12, turn: 5, phase: "COMBAT", decisionId: "353:1",
        event: { kind: "combat", event: { kind: "ai-detail", observation } }, context: null, contextError: null });
    };
    await strategy.executeTurn("s", f.state, f.terrain);
    await journal.finish();
    const rows = await storage.readJournal(sessionId, 0, 256);
    const jsonl = rows.map(value => JSON.stringify(value)).join("\n");
    const decoded: unknown[] = jsonl.split("\n").map(line => JSON.parse(line) as unknown);
    return { dev: import.meta.env.DEV, observed: observations.length, persisted: rows.length, decoded: decoded.length,
      transitionRetained: jsonl.includes('"lethalTransition"'), alternativeRetained: jsonl.includes('"alternative-accepted"'),
      simulatedStateLeaked: /"copiedTerrain"|"heightmap"|"players"/.test(jsonl),
      finalTarget: observations[0]?.target, jsonl };
  } finally { setRNG(previous); storage.close(); }
}
