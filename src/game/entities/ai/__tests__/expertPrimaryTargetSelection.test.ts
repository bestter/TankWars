import { describe, expect, it } from "vitest";
import { flatTerrain, makePlayer, makeTank } from "../../../__tests__/helpers";
import type { GameState } from "../../../../types/game";
import { primaryTarget, chooseExpertPlan, type ExpertDecisionTrace } from "../expertPlanner";
import {
  resolvePostSimulationPrimaryTarget,
  type ValidExpertShotResult,
} from "../expertShotEvaluator";
import { FORECAST_SHOT_ID } from "../physicalShotForecast";
import { LethalTransitionDetector } from "../lethalTransition";
import { createIdealExpertAim } from "../shotAdvisor";

describe("primaryTarget avant simulation (#388)", () => {
  it("départage d'abord par PV + bouclier croissant", () => {
    const a = makePlayer({ id: "a", tank: makeTank("a", 100, 300, { health: 80, shield: 20 }) }); // 100
    const b = makePlayer({ id: "b", tank: makeTank("b", 200, 300, { health: 70, shield: 20 }) }); // 90
    const roster = [a, b];

    expect(primaryTarget([a, b], roster).id).toBe("b");
    expect(primaryTarget([b, a], roster).id).toBe("b");
  });

  it("départage à PV + bouclier égal par score de profil décroissant (ex. [v2-heuristic, v4-smart] à 140 PV effectifs)", () => {
    const p2 = makePlayer({
      id: "player-2",
      isHuman: false,
      aiProfile: "v2-heuristic",
      tank: makeTank("player-2", 200, 300, { health: 100, shield: 40 }),
    }); // 140, profil 0.5
    const p4 = makePlayer({
      id: "player-4",
      isHuman: false,
      aiProfile: "v4-smart",
      tank: makeTank("player-4", 400, 300, { health: 100, shield: 40 }),
    }); // 140, profil 1.0
    const roster = [p2, p4];

    // Même si player-2 apparaît avant player-4 dans le roster, le profil v4-smart (1.0 > 0.5) l'emporte
    expect(primaryTarget([p2, p4], roster).id).toBe("player-4");
    expect(primaryTarget([p4, p2], roster).id).toBe("player-4");
  });

  it("respecte la hiérarchie complète des profils à PV+bouclier égal", () => {
    const random = makePlayer({ id: "rand", isHuman: false, aiProfile: "v1-random", tank: makeTank("rand", 100, 300, { health: 100 }) });
    const heuristic = makePlayer({ id: "heur", isHuman: false, aiProfile: "v2-heuristic", tank: makeTank("heur", 200, 300, { health: 100 }) });
    const sniper = makePlayer({ id: "snip", isHuman: false, aiProfile: "v3-sniper", tank: makeTank("snip", 300, 300, { health: 100 }) });
    const human = makePlayer({ id: "hum", isHuman: true, tank: makeTank("hum", 400, 300, { health: 100 }) });
    const smart = makePlayer({ id: "smart", isHuman: false, aiProfile: "v4-smart", tank: makeTank("smart", 500, 300, { health: 100 }) });
    const roster = [random, heuristic, sniper, human, smart];

    // v4-smart 1.0 > human 0.9
    expect(primaryTarget([human, smart], roster).id).toBe("smart");
    // human 0.9 > v3-sniper 0.8
    expect(primaryTarget([sniper, human], roster).id).toBe("hum");
    // v3-sniper 0.8 > v2-heuristic 0.5
    expect(primaryTarget([heuristic, sniper], roster).id).toBe("snip");
    // v2-heuristic 0.5 > v1-random 0.1
    expect(primaryTarget([random, heuristic], roster).id).toBe("heur");
  });

  it("utilise l'ordre du roster en dernier recours lorsque PV+bouclier et profil sont identiques", () => {
    const a = makePlayer({ id: "a", isHuman: true, tank: makeTank("a", 100, 300, { health: 100, shield: 20 }) });
    const b = makePlayer({ id: "b", isHuman: true, tank: makeTank("b", 200, 300, { health: 100, shield: 20 }) });
    const roster = [a, b];

    expect(primaryTarget([a, b], roster).id).toBe("a");
    expect(primaryTarget([b, a], roster).id).toBe("a");
  });
});

describe("resolvePostSimulationPrimaryTarget (#388)", () => {
  const shooter = makePlayer({ id: "shooter", tank: makeTank("shooter", 50, 300) });
  const p1 = makePlayer({ id: "p1", isHuman: false, aiProfile: "v2-heuristic", tank: makeTank("p1", 200, 300, { health: 100 }) });
  const p2 = makePlayer({ id: "p2", isHuman: false, aiProfile: "v4-smart", tank: makeTank("p2", 300, 300, { health: 100 }) });
  const p3 = makePlayer({ id: "p3", isHuman: true, tank: makeTank("p3", 400, 300, { health: 100 }) });
  const roster = [shooter, p1, p2, p3];

  it("donne priorité à la destruction attribuée sur les simples dégâts", () => {
    const impact = {
      forecast: {
        destruction: [{ shotId: FORECAST_SHOT_ID, shooterId: "shooter", victimId: "p1", cause: "blast" }],
        damage: [{ shotId: FORECAST_SHOT_ID, shooterId: "shooter", victimId: "p2", healthDamageMilli: 80_000, shieldLostMilli: 0 }],
        hits: [],
      },
    };
    // p1 est détruit, p2 a subi 80 PV de dégâts
    expect(resolvePostSimulationPrimaryTarget(impact, [p1, p2], roster, shooter).id).toBe("p1");
    expect(resolvePostSimulationPrimaryTarget(impact, [p2, p1], roster, shooter).id).toBe("p1");
  });

  it("donne priorité à la perte physique réelle totale décroissante en l'absence de destruction", () => {
    const impact = {
      forecast: {
        destruction: [],
        damage: [
          { shotId: FORECAST_SHOT_ID, shooterId: "shooter", victimId: "p1", healthDamageMilli: 20_000, shieldLostMilli: 10_000 }, // 30_000
          { shotId: FORECAST_SHOT_ID, shooterId: "shooter", victimId: "p2", healthDamageMilli: 40_000, shieldLostMilli: 5_000 },  // 45_000
        ],
        hits: [],
      },
    };
    expect(resolvePostSimulationPrimaryTarget(impact, [p1, p2], roster, shooter).id).toBe("p2");
  });

  it("exclut shieldAbsorbedMilli de la perte physique réelle", () => {
    const impact = {
      forecast: {
        destruction: [],
        damage: [
          // p1 absorbe 50_000 sans perte de bouclier (perte réelle 0)
          { shotId: FORECAST_SHOT_ID, shooterId: "shooter", victimId: "p1", healthDamageMilli: 0, shieldLostMilli: 0, shieldAbsorbedMilli: 50_000 },
          // p2 perd 1_000 de bouclier (perte réelle 1_000)
          { shotId: FORECAST_SHOT_ID, shooterId: "shooter", victimId: "p2", healthDamageMilli: 0, shieldLostMilli: 1_000, shieldAbsorbedMilli: 0 },
        ],
        hits: [],
      },
    };
    expect(resolvePostSimulationPrimaryTarget(impact, [p1, p2], roster, shooter).id).toBe("p2");
  });

  it("donne priorité à l'impact direct à dégâts égaux", () => {
    const impact = {
      forecast: {
        destruction: [],
        damage: [
          { shotId: FORECAST_SHOT_ID, shooterId: "shooter", victimId: "p1", healthDamageMilli: 20_000, shieldLostMilli: 0 },
          { shotId: FORECAST_SHOT_ID, shooterId: "shooter", victimId: "p2", healthDamageMilli: 20_000, shieldLostMilli: 0 },
        ],
        hits: [{ shotId: FORECAST_SHOT_ID, directTargetId: "p2" }],
      },
    };
    expect(resolvePostSimulationPrimaryTarget(impact, [p1, p2], roster, shooter).id).toBe("p2");
  });

  it("départage par profil à impact direct et dégâts égaux", () => {
    const impact = {
      forecast: {
        destruction: [],
        damage: [
          { shotId: FORECAST_SHOT_ID, shooterId: "shooter", victimId: "p1", healthDamageMilli: 10_000, shieldLostMilli: 0 },
          { shotId: FORECAST_SHOT_ID, shooterId: "shooter", victimId: "p2", healthDamageMilli: 10_000, shieldLostMilli: 0 },
        ],
        hits: [],
      },
    };
    // p1 est v2-heuristic (0.5), p2 est v4-smart (1.0)
    expect(resolvePostSimulationPrimaryTarget(impact, [p1, p2], roster, shooter).id).toBe("p2");
  });

  it("bascule vers les cibles collatérales si aucun membre de targets n'est affecté", () => {
    const impact = {
      forecast: {
        destruction: [{ shotId: FORECAST_SHOT_ID, shooterId: "shooter", victimId: "p3", cause: "blast" }],
        damage: [{ shotId: FORECAST_SHOT_ID, shooterId: "shooter", victimId: "p3", healthDamageMilli: 100_000, shieldLostMilli: 0 }],
        hits: [{ shotId: FORECAST_SHOT_ID, directTargetId: "p3" }],
      },
    };
    // Le groupe évalué est [p1, p2], mais ni p1 ni p2 ne sont touchés. p3 (collatéral) est détruit.
    expect(resolvePostSimulationPrimaryTarget(impact, [p1, p2], roster, shooter).id).toBe("p3");
  });

  it("reste sur targets si au moins un membre de targets est affecté, même si un collatéral subit davantage de dégâts", () => {
    const impact = {
      forecast: {
        destruction: [],
        damage: [
          { shotId: FORECAST_SHOT_ID, shooterId: "shooter", victimId: "p1", healthDamageMilli: 10_000, shieldLostMilli: 0 },
          { shotId: FORECAST_SHOT_ID, shooterId: "shooter", victimId: "p3", healthDamageMilli: 90_000, shieldLostMilli: 0 },
        ],
        hits: [],
      },
    };
    // p1 est dans targets et affecté -> le bassin reste targets ([p1, p2])
    expect(resolvePostSimulationPrimaryTarget(impact, [p1, p2], roster, shooter).id).toBe("p1");
  });

  it("supporte un résultat sans forecast via destroyedIds", () => {
    const impact = {
      destroyedIds: new Set(["p2"]),
    };
    expect(resolvePostSimulationPrimaryTarget(impact, [p1, p2], roster, shooter).id).toBe("p2");
  });
});

describe("Détecteur de transition létale avec cible principale issue de l'impact réel (#388)", () => {
  it("déclenche provoked-survival lorsque le tir sur une paire [v2-heuristic, v4-smart] frappe et laisse vivant v4-smart", () => {
    const self = makePlayer({ id: "self", isHuman: false, aiProfile: "v4-smart", tank: makeTank("self", 100, 336, { health: 100 }) });
    const p2 = makePlayer({ id: "player-2", isHuman: false, aiProfile: "v2-heuristic", tank: makeTank("player-2", 300, 336, { health: 100, shield: 40 }) });
    const p4 = makePlayer({ id: "player-4", isHuman: false, aiProfile: "v4-smart", tank: makeTank("player-4", 500, 336, { health: 100, shield: 40 }) });
    const terrain = flatTerrain(800, 480);
    const state: GameState = {
      phase: "COMBAT",
      players: [self, p2, p4],
      currentPlayerIndex: 0,
      turn: 1,
      roundNumber: 12,
      windForce: 0,
      gravity: 260,
      localShotContext: { playerCountAtMatchStart: 3, isFirstShotOfRound: true },
    };

    // Simulation de l'évaluation : un tir BULLET visant la paire [player-2, player-4]
    // qui touche directement et blesse uniquement player-4 (laissé à 6 PV), sans toucher player-2.
    const evaluate = () => {
      const mockResult: ValidExpertShotResult = {
        kind: "evaluated",
        primaryTargetId: "player-4", // assigné selon l'impact réel
        attempts: 1,
        offset: 0,
        requestedPoint: { x: 500, y: 328.5 },
        policy: { variant: "full", penalizeProximity: false },
        rawCommand: { angle: 45, power: 50 },
        command: { angle: 45, power: 50 },
        destination: { x: 500, y: 328.5, kind: "tank" },
        pointOrder: 0,
        profit: 50,
        destroyedIds: new Set<string>(),
        shooterDestroyed: false,
        humanDestroyedCount: 0,
        humanDamageMilli: 0,
        aiDestroyedCount: 0,
        aiDamageMilli: 134_000,
        forecast: {
          complete: true,
          profit: 50,
          steps: 100,
          survivors: ["self", "player-2", "player-4"],
          hits: [{ shotId: FORECAST_SHOT_ID, directTargetId: "player-4", x: 500, y: 328.5, munitionId: 0, weaponId: "BULLET" }],
          damage: [{ shotId: FORECAST_SHOT_ID, shooterId: "self", victimId: "player-4", healthDamageMilli: 94_000, shieldLostMilli: 40_000, shieldAbsorbedMilli: 0, source: "projectile", classification: "direct", munitionId: 0, weaponId: "BULLET" }],
          destruction: [],
          humanDestroyedCount: 0,
          humanDamageMilli: 0,
          aiDestroyedCount: 0,
          aiDamageMilli: 134_000,
          support: [],
        },
      };
      return mockResult;
    };

    let decisionTrace: ExpertDecisionTrace | undefined;
    const plan = chooseExpertPlan(
      self,
      state,
      terrain,
      createIdealExpertAim(),
      evaluate as unknown as typeof import("../expertShotEvaluator").evaluateExpertShot,
      (t) => { decisionTrace = t; },
    );

    // Le plan principal doit avoir primaryTargetId assigné à player-4
    expect(plan?.primaryTargetId).toBe("player-4");
    expect(decisionTrace?.selected?.primaryTargetId).toBe("player-4");
    expect(decisionTrace?.targets?.find((t) => t.playerId === "player-4")?.candidateCount).toBeGreaterThan(0);

    // Dans la trace de transition létale :
    // Avec primaryTargetId = "player-4" (v4-smart), le détecteur n'est PAS court-circuité par target-type
    const detector = new LethalTransitionDetector();
    const candidate = {
      primaryTargetId: plan!.primaryTargetId,
      weaponId: plan!.weaponId,
      command: plan!.command,
      result: plan!.result,
    };
    const analysis = detector.analyze(candidate, self, state, terrain);
    // Comme la cible est un v4-smart survivant et qu'aucune menace initiale n'existait,
    // l'analyse ne conclut pas "safe: target-type"
    expect(analysis.reason).not.toBe("target-type");
  });
});
