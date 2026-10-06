import { FALL_DISTANCE_MAX_PX, type Player } from "../../types/player";
import { ALL_WEAPON_IDS } from "../../types/weapon";
import type { EarningsRejectedReason, RoundOutcomeWire, ShotEarningsMessage } from "./protocol";

/** Snapshot only after rewards have been calculated; never alter simulation deaths. */
export function earningsPlayers(players: readonly Player[]): Player[] {
  const copy = structuredClone([...players]);
  for (const player of copy) if (player.tank.isDead) player.tank.health = 0;
  return copy;
}

export function validateEarnings(
  report: ShotEarningsMessage,
  roster: readonly Player[],
  shooterId: string,
  weaponId: string,
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
  for (const [index, original] of roster.entries()) {
    const p = received.get(original.id)!;
    const t = p.tank;
    const before = original.tank;
    if (p.name !== original.name || p.isHuman !== original.isHuman ||
        (p.aiProfile ?? null) !== (original.aiProfile ?? null) || t.id !== before.id || t.color !== before.color) return fail("IDENTITY_MISMATCH");
    if (ALL_WEAPON_IDS.some((id) => (p.inventory[id] ?? 0) !== (original.inventory[id] ?? 0)) || t.currentWeapon !== before.currentWeapon) return fail("INVENTORY_MISMATCH");
    if (before.isDead && !t.isDead) return fail("RESURRECTION");
    if ((!t.isDead && t.health <= 0) || (t.isDead && t.health > 0) || report.deadSlots[index] !== t.isDead) return fail("DEATH_INCONSISTENT");
    if (t.maxHealth !== before.maxHealth || t.maxShield !== before.maxShield || t.health < 0 || t.health > before.maxHealth || t.shield < 0 || t.shield > before.maxShield) return fail("CAP_MISMATCH");
    players.push({ ...original, inventory: { ...original.inventory }, tank: {
      ...before, position: { ...t.position }, angle: t.angle, power: t.power,
      health: t.health, shield: t.shield, isDead: t.isDead,
      hitReaction: t.hitReaction ? { wasDirectHit: t.hitReaction.wasDirectHit,
        fallDistance: Math.min(FALL_DISTANCE_MAX_PX, t.hitReaction.fallDistance) } : undefined,
    } });
  }
  const awards = new Set<string>();
  for (const award of report.awards) {
    if (!known.has(award.playerId) || awards.has(award.playerId) || !Number.isSafeInteger(known.get(award.playerId)!.money + award.amount)) return fail("MALFORMED");
    awards.add(award.playerId);
  }
  const victims = new Set<string>();
  for (const id of report.directHitVictimIds) {
    if (!known.has(id) || victims.has(id) || id === shooterId || weaponId === "BULLDOZER") return fail("ILLEGAL_VICTIM");
    victims.add(id);
  }
  const alive = players.filter((p) => !p.tank.isDead && p.tank.health > 0);
  const roundOutcome = { isRoundEnd: alive.length <= 1, isDraw: alive.length === 0,
    roundWinnerId: alive.length === 1 ? alive[0].id : null };
  if (report.roundOutcome.isRoundEnd !== roundOutcome.isRoundEnd || report.roundOutcome.isDraw !== roundOutcome.isDraw || report.roundOutcome.roundWinnerId !== roundOutcome.roundWinnerId) return fail("ROUND_MISMATCH");
  return { ok: true, players, roundOutcome };
}
