import type { GameCanvasState } from "./gameCanvasReducer";

export interface CanvasLoopController {
  readonly setPhaseActive: (nextPhaseActive: boolean) => void;
  readonly dispose: () => void;
}

type CanvasLoopPhaseState = Pick<
  GameCanvasState,
  "gamePhase" | "winner" | "protocolMismatch" | "roundPreparationError" | "networkError"
>;

/** Détermine si la phase courante anime continuellement le Canvas. */
export function isCanvasPhaseActive(state: CanvasLoopPhaseState): boolean {
  if (
    Boolean(state.protocolMismatch) ||
    Boolean(state.roundPreparationError) ||
    ((state.gamePhase === "SHOP" || state.gamePhase === "SUMMARY") &&
      Boolean(state.networkError))
  ) {
    return false;
  }

  return (
    state.gamePhase === "COMBAT" ||
    state.gamePhase === "RESOLUTION" ||
    state.gamePhase === "CELEBRATION" ||
    (state.gamePhase === "GAME_OVER" && state.winner !== null)
  );
}

/** Démarre la boucle de rendu Canvas et la suspend hors phase active, hors écran ou onglet masqué. */
export function startCanvasLoop(
  render: () => void,
  options?: {
    readonly canvas?: HTMLCanvasElement | null;
    readonly initialPhaseActive?: boolean;
  },
): CanvasLoopController {
  const canvas = options?.canvas ?? null;
  let disposed = false;
  let phaseActive = options?.initialPhaseActive ?? true;
  let pendingStaticRender = !phaseActive;
  let documentVisible =
    typeof document === "undefined" || document.visibilityState === "visible";
  let canvasInViewport = true;
  let frame: number | undefined;

  const cancelScheduledFrame = (): void => {
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
      frame = undefined;
    }
  };

  const canRender = (): boolean =>
    !disposed && documentVisible && canvasInViewport;

  const shouldRun = (): boolean => phaseActive && canRender();

  const draw = (): void => {
    frame = undefined;
    if (!shouldRun()) return;
    pendingStaticRender = false;
    render();
    if (shouldRun() && frame === undefined) {
      frame = requestAnimationFrame(draw);
    }
  };

  const syncLoop = (): void => {
    if (!shouldRun()) {
      cancelScheduledFrame();
      if (!phaseActive && pendingStaticRender && canRender()) {
        pendingStaticRender = false;
        render();
      }
      return;
    }
    pendingStaticRender = false;
    if (frame === undefined) {
      draw();
    }
  };

  const onVisibilityChange = (): void => {
    if (typeof document === "undefined") return;
    documentVisible = document.visibilityState === "visible";
    syncLoop();
  };

  const onContentVisibilityAutoStateChange = (event: Event): void => {
    if ("skipped" in event && typeof event.skipped === "boolean") {
      canvasInViewport = !event.skipped;
      syncLoop();
    }
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  if (canvas) {
    canvas.addEventListener(
      "contentvisibilityautostatechange",
      onContentVisibilityAutoStateChange,
    );
  }

  let observer: IntersectionObserver | null = null;
  const rootStyle =
    typeof document !== "undefined" ? document.documentElement?.style : undefined;
  const supportsContentVisibility = Boolean(
    rootStyle && "contentVisibility" in rootStyle,
  );
  if (
    canvas &&
    !supportsContentVisibility &&
    typeof IntersectionObserver === "function"
  ) {
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.length === 0) return;
        for (const entry of entries) {
          canvasInViewport = entry.isIntersecting;
        }
        syncLoop();
      },
      { rootMargin: "200px" },
    );
    observer.observe(canvas);
  }

  syncLoop();

  return {
    setPhaseActive: (nextPhaseActive: boolean): void => {
      if (disposed || nextPhaseActive === phaseActive) return;
      phaseActive = nextPhaseActive;
      pendingStaticRender = !phaseActive;
      syncLoop();
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      pendingStaticRender = false;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      if (canvas) {
        canvas.removeEventListener(
          "contentvisibilityautostatechange",
          onContentVisibilityAutoStateChange,
        );
      }
      observer?.disconnect();
      observer = null;
      cancelScheduledFrame();
    },
  };
}
