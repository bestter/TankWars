import { useEffect, useRef, type RefObject } from "react";
import type { GameCanvasState } from "./gameCanvasReducer";

type CombatState = Pick<GameCanvasState, "gamePhase" | "protocolMismatch" | "roundPreparationError">;

async function releaseScreenLock(sentinel: WakeLockSentinel): Promise<void> {
  try {
    await sentinel.release();
  } catch (error: unknown) {
    console.warn("[Screen Wake Lock] Failed to release combat screen lock", error);
  }
}

// Own browser resources in one controller; React only starts/stops its lifetime.
function observeVisibleCombat(
  pending: RefObject<Promise<void> | null>,
  wakeLock: WakeLock,
): () => void {
  let disposed = false;
  let visibilityGeneration = 0;
  let sentinel: WakeLockSentinel | null = null;
  let queued = false;
  const eligible = () => !disposed && document.visibilityState === "visible";
  const forgetReleased = () => {
    sentinel?.removeEventListener("release", forgetReleased);
    sentinel = null;
  };
  const track = (operation: Promise<void>) => {
    const tracked = operation
      .catch(() => {})
      .then(() => {
        if (pending.current === tracked) pending.current = null;
      });
    pending.current = tracked;
  };
  const release = () => {
    if (!sentinel) return;
    const previous = sentinel;
    forgetReleased();
    track(releaseScreenLock(previous));
  };
  const acquire = () => {
    if (!eligible() || sentinel) return;
    if (pending.current) {
      if (!queued) {
        queued = true;
        void pending.current.then(() => {
          queued = false;
          acquire();
        });
      }
      return;
    }
    const generation = visibilityGeneration;
    track((async () => {
      try {
        const acquired = await wakeLock.request("screen");
        if (!eligible() || generation !== visibilityGeneration) {
          await releaseScreenLock(acquired);
        } else if (!acquired.released) {
          sentinel = acquired;
          acquired.addEventListener("release", forgetReleased);
        }
      } catch (error: unknown) {
        console.warn("[Screen Wake Lock] Failed to acquire combat screen lock", error);
      }
    })());
  };
  const visibilityChanged = () => {
    if (document.visibilityState === "visible") acquire();
    else {
      visibilityGeneration += 1;
      release();
    }
  };

  document.addEventListener("visibilitychange", visibilityChanged);
  acquire();
  return () => {
    disposed = true;
    document.removeEventListener("visibilitychange", visibilityChanged);
    release();
  };
}

export function useCombatWakeLock(state: CombatState): void {
  // Keep acquisition/release serialized even across StrictMode effect restarts.
  const pending = useRef<Promise<void> | null>(null);
  const active = (state.gamePhase === "COMBAT" || state.gamePhase === "RESOLUTION") &&
    !state.protocolMismatch && !state.roundPreparationError;

  useEffect(() => {
    const wakeLock = typeof navigator !== "undefined" && navigator ? navigator.wakeLock : undefined;
    if (!active || typeof document === "undefined" || typeof wakeLock?.request !== "function") return;

    return observeVisibleCombat(pending, wakeLock);
  }, [active]);
}
