import { useEffect, useRef, useState, type RefObject } from "react";
import type { GameEngine } from "../../game/engine/GameEngine";
import type { GamePhase } from "../../types/game";
import type { AdvisorObjective } from "../../game/entities/ai/expertPolicy";
import { AdvisorController, type AdvisorView } from "./AdvisorController";

export function useShotAdvisor(engineRef: RefObject<GameEngine | null>, phaseRef: RefObject<GamePhase>,
  gameMode: "local" | "online", initialPlayerCountRef: RefObject<number>) {
  const controllerRef = useRef<AdvisorController | null>(null);
  const [view, setView] = useState<AdvisorView>({ objective: "SURVIE", status: "idle" });
  useEffect(() => {
    const controller = new AdvisorController({
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
  return { view, request: () => controllerRef.current?.request(), apply: () => controllerRef.current?.apply(),
    setObjective: (objective: AdvisorObjective) => controllerRef.current?.setObjective(objective),
    reset: () => controllerRef.current?.reset() };
}
