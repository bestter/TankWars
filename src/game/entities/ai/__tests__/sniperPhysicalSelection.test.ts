/**
 * Sélection physique SNIPER (#289).
 * Reproduction : npm run test -- src/game/entities/ai/__tests__/sniperPhysicalSelection.test.ts
 * Le retrait du jet BULLET à 50 % décale la séquence globale de secureRandom.
 * Les offsets, réactions et gaffes gardent les valeurs de fallibleAim et aimCorruption.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flatTerrain, makePlayer, makeTank } from "../../../__tests__/helpers";
import type { GameState } from "../../../../types/game";
import type { Player } from "../../../../types/player";
import { TERRAIN_MATERIAL } from "../../../../types/terrain";
import { WEAPON_REGISTRY, type WeaponId } from "../../../../types/weapon";
import type { CombatDamageEvent, CombatDestructionEvent } from "../../../economy/shotRewards";
import * as economics from "../../../economy/shotRewards";
import * as random from "../../../../utils/random";
import { PhysicsEngine, type ProjectileHitEvent } from "../../../engine/PhysicsEngine";
import { TerrainManager } from "../../../engine/Terrain";
import { TankManager } from "../../TankManager";
import { BALLISTICS_DT, launchFromBarrel } from "../../../engine/projectileMotion";
import { finalizeAdvancedAim, ADVANCED_GAFFES } from "../aimCorruption";
import type { AimMemory } from "../aimMemory";
import * as fallible from "../fallibleAim";
import * as aimMemory from "../aimMemory";
import * as physical from "../physicalShotForecast";
import * as candidates from "../materialCandidates";
import type { MaterialSolver } from "../localMaterialPlanner";
import { AISniperStrategy } from "../AISniperStrategy";
import { getHitReactionIntensity } from "../hitReaction";
import { localMaterialPoints } from "../materialCandidates";
import * as sniperAim from "../sniperAim";
import * as sniperSelection from "../sniperPhysicalSelection";
import {
  SNIPER_SEARCH_LIMITS,
  chooseSniperPhysicalShot,
  sniperBulletRefusal,
  sniperDrillerRefusal,
  type SniperSelectionTrace,
} from "../sniperPhysicalSelection";

const EMPTY_TRACE: SniperSelectionTrace = {
  selectionReason: "seul candidat",
  admissible: [],
  refusals: [],
  searches: 0,
  forecasts: 0,
  cacheHits: 0,
};

function fixture(partial: { bullet?: number; driller?: number; money?: number } = {}) {
  const terrain = flatTerrain(800, 480);
  const self = makePlayer({
    id: "self", isHuman: false, aiProfile: "v3-sniper", money: partial.money ?? 1000,
    tank: makeTank("self", 100, 336),
    inventory: { BULLET: partial.bullet ?? 2, DRILLER: partial.driller ?? 1 },
  });
  const target = makePlayer({ id: "target", isHuman: true, tank: makeTank("target", 400, 336) });
  const state: GameState = {
    phase: "COMBAT", players: [self, target], currentPlayerIndex: 0, turn: 1, roundNumber: 1,
    windForce: 0, gravity: 260,
    localShotContext: { playerCountAtMatchStart: 2, isFirstShotOfRound: false },
  };
  return { terrain, self, target, state };
}

type Complete = Extract<physical.PhysicalResolution, { complete: true }>;

function forecast(overrides: Partial<Complete> = {}): Complete {
  return {
    complete: true, survivors: ["self", "target"], hits: [], damage: [], destruction: [],
    support: [{ playerId: "target", x: 400, before: 336, after: 336 }], steps: 1,
    humanDamageMilli: 0, humanDestroyedCount: 0, aiDamageMilli: 0, aiDestroyedCount: 0,
    ...overrides,
  };
}

function damage(weapon: WeaponId, overrides: Partial<CombatDamageEvent> = {}): CombatDamageEvent {
  return {
    shotId: 1, munitionId: 0, shooterId: "self", victimId: "target", weaponId: weapon,
    source: "projectile", classification: "direct", shieldLostMilli: 0, shieldAbsorbedMilli: 0,
    healthDamageMilli: 1000, ...overrides,
  };
}

function destroyed(weapon: WeaponId, cause: CombatDestructionEvent["cause"], overrides: Partial<CombatDestructionEvent> = {}): CombatDestructionEvent {
  return { shotId: 1, shooterId: "self", victimId: "target", weaponId: weapon, cause, ...overrides };
}

function hit(weapon: WeaponId, directTargetId?: string): ProjectileHitEvent {
  return { shotId: 1, munitionId: 0, x: 400, y: 330, weaponId: weapon, directTargetId };
}

function solver(complete = true): MaterialSolver & ReturnType<typeof vi.fn<MaterialSolver>> {
  let angle = 30;
  return vi.fn<MaterialSolver>(() => ({ command: { angle: angle++, power: 50 }, complete }));
}

function support(after = 390) {
  return [{ playerId: "target", x: 400, before: 336, after }];
}

function bulletProof(loss = 1000, destruction: CombatDestructionEvent[] = []): Complete {
  return forecast({
    hits: [hit("BULLET", "target")],
    damage: [damage("BULLET", { healthDamageMilli: loss })],
    destruction,
  });
}

function drillerProof(options: { fall?: number; cause?: CombatDestructionEvent["cause"]; loss?: number } = {}): Complete {
  const fall = options.fall ?? 0;
  const events = fall > 0 ? [damage("DRILLER", { source: "fall", classification: "indirect", healthDamageMilli: fall })] : [];
  return forecast({
    hits: [hit("DRILLER")],
    support: support(),
    damage: events,
    destruction: options.cause ? [destroyed("DRILLER", options.cause)] : [],
    survivors: options.cause ? ["self"] : ["self", "target"],
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("SNIPER physical proofs", () => {
  it("accepts a direct useful BULLET and rejects interception, absorption and a miss", () => {
    const f = fixture();
    expect(sniperBulletRefusal(bulletProof(), f.self, f.target)).toBeNull();
    expect(sniperBulletRefusal(forecast({
      hits: [hit("BULLET", "other")],
      damage: [damage("BULLET")],
    }), f.self, f.target)).toBe("interception");
    expect(sniperBulletRefusal(forecast({ hits: [hit("BULLET", "target")], damage: [damage("BULLET", {
      healthDamageMilli: 0, shieldLostMilli: 0, shieldAbsorbedMilli: 1000,
    })] }), f.self, f.target)).toBe("absorption seule");
    expect(sniperBulletRefusal(forecast({ hits: [] }), f.self, f.target)).toBe("pas d'impact direct");
    expect(sniperBulletRefusal(forecast({
      hits: [hit("BULLET", "target")], survivors: ["target"],
      damage: [damage("BULLET")],
    }), f.self, f.target)).toBe("tireur détruit");
  });

  it("accepts a damaging fall, burial or lava and rejects the other DRILLER outcomes", () => {
    const f = fixture();
    expect(sniperDrillerRefusal(drillerProof({ fall: 4000 }), f.self, f.target)).toBeNull();
    expect(sniperDrillerRefusal(drillerProof({ cause: "buried" }), f.self, f.target)).toBeNull();
    expect(sniperDrillerRefusal(drillerProof({ cause: "lava" }), f.self, f.target)).toBeNull();
    expect(sniperDrillerRefusal(forecast({ hits: [hit("DRILLER")], support: support() }), f.self, f.target))
      .toBe("excavation seule");
    expect(sniperDrillerRefusal(forecast({
      hits: [hit("DRILLER")], support: support(),
      damage: [damage("DRILLER", { source: "fall", healthDamageMilli: 0 })],
    }), f.self, f.target)).toBe("chute sans dommage");
    expect(sniperDrillerRefusal(forecast({
      hits: [hit("DRILLER")], support: support(),
      damage: [damage("DRILLER", { healthDamageMilli: 8000 })],
      destruction: [destroyed("DRILLER", "health-zero")],
    }), f.self, f.target)).toBe("destruction health-zero");
    expect(sniperDrillerRefusal(forecast({
      hits: [hit("DRILLER")], support: support(),
      damage: [damage("DRILLER", { healthDamageMilli: 800 })],
    }), f.self, f.target)).toBe("souffle seul");
    expect(sniperDrillerRefusal(forecast({
      hits: [hit("DRILLER")], support: support(),
      destruction: [destroyed("DRILLER", "out-of-bounds")],
    }), f.self, f.target)).toBe("hors carte");
    expect(sniperDrillerRefusal(forecast({
      hits: [hit("DRILLER")], support: support(),
      damage: [damage("DRILLER", { source: "fall", healthDamageMilli: 4000, shooterId: "other" })],
    }), f.self, f.target)).toBe("attribution étrangère");
    expect(sniperDrillerRefusal(forecast({
      hits: [hit("DRILLER", "target")], support: support(),
      damage: [damage("DRILLER", { source: "fall", healthDamageMilli: 4000 })],
    }), f.self, f.target)).toBe("impact direct");
    expect(sniperDrillerRefusal(forecast({ hits: [], support: support() }), f.self, f.target))
      .toBe("pas d'impact terrain");
    expect(sniperDrillerRefusal(forecast({ hits: [hit("DRILLER")], support: support(336) }), f.self, f.target))
      .toBe("sans perte de support");
    expect(sniperDrillerRefusal(forecast({
      hits: [hit("DRILLER")], support: support(), survivors: ["target"],
      damage: [damage("DRILLER", { source: "fall", healthDamageMilli: 4000 })],
    }), f.self, f.target)).toBe("tireur détruit");
  });
});

describe("SNIPER ranking, fallback and bounds", () => {
  function choose(f: ReturnType<typeof fixture>, resolve: (weapon: WeaponId, angle: number) => physical.PhysicalResolution, offset = 12, solve = solver()) {
    vi.spyOn(physical, "resolvePhysicalShot").mockImplementation((_state, _terrain, _self, weapon, command) =>
      resolve(weapon, command.angle));
    return { choice: chooseSniperPhysicalShot(f.self, f.target, f.state, f.terrain, offset, solve), solve };
  }

  it("ranks destruction, then the target's real loss, then BULLET, and ignores other victims", () => {
    const f = fixture();
    const lethalDriller = drillerProof({ cause: "buried" });
    const woundingBullet = bulletProof(5000);
    const first = choose(f, (weapon) => weapon === "DRILLER" ? lethalDriller : woundingBullet);
    expect(first.choice).toMatchObject({ weaponId: "DRILLER", reason: "driller", certified: true });

    const equalDestruction = choose(f, (weapon) => weapon === "BULLET"
      ? bulletProof(1000, [destroyed("BULLET", "health-zero")])
      : forecast({ ...drillerProof({ cause: "buried", fall: 5000 }) }));
    expect(equalDestruction.choice.weaponId).toBe("DRILLER");

    const bulletWinsTie = choose(f, (weapon) => weapon === "BULLET"
      ? bulletProof(2000, [destroyed("BULLET", "health-zero")])
      : drillerProof({ cause: "lava", fall: 2000 }));
    expect(bulletWinsTie.choice).toMatchObject({ weaponId: "BULLET", variant: "full", point: { kind: "tank" } });

    let drillerIndex = 0;
    const collateral = choose(f, (weapon) => {
      if (weapon === "BULLET") return bulletProof(40);
      const index = drillerIndex;
      drillerIndex += 1;
      if (index === 0) return forecast({
        ...drillerProof({ fall: 50 }),
        damage: [
          damage("DRILLER", { source: "fall", healthDamageMilli: 50 }),
          damage("DRILLER", { victimId: "other", healthDamageMilli: 9000 }),
        ],
      });
      return drillerProof({ fall: 80 });
    });
    expect(collateral.choice).toMatchObject({ weaponId: "DRILLER", variant: "high" });
  });

  it("keeps the earlier point and arc when destruction, loss and weapon are equal", () => {
    const bullet = fixture();
    const sameBullet = choose(bullet, (weapon) => weapon === "BULLET" ? bulletProof(1000) : forecast());
    expect(sameBullet.choice).toMatchObject({ weaponId: "BULLET", variant: "full", point: { kind: "tank" } });

    const driller = fixture({ bullet: 0 });
    const sameFall = drillerProof({ fall: 1000 });
    const earlier = choose(driller, () => sameFall);
    expect(earlier.choice).toMatchObject({ weaponId: "DRILLER", variant: "full", point: { kind: "tank" } });
  });

  it("does not search MISSILE while an admissible BULLET or DRILLER exists", () => {
    const f = fixture();
    const { solve } = choose(f, (weapon) => weapon === "BULLET" ? bulletProof() : drillerProof({ fall: 10 }));
    expect(solve.mock.calls.some((call) => call[1] === "MISSILE")).toBe(false);
    expect(solve).toHaveBeenCalledTimes(SNIPER_SEARCH_LIMITS.bullet + SNIPER_SEARCH_LIMITS.driller);
  });

  it("falls back to a useful MISSILE, then a surviving one, then the uncertified tank command", () => {
    const f = fixture();
    const useful = choose(f, (weapon) => weapon === "MISSILE"
      ? forecast({ hits: [hit("MISSILE", "target")], damage: [damage("MISSILE")] })
      : forecast());
    expect(useful.choice).toMatchObject({ weaponId: "MISSILE", reason: "missile-useful", certified: true, variant: "full" });
    expect(useful.choice.trace.selectionReason).toBe("repli utile");
    expect(useful.solve.mock.calls.filter((call) => call[1] === "MISSILE")).toHaveLength(1);

    const surviving = choose(f, () => forecast());
    expect(surviving.choice).toMatchObject({ reason: "missile-surviving", certified: true, variant: "full" });
    expect(surviving.choice.trace.selectionReason).toBe("repli survivant");

    const ordinary = choose(f, () => forecast({ survivors: ["target"] }), 0, solver(false));
    const ordinaryIndex = SNIPER_SEARCH_LIMITS.bullet + SNIPER_SEARCH_LIMITS.driller;
    expect(ordinary.choice).toMatchObject({ reason: "missile-ordinary", certified: false, variant: "full", point: { kind: "tank" } });
    expect(ordinary.solve).toHaveBeenCalledTimes(SNIPER_SEARCH_LIMITS.total);
    expect(ordinary.choice.rawCommand).toEqual(ordinary.solve.mock.results[ordinaryIndex]?.value.command);
    expect(ordinary.choice.trace.selectionReason).toBe("secours ordinaire");
  });

  it("records a surviving missile replaced by a later useful one", () => {
    const f = fixture({ bullet: 0, driller: 0 });
    let missiles = 0;
    const { choice } = choose(f, (weapon) => {
      if (weapon !== "MISSILE") return forecast();
      missiles += 1;
      return missiles === 1
        ? forecast()
        : forecast({ hits: [hit("MISSILE", "target")], damage: [damage("MISSILE")] });
    });
    expect(choice.trace.selectionReason).toBe("repli utile");
    expect(choice.trace.runnerUp).toMatchObject({ weaponId: "MISSILE", variant: "full" });
    expect(choice.trace.refusals.some((entry) => entry.refusal === "survivant écarté" && entry.command)).toBe(true);
  });

  it("does not promote SOFT excavation and vetoes ROCK without a DRILLER search", () => {
    const f = fixture();
    f.terrain.setMaterialRange(0, 799, TERRAIN_MATERIAL.SOFT);
    const soft = choose(f, (weapon) => weapon === "DRILLER"
      ? forecast({ hits: [hit("DRILLER")], support: support() })
      : forecast());
    expect(soft.choice.weaponId).toBe("MISSILE");
    expect(soft.solve.mock.calls.some((call) => call[1] === "DRILLER")).toBe(true);

    f.terrain.setMaterialRange(0, 799, TERRAIN_MATERIAL.ROCK);
    const resolve = vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(forecast());
    resolve.mockClear();
    const solve = solver();
    chooseSniperPhysicalShot(f.self, f.target, f.state, f.terrain, 0, solve);
    expect(solve.mock.calls.some((call) => call[1] === "DRILLER")).toBe(false);
    expect(resolve.mock.calls.some((call) => call[3] === "DRILLER")).toBe(false);
  });

  it("fires the synthetic missile when no tactical point is returned", () => {
    const f = fixture();
    f.target.tank.position.x = -1000;
    expect(localMaterialPoints(f.self, f.target, "BULLET", f.terrain)).toEqual([]);
    expect(localMaterialPoints(f.self, f.target, "DRILLER", f.terrain)).toEqual([]);
    expect(localMaterialPoints(f.self, f.target, "MISSILE", f.terrain)).toEqual([]);
    const solve = vi.fn<MaterialSolver>();
    const choice = chooseSniperPhysicalShot(f.self, f.target, f.state, f.terrain, 0, solve);
    expect(choice).toMatchObject({
      weaponId: "MISSILE",
      certified: false,
      reason: "missile-ordinary",
      rawCommand: { angle: 45, power: 50 },
      command: { angle: 45, power: 50 },
    });
    expect(choice.trace.selectionReason).toBe("secours synthétique");
    expect(choice.trace.searches).toBe(0);
    expect(choice.trace.forecasts).toBe(0);
    expect(solve).not.toHaveBeenCalled();
  });

  it("caps a long point list at 2/4/4 searches and reuses one forecast per normalized command", () => {
    const f = fixture();
    vi.spyOn(candidates, "localMaterialPoints").mockReturnValue(
      Array.from({ length: 20 }, (_, index) => ({ x: 300 + index, y: 330, kind: "tank" as const })));
    const resolve = vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(forecast({ survivors: ["target"] }));
    const solve = vi.fn<MaterialSolver>().mockReturnValue({ command: { angle: 40.04, power: 50.2 }, complete: true });
    const choice = chooseSniperPhysicalShot(f.self, f.target, f.state, f.terrain, 9, solve);
    expect(solve.mock.calls.map((call) => call[1])).toEqual([
      ...Array.from({ length: SNIPER_SEARCH_LIMITS.bullet }, () => "BULLET"),
      ...Array.from({ length: SNIPER_SEARCH_LIMITS.driller }, () => "DRILLER"),
      ...Array.from({ length: SNIPER_SEARCH_LIMITS.missile }, () => "MISSILE"),
    ]);
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(resolve).toHaveBeenCalledWith(f.state, f.terrain, f.self, "BULLET", { angle: 40, power: 50 });
    expect(choice).toMatchObject({ reason: "missile-ordinary", certified: false });
    expect(solve.mock.calls.every((call) => call[0].x >= 300 + 9)).toBe(true);
  });

  it("aims at the offset point, keeps Y and does not clamp X", () => {
    const f = fixture({ bullet: 0, driller: 0 });
    const solve = solver(false);
    const offset = 500;
    chooseSniperPhysicalShot(f.self, f.target, f.state, f.terrain, offset, solve);
    const expected: Array<[number, number, "full" | "high"]> = localMaterialPoints(
      f.self, f.target, "MISSILE", f.terrain,
    ).flatMap((point) =>
      (["full", "high"] as const).map((variant): [number, number, "full" | "high"] =>
        [point.x + offset, point.y, variant]));
    expect(solve.mock.calls.map((call) => [call[0].x, call[0].y, call[2]])).toEqual(expected);
    expect(expected.some((entry) => entry[0] > f.terrain.width)).toBe(true);
  });

  it("ignores money, prices and economic context and never scores rewards", () => {
    const left = fixture({ money: 0 });
    const right = fixture({ money: 90000 });
    delete right.state.localShotContext;
    const price = WEAPON_REGISTRY.BULLET.price;
    WEAPON_REGISTRY.BULLET.price = 1;
    const reward = vi.spyOn(economics, "calculateShotRewards");
    const resolve = (weapon: WeaponId) => weapon === "BULLET" ? bulletProof(100) : forecast();
    const first = choose(left, resolve, 4);
    WEAPON_REGISTRY.BULLET.price = 99999;
    const second = choose(right, resolve, 4);
    WEAPON_REGISTRY.BULLET.price = price;
    expect(second.choice).toEqual(first.choice);
    expect(reward).not.toHaveBeenCalled();
  });

  it("keeps the same choice when the trace is disabled and leaves logging to the strategy", async () => {
    const f = fixture();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(physical, "resolvePhysicalShot").mockReturnValue(bulletProof());
    const solve = solver();
    const traced = chooseSniperPhysicalShot(f.self, f.target, f.state, f.terrain, 0, solve);
    expect(info.mock.calls.some((call) => call[0] === "[AI SNIPER] Décision")).toBe(false);
    expect(traced.trace.admissible.length).toBeGreaterThan(0);
    const shot = await new AISniperStrategy().executeTurn("self", f.state, f.terrain);
    const line = info.mock.calls.find((call) => call[0] === "[AI SNIPER] Décision");
    expect(typeof line?.[1]).toBe("string");
    const payload = JSON.parse(String(line?.[1])) as { choice: { finalCommand: { angle: number; power: number }; weaponId: string } };
    expect(payload.choice.finalCommand).toEqual({ angle: shot.angle, power: shot.power });
    expect(payload.choice.weaponId).toBe(shot.weaponId);
    info.mockClear();
    vi.stubEnv("DEV", false);
    const silent = chooseSniperPhysicalShot(f.self, f.target, f.state, f.terrain, 0, solver());
    expect(silent.weaponId).toBe(traced.weaponId);
    expect(silent.reason).toBe(traced.reason);
    expect(silent.trace.admissible).toEqual([]);
    expect(silent.trace.refusals).toEqual([]);
    expect(silent.trace.runnerUp).toBeUndefined();
    expect(silent.trace.selectionReason).toBe(traced.trace.selectionReason);
    expect(silent.trace.searches).toBe(traced.trace.searches);
    expect(silent.trace.forecasts).toBe(traced.trace.forecasts);
    await new AISniperStrategy().executeTurn("self", f.state, f.terrain);
    expect(info.mock.calls.some((call) => call[0] === "[AI SNIPER] Décision")).toBe(false);
  });
});

describe("SNIPER turn wiring", () => {
  function memoryOf(strategy: AISniperStrategy): Map<string, AimMemory> {
    return (strategy as unknown as { memories: Map<string, AimMemory> }).memories;
  }

  it("records one attempt, draws one offset and fires the normalized command without a later search", async () => {
    const f = fixture();
    const selection = vi.spyOn(sniperSelection, "chooseSniperPhysicalShot");
    selection.mockReturnValue({
      weaponId: "BULLET", point: { x: 400, y: 330, kind: "tank" }, variant: "high",
      rawCommand: { angle: 45.04, power: 50.2 }, command: { angle: 45, power: 50 },
      certified: true, reason: "bullet", trace: EMPTY_TRACE,
    });
    const offset = vi.spyOn(fallible, "signedImpactOffset").mockReturnValue(12);
    const record = vi.spyOn(aimMemory, "recordAimAttempt");
    vi.spyOn(fallible, "maybeGaffe").mockReturnValue(false);
    const search = vi.spyOn(sniperAim, "solveSniperAim");
    const shot = await new AISniperStrategy().executeTurn("self", f.state, f.terrain);
    expect(record).toHaveBeenCalledTimes(1);
    expect(offset).toHaveBeenCalledTimes(1);
    expect(shot).toEqual({ angle: 45, power: 50, weaponId: "BULLET" });
    expect(search).not.toHaveBeenCalled();
    expect(f.self.inventory).toEqual({ BULLET: 2, DRILLER: 1 });
    expect(f.self.tank.currentWeapon).toBe("BULLET");
  });

  it("applies reaction then gaffe once to the raw command and skips corruption at intensity zero", async () => {
    const f = fixture();
    const raw = { angle: 45.04, power: 50.2 };
    const normalized = finalizeAdvancedAim(raw);
    vi.spyOn(sniperSelection, "chooseSniperPhysicalShot").mockReturnValue({
      weaponId: "DRILLER", point: { x: 381, y: 336, kind: "terrain" }, variant: "full",
      rawCommand: raw, command: normalized, certified: true, reason: "driller", trace: EMPTY_TRACE,
    });
    vi.spyOn(fallible, "signedImpactOffset").mockReturnValue(3);
    vi.spyOn(fallible, "maybeGaffe").mockReturnValue(false);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const calm = await new AISniperStrategy().executeTurn("self", f.state, f.terrain);
    expect(calm).toEqual({ ...normalized, weaponId: "DRILLER" });

    f.self.tank.hitReaction = { wasDirectHit: true, fallDistance: 0 };
    vi.spyOn(random, "secureRandom").mockReturnValue(0);
    vi.spyOn(fallible, "maybeGaffe").mockReturnValue(true);
    const intensity = getHitReactionIntensity("v3-sniper", f.self.tank.hitReaction);
    const gaffe = ADVANCED_GAFFES["v3-sniper"];
    const strategy = new AISniperStrategy();
    const shot = await strategy.executeTurn("self", f.state, f.terrain);
    const reacted = {
      angle: raw.angle - intensity * gaffe.angleAmplitude - gaffe.angleAmplitude,
      power: raw.power - intensity * gaffe.powerAmplitude - gaffe.powerAmplitude,
    };
    expect(shot).toEqual({ ...finalizeAdvancedAim(reacted), weaponId: "DRILLER" });
    expect(f.self.tank.hitReaction).toEqual({ wasDirectHit: false, fallDistance: 0 });
    const line = info.mock.calls.filter((call) => call[0] === "[AI SNIPER] Décision").at(-1);
    const payload = JSON.parse(String(line?.[1])) as {
      choice: { finalCommand: { angle: number; power: number }; gaffeOccurred: boolean; reactionIntensity: number; rawCommand: { angle: number; power: number } };
    };
    expect(payload.choice.finalCommand).toEqual({ angle: shot.angle, power: shot.power });
    expect(payload.choice.gaffeOccurred).toBe(true);
    expect(payload.choice.reactionIntensity).toBe(intensity);
    expect(payload.choice.rawCommand).toEqual(raw);
  });

  it.each([1, 5, 12] as const)("shares one signed offset for round %s across attempts, including a target change", async (round) => {
    const f = fixture({ bullet: 0, driller: 0 });
    f.state.roundNumber = round;
    const strategy = new AISniperStrategy();
    const solve = vi.spyOn(sniperAim, "solveSniperAim")
      .mockReturnValue({ command: { angle: 40, power: 55 }, complete: false });
    const offset = vi.spyOn(fallible, "signedImpactOffset");
    vi.spyOn(fallible, "maybeGaffe").mockReturnValue(false);
    vi.spyOn(random, "secureRandom").mockReturnValue(0.25);
    for (const attempt of [1, 2, 3]) {
      memoryOf(strategy).set(f.self.id, {
        currentTargetId: f.target.id, currentTargetAttempts: attempt - 1, lastRoundNumber: round,
      });
      offset.mockClear();
      solve.mockClear();
      await strategy.executeTurn("self", f.state, f.terrain);
      const sign = f.target.tank.position.x > f.terrain.width - f.target.tank.position.x ? -1 : 1;
      const direction = attempt === 2 ? -sign : sign;
      expect(offset).toHaveBeenCalledExactlyOnceWith(attempt, "v3-sniper", round, direction);
      const tankXs = solve.mock.calls.filter((call) => call[2] === 330).map((call) => call[1]);
      expect(new Set(tankXs).size).toBe(1);
      expect(Math.sign((tankXs[0] ?? 0) - 400)).toBe(direction);
    }
    const other = makePlayer({ id: "other", tank: makeTank("other", 600, 336) });
    f.state.players[1] = other;
    offset.mockClear();
    await strategy.executeTurn("self", f.state, f.terrain);
    expect(offset).toHaveBeenCalledWith(1, "v3-sniper", round, expect.any(Number));
  });

  it("logs a JSON fallback when no enemy remains and does not search", async () => {
    const f = fixture();
    f.state.players = [f.self];
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const search = vi.spyOn(sniperAim, "solveSniperAim");
    const shot = await new AISniperStrategy().executeTurn("self", f.state, f.terrain);
    expect(shot).toEqual({ angle: 45, power: 50, weaponId: "MISSILE" });
    expect(search).not.toHaveBeenCalled();
    const payload = JSON.parse(String(info.mock.calls.find((call) => call[0] === "[AI SNIPER] Décision")?.[1])) as {
      finalReason: string;
      choice: { finalCommand: { angle: number; power: number } };
    };
    expect(payload.finalReason).toBe("aucun adversaire vivant");
    expect(payload.choice.finalCommand).toEqual({ angle: 45, power: 50 });
  });

  it("logs a JSON fallback when the shooter is missing or dead and does not search", async () => {
    const f = fixture();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const search = vi.spyOn(sniperAim, "solveSniperAim");
    const selection = vi.spyOn(sniperSelection, "chooseSniperPhysicalShot");
    const missing = await new AISniperStrategy().executeTurn("absent", f.state, f.terrain);
    expect(missing).toEqual({ angle: 45, power: 50, weaponId: "MISSILE" });
    const missingPayload = JSON.parse(String(info.mock.calls.find((call) => call[0] === "[AI SNIPER] Décision")?.[1])) as {
      finalReason: string;
      shooterId?: string;
      choice: { finalCommand: { angle: number; power: number }; weaponId: string };
    };
    expect(missingPayload.finalReason).toBe("tireur absent ou mort");
    expect(missingPayload.shooterId).toBeUndefined();
    expect(missingPayload.choice).toEqual({
      weaponId: "MISSILE", certified: false, finalCommand: { angle: 45, power: 50 },
    });

    info.mockClear();
    f.self.tank.isDead = true;
    const dead = await new AISniperStrategy().executeTurn(f.self.tank.id, f.state, f.terrain);
    expect(dead).toEqual({ angle: 45, power: 50, weaponId: "MISSILE" });
    const deadPayload = JSON.parse(String(info.mock.calls.find((call) => call[0] === "[AI SNIPER] Décision")?.[1])) as {
      finalReason: string;
      shooterId?: string;
    };
    expect(deadPayload.finalReason).toBe("tireur absent ou mort");
    expect(deadPayload.shooterId).toBe(f.self.id);
    expect(search).not.toHaveBeenCalled();
    expect(selection).not.toHaveBeenCalled();
    expect(f.self.inventory).toEqual({ BULLET: 2, DRILLER: 1 });
  });
});

describe("SNIPER physical corpus", () => {
  function witness(state: GameState, terrain: TerrainManager, shooter: Player, weapon: WeaponId, command: { angle: number; power: number }) {
    const copied = new TerrainManager(terrain.width, terrain.height);
    copied.loadHeights([...terrain.getHeightmap()], [...terrain.getMaterials()]);
    const tanks = new TankManager();
    tanks.setPlayers(structuredClone(state.players));
    const hits: ProjectileHitEvent[] = [];
    const damageEvents: CombatDamageEvent[] = [];
    const destruction: CombatDestructionEvent[] = [];
    tanks.onDamageApplied = (event) => damageEvents.push(event);
    tanks.onTankDestroyed = (event) => destruction.push(event);
    tanks.beginShotAttribution(1, shooter.id, weapon);
    const engine = new PhysicsEngine(() => 0.5, false);
    engine.onProjectileHit = (event) => hits.push(event);
    const launch = launchFromBarrel(shooter.tank.position.x, shooter.tank.position.y, command.angle);
    engine.launchProjectile(launch.x, launch.y, command.angle, command.power, weapon,
      shooter.id, shooter.tank.color, { shotId: 1, munitionId: 0 });
    let steps = 0;
    for (; steps < 2400; steps += 1) {
      engine.updateProjectiles(BALLISTICS_DT, state.gravity, state.windForce, copied, tanks);
      tanks.applyGravity(BALLISTICS_DT, copied);
      tanks.checkTankBurial(copied);
      if (!engine.hasActiveProjectiles() && !tanks.anyTankIsFalling()) {
        return { complete: true, hits, damage: damageEvents, destruction, steps: steps + 1 };
      }
    }
    return { complete: false, hits, damage: damageEvents, destruction, steps };
  }

  it("publishes isolated real-physics measures without a BULLET frequency floor", () => {
    expect(import.meta.env.DEV, "les mesures lisent la trace de développement").toBe(true);
    const { solveSniperAim } = sniperAim;
    const rows = [
      { name: "flat-zero", wind: 0, material: TERRAIN_MATERIAL.DIRT, offset: 0, slope: false },
      { name: "flat-offset", wind: 0, material: TERRAIN_MATERIAL.DIRT, offset: 48, slope: false },
      { name: "rock", wind: 0, material: TERRAIN_MATERIAL.ROCK, offset: 0, slope: false },
      { name: "soft-wind", wind: 15, material: TERRAIN_MATERIAL.SOFT, offset: -12, slope: false },
      { name: "west-slope", wind: -15, material: TERRAIN_MATERIAL.DIRT, offset: 8, slope: true },
      { name: "empty-bullet", wind: 0, material: TERRAIN_MATERIAL.DIRT, offset: 0, slope: false, bullet: 0 },
    ].map((spec) => {
      const f = fixture({ bullet: "bullet" in spec ? spec.bullet : undefined });
      f.state.windForce = spec.wind;
      f.terrain.setMaterialRange(0, 799, spec.material);
      if (spec.slope) {
        const heights = [...f.terrain.getHeightmap()];
        for (let x = 360; x < 460; x += 1) heights[x] = 280;
        f.terrain.loadHeights(heights, [...f.terrain.getMaterials()]);
        f.target.tank.position.y = 280;
      }
      const before = structuredClone({ inventory: f.self.inventory, money: f.self.money });
      const heights = [...f.terrain.getHeightmap()];
      const materials = [...f.terrain.getMaterials()];
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const reward = vi.spyOn(economics, "calculateShotRewards");
      const resolve = vi.spyOn(physical, "resolvePhysicalShot");
      const choice = chooseSniperPhysicalShot(f.self, f.target, f.state, f.terrain, spec.offset, (point, weapon, variant) =>
        solveSniperAim(f.self, point.x, point.y, f.state.windForce, f.state.gravity, f.terrain, weapon, variant));
      const again = chooseSniperPhysicalShot(f.self, f.target, f.state, f.terrain, spec.offset, (point, weapon, variant) =>
        solveSniperAim(f.self, point.x, point.y, f.state.windForce, f.state.gravity, f.terrain, weapon, variant));
      const trace = choice.trace;
      expect(info.mock.calls.some((call) => call[0] === "[AI SNIPER] Décision")).toBe(false);
      expect(again).toEqual(choice);
      expect(trace.searches).toBeLessThanOrEqual(SNIPER_SEARCH_LIMITS.total);
      expect(trace.forecasts).toBeLessThanOrEqual(trace.searches);
      expect(reward).not.toHaveBeenCalled();
      expect(f.self.inventory).toEqual(before.inventory);
      expect(f.self.money).toBe(before.money);
      expect(f.terrain.getHeightmap()).toEqual(heights);
      expect(f.terrain.getMaterials()).toEqual(materials);
      if (spec.material === TERRAIN_MATERIAL.ROCK) expect(choice.weaponId).not.toBe("DRILLER");
      if (choice.certified) {
        const forecasted = resolve.mock.calls.find((call) => call[3] === choice.weaponId &&
          call[4].angle === choice.command.angle && call[4].power === choice.command.power);
        expect(forecasted).toBeDefined();
        if (!forecasted) return;
        const seen = witness(f.state, f.terrain, f.self, choice.weaponId, choice.command);
        const forecastValue = resolve.mock.results[resolve.mock.calls.indexOf(forecasted)]?.value as physical.PhysicalResolution | undefined;
        expect(forecastValue?.complete).toBe(true);
        if (!forecastValue?.complete) return;
        expect(seen.hits).toEqual(forecastValue.hits);
        expect(seen.damage).toEqual(forecastValue.damage);
        expect(seen.destruction).toEqual(forecastValue.destruction);
      }
      const counts = new Map<string, number>();
      for (const refusal of trace.refusals) {
        const key = `${refusal.weaponId}:${refusal.refusal}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      info.mockRestore();
      resolve.mockRestore();
      reward.mockRestore();
      return {
        name: spec.name, weapon: choice.weaponId, reason: choice.reason, certified: choice.certified,
        searches: trace.searches, forecasts: trace.forecasts,
        admissible: trace.admissible.map(({ weaponId, kind, variant, destroyed, loss }) => ({
          weaponId, kind, variant, destroyed, loss,
        })),
        refusals: [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      };
    });
    expect(rows).toEqual([
      {
        name: "flat-zero", weapon: "BULLET", reason: "bullet", certified: true, searches: 6, forecasts: 4,
        admissible: [
          { weaponId: "BULLET", kind: "tank", variant: "full", destroyed: false, loss: 75000 },
          { weaponId: "BULLET", kind: "tank", variant: "high", destroyed: false, loss: 75000 },
          { weaponId: "DRILLER", kind: "terrain", variant: "full", destroyed: false, loss: 26000 },
          { weaponId: "DRILLER", kind: "terrain", variant: "high", destroyed: false, loss: 49000 },
        ],
        refusals: [["DRILLER:impact direct", 2]],
      },
      {
        name: "flat-offset", weapon: "MISSILE", reason: "missile-useful", certified: true, searches: 9, forecasts: 9,
        admissible: [],
        refusals: [
          ["BULLET:pas d'impact direct", 2],
          ["DRILLER:impact direct", 1],
          ["DRILLER:sans perte de support", 3],
          ["MISSILE:sans effet", 1],
          ["MISSILE:survivant écarté", 1],
        ],
      },
      {
        name: "rock", weapon: "BULLET", reason: "bullet", certified: true, searches: 2, forecasts: 1,
        admissible: [
          { weaponId: "BULLET", kind: "tank", variant: "full", destroyed: true, loss: 100000 },
          { weaponId: "BULLET", kind: "tank", variant: "high", destroyed: true, loss: 100000 },
        ],
        refusals: [["DRILLER:veto ROCK", 1]],
      },
      {
        name: "soft-wind", weapon: "BULLET", reason: "bullet", certified: true, searches: 6, forecasts: 6,
        admissible: [
          { weaponId: "BULLET", kind: "tank", variant: "high", destroyed: false, loss: 92000 },
          { weaponId: "DRILLER", kind: "tank", variant: "full", destroyed: false, loss: 49532 },
          { weaponId: "DRILLER", kind: "terrain", variant: "full", destroyed: false, loss: 51000 },
          { weaponId: "DRILLER", kind: "terrain", variant: "high", destroyed: false, loss: 66000 },
        ],
        refusals: [["BULLET:pas d'impact direct", 1], ["DRILLER:impact direct", 1]],
      },
      {
        name: "west-slope", weapon: "BULLET", reason: "bullet", certified: true, searches: 6, forecasts: 6,
        admissible: [
          { weaponId: "BULLET", kind: "tank", variant: "full", destroyed: false, loss: 75000 },
          { weaponId: "BULLET", kind: "tank", variant: "high", destroyed: false, loss: 75000 },
        ],
        refusals: [["DRILLER:impact direct", 4]],
      },
      {
        name: "empty-bullet", weapon: "DRILLER", reason: "driller", certified: true, searches: 4, forecasts: 3,
        admissible: [
          { weaponId: "DRILLER", kind: "terrain", variant: "full", destroyed: false, loss: 26000 },
          { weaponId: "DRILLER", kind: "terrain", variant: "high", destroyed: false, loss: 49000 },
        ],
        refusals: [["BULLET:stock vide", 1], ["DRILLER:impact direct", 2]],
      },
    ]);
  }, 60_000);
});
