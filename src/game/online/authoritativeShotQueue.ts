import type { GamePhase } from "../../types/game";
import type { AuthoritativeReplayMode } from "../engine/TurnManager";
import type { ShotMessage } from "./protocol";

export interface QueuedAuthoritativeShot {
  readonly message: ShotMessage;
  readonly mode: AuthoritativeReplayMode;
}

export interface AuthoritativeShotQueueHost {
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
  private readonly replayedShotIds = new Set<number>();
  private replayActive = false;
  private activeShotId: number | null = null;
  private catchUpShotId: number | null = null;

  private readonly host: AuthoritativeShotQueueHost;

  constructor(host: AuthoritativeShotQueueHost) {
    this.host = host;
  }

  get replayActiveNow(): boolean {
    return this.replayActive;
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
    this.queued.sort((a, b) => a.message.shotId - b.message.shotId);
    if (shouldLockForCatchUp) this.host.lockForCatchUp();
    this.drain();
  }

  purgeCompletedRound(completedRoundNumber: number): void {
    const retained: QueuedAuthoritativeShot[] = [];
    for (const queued of this.queued) {
      if (queued.message.roundNumber <= completedRoundNumber) {
        this.acknowledgeWithoutReplay(queued.message);
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
    if (this.replayActive) return;

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

    this.queued.shift();
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
    this.host.acknowledgePendingFire(next.message);
    this.host.executeRemoteFire(next.message, next.mode);
  }

  onShotSettled(shotId: number): void {
    this.replayActive = false;
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
