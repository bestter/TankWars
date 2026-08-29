import { describe, expect, it, vi } from "vitest";
import type { GamePhase } from "../../../types/game";
import type { AuthoritativeReplayMode } from "../../engine/TurnManager";
import type { ShotMessage } from "../protocol";
import {
  AuthoritativeShotQueue,
  type AuthoritativeShotQueueHost,
} from "../authoritativeShotQueue";

const command = { angle: 45, power: 50, weaponId: "MISSILE" as const };

function shot(id: number, roundNumber = 1): ShotMessage {
  return {
    type: "SHOT",
    actionId: `fire-${id}`,
    shotId: id,
    roundNumber,
    shotNumberInRound: id,
    isFirstShotOfRound: id === 1,
    slot: 0,
    ownerId: "p1",
    command,
  };
}

function createHost(
  initial: {
    phase?: GamePhase;
    paused?: boolean;
    lastSeenShotId?: number;
  } = {},
): AuthoritativeShotQueueHost & {
  phase: GamePhase;
  paused: boolean;
  seen: number;
  executed: Array<{ shotId: number; mode: AuthoritativeReplayMode }>;
  idleCalls: number;
} {
  const host = {
    phase: initial.phase ?? "COMBAT",
    paused: initial.paused ?? false,
    seen: initial.lastSeenShotId ?? 0,
    executed: [] as Array<{ shotId: number; mode: AuthoritativeReplayMode }>,
    idleCalls: 0,
    getGamePhase: () => host.phase,
    isInterRoundPaused: () => host.paused,
    lastSeenShotId: () => host.seen,
    markSeen: (shotId: number) => {
      host.seen = Math.max(host.seen, shotId);
    },
    acknowledgePendingFire: vi.fn(),
    executeRemoteFire: (message: ShotMessage, mode: AuthoritativeReplayMode) => {
      host.executed.push({ shotId: message.shotId, mode });
    },
    onIdle: () => {
      host.idleCalls += 1;
    },
    lockForCatchUp: vi.fn(),
    unlockAfterCatchUp: vi.fn(),
  };
  return host;
}

describe("AuthoritativeShotQueue", () => {
  it("calls onIdle once when drained empty", () => {
    const host = createHost();
    const queue = new AuthoritativeShotQueue(host);
    queue.drain();
    expect(host.idleCalls).toBe(1);
    expect(host.executed).toEqual([]);
  });

  it("does not drain while a replay is active", () => {
    const host = createHost();
    const queue = new AuthoritativeShotQueue(host);
    queue.enqueue([shot(1)], "LIVE_REMOTE");
    expect(host.executed).toEqual([{ shotId: 1, mode: "LIVE_REMOTE" }]);
    queue.enqueue([shot(2)], "LIVE_REMOTE");
    expect(host.executed).toHaveLength(1);
    queue.drain();
    expect(host.executed).toHaveLength(1);
  });

  it("purges completed-round shots without executing them and keeps the next round", () => {
    const host = createHost();
    const queue = new AuthoritativeShotQueue(host);
    queue.enqueue([shot(5, 1)], "LIVE_REMOTE");
    queue.enqueue([shot(3, 1), shot(6, 2)], "LIVE_REMOTE");
    queue.purgeCompletedRound(1);
    queue.onShotSettled(5);
    expect(host.executed).toEqual([
      { shotId: 5, mode: "LIVE_REMOTE" },
      { shotId: 6, mode: "LIVE_REMOTE" },
    ]);
  });

  it("skips a duplicate already-replayed shotId", () => {
    const host = createHost();
    const queue = new AuthoritativeShotQueue(host);
    queue.enqueue([shot(3)], "LIVE_REMOTE");
    queue.onShotSettled(3);
    host.executed.length = 0;
    queue.enqueue([shot(3)], "LIVE_REMOTE");
    expect(host.executed).toEqual([]);
    expect(host.idleCalls).toBeGreaterThan(0);
  });

  it("acknowledges historical shots without replay when not in combat", () => {
    const host = createHost({ phase: "SHOP", paused: true, lastSeenShotId: 0 });
    const queue = new AuthoritativeShotQueue(host);
    queue.enqueue([shot(4)], "CATCH_UP");
    expect(host.executed).toEqual([]);
    expect(host.seen).toBe(4);
    expect(queue.pendingCount).toBe(0);
  });
});
