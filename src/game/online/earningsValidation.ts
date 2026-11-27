import { FALL_DISTANCE_MAX_PX, type Player } from "../../types/player";
import { reinforcedShieldCapacity } from "../round/shield";
import { ROUND_HEIGHT, ROUND_WIDTH } from "../round/prepareRound";
import { CLUSTER_SUBMUNITION_COUNT } from "../combatConstants";
import {
  DAMAGE_PRECISION,
  ExactAccumulator,
  calculateBaseRewardMilli,
} from "../economy/fixedPoint";
import { ALL_WEAPON_IDS } from "../../types/weapon";
import type { EarningsRejectedReason, RoundOutcomeWire, ShotEarningsMessage } from "./protocol";

const DEAD_POSITION_MARGIN_PX = 2000;
const MASS_DESTRUCTION_WEAPONS = new Set(["NUKE", "THERMONUCLEAR"]);

/** Snapshot only after rewards have been calculated; never alter simulation deaths. */
export function earningsPlayers(players: readonly Player[]): Player[] {
  const copy = structuredClone([...players]);
  for (const player of copy) {
    if (!player.tank.isDead) continue;
    player.tank.health = 0;
    player.tank.shield = 0;
  }
  return copy;
}

export function validateEarnings(
  report: ShotEarningsMessage,
  roster: readonly Player[],
  shooterId: string,
  weaponId: string,
  isFirstShotOfRound = true,
): { ok: true; players: Player[]; roundOutcome: RoundOutcomeWire } | { ok: false; reason: EarningsRejectedReason } {
  const fail = (reason: EarningsRejectedReason) => ({ ok: false as const, reason });
  if (report.deadSlots.length !== roster.length) return fail("MALFORMED");
  const known = new Map(roster.map((p) => [p.id, p]));
  const received = new Map<string, Player>();
  for (const p of report.players) {
    if (!known.has(p.id)) return fail("MALFORMED");
    if (received.has(p.id)) return fail("DUPLICATE_PLAYER");
    received.set(p.id, p);
  }
  if (received.size !== roster.length) return fail("MISSING_PLAYER");
  const players: Player[] = [];
  const beforeById = new Map<string, Player>();
  const afterById = new Map<string, Player>();
  const directVictims = new Set(weaponId === "BULLDOZER" ? [] : report.directHitVictimIds);
  const isCluster = weaponId === "CLUSTER";
  let opponentDamageMilli = 0;
  let newlyDeadOpponents = 0;
  const aliveBeforeIds: string[] = [];
  for (const [index, original] of roster.entries()) {
    const p = received.get(original.id)!;
    const t = p.tank;
    const before = original.tank;
    if (p.name !== original.name || p.isHuman !== original.isHuman ||
        (p.aiProfile ?? null) !== (original.aiProfile ?? null) || t.id !== before.id || t.color !== before.color) return fail("IDENTITY_MISMATCH");
    if (ALL_WEAPON_IDS.some((id) => (p.inventory[id] ?? 0) !== (original.inventory[id] ?? 0)) || t.currentWeapon !== before.currentWeapon) return fail("INVENTORY_MISMATCH");
    if (before.isDead && !t.isDead) return fail("RESURRECTION");
    if ((!t.isDead && t.health <= 0) || (t.isDead && t.health > 0) || report.deadSlots[index] !== t.isDead) return fail("DEATH_INCONSISTENT");
    if (t.maxHealth !== before.maxHealth || t.maxShield !== before.maxShield || t.health < 0 || t.health > before.maxHealth || t.shield < 0 || t.shield > reinforcedShieldCapacity(before.maxShield)) return fail("CAP_MISMATCH");
    if (t.health > before.health || t.shield > before.shield) return fail("CAP_MISMATCH");
    const minX = t.isDead ? -DEAD_POSITION_MARGIN_PX : 0;
    const maxX = t.isDead ? ROUND_WIDTH + DEAD_POSITION_MARGIN_PX : ROUND_WIDTH;
    const minY = t.isDead ? -DEAD_POSITION_MARGIN_PX : 0;
    const maxY = t.isDead ? ROUND_HEIGHT + DEAD_POSITION_MARGIN_PX : ROUND_HEIGHT;
    if (t.position.x < minX || t.position.x > maxX || t.position.y < minY || t.position.y > maxY) {
      return fail("MALFORMED");
    }
    const normalized: Player = { ...original, inventory: { ...original.inventory }, tank: {
      ...before, position: { ...t.position }, angle: t.angle, power: t.power,
      health: t.health, shield: t.isDead ? 0 : t.shield, isDead: t.isDead,
      hitReaction: t.hitReaction ? { wasDirectHit: t.hitReaction.wasDirectHit,
        fallDistance: Math.min(FALL_DISTANCE_MAX_PX, t.hitReaction.fallDistance) } : undefined,
    } };
    players.push(normalized);
    beforeById.set(original.id, original);
    afterById.set(original.id, normalized);
    if (!before.isDead) {
      aliveBeforeIds.push(original.id);
      if (original.id !== shooterId) {
        const healthDelta = Math.max(0, before.health - normalized.tank.health);
        const shieldDelta = Math.max(0, before.shield - normalized.tank.shield);
        if (healthDelta > 0 || shieldDelta > 0) {
          // The final direct impact can absorb one damage point even with a
          // fractional shield left. Earlier absorption pays at most half per
          // shield point spent (splash reward or the direct absorption ratio).
          let shieldDamageCap = shieldDelta;
          const wasDirect = directVictims.has(original.id);
          if (shieldDelta > 0 && normalized.tank.shield === 0 && wasDirect) {
            const directAbsorptionCap = isCluster ? shieldDelta / 2 + 1 : Math.ceil(shieldDelta / 2);
            shieldDamageCap = Math.max(shieldDelta, directAbsorptionCap);
          }
          // Each submunition rounds health and absorption independently,
          // adding at most half a milli-point per impact and component.
          const roundingPerComponent = isCluster && wasDirect ? Math.floor(CLUSTER_SUBMUNITION_COUNT / 2) : 0;
          opponentDamageMilli +=
            Math.ceil(healthDelta * DAMAGE_PRECISION) +
            Math.ceil(shieldDamageCap * DAMAGE_PRECISION) +
            (healthDelta > 0 ? roundingPerComponent : 0) +
            (shieldDelta > 0 ? roundingPerComponent : 0);
        }
        if (normalized.tank.isDead) {
          newlyDeadOpponents++;
        }
      }
    }
  }
  const alive = players.filter((p) => !p.tank.isDead && p.tank.health > 0);
  const roundOutcome = { isRoundEnd: alive.length <= 1, isDraw: alive.length === 0,
    roundWinnerId: alive.length === 1 ? alive[0].id : null };
  if (report.roundOutcome.isRoundEnd !== roundOutcome.isRoundEnd || report.roundOutcome.isDraw !== roundOutcome.isDraw || report.roundOutcome.roundWinnerId !== roundOutcome.roundWinnerId) return fail("ROUND_MISMATCH");

  const isMassDestruction = MASS_DESTRUCTION_WEAPONS.has(weaponId);
  const xMilli = calculateBaseRewardMilli(roster.length);
  const drawRecipients = new Set(
    isMassDestruction
      ? aliveBeforeIds.filter((id) => id !== shooterId)
      : aliveBeforeIds,
  );

  const awards = new Set<string>();
  for (const award of report.awards) {
    const target = known.get(award.playerId);
    if (!target || awards.has(award.playerId) || !Number.isSafeInteger(target.money + award.amount)) return fail("MALFORMED");
    const cap = new ExactAccumulator();
    if (roundOutcome.roundWinnerId === award.playerId) {
      cap.add(BigInt(50 * xMilli), BigInt(DAMAGE_PRECISION));
    } else if (roundOutcome.isDraw) {
      if (drawRecipients.has(award.playerId)) {
        cap.add(BigInt(50 * xMilli), BigInt(DAMAGE_PRECISION) * BigInt(drawRecipients.size));
      }
      if (award.playerId === shooterId) {
        cap.add(BigInt(xMilli), BigInt(DAMAGE_PRECISION));
      }
    }
    if (award.playerId === shooterId) {
      if (opponentDamageMilli > 0) {
        cap.add(
          BigInt(xMilli) * BigInt(opponentDamageMilli),
          BigInt(DAMAGE_PRECISION * DAMAGE_PRECISION) * BigInt(isMassDestruction ? 2 : 1),
        );
      }
      if (newlyDeadOpponents > 0) {
        const killMultiplier = isMassDestruction ? 2 : isFirstShotOfRound ? 50 : 25;
        cap.add(BigInt(killMultiplier * xMilli) * BigInt(newlyDeadOpponents), BigInt(DAMAGE_PRECISION));
      }
    }
    if (award.amount > cap.ceilToSafeInteger()) return fail("MALFORMED");
    awards.add(award.playerId);
  }
  const victims = new Set<string>();
  for (const id of report.directHitVictimIds) {
    const beforeVictim = beforeById.get(id);
    const afterVictim = afterById.get(id);
    const damaged = !!beforeVictim && !!afterVictim && !beforeVictim.tank.isDead &&
      (afterVictim.tank.health < beforeVictim.tank.health ||
        afterVictim.tank.shield < beforeVictim.tank.shield ||
        afterVictim.tank.isDead);
    if (!damaged || victims.has(id) || id === shooterId || weaponId === "BULLDOZER") return fail("ILLEGAL_VICTIM");
    victims.add(id);
  }
  return { ok: true, players, roundOutcome };
}
