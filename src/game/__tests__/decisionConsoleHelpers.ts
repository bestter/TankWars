/** Reassemble the actual emitted transport, as a saved browser-console text export does. */
export function decisionJSON(calls: readonly (readonly unknown[])[], label = "[AI EXPERT] Décision"): string {
  const lines = calls.map(call => String(call[0]));
  const headerLine = lines.find(line => line.startsWith(`${label} {`));
  if (!headerLine) throw new Error("MISSING_DECISION_HEADER");
  const header = JSON.parse(headerLine.slice(label.length + 1)) as { traceId: string; detailParts: number };
  const parts = lines.filter(line => line.startsWith(`${label} fragment `))
    .map(line => JSON.parse(line.slice(`${label} fragment `.length)) as { traceId: string; kind: string; part: number; data: string })
    .filter(value => value.traceId === header.traceId && value.kind === "detail").sort((a, b) => a.part - b.part);
  if (parts.length !== header.detailParts) throw new Error("INCOMPLETE_DECISION");
  return parts.map(value => value.data).join("");
}
