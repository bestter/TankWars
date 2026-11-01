import { summarizeAdvice } from "./advisorProtocol";
import { calculateShotAdvice, type AdvisorSnapshot } from "./shotAdvisor";
import type { AdvisorObjective } from "./expertPolicy";

self.onmessage = (event: MessageEvent<{ snapshot: AdvisorSnapshot; objective: AdvisorObjective }>) => {
  try {
    const advice = calculateShotAdvice(event.data.snapshot, event.data.objective);
    self.postMessage({ advice: advice ? summarizeAdvice(advice) : null });
  } catch (error) {
    console.error("[Shot advisor] Calculation failed", error);
    self.postMessage({ error: true });
  }
};
