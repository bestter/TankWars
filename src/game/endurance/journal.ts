import type { EnduranceEvent, Incident } from "./types";
import type { Player } from "../../types/player";
import type { PurchaseObservation } from "../observation";

export type JournalEvent =
  | { kind: "combat"; event: EnduranceEvent }
  | { kind: "incident"; incident: Incident }
  | { kind: "session-start"; metadata: unknown }
  | { kind: "block-start" | "block-end" | "phase" | "round-start" | "round-end" | "session-stop"; reason: string | null; players: readonly Player[] }
  | { kind: "decision-cancelled"; reason: string }
  | { kind: "shop-start" | "shop-end"; visitId: string; player: Player }
  | { kind: "purchase"; visitId: string; purchase: PurchaseObservation };
export interface JournalEntry {
  schemaVersion: 1; sessionId: string; sequence: number; at: string; atMs: number;
  blockId: string | null; blockIndex: number; seed: number | null; round: number; turn: number;
  phase: string; decisionId: string | null; event: JournalEvent;
  context: { players: readonly Player[]; windForce: number | null } | null;
  contextError: string | null;
}
export interface JournalStatus {
  schemaVersion: 1; sessionId: string; emitted: number; persisted: number; complete: boolean; error: string | null;
}
export interface JournalStorage {
  appendJournal(entries: readonly JournalEntry[], status: JournalStatus): Promise<void>;
  readJournal(sessionId: string, after: number, limit: number): Promise<JournalEntry[]>;
  journalStatus(sessionId: string): Promise<JournalStatus | null>;
}

/** Bounded write-behind queue; the caller supplies the session's serialized storage lane. */
export class EnduranceJournal {
  readonly status: JournalStatus;
  private queue: JournalEntry[] = [];
  private inFlight = 0;
  private work: Promise<void> | null = null;
  private writable = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly write: JournalStorage["appendJournal"];
  private readonly failure: (error: unknown) => void;
  constructor(sessionId: string,
    write: JournalStorage["appendJournal"], failure: (error: unknown) => void) {
    this.write = write; this.failure = failure;
    this.status = { schemaVersion: 1, sessionId, emitted: 0, persisted: 0, complete: false, error: null };
  }
  append(entry: Omit<JournalEntry, "schemaVersion" | "sequence" | "sessionId">): void {
    if (this.status.complete) return;
    const sequence = ++this.status.emitted;
    if (this.status.error) return;
    if (this.queue.length + this.inFlight >= 2048) { this.failed(new Error("JOURNAL_BACKPRESSURE")); return; }
    try { this.queue.push(structuredClone({ ...entry, schemaVersion: 1, sequence, sessionId: this.status.sessionId })); }
    catch (error) { this.failed(error); return; }
    if (this.queue.length >= 256) void this.flush();
    else if (this.timer === undefined) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 1000);
  }
  private failed(error: unknown, storageFailure = false): void {
    if (storageFailure) this.writable = false;
    if (this.status.error) return;
    this.status.error = String(error); this.status.complete = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    // Never interrupt a synchronous economic transaction between its mutations.
    queueMicrotask(() => this.failure(error));
  }
  flush(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.work) return this.work;
    this.work = this.drain().finally(() => { this.work = null; });
    return this.work;
  }
  private async drain(): Promise<void> {
    while (this.queue.length && this.writable) {
      const batch = this.queue.splice(0, 256); this.inFlight = batch.length;
      const persisted = batch[batch.length - 1].sequence;
      // Batches deliberately share one transaction lane; acknowledgements must precede the next batch.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      try { await this.write(batch, { ...this.status, persisted }); this.status.persisted = persisted; }
      catch (error) { this.queue.unshift(...batch); this.failed(error, true); }
      finally { this.inFlight = 0; }
    }
  }
  async finish(): Promise<void> {
    await this.flush();
    const complete = !this.status.error && this.status.emitted === this.status.persisted;
    try { await this.write([], { ...this.status, complete }); this.status.complete = complete; }
    catch (error) { this.failed(error); }
  }
  /** Failed writes remain bounded and exportable; the bridge only exposes confirmed pages. */
  pending(): JournalEntry[] { return structuredClone(this.queue); }
  invalidate(error: unknown): void { this.failed(error); }
}
