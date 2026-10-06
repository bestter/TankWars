import type { Player } from "../../types/player";
import type { RoundMap } from "../round/prepareRound";
import { isStrictOnlineMessage, type ShotMessage, type ZeusAppointedMessage, type ZeusStrikeMessage, type ZeusStrikeAppliedMessage, type ZeusStateMessage, type ShopFinishMessage, type FireRejectedMessage } from "./protocol";

export const MAX_COMBAT_MESSAGE_BYTES = 64 * 1024;
export type CombatEvent = ShotMessage | ZeusAppointedMessage | ZeusStrikeMessage | ZeusStrikeAppliedMessage;
export interface ActiveCombatShot extends Omit<ShotMessage, "type"> {
  shooterSettled: boolean;
  earningsApplied: boolean;
  releaseAt: number | null;
  zeusEvaluated: boolean;
  appointment: import("../zeus/zeusDomain").ZeusAppointment | null;
}
export interface CombatSnapshot {
  roundNumber: number;
  map: RoundMap;
  initialPlayers: Player[];
  players: Player[];
  economicRevision: number;
  roundEarningsByPlayer: Record<string, number>;
  currentPlayerIndex: number;
  zeus: ZeusStateMessage;
  lastFireResult?: FireRejectedMessage | null;
  completedShop?: ShopFinishMessage | null;
  activeShotId: number | null;
  activeShot: ActiveCombatShot | null;
  authoritySlot: number | null;
  authorityEpoch: number;
  events: CombatEvent[];
}
export interface CombatCatchUpMessage {
  type: "COMBAT_CATCH_UP_BEGIN" | "COMBAT_CATCH_UP_FRAGMENT" | "COMBAT_CATCH_UP_END";
  catchUpId: string;
  roundNumber: number;
  fragmentCount: number;
  boundary: number;
  index?: number;
  kind?: "BASE" | "EVENTS";
  data?: string;
  events?: CombatEvent[];
  firstSequence?: number;
  lastSequence?: number;
}

export function encodedCombatBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function isCombatEvent(value: unknown): value is CombatEvent {
  return isStrictOnlineMessage(value) && (value.type === "SHOT" || value.type === "ZEUS_APPOINTED" || value.type === "ZEUS_STRIKE" || value.type === "ZEUS_STRIKE_APPLIED");
}

function validateSnapshot(snapshot: CombatSnapshot, roundNumber: number, boundary: number): void {
  const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (snapshot.roundNumber !== roundNumber || snapshot.events.length !== boundary ||
      !isStrictOnlineMessage({ type: "GAME_START", protocolVersion: 3, currentPlayerIndex: snapshot.currentPlayerIndex, players: snapshot.initialPlayers, map: snapshot.map }) ||
      !isStrictOnlineMessage(snapshot.zeus) ||
      !isStrictOnlineMessage({ type: "STATE_UPDATE", currentPlayerIndex: snapshot.currentPlayerIndex, roundEnded: false, players: snapshot.players }) ||
      !integer(snapshot.economicRevision) || !integer(snapshot.authorityEpoch) ||
      (snapshot.authoritySlot !== null && (!integer(snapshot.authoritySlot) || snapshot.authoritySlot >= snapshot.players.length)) ||
      !snapshot.roundEarningsByPlayer || Object.values(snapshot.roundEarningsByPlayer).some((v) => !integer(v))) throw new Error("Invalid combat snapshot");
  const ids = new Set(snapshot.initialPlayers.map((p) => p.id));
  if (ids.size !== snapshot.initialPlayers.length || snapshot.players.length !== ids.size ||
      new Set(snapshot.players.map((p) => p.id)).size !== ids.size || snapshot.players.some((p) => !ids.has(p.id)) ||
      Object.keys(snapshot.roundEarningsByPlayer).length !== ids.size || [...ids].some((id) => !integer(snapshot.roundEarningsByPlayer[id]))) throw new Error("Invalid combat roster");
  if (snapshot.lastFireResult && !isStrictOnlineMessage(snapshot.lastFireResult)) throw new Error("Invalid fire recovery");
  if (snapshot.completedShop && !isStrictOnlineMessage(snapshot.completedShop)) throw new Error("Invalid shop recovery");
  const active = snapshot.activeShot;
  if (active === null) {
    if (snapshot.activeShotId !== null) throw new Error("Missing active shot");
  } else if (!active || !isStrictOnlineMessage({ ...active, type: "SHOT" }) || active.shotId !== snapshot.activeShotId ||
      typeof active.shooterSettled !== "boolean" || typeof active.earningsApplied !== "boolean" || typeof active.zeusEvaluated !== "boolean" ||
      (active.releaseAt !== null && !integer(active.releaseAt)) ||
      !snapshot.events.some((e) => e.type === "SHOT" && e.shotId === active.shotId)) throw new Error("Invalid active shot");
  let lastShotId = 0;
  let strike: ZeusStrikeMessage | null = null;
  for (const event of snapshot.events) {
    if (event.type === "SHOT") {
      if (strike || event.shotId <= lastShotId || snapshot.initialPlayers[event.slot]?.id !== event.ownerId) throw new Error("Invalid shot ordering");
      lastShotId = event.shotId;
    } else {
      if (event.afterShotId !== lastShotId) throw new Error("Invalid Zeus boundary");
      if (event.type === "ZEUS_STRIKE") {
        if (strike || !ids.has(event.zeusId) || !ids.has(event.targetId) || event.zeusId === event.targetId) throw new Error("Invalid Zeus strike");
        strike = event;
      } else if (event.type === "ZEUS_STRIKE_APPLIED") {
        if (!strike || strike.strikeId !== event.strikeId || strike.zeusId !== event.zeusId || strike.targetId !== event.targetId) throw new Error("Invalid Zeus result");
        strike = null;
      } else if (strike || !ids.has(event.zeusId)) throw new Error("Invalid Zeus appointment");
    }
  }
}

/** Capture once, then fragment that immutable snapshot including its base. */
export function fragmentCombat(snapshot: CombatSnapshot, catchUpId: string): CombatCatchUpMessage[] {
  const { events, ...base } = structuredClone(snapshot);
  const header = { catchUpId, roundNumber: snapshot.roundNumber, fragmentCount: Number.MAX_SAFE_INTEGER,
    boundary: events.at(-1)?.eventSequence ?? 0 };
  const fragments: CombatCatchUpMessage[] = [];
  const push = (body: Partial<CombatCatchUpMessage>) => fragments.push({ ...header,
    type: "COMBAT_CATCH_UP_FRAGMENT", index: fragments.length, ...body });
  const data = JSON.stringify(base);
  // JSON string escaping can expand a UTF-16 code unit to six bytes.
  for (let offset = 0; offset < data.length; offset += 8000) push({ kind: "BASE", data: data.slice(offset, offset + 8000) });
  let batch: CombatEvent[] = [];
  const flush = () => {
    if (batch.length === 0) return;
    push({ kind: "EVENTS", events: batch, firstSequence: batch[0].eventSequence, lastSequence: batch.at(-1)!.eventSequence });
    batch = [];
  };
  for (const event of events) {
    const candidate = { ...header, type: "COMBAT_CATCH_UP_FRAGMENT", index: fragments.length,
      kind: "EVENTS", events: [...batch, event], firstSequence: batch[0]?.eventSequence ?? event.eventSequence, lastSequence: event.eventSequence };
    if (encodedCombatBytes(candidate) > MAX_COMBAT_MESSAGE_BYTES) flush();
    batch.push(event);
    if (encodedCombatBytes({ ...candidate, events: batch }) > MAX_COMBAT_MESSAGE_BYTES) throw new RangeError("Combat event exceeds transport limit");
  }
  flush();
  const finalHeader = { ...header, fragmentCount: fragments.length };
  const messages: CombatCatchUpMessage[] = [ { ...finalHeader, type: "COMBAT_CATCH_UP_BEGIN" },
    ...fragments.map((part) => ({ ...part, fragmentCount: fragments.length })),
    { ...finalHeader, type: "COMBAT_CATCH_UP_END" } ];
  if (messages.some((m) => encodedCombatBytes(m) > MAX_COMBAT_MESSAGE_BYTES)) throw new RangeError("Combat fragment exceeds transport limit");
  return messages;
}

/** Incomplete/contradictory batches never expose a partial scene. */
export class CombatCatchUpAssembler {
  private header: CombatCatchUpMessage | null = null;
  private readonly parts = new Map<number, CombatCatchUpMessage>();
  private ended = false;
  private completed = new Set<string>();

  accept(message: CombatCatchUpMessage): CombatSnapshot | null {
    if (!isStrictOnlineMessage(message)) throw new Error("Invalid combat envelope");
    if (encodedCombatBytes(message) > MAX_COMBAT_MESSAGE_BYTES) throw new Error("Combat fragment too large");
    if (this.completed.has(message.catchUpId)) return null;
    if (message.type === "COMBAT_CATCH_UP_BEGIN") {
      if (this.header?.catchUpId !== message.catchUpId) {
        if (this.header) this.completed.add(this.header.catchUpId);
        this.parts.clear(); this.ended = false; this.header = message;
      }
    }
    const h = this.header;
    if (!h || message.catchUpId !== h.catchUpId) return null;
    if (message.roundNumber !== h.roundNumber || message.fragmentCount !== h.fragmentCount || message.boundary !== h.boundary) throw new Error("Contradictory combat batch");
    if (message.type === "COMBAT_CATCH_UP_END") this.ended = true;
    if (message.type === "COMBAT_CATCH_UP_FRAGMENT") {
      const index = message.index;
      if (index === undefined || !Number.isSafeInteger(index) || index < 0 || index >= h.fragmentCount) throw new Error("Invalid combat fragment index");
      const previous = this.parts.get(index);
      if (previous && JSON.stringify(previous) !== JSON.stringify(message)) throw new Error("Contradictory combat fragment");
      this.parts.set(index, message);
    }
    if (!this.ended || this.parts.size !== h.fragmentCount) return null;
    let data = "";
    const events: CombatEvent[] = [];
    for (let index = 0; index < h.fragmentCount; index++) {
      const part = this.parts.get(index)!;
      if (part.kind === "BASE" && typeof part.data === "string" && events.length === 0) data += part.data;
      else if (part.kind === "EVENTS" && Array.isArray(part.events) && part.events.length > 0) {
        if (part.firstSequence !== part.events[0].eventSequence || part.lastSequence !== part.events.at(-1)!.eventSequence) throw new Error("Invalid combat range");
        for (const event of part.events) {
          if (!isCombatEvent(event) || event.roundNumber !== h.roundNumber || event.eventSequence !== events.length + 1) throw new Error("Discontinuous combat journal");
          events.push(event);
        }
      } else throw new Error("Invalid combat fragment");
    }
    const base: unknown = JSON.parse(data);
    if (!base || typeof base !== "object" || Array.isArray(base)) throw new Error("Invalid combat base");
    const snapshot = { ...base, events } as CombatSnapshot;
    validateSnapshot(snapshot, h.roundNumber, h.boundary);
    this.completed.add(h.catchUpId);
    this.header = null;
    return snapshot;
  }
}
