import type { ExpertDecisionTrace } from "./expertPlanner";

/** Keep the explanation ahead of detailed forecast arrays and rosters in browser exports. */
export function summarizeExpertDecision(trace: ExpertDecisionTrace | undefined) {
  const transition = trace?.lethalTransition;
  const analysis = transition?.analysis;
  return {
    phase: trace?.phase,
    transitionReason: trace?.transitionReason,
    selectionReason: trace?.selectionReason,
    candidateCount: trace?.candidateCount,
    selectedThreatId: trace?.selectedThreatId,
    survivalRoll: trace?.survivalRoll,
    threats: trace?.threats,
    targets: trace?.targets,
    advisorFallback: trace?.advisorFallback,
    lethalTransition: transition && {
      reason: transition.reason, initialTargetId: transition.initialTargetId, finalTargetId: transition.finalTargetId,
      analysis: analysis && { status: analysis.status, reason: analysis.reason,
        initial: analysis.initial?.status ?? null, after: analysis.after?.status ?? null, reply: analysis.reply?.status ?? null },
      alternatives: transition.alternatives.map(value => ({ targetId: value.targetId, accepted: value.accepted,
        status: value.analysis.status, reason: value.analysis.reason })),
    },
  };
}
