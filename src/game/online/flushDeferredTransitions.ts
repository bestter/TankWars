import type {
  DeferredAuthoritativeTransition,
  DeferredTransitionBuffer,
} from "./deferredTransitions";

export interface ShotQueueIdleState {
  readonly replayActiveNow: boolean;
  readonly pendingCount: number;
}

export function flushDeferredTransitions(
  shotQueue: ShotQueueIdleState,
  buffer: DeferredTransitionBuffer,
  apply: (item: DeferredAuthoritativeTransition) => void,
): void {
  if (shotQueue.replayActiveNow) return;
  const items = buffer.drain();
  for (const item of items) {
    if (item.kind === "ROUND_END" && shotQueue.pendingCount > 0) {
      buffer.enqueue(item);
      continue;
    }
    apply(item);
  }
}

export function scheduleDeferredTransition(
  shotQueue: ShotQueueIdleState,
  buffer: DeferredTransitionBuffer,
  apply: (item: DeferredAuthoritativeTransition) => void,
  item: DeferredAuthoritativeTransition,
): void {
  buffer.enqueue(item);
  flushDeferredTransitions(shotQueue, buffer, apply);
}
