import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { GameEngine } from "../../game/engine/GameEngine";
import type { GamePhase } from "../../types/game";
import type { AdvisorObjective } from "../../game/entities/ai/expertPolicy";
import { AdvisorController, type AdvisorView } from "./AdvisorController";

export function useShotAdvisor(engineRef: RefObject<GameEngine | null>, phaseRef: RefObject<GamePhase>,
  gameMode: "local" | "online", initialPlayerCountRef: RefObject<number>) {
  const controllerRef = useRef<AdvisorController | null>(null);
  const [view, setView] = useState<AdvisorView>({ objective: "OPTIMISER_PROFIT", status: "idle" });
  useEffect(() => {
    const controller = new AdvisorController({
      observing: () => Boolean(engineRef.current?.diagnosticSink),
      observe(event) {
        const engine = engineRef.current;
        if (!engine?.diagnosticSink) return;
        if (event.status === "calculating") engine.diagnosticSink({ kind: "current", snapshot: engine.captureDiagnosticState(), requestId: event.requestId });
        engine.diagnosticSink({ kind: "advisor", ...event });
      },
      capture() {
        const engine = engineRef.current;
        if (gameMode !== "local" || phaseRef.current !== "COMBAT" || !engine ||
            engine.getActiveProjectiles().length > 0 || engine.getActiveZeusId()) return null;
        const state = engine.getTurnManager().captureAdvisorState();
        if (!state) return null;
        if (state.localShotContext) state.localShotContext.playerCountAtMatchStart = initialPlayerCountRef.current;
        const terrain = engine.getTerrain();
        return { state, width: terrain.width, height: terrain.height,
          heights: [...terrain.getHeightmap()], materials: [...terrain.getMaterials()] };
      },
      apply(result) { return engineRef.current?.getTurnManager().applyAdvisorCommand(result.command) ?? false; },
    }, () => new Worker(new URL("../../game/entities/ai/shotAdvisor.worker.ts", import.meta.url),
      { type: "module" }), setView);
    controllerRef.current = controller;
    const interval = window.setInterval(() => controller.refresh(), 100);
    return () => {
      window.clearInterval(interval);
      controller.dispose();
      controllerRef.current = null;
    };
  }, [engineRef, phaseRef, gameMode, initialPlayerCountRef]);
  const request = useCallback(() => controllerRef.current?.request(), []);
  const apply = useCallback(() => controllerRef.current?.apply(), []);
  const setObjective = useCallback((objective: AdvisorObjective) => controllerRef.current?.setObjective(objective), []);
  const toggleLock = useCallback((targetId: string) => controllerRef.current?.toggleLock(targetId), []);
  const releaseDeadTargets = useCallback((deadIds: readonly string[]) => controllerRef.current?.releaseDeadTargets(deadIds), []);
  const reset = useCallback(() => controllerRef.current?.reset(), []);
  const lockFor = useCallback((playerId: string | undefined) => controllerRef.current?.lockFor(playerId), []);
  return { view, request, apply, setObjective, toggleLock, releaseDeadTargets, reset, lockFor };
}
