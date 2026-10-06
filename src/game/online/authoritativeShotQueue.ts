import type { CombatEvent } from "./combatCatchUp";
import type { GamePhase } from "../../types/game";
import type { AuthoritativeReplayMode } from "../engine/TurnManager";
import type { ShotMessage } from "./protocol";

export interface QueuedAuthoritativeShot {
  readonly message: CombatEvent;
  readonly mode: AuthoritativeReplayMode;
}

export interface AuthoritativeShotQueueHost {
  readonly executeCombatEvent?: (message: Exclude<CombatEvent, ShotMessage>, mode: AuthoritativeReplayMode, done: () => void) => void;
  readonly getGamePhase: () => GamePhase;
  readonly isInterRoundPaused: () => boolean;
  readonly lastSeenShotId: () => number;
  readonly markSeen: (shotId: number) => void;
  readonly acknowledgePendingFire: (message: ShotMessage) => void;
  readonly executeRemoteFire: (
    message: ShotMessage,
    mode: AuthoritativeReplayMode,
  ) => void;
  readonly onIdle: () => void;
  readonly lockForCatchUp: () => void;
  readonly unlockAfterCatchUp: () => void;
}

export class AuthoritativeShotQueue {
  private readonly queued: QueuedAuthoritativeShot[] = [];
  private readonly queuedShotIds = new Set<number>();
  private readonly economicShotIds = new Set<number>();
  private readonly replayedShotIds = new Set<number>();
  private replayActive = false;
  private activeShotId: number | null = null;
  private catchUpShotId: number | null = null;

  private receivingCatchUp = false;
  private generation = 0;
  private readonly eventIds = new Map<number, string>();
  private lastEventSequence = 0;
  private activeEventSequence: number | null = null;

  public get processedEventSequence(): number { return this.lastEventSequence; }
  private activeZeusId: number | null = null;

  public resetForNextRound(): void {
    this.eventIds.clear(); this.economicShotIds.clear(); this.lastEventSequence = 0;
  }

  public beginReconstruction(): void {
    this.generation++;
    this.lastEventSequence = 0; this.activeEventSequence = null;
    this.queued.length = 0;
    this.queuedShotIds.clear(); this.replayedShotIds.clear(); this.eventIds.clear();
    this.replayActive = false; this.activeShotId = null; this.activeZeusId = null;
    this.catchUpShotId = null; this.receivingCatchUp = true;
    this.host.lockForCatchUp();
  }

  public finishReceiving(): void {
    this.receivingCatchUp = false;
    this.drain();
  }

  public get isReceivingCatchUp(): boolean { return this.receivingCatchUp; }

  public enqueueCombat(events: readonly CombatEvent[], mode: AuthoritativeReplayMode | ((event: CombatEvent) => AuthoritativeReplayMode)): void {
    for (const message of events) {
      const previous = this.eventIds.get(message.eventSequence);
      const serialized = JSON.stringify(message);
      if (previous && previous !== serialized) throw new Error("Contradictory combat event");
      if (previous) continue;
      this.eventIds.set(message.eventSequence, serialized);
      const resolvedMode = typeof mode === "function" ? mode(message) : mode;
      if (message.type === "ZEUS_STRIKE_APPLIED" && this.activeZeusId === message.strikeId) {
        const generation = this.generation;
        this.host.executeCombatEvent?.(message, resolvedMode, () => {
          if (generation !== this.generation) return;
          this.lastEventSequence = message.eventSequence;
          this.activeZeusId = null; this.replayActive = false; this.drain();
        });
      } else this.queued.push({ message, mode: resolvedMode });
    }
    this.queued.sort((a, b) => a.message.eventSequence - b.message.eventSequence);
    this.drain();
  }

  private readonly host: AuthoritativeShotQueueHost;

  constructor(host: AuthoritativeShotQueueHost) {
    this.host = host;
  }

  get replayActiveNow(): boolean {
    return this.replayActive || this.receivingCatchUp;
  }

  get pendingCount(): number {
    return this.queued.length;
  }

  get activeServerShotId(): number | null {
    return this.activeShotId;
  }

  get catchUpActiveShotId(): number | null {
    return this.catchUpShotId;
  }

  setCatchUpActiveShotId(shotId: number | null): void {
    this.catchUpShotId = shotId;
  }

  clearActiveServerShotId(): void {
    this.activeShotId = null;
  }

  noteCatchUpShotApplied(shotId: number): void {
    this.economicShotIds.add(shotId);
    if (this.catchUpShotId !== shotId) return;
    this.catchUpShotId = null;
    if (!this.replayActive && this.queued.length === 0) {
      this.host.unlockAfterCatchUp();
    }
  }

  enqueue(
    shots: readonly ShotMessage[],
    mode:
      | AuthoritativeReplayMode
      | ((message: ShotMessage) => AuthoritativeReplayMode),
  ): void {
    let shouldLockForCatchUp = false;
    for (const message of [...shots].sort((a, b) => a.shotId - b.shotId)) {
      const resolvedMode = typeof mode === "function" ? mode(message) : mode;
      this.host.acknowledgePendingFire(message);
      if (
        resolvedMode !== "ACTIVE_RECOVERY" &&
        (this.host.getGamePhase() !== "COMBAT" || this.host.isInterRoundPaused())
      ) {
        this.acknowledgeWithoutReplay(message);
        continue;
      }
      if (
        (resolvedMode !== "ACTIVE_RECOVERY" &&
          message.shotId <= this.host.lastSeenShotId()) ||
        this.replayedShotIds.has(message.shotId) ||
        this.queuedShotIds.has(message.shotId) ||
        (this.replayActive && this.activeShotId === message.shotId)
      ) {
        continue;
      }
      this.queuedShotIds.add(message.shotId);
      this.queued.push({ message, mode: resolvedMode });
      if (
        resolvedMode === "CATCH_UP" ||
        resolvedMode === "ACTIVE_RECOVERY"
      ) {
        shouldLockForCatchUp = true;
      }
    }
    this.queued.sort((a, b) => a.message.eventSequence - b.message.eventSequence);
    if (shouldLockForCatchUp) this.host.lockForCatchUp();
    this.drain();
  }

  purgeCompletedRound(completedRoundNumber: number): void {
    const retained: QueuedAuthoritativeShot[] = [];
    for (const queued of this.queued) {
      if (queued.message.roundNumber <= completedRoundNumber) {
        if (queued.message.type === "SHOT") this.acknowledgeWithoutReplay(queued.message);
      } else {
        retained.push(queued);
      }
    }
    this.queued.length = 0;
    this.queued.push(...retained);
    if (!this.replayActive && retained.length === 0) {
      this.catchUpShotId = null;
      this.host.unlockAfterCatchUp();
    }
  }

  drain(): void {
    if (this.replayActive || this.receivingCatchUp) return;

    const next = this.queued[0];
    if (!next) {
      this.host.onIdle();
      if (this.catchUpShotId === null) this.host.unlockAfterCatchUp();
      return;
    }
    if (
      this.host.getGamePhase() !== "COMBAT" ||
      this.host.isInterRoundPaused()
    ) {
      return;
    }

    if (this.eventIds.has(next.message.eventSequence) && next.message.eventSequence !== this.lastEventSequence + 1) throw new Error("Discontinuous combat journal");
    this.queued.shift();
    if (next.message.type !== "SHOT") {
      const message = next.message;
      this.lastEventSequence = message.eventSequence;
      const generation = this.generation;
      if (message.type === "ZEUS_STRIKE") {
        this.replayActive = true; this.activeZeusId = message.strikeId;
        this.host.executeCombatEvent?.(message, next.mode, () => {});
        const result = this.queued.findIndex((e) => e.message.type === "ZEUS_STRIKE_APPLIED" && e.message.strikeId === message.strikeId);
        if (result >= 0) {
          const applied = this.queued.splice(result, 1)[0];
          if (applied.message.type === "ZEUS_STRIKE_APPLIED") this.host.executeCombatEvent?.(applied.message, applied.mode, () => {
            if (generation !== this.generation) return;
            this.lastEventSequence = applied.message.eventSequence;
            this.activeZeusId = null; this.replayActive = false; this.drain();
          });
        }
      } else {
        this.replayActive = true;
        this.host.executeCombatEvent?.(message, next.mode, () => {
          if (generation !== this.generation) return;
          this.replayActive = false; this.drain();
        });
      }
      return;
    }
    this.queuedShotIds.delete(next.message.shotId);
    if (
      this.replayedShotIds.has(next.message.shotId) ||
      (next.mode !== "ACTIVE_RECOVERY" &&
        next.message.shotId <= this.host.lastSeenShotId())
    ) {
      this.drain();
      return;
    }

    this.replayActive = true;
    this.activeShotId = next.message.shotId;
    this.activeEventSequence = next.message.eventSequence;
    this.host.acknowledgePendingFire(next.message);
    this.host.executeRemoteFire(next.message, next.mode);
  }

  onShotSettled(shotId: number): void {
    if (this.activeShotId !== shotId) return;
    this.replayActive = false;
    if (this.economicShotIds.has(shotId)) {
      this.activeShotId = null;
      if (this.catchUpShotId === shotId) this.catchUpShotId = null;
    }
    if (this.activeEventSequence !== null) this.lastEventSequence = this.activeEventSequence;
    this.activeEventSequence = null;
    this.replayedShotIds.add(shotId);
    this.host.markSeen(shotId);
    this.drain();
  }

  private acknowledgeWithoutReplay(message: ShotMessage): void {
    this.host.acknowledgePendingFire(message);
    this.queuedShotIds.delete(message.shotId);
    this.replayedShotIds.add(message.shotId);
    if (message.shotId <= this.host.lastSeenShotId()) return;
    this.host.markSeen(message.shotId);
  }
}
