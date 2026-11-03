import { summarizeAdvice } from "./advisorProtocol";
import { calculateShotAdvice, type AdvisorSnapshot } from "./shotAdvisor";
import type { ExpertDecisionTrace } from "./expertPlanner";
import type { AdvisorObjective } from "./expertPolicy";
import { summarizeExpertDecision } from "./expertDecisionLog";

self.onmessage = (event: MessageEvent<{ snapshot: AdvisorSnapshot; objective: AdvisorObjective; requestId?: number; observe?: boolean }>) => {
  try {
    let decision: ExpertDecisionTrace | undefined;
    const advice = calculateShotAdvice(event.data.snapshot, event.data.objective,
      (import.meta.env.DEV || import.meta.env.MODE === "endurance") && (import.meta.env.DEV || event.data.observe === true)
        ? (trace) => { decision = trace; } : undefined);
    self.postMessage({ advice: advice ? summarizeAdvice(advice) : null, requestId: event.data.requestId, decision,
      decisionSummary: import.meta.env.DEV ? summarizeExpertDecision(decision) : undefined });
  } catch (error) {
    console.error("[Shot advisor] Calculation failed", error);
    self.postMessage({ error: true, requestId: event.data.requestId });
  }
};
