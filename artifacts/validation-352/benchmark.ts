import { flatTerrain, makePlayer, makeTank } from "../../src/game/__tests__/helpers";
import type { GameState } from "../../src/types/game";
import { createExpertForecastCache, evaluateExpertShot, isValidExpertShot } from "../../src/game/entities/ai/expertShotEvaluator";
import { createIdealExpertAim, calculateShotAdvice } from "../../src/game/entities/ai/shotAdvisor";
import { chooseTransitionSafePlan } from "../../src/game/entities/ai/lethalTransition";
import { AISmartStrategy } from "../../src/game/entities/ai/AISmartStrategy";
import { createSeededRNG, getRNG, setRNG } from "../../src/utils/random";
import type { AIObservation } from "../../src/game/observation";
import { IndexedEnduranceStorage } from "../../src/game/endurance/storage";
import { EnduranceJournal } from "../../src/game/endurance/journal";

export async function benchmark(worker = false) {
  const rows = [];
  for (const count of [2, 3, 4]) for (const scenario of ["no-reply", "reply", "exhausted"]) {
    const self = makePlayer({ id: "s", isHuman: false, aiProfile: "v4-smart", inventory: {},
      tank: makeTank("s", 80, 336, { health: scenario === "no-reply" ? 100 : 30 }) });
    const players = [self, ...Array.from({ length: count - 1 }, (_, i) => makePlayer({ id: `c${i}`, inventory: {},
      isHuman: scenario === "exhausted" || i === 0, aiProfile: "v1-random",
      tank: makeTank(`c${i}`, 300 + i * 210, 336, { health: 60 }) }))];
    const state: GameState = { phase: "COMBAT", players, currentPlayerIndex: 0, turn: 5, roundNumber: 2,
      windForce: 0, gravity: 260, localShotContext: { playerCountAtMatchStart: count, isFirstShotOfRound: false } };
    const terrain = flatTerrain(900, 480);
    const candidates = players.slice(1).map(target => {
      const result = evaluateExpertShot(state, terrain, self, "MISSILE", [target], false, false,
        createExpertForecastCache(), { mode: "own", aim: createIdealExpertAim().forTarget(target.id), selectionPolicy: "OPTIMISER_PROFIT" });
      if (!isValidExpertShot(result)) throw new Error("UNCERTIFIED_FIXTURE");
      return { primaryTargetId: target.id, weaponId: "MISSILE" as const, command: result.command, result };
    });
    for (const observe of [false, true]) {
      let observation: AIObservation | undefined;
      const strategy = new AISmartStrategy();
      if (observe) strategy.onDecisionObserved = value => { observation = value; };
      const previous = getRNG(); setRNG(createSeededRNG(12453));
      const start = performance.now();
      const selection = chooseTransitionSafePlan(candidates, self, state, terrain, true);
      const detectorMs = performance.now() - start;
      const frameStart = worker ? 0 : await new Promise<number>(resolve => requestAnimationFrame(resolve));
      const aiStart = performance.now();
      const command = await strategy.executeTurn(self.tank.id, structuredClone(state), terrain);
      const expertMs = performance.now() - aiStart;
      setRNG(previous);
      const expertFrameGapMs = worker ? null : await new Promise<number>(resolve => requestAnimationFrame(now => resolve(now - frameStart)));
      const snapshot = { state: { ...state, players: structuredClone(players) }, width: 900, height: 480,
        heights: [...terrain.getHeightmap()], materials: [...terrain.getMaterials()] };
      snapshot.state.players[0].isHuman = true;
      const advisorStart = performance.now();
      const advice = calculateShotAdvice(snapshot, "OPTIMISER_PROFIT", observe ? () => {} : undefined);
      const searches = [selection.trace.analysis, ...selection.trace.alternatives.map(value => value.analysis)]
        .flatMap(value => value ? [value.initial, value.after, value.reply].filter(value => value !== null) : []);
      rows.push({ worker, count, scenario, observe, detectorMs, expertMs, expertFrameGapMs, advisorMs: performance.now() - advisorStart,
        reason: selection.trace.reason, risk: selection.trace.analysis?.reason,
        searches: searches.reduce((sum, search) => sum + search.searches, 0),
        forecasts: searches.reduce((sum, search) => sum + search.forecasts, 0), command, advice: advice?.command,
        observed: Boolean(observation) });
    }
  }
  return rows;
}

export async function verifyCompiledJournal() {
  const self = makePlayer({ id: "s", isHuman: false, aiProfile: "v4-smart", inventory: {}, tank: makeTank("s", 100, 336) });
  const target = makePlayer({ id: "c", inventory: {}, tank: makeTank("c", 400, 336, { health: 60 }) });
  const state: GameState = { phase: "COMBAT", players: [self, target], currentPlayerIndex: 0, turn: 4, roundNumber: 12,
    windForce: 0, gravity: 260, localShotContext: { playerCountAtMatchStart: 2, isFirstShotOfRound: false } };
  const storage = new IndexedEnduranceStorage(); const sessionId = `validation-352-${Date.now()}`;
  const journal = new EnduranceJournal(sessionId, (entries, status) => storage.appendJournal(entries, status), error => { throw error; });
  const strategy = new AISmartStrategy();
  const previous = getRNG(); setRNG(createSeededRNG(12453));
  await strategy.executeTurn("s", structuredClone(state), flatTerrain(800, 480));
  strategy.onDecisionObserved = observation => journal.append({ at: new Date().toISOString(), atMs: 0,
    blockId: "validation", blockIndex: 1, seed: 12453, round: 2, turn: 4, phase: "COMBAT", decisionId: "validation:1",
    event: { kind: "combat", event: { kind: "ai-detail", observation } }, context: null, contextError: null });
  setRNG(createSeededRNG(12453));
  await strategy.executeTurn("s", state, flatTerrain(800, 480)); setRNG(previous);
  const fallback = new AISmartStrategy(); fallback.onDecisionObserved = strategy.onDecisionObserved;
  const fallbackState = structuredClone(state); delete fallbackState.localShotContext;
  setRNG(createSeededRNG(12453));
  await fallback.executeTurn("s", fallbackState, flatTerrain(800, 480)); setRNG(previous);
  await journal.finish();
  const rows = await storage.readJournal(sessionId, 0, 256);
  const jsonl = rows.map(value => JSON.stringify(value)).join("\n");
  const decoded: unknown[] = jsonl.split("\n").map(line => JSON.parse(line) as unknown);
  const record = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
  const diagnostics = (value: unknown) => {
    const event = record(record(value)?.event);
    const observation = record(record(event?.event)?.observation);
    return record(observation?.diagnostics);
  };
  const main = record(diagnostics(decoded[0])?.planner);
  const fallbackDiagnostics = diagnostics(decoded[1]);
  const result = { dev: import.meta.env.DEV, persisted: rows.length,
    transitionRetained: jsonl.includes('"lethalTransition"'),
    simulatedTerrainLeaked: jsonl.includes('"copiedTerrain"') || jsonl.includes('"offscreenCanvas"'),
    reloaded: main?.lethalTransition,
    targets: main?.targets,
    fallback: record(fallbackDiagnostics?.fallbackChoice),
    fallbackTarget: fallbackDiagnostics?.targetSelection };
  storage.close(); return result;
}
