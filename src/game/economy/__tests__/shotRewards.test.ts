import { describe, expect, it } from "vitest";
import { calculateBaseRewardMilli, normalizeDamageToMilli } from "../fixedPoint";
import {
  calculateShotRewards,
  type CombatDamageEvent,
  type CombatDestructionEvent,
  type ShotRewardInput,
} from "../shotRewards";

function baseInput(overrides: Partial<ShotRewardInput> = {}): ShotRewardInput {
  return {
    shotId: 1,
    shooterId: "p1",
    weaponId: "MISSILE",
    playerCountAtMatchStart: 2,
    isFirstShotOfRound: false,
    aliveBeforeShot: ["p1", "p2"],
    survivorsAfterShot: ["p1", "p2"],
    damageEvents: [],
    destructionEvents: [],
    ...overrides,
  };
}

function damage(overrides: Partial<CombatDamageEvent> = {}): CombatDamageEvent {
  return {
    shotId: 1,
    munitionId: 1,
    shooterId: "p1",
    victimId: "p2",
    weaponId: "MISSILE",
    source: "projectile",
    classification: "direct",
    shieldAbsorbedMilli: 0,
    healthDamageMilli: 1_000,
    ...overrides,
  };
}

function destruction(overrides: Partial<CombatDestructionEvent> = {}): CombatDestructionEvent {
  return {
    shotId: 1,
    shooterId: "p1",
    victimId: "p2",
    weaponId: "MISSILE",
    cause: "health-zero",
    ...overrides,
  };
}

function amountFor(input: ShotRewardInput, playerId = "p1"): number {
  return calculateShotRewards(input).awards.find((award) => award.playerId === playerId)?.amount ?? 0;
}

describe("calculateBaseRewardMilli", () => {
  it.each([
    [2, 3_000],
    [3, 3_500],
    [4, 4_000],
  ])("calcule X pour %i joueurs", (players, expected) => {
    expect(calculateBaseRewardMilli(players)).toBe(expected);
  });

  it("refuse un nombre de joueurs hors de 2 à 4", () => {
    expect(() => calculateBaseRewardMilli(1)).toThrow(RangeError);
    expect(() => calculateBaseRewardMilli(5)).toThrow(RangeError);
  });

  it("normalise les dommages au millième", () => {
    expect(normalizeDamageToMilli(1.2346)).toBe(1_235);
  });
});

describe("calculateShotRewards", () => {
  it("calcule les dommages directs et indirects", () => {
    expect(amountFor(baseInput({ damageEvents: [damage({ healthDamageMilli: 1_500 })] }))).toBe(5);
    expect(
      amountFor(baseInput({ damageEvents: [damage({ classification: "indirect", healthDamageMilli: 1_500 })] })),
    ).toBe(3);
  });

  it("réduit de moitié les dommages de projectile massif", () => {
    expect(
      amountFor(
        baseInput({
          weaponId: "NUKE",
          damageEvents: [damage({ weaponId: "NUKE", healthDamageMilli: 2_000 })],
        }),
      ),
    ).toBe(3);
  });

  it("calcule les chutes directes et indirectes sans réduction massive", () => {
    expect(
      amountFor(baseInput({ damageEvents: [damage({ source: "fall", healthDamageMilli: 4_000 })] })),
    ).toBe(3);
    expect(
      amountFor(
        baseInput({
          weaponId: "NUKE",
          damageEvents: [
            damage({ source: "fall", weaponId: "NUKE", classification: "indirect", healthDamageMilli: 4_000 }),
          ],
        }),
      ),
    ).toBe(2);
  });

  it("paie 25 X pour une destruction normale et 50 X au premier tir", () => {
    expect(amountFor(baseInput({ destructionEvents: [destruction()] }))).toBe(75);
    expect(amountFor(baseInput({ isFirstShotOfRound: true, destructionEvents: [destruction()] }))).toBe(150);
  });

  it("limite une destruction massive à 2 X même au premier tir", () => {
    expect(
      amountFor(
        baseInput({
          weaponId: "NUKE",
          isFirstShotOfRound: true,
          destructionEvents: [destruction({ weaponId: "NUKE" })],
        }),
      ),
    ).toBe(6);
  });

  it("paie le dernier survivant", () => {
    expect(amountFor(baseInput({ survivorsAfterShot: ["p1"] }))).toBe(150);
  });

  it("partage une nulle normale puis ajoute X au tireur", () => {
    const input = baseInput({ survivorsAfterShot: [] });
    expect(amountFor(input, "p1")).toBe(78);
    expect(amountFor(input, "p2")).toBe(75);
  });

  it("exclut le tireur du partage d’une nulle massive", () => {
    const input = baseInput({ weaponId: "THERMONUCLEAR", survivorsAfterShot: [] });
    expect(amountFor(input, "p1")).toBe(3);
    expect(amountFor(input, "p2")).toBe(150);
  });

  it("ignore l’autodommage et l’autodestruction", () => {
    const input = baseInput({
      damageEvents: [damage({ victimId: "p1", healthDamageMilli: 100_000 })],
      destructionEvents: [destruction({ victimId: "p1" })],
    });
    expect(amountFor(input)).toBe(0);
  });

  it("cumule les dommages sur plusieurs tanks et les sous-munitions Cluster", () => {
    const input = baseInput({
      playerCountAtMatchStart: 3,
      aliveBeforeShot: ["p1", "p2", "p3"],
      survivorsAfterShot: ["p1", "p2", "p3"],
      weaponId: "CLUSTER",
      damageEvents: [
        damage({ weaponId: "CLUSTER", munitionId: 1, healthDamageMilli: 1_000 }),
        damage({ weaponId: "CLUSTER", munitionId: 2, victimId: "p3", healthDamageMilli: 2_000 }),
      ],
    });
    expect(amountFor(input)).toBe(11);
    expect(calculateShotRewards(input).damageDealtMilliByPlayer.p1).toBe(3_000);
  });

  it("n’applique qu’un ceil après le cumul de 1,5 et 0,375", () => {
    const input = baseInput({
      damageEvents: [
        damage({ healthDamageMilli: 500 }),
        damage({ munitionId: 2, source: "fall", classification: "indirect", healthDamageMilli: 1_000 }),
      ],
    });
    expect(amountFor(input)).toBe(2);
  });

  it("ne sur-arrondit pas un montant déjà entier", () => {
    expect(amountFor(baseInput({ damageEvents: [damage({ healthDamageMilli: 2_000 })] }))).toBe(6);
  });

  it("respecte les limites normalisées au millième", () => {
    expect(
      amountFor(baseInput({ damageEvents: [damage({ healthDamageMilli: normalizeDamageToMilli(0.001) })] })),
    ).toBe(1);
  });
});
